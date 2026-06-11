import { app, BrowserWindow, ipcMain, Tray, Menu, dialog } from 'electron' // Electron core modules
import os from 'os' // OS utilities
import { createClient } from 'webdav' // WebDAV client
import fs from 'fs/promises' // Promise-based FS API
import fssync from 'fs' // Sync FS API
import path from 'path' // Path utilities
import { fileURLToPath } from 'url' // ESM helpers

const __filename = fileURLToPath(import.meta.url) // Current file path
const __dirname = path.dirname(__filename) // Current dir path
const localRoot = path.join(os.homedir(), 'Nextcloud-Temp') // Local sync root

let win // BrowserWindow ref
let tray // Tray ref
let client // WebDAV client
let isSyncing = false // Re-entrancy lock
let isConnected = false // Connection status

const TIMESTAMP_TOLERANCE = 5000 // 5s tolerance
const UPLOAD_CONCURRENCY = 12 // Max parallel per-file WebDAV operations during Sync Up

// Run async tasks with a bounded concurrency limit, preserving no particular order.
async function runWithConcurrency(items, limit, worker) {
  let index = 0 // Shared cursor into items
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (index < items.length) {
      const current = index++ // Claim next item
      await worker(items[current], current) // Process it
    }
  })
  await Promise.all(runners) // Wait for all lanes to drain
}

// Process-level hardening to avoid crashes on EPIPE and similar
process.on('uncaughtException', (err) => {
  const code = err && (err.code || err.errno || '')
  if (code === 'EPIPE') {
    console.warn('Suppressed uncaught EPIPE in main process')
    return
  }
  console.error('Uncaught exception:', err?.message || err)
})
process.on('unhandledRejection', (reason) => {
  const code = reason && (reason.code || reason.errno || '')
  if (code === 'EPIPE') {
    console.warn('Suppressed unhandledRejection EPIPE in main process')
    return
  }
  console.error('Unhandled promise rejection:', reason?.message || reason)
})

// Handle system shutdown gracefully
process.on('SIGTERM', async () => {
  console.log('🔄 System shutdown detected - performing final sync...')
  
  if (client && isConnected) {
    try {
      // Final sync before shutdown
      console.log('📤 Performing final sync before shutdown...')
      await performSyncUp()
      console.log('✅ Final sync completed successfully')
    } catch (e) {
      console.error('❌ Final sync failed:', e?.message)
    }
  }
  
  console.log('👋 Shutting down gracefully...')
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('🔄 Interrupt signal received - performing final sync...')
  
  if (client && isConnected) {
    try {
      console.log('📤 Performing final sync before exit...')
      await performSyncUp()
      console.log('✅ Final sync completed successfully')
    } catch (e) {
      console.error('❌ Final sync failed:', e?.message)
    }
  }
  
  console.log('👋 Exiting gracefully...')
  process.exit(0)
})

// Files and patterns to exclude from sync
const SYNC_EXCLUSIONS = [
  '.sync-state.json',           // Local sync metadata
  '.sync-folders.json',         // Top-level folder selection (local only)
  'node_modules',               // Node.js dependencies
  '.conflict-',                // Conflict files (pattern)
  '.DS_Store',                 // macOS system files
  'Thumbs.db',                  // Windows thumbnails
  'desktop.ini',               // Windows system files
  '.git',                      // Git repository
  '.vscode',                   // VS Code settings
  '.idea',                     // IntelliJ/WebStorm settings
  '*.tmp',                     // Temporary files
  '*.log'                      // Log files
]

// Helper function to check if a path should be excluded
function shouldExcludePath(path) {
  return SYNC_EXCLUSIONS.some(exclusion => {
    if (exclusion.includes('*')) {
      // Handle wildcard patterns
      const pattern = exclusion.replace(/\*/g, '.*')
      return new RegExp(pattern).test(path)
    }
    return path.includes(exclusion)
  })
}

function createWindow() {
  win = new BrowserWindow({
    title: "My Electron App", // Title
    width: 600, // Width
    height: 770, // Height
    icon: path.join(__dirname, 'icon.png'), // Icon
    webPreferences:{ preload: path.join(__dirname, 'preload.js') } // Preload script
  })

  win.loadFile('index.html') // Load UI
  win.removeMenu() // Hide menu
  //win.webContents.openDevTools(); // Show dev tools

  win.on('close', (event) => {
    if (!app.isQuiting) { event.preventDefault(); win.hide() } // Minimize to tray
  })
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'trayicon.png')) // Create tray icon
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => win.show() }, // Show window
    { label: 'Quit', click: () => { app.isQuiting = true; app.quit() } } // Quit app
  ])
  tray.setToolTip('My Electron App') // Tooltip
  tray.setContextMenu(contextMenu) // Context menu
  tray.on('click', () => { win.isVisible() ? win.hide() : win.show() }) // Toggle window
}

// Ensure single instance: focus existing window and exit second instance
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  app.whenReady().then(() => { createWindow(); createTray() }) // Init app
}

ipcMain.handle('login', async (event, { server, username, password, selectFolders }) => {
  isSyncing = false // Reset lock

  const base = `${server.replace(/\/+$/,'')}/remote.php/dav/files/${encodeURIComponent(username)}/` // Base URL
  client = createClient(base, { username, password }) // Create client

  try {
    await client.getDirectoryContents('/') // Probe root
    isConnected = true // Mark as connected
    if (!fssync.existsSync(localRoot)) fssync.mkdirSync(localRoot,{recursive:true}) // Ensure local root
    await loadSelectedTopFolders() // Apply any previously saved folder selection

    // Folder-selection mode: don't sync yet — let the UI fetch the folder list and confirm.
    if (selectFolders) {
      event.sender.send('login-result', { status:'ok', message:'Login erfolgreich – bitte Ordner auswählen', mode:'select-folders' }) // Notify UI
      return { status:'logged-in' } // Ack; sync starts after selection
    }

    event.sender.send('login-result', { status:'ok', message:'Login erfolgreich, initialer Sync startet' }) // Notify UI

    // Initial sync down after login - Server to Client only
    setImmediate(async () => {
      try {
        await performInitialSyncDown()
        // Message is already sent by performInitialSyncDown()
      } catch (e) {
        console.error('Initial sync failed:', e?.message)
        event.sender.send('sync-result', { status:'error', message: `Initialer Sync fehlgeschlagen: ${e?.message}` })
      }
    })

    return { status:'logged-in' } // Ack
  } catch (e) {
    const msg = e?.message || 'Login fehlgeschlagen' // Message
    console.error('Login error:', msg) // Log
    event.sender.send('login-result', { status:'error', message: msg }) // Notify UI
    return { status:'failed' } // Ack
  }
})

ipcMain.handle('logout', async () => {
  client = null // Drop client
  isSyncing = false // Reset lock
  isConnected = false // Mark as disconnected
  console.log('Logged out') // Log
  return { status: 'logged-out' } // Ack
})

ipcMain.handle('get-version', async () => {
  return { version: app.getVersion() } // Return version from package.json
})

// New sync handlers
ipcMain.handle('sync-down', async () => {
  if (!client) return { status: 'no-client' } // Guard
  if (isSyncing) return { status: 'already-syncing' } // Prevent concurrent syncs
  
  try {
    await performSyncDown()
    return { status: 'success' }
  } catch (e) {
    console.error('Sync down failed:', e?.message)
    return { status: 'error', message: e?.message }
  }
})

ipcMain.handle('sync-up', async () => {
  if (!client) return { status: 'no-client' } // Guard
  if (isSyncing) return { status: 'already-syncing' } // Prevent concurrent syncs

  try {
    await performSyncUp()
    return { status: 'success' }
  } catch (e) {
    console.error('Sync up failed:', e?.message)
    return { status: 'error', message: e?.message }
  }
})

// List first-level folders with their (server-computed) recursive size, instantly.
// Uses a single Depth:1 PROPFIND with details:true and reads Nextcloud's quota-used-bytes,
// so no recursive scan is needed.
ipcMain.handle('list-top-folders', async () => {
  if (!client) return { status: 'no-client' } // Guard
  try {
    const list = await client.getDirectoryContents('/', { details: true }) // Raw props per entry
    const items = list.data ?? list // details:true wraps results in { data }
    const folders = []
    for (const item of items) {
      if (item.type !== 'directory') continue // top-level folders only
      const name = item.basename || item.filename.replace(/^\/+|\/+$/g, '')
      if (!name || shouldExcludePath(name)) continue // skip excluded
      const props = item.props || {}
      const rawSize = Number(props['quota-used-bytes']) // Nextcloud: recursive bytes used by this folder
      const size = Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : null // negatives = unknown
      folders.push({ name, size }) // size may be null if server didn't report it
    }
    folders.sort((a, b) => (b.size ?? 0) - (a.size ?? 0)) // Biggest first
    return {
      status: 'ok',
      folders,
      selected: selectedPaths ? [...selectedPaths] : null, // Saved selected paths (any depth); null = all
    }
  } catch (e) {
    console.error('list-top-folders failed:', e?.message)
    return { status: 'error', message: e?.message }
  }
})

// List the immediate sub-folders of a given top-level folder (lazy, on expand).
// Same instant single Depth:1 PROPFIND as list-top-folders, scoped to one path.
ipcMain.handle('list-subfolders', async (_event, { path: relPath }) => {
  if (!client) return { status: 'no-client' } // Guard
  const clean = String(relPath || '').replace(/^\/+|\/+$/g, '') // Normalize POSIX rel path
  if (!clean) return { status: 'error', message: 'Kein Pfad angegeben' }
  try {
    const list = await client.getDirectoryContents('/' + clean, { details: true }) // Raw props per entry
    const items = list.data ?? list // details:true wraps results in { data }
    const folders = []
    for (const item of items) {
      if (item.type !== 'directory') continue // sub-folders only
      const name = item.basename || item.filename.replace(/^\/+|\/+$/g, '').split('/').pop()
      if (!name || shouldExcludePath(name)) continue // skip excluded
      const childPath = clean + '/' + name // Full POSIX path used for selection
      const props = item.props || {}
      const rawSize = Number(props['quota-used-bytes']) // Nextcloud: recursive bytes used by this folder
      const size = Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : null // negatives = unknown
      folders.push({ name, path: childPath, size })
    }
    folders.sort((a, b) => (b.size ?? 0) - (a.size ?? 0)) // Biggest first
    return { status: 'ok', folders }
  } catch (e) {
    console.error('list-subfolders failed:', e?.message)
    return { status: 'error', message: e?.message }
  }
})

// Persist the user's folder selection, then run the initial sync down for the chosen scope.
// paths === null (or empty array meaning "all") clears the filter and syncs everything.
// paths = selected folder paths at any depth; each syncs everything beneath it.
ipcMain.handle('set-selected-folders', async (_event, { paths }) => {
  if (!client) return { status: 'no-client' } // Guard
  try {
    await saveSelectedTopFolders(Array.isArray(paths) ? paths : null) // Update + persist
    setImmediate(async () => {
      try {
        await performInitialSyncDown()
      } catch (e) {
        console.error('Initial sync failed:', e?.message)
        win?.webContents?.send('sync-result', { status:'error', message: `Initialer Sync fehlgeschlagen: ${e?.message}` })
      }
    })
    return { status: 'ok' }
  } catch (e) {
    console.error('set-selected-folders failed:', e?.message)
    return { status: 'error', message: e?.message }
  }
})

// Initial sync function - downloads files with timestamp check
async function performInitialSyncDown() {
  if (isSyncing) { console.log('Sync already running, skipping'); return }
  isSyncing = true
  
  win?.webContents?.send('sync-start')
  const syncState = await loadSyncState() // Fingerprints so Sync Up can skip unchanged files
  
  try {
    console.log('Initial sync from Nextcloud to local...')
    win?.webContents?.send('sync-result', { status: 'info', message: 'Initialer Download von Nextcloud...' })
    await downloadDir(client, '', localRoot, syncState)
    console.log('✅ Initialer Sync abgeschlossen')
    win?.webContents?.send('sync-result', { status: 'ok', message: 'Initialer Sync abgeschlossen' })
  } catch (e) {
    const msg = e?.message || 'Unknown error'
    console.error('Initial sync failed:', msg)
    win?.webContents?.send('sync-result', { status: 'error', message: `Initialer Sync Fehler: ${msg}` })
    throw e
  } finally {
    await pruneSyncStateMissingLocals(syncState) // Drop entries for removed paths
    await saveSyncState(syncState) // Persist fingerprints
    isSyncing = false
  }
}

// Regular sync down function - only downloads newer files
async function performSyncDown() {
  if (isSyncing) { console.log('Sync already running, skipping'); return }
  isSyncing = true
  
  win?.webContents?.send('sync-start')
  const syncState = await loadSyncState() // Keep upload fingerprints aligned with server
  
  try {
    console.log('Syncing from Nextcloud to local...')
    win?.webContents?.send('sync-result', { status: 'info', message: 'Download von Nextcloud...' })
    await downloadDir(client, '', localRoot, syncState)
    console.log('✅ Sync Down (Server → Client) abgeschlossen')
    win?.webContents?.send('sync-result', { status: 'ok', message: 'Sync Down erfolgreich' })
  } catch (e) {
    const msg = e?.message || 'Unknown error'
    console.error('Sync down failed:', msg)
    win?.webContents?.send('sync-result', { status: 'error', message: `Sync Down Fehler: ${msg}` })
    throw e
  } finally {
    await pruneSyncStateMissingLocals(syncState) // Drop entries for removed paths
    await saveSyncState(syncState) // Persist fingerprints
    isSyncing = false
  }
}

async function performSyncUp() {
  if (isSyncing) { console.log('Sync already running, skipping'); return }
  isSyncing = true
  
  win?.webContents?.send('sync-start')
  const syncState = await loadSyncState() // Skip PROPFIND per file when local matches last aligned snapshot
  
  try {
    console.log('Syncing from local to Nextcloud...')
    win?.webContents?.send('sync-result', { status: 'info', message: 'Upload zu Nextcloud...' })
    
    // Check for files to delete on server
    const filesToDelete = await getFilesToDelete()
    if (filesToDelete.length > 0) {
      const proceed = await confirmMassDeletion('Lokale Löschung erkannt', filesToDelete.length, filesToDelete.slice(0, 10))
      if (!proceed) {
        win?.webContents?.send('sync-result', { status: 'info', message: 'Upload abgebrochen - keine Löschungen' })
        return
      }
      
      // Delete files on server
      const deleteReadOnlyWarned = new Set() // Track warned directories
      for (const filePath of filesToDelete) {
        try {
          await client.deleteFile('/' + filePath)
          delete syncState.files[filePath] // Remove fingerprint so state stays consistent
          console.log(`Deleted on server: ${filePath}`)
          win?.webContents?.send('sync-result', { status: 'info', message: `Am Server gelöscht: ${filePath}` })
        } catch (e) {
          if (isPermissionError(e)) { // Permission error
            const dirRel = path.posix.dirname(filePath) || '/' // Directory path
            if (!deleteReadOnlyWarned.has(dirRel)) { // Warn once per directory
              deleteReadOnlyWarned.add(dirRel) // Mark as warned
              win?.webContents?.send('sync-result', { status: 'warning', message: `Kein Löschrecht in „/${dirRel}" – Löschungen werden dort übersprungen` }) // Notify
            }
            console.warn(`Skipped deletion (read-only): ${filePath}`) // Log skip
            win?.webContents?.send('sync-result', { status: 'warning', message: `Löschung übersprungen (read-only): ${filePath}` })
          } else {
            console.warn(`Could not delete ${filePath} on server:`, e?.message) // Other error
            win?.webContents?.send('sync-result', { status: 'warning', message: `Server-Löschung fehlgeschlagen: ${filePath}` })
          }
        }
      }
    }
    
    await uploadDir(client, localRoot, '', new Set(), { value: false }, syncState)
    console.log('✅ Sync Up (Client → Server) abgeschlossen')
    win?.webContents?.send('sync-result', { status: 'ok', message: 'Sync Up erfolgreich' })
  } catch (e) {
    const msg = e?.message || 'Unknown error'
    console.error('Sync up failed:', msg)
    win?.webContents?.send('sync-result', { status: 'error', message: `Sync Up Fehler: ${msg}` })
    throw e
  } finally {
    await pruneSyncStateMissingLocals(syncState) // Drop entries for removed paths
    await saveSyncState(syncState) // Persist fingerprints
    isSyncing = false
  }
}

// ---------- Confirmation helper ----------
async function confirmMassDeletion(title, count, preview) {
  try {
    const detailList = preview.map(p => `• ${p}`).join('\n') // Build preview lines
    const { response } = await dialog.showMessageBox(win ?? null, { // Show modal
      type: 'warning', // Warning dialog
      buttons: ['Abbrechen', 'Fortfahren'], // Buttons
      defaultId: 0, // Default to cancel
      cancelId: 0, // Esc cancels
      title, // Title
      message: `${count} Dateien werden am Server gelöscht. Fortfahren?`, // Short message
      detail: detailList.length ? `Beispiele:\n${detailList}` : undefined, // Show first items
      noLink: true // Native button style
    })
    return response === 1 // true if "Fortfahren"
  } catch (e) {
    console.warn('Deletion confirmation dialog failed, treating as cancel:', e?.message)
    return false
  }
}

// Helper function to get files that should be deleted on server
async function getFilesToDelete() {
  const localFiles = new Set()
  const remoteFiles = new Set()
  
  // Collect local files
  await collectLocalFiles(localRoot, '', localFiles)
  
  // Collect remote files
  await collectRemoteFiles(client, '', remoteFiles)
  
  // Find files that exist on server but not locally
  const toDelete = []
  for (const remoteFile of remoteFiles) {
    if (!localFiles.has(remoteFile) && !shouldExcludePath(remoteFile)) {
      toDelete.push(remoteFile)
    }
  }
  
  return toDelete
}

// Helper function to collect local files
async function collectLocalFiles(localRoot, rel, files) {
  try {
    const absDir = path.join(localRoot, rel)
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    
    for (const entry of entries) {
      if (shouldExcludePath(entry.name)) continue

      const nextRel = path.posix.join(rel, entry.name)
      if (shouldSkipEntry(nextRel, entry.isDirectory())) continue // ignore folders outside the selection
      if (entry.isDirectory()) {
        await collectLocalFiles(localRoot, nextRel, files)
      } else {
        files.add(nextRel)
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
  }
}

// Helper function to collect remote files
async function collectRemoteFiles(client, rel, files) {
  try {
    const list = await client.getDirectoryContents('/' + rel)
    for (const item of list) {
      const relPath = item.filename.replace(/^\//, '')
      if (shouldExcludePath(relPath)) continue
      if (shouldSkipEntry(relPath, item.type === 'directory')) continue // ignore folders outside the selection (never flag for deletion)

      if (item.type === 'directory') {
        await collectRemoteFiles(client, relPath, files)
      } else {
        files.add(relPath)
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
  }
}

function isNetworkError(error) {
  const networkCodes = ['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'] // Node codes
  const code = error?.code || '' // Code
  const status = error?.response?.status || 0 // HTTP status
  return networkCodes.includes(code) || status >= 500 || status === 423 // Treat as transient
}

// Check if error indicates permission issues (read-only share)
function isPermissionError(error) {
  const status = error?.response?.status || 0
  const code = error?.code || ''
  return status === 401 || status === 403 || status === 405 || status === 423 || code === 'EACCES'
}

// Check if error indicates quota issues
function isQuotaError(error) {
  const status = error?.response?.status || 0
  return status === 507 // Insufficient Storage
}

const SYNC_STATE_FILE = '.sync-state.json' // Local fingerprint store (excluded from WebDAV sync)

function syncStateFilePath() {
  return path.join(localRoot, SYNC_STATE_FILE) // Absolute path to state file
}

async function loadSyncState() {
  try {
    const raw = await fs.readFile(syncStateFilePath(), 'utf8') // Read JSON
    const data = JSON.parse(raw) // Parse
    if (data && typeof data.files === 'object' && data.files !== null) {
      return { files: { ...data.files } } // Mutable copy
    }
  } catch {
    // Missing or corrupt → treat as empty
  }
  return { files: {} } // Default
}

async function saveSyncState(state) {
  const payload = JSON.stringify({ v: 1, files: state.files }, null, 0) // Compact JSON
  await fs.writeFile(syncStateFilePath(), payload, 'utf8') // Persist
}

// ---------- Folder selection (independent path selection, any depth) ----------
// When enabled, only selected folder paths are synced (down + up + delete check).
// A selected path syncs everything beneath it. A path may be selected without its parent —
// the parent is then only a "pass-through" directory: created/traversed, but its own files
// are not synced unless the parent itself is selected too.
// Stored locally; an empty/missing selection means "sync everything" (no filtering).
const SYNC_FOLDERS_FILE = '.sync-folders.json' // Local selection store (excluded from WebDAV sync)

function syncFoldersFilePath() {
  return path.join(localRoot, SYNC_FOLDERS_FILE) // Absolute path
}

// In-memory selection for the current session. null = no filter (sync all).
// A Set of POSIX paths (any depth, e.g. "Documents" or "Documents/Rechnungen").
let selectedPaths = null

async function loadSelectedTopFolders() {
  try {
    const raw = await fs.readFile(syncFoldersFilePath(), 'utf8') // Read JSON
    const data = JSON.parse(raw) // Parse
    // v3: { paths: [...] } independent path selection.
    if (data && Array.isArray(data.paths)) {
      selectedPaths = data.paths.length ? new Set(data.paths) : null
      return selectedPaths
    }
    // Back-compat: v1/v2 stored top-level folders in "folders" (+ optional "excluded").
    // Migrate by treating selected top folders as selected paths; drop excluded sub-paths
    // (their absence from the new set means "not synced", matching old behavior closely enough).
    if (data && Array.isArray(data.folders)) {
      const excluded = new Set(Array.isArray(data.excluded) ? data.excluded : [])
      const paths = data.folders.filter((f) => !excluded.has(f))
      selectedPaths = paths.length ? new Set(paths) : null
      return selectedPaths
    }
  } catch {
    // Missing or corrupt → no filter
  }
  selectedPaths = null // Sync everything
  return null
}

async function saveSelectedTopFolders(paths) {
  selectedPaths = Array.isArray(paths) && paths.length ? new Set(paths) : null // Update in-memory
  if (selectedPaths === null) {
    try { await fs.unlink(syncFoldersFilePath()) } catch { /* nothing to remove */ }
    return
  }
  const payload = JSON.stringify({ v: 3, paths: [...selectedPaths] }, null, 0) // Compact JSON
  await fs.writeFile(syncFoldersFilePath(), payload, 'utf8') // Persist
}

// Normalize a relative POSIX path (strip surrounding slashes).
function cleanRel(relPosix) {
  return relPosix.replace(/^\/+|\/+$/g, '')
}

// True when relPosix is the same as, or a descendant of, any selected path.
// Such a path is fully in scope (its own files sync).
function isUnderSelected(clean) {
  if (!selectedPaths) return false
  if (selectedPaths.has(clean)) return true // Exactly selected
  for (const sel of selectedPaths) {
    if (clean.startsWith(sel + '/')) return true // Under a selected ancestor
  }
  return false
}

// True when relPosix is a strict ancestor of some selected path (a pass-through directory
// that must be created/traversed to reach a deeper selection, but isn't itself selected).
function isAncestorOfSelected(clean) {
  if (!selectedPaths) return false
  for (const sel of selectedPaths) {
    if (sel.startsWith(clean + '/')) return true // clean is an ancestor of sel
  }
  return false
}

// Single skip decision for a directory entry (file or folder) during a sync walk.
// Returns true when the entry must be skipped entirely. Honors the independent path model:
//   - no filter            → never skip
//   - root-level file       → always kept (top-level loose files stay in sync)
//   - file (nested)         → skip unless under a selected path
//   - directory             → skip unless under a selection OR an ancestor of one (pass-through)
// A pass-through directory is traversed/created but contributes no files of its own; files
// directly inside it are nested files and get skipped by the file rule above.
function shouldSkipEntry(relPosix, isDir) {
  if (!selectedPaths) return false // No filter active → keep everything
  const clean = cleanRel(relPosix)
  if (!clean) return false // Root itself
  if (!isDir) {
    if (!clean.includes('/')) return false // Root-level loose file → keep
    return !isUnderSelected(clean) // Nested file kept only under a selection
  }
  if (isUnderSelected(clean)) return false // Directory in scope
  if (isAncestorOfSelected(clean)) return false // Pass-through to a deeper selection
  return true // Directory outside every selected subtree → skip
}

function recordSyncedLocalFile(relPosix, stats, state) {
  state.files[relPosix] = { size: stats.size, mtimeMs: stats.mtimeMs } // Snapshot after last known alignment
}

function localMatchesSyncSnapshot(relPosix, stats, state) {
  const e = state.files[relPosix] // Cached entry
  if (!e) return false // Unknown → must check remote
  return e.size === stats.size && e.mtimeMs === stats.mtimeMs // Skip PROPFIND if unchanged locally since last sync
}

async function pruneSyncStateMissingLocals(state) {
  for (const rel of Object.keys(state.files)) {
    const abs = path.join(localRoot, ...rel.split('/')) // Native path from POSIX rel
    try {
      const st = await fs.stat(abs) // Exists?
      if (!st.isFile()) delete state.files[rel] // Not a regular file → drop
    } catch {
      delete state.files[rel] // Gone locally → drop
    }
  }
}

// Simplified shouldDownload function
async function shouldDownload(localPath, remoteItem) {
  try {
    const localStats = await fs.stat(localPath) // Local stat
    const remoteTime = new Date(remoteItem.lastmod) // Remote time
    const localTime = new Date(localStats.mtime) // Local time
    const timeDiff = remoteTime.getTime() - localTime.getTime() // Positive if remote newer

    return timeDiff > TIMESTAMP_TOLERANCE // Download if remote is newer
  } catch {
    return true // Local missing → download
  }
}

async function downloadDir(client, remoteRel, localRoot, syncState = null) {
  try {
    const list = await client.getDirectoryContents('/' + remoteRel) // List dir
    for (const item of list) {
      try {
        const rel = item.filename.replace(/^\//,'') // Normalize
        if (shouldExcludePath(rel)) continue // Skip excluded files and patterns
        if (shouldSkipEntry(rel, item.type === 'directory')) continue // Skip folders outside the selection entirely (don't even create them)
        const abs = path.join(localRoot, rel) // Local path

        if (item.type === 'directory') {
          await fs.mkdir(abs, { recursive: true }) // Ensure dir
          await downloadDir(client, rel, localRoot, syncState) // Recurse
        } else {
          if (await shouldDownload(abs, item)) { // Decide
            const buf = await client.getFileContents('/' + rel) // Read remote
            await fs.mkdir(path.dirname(abs), { recursive: true }) // Ensure parent
            await fs.writeFile(abs, buf) // Write file
            const remoteTime = new Date(item.lastmod) // Remote mtime
            await fs.utimes(abs, remoteTime, remoteTime) // Set mtime
            if (syncState) {
              const st = await fs.stat(abs) // Local metadata after align
              recordSyncedLocalFile(rel, st, syncState) // Record for upload fast-path
            }
            console.log(`Downloaded: ${rel}`) // Log
            win?.webContents?.send('sync-result', { status: 'info', message: `Heruntergeladen: ${rel}` })
          } else if (syncState) {
            try {
              const st = await fs.stat(abs) // Already matches remote — refresh snapshot without re-download
              recordSyncedLocalFile(rel, st, syncState) // Record for upload fast-path
            } catch {
              // Local missing though shouldDownload was false — unusual; skip state
            }
          }
        }
      } catch (e) {
        console.error(`Error processing ${item.filename}:`, e?.message) // Per-item error
      }
    }
  } catch (e) {
    if (!isNetworkError(e)) console.error(`Error downloading dir ${remoteRel}:`, e?.message) // Non-network error
    throw e // Bubble up
  }
}

// Upload a single file: decides whether to upload, performs it, and updates state.
// Safe to run concurrently with sibling files — the shared readOnlyWarned/quota/syncState
// objects are only mutated, and Node's single-threaded model rules out real races.
async function uploadFile(client, localRoot, nextRel, readOnlyWarned, stopUploadsDueToQuota, syncState) {
  const localPath = path.join(localRoot, nextRel) // abs path
  const localStats = await fs.stat(localPath) // Single local stat per file
  if (syncState && localMatchesSyncSnapshot(nextRel, localStats, syncState)) {
    return // Unchanged since last aligned sync — skip remote PROPFIND and upload
  }

  if (await shouldUpload(client, localPath, '/' + nextRel, localStats)) { // decide upload
    const parentPosix = path.posix.dirname('/' + nextRel) // remote parent
    if (parentPosix && parentPosix !== '/' && parentPosix !== '.') {
      await ensureRemoteDir(client, parentPosix) // ensure parent
    }

    try {
      const data = await fs.readFile(localPath) // read local
      await client.putFileContents('/' + nextRel, data, { overwrite: true }) // upload

      // Align local mtime to the upload moment (whole seconds) instead of
      // doing an extra PROPFIND for the server's lastmod. The server stamps
      // lastmod ≈ now at second resolution, so this stays inside TIMESTAMP_TOLERANCE
      // and avoids a per-file round-trip.
      try {
        const alignedTime = new Date(Math.floor(Date.now() / 1000) * 1000) // now, second resolution
        await fs.utimes(localPath, alignedTime, alignedTime) // align mtime
      } catch {
        console.warn(`Could not sync timestamp for ${nextRel}`) // warn
        win?.webContents?.send('sync-result', { status: 'warning', message: `Zeitstempel-Sync fehlgeschlagen: ${nextRel}` })
      }

      if (syncState) {
        const st = await fs.stat(localPath) // Post-upload metadata
        recordSyncedLocalFile(nextRel, st, syncState) // Persist fast-path fingerprint
      }

      console.log(`Uploaded: ${nextRel}`) // ok
      win?.webContents?.send('sync-result', { status: 'info', message: `Hochgeladen: ${nextRel}` })
    } catch (e) {
      if (isPermissionError(e)) { // read-only share
        const dirRel = path.posix.dirname(nextRel) || '/' // dir
        if (!readOnlyWarned.has(dirRel)) { // warn once
          readOnlyWarned.add(dirRel) // mark
          win?.webContents?.send('sync-result', { status: 'warning', message: `Kein Schreibrecht in „/${dirRel}" – Uploads werden dort übersprungen` }) // notify
        }
        console.warn(`Skipped (read-only): ${nextRel}`) // log skip
        win?.webContents?.send('sync-result', { status: 'warning', message: `Upload übersprungen (read-only): ${nextRel}` })
        return // keep going with siblings
      }
      if (isQuotaError(e)) {
        if (!stopUploadsDueToQuota.value) {
          stopUploadsDueToQuota.value = true
          console.warn('Server storage exhausted (507). Skipping remaining uploads this cycle.')
          win?.webContents?.send('sync-result', { status: 'warning', message: 'Server-Speicher erschöpft (507) – restliche Uploads werden übersprungen' })
        }
        return
      }
      console.error(`Error uploading ${nextRel}:`, e?.message) // other error
      win?.webContents?.send('sync-result', { status: 'warning', message: `Upload fehlgeschlagen: ${nextRel}` })
      return // keep going with siblings
    }
  } else if (syncState) {
    recordSyncedLocalFile(nextRel, localStats, syncState) // No upload needed; cache for next Sync Up
  }
}

// Upload function with permission checks. Files within a directory are processed
// with bounded concurrency (UPLOAD_CONCURRENCY) so per-file PROPFINDs run in parallel;
// subdirectories are still walked sequentially to avoid opening the whole tree at once.
async function uploadDir(client, localRoot, rel, readOnlyWarned = new Set(), stopUploadsDueToQuota = { value: false }, syncState = null) {
  try {
    const absDir = path.join(localRoot, rel) // local dir
    const entries = await fs.readdir(absDir, { withFileTypes: true }) // list

    const fileRels = [] // Files in this directory, processed in parallel below
    const dirRels = [] // Subdirectories, recursed sequentially after files

    for (const e of entries) {
      if (shouldExcludePath(e.name)) continue // skip excluded files
      const nextRel = path.posix.join(rel, e.name) // POSIX rel
      if (shouldSkipEntry(nextRel, e.isDirectory())) continue // skip folders outside the selection entirely
      if (e.isDirectory()) dirRels.push(nextRel)
      else fileRels.push(nextRel)
    }

    await runWithConcurrency(fileRels, UPLOAD_CONCURRENCY, async (nextRel) => {
      if (stopUploadsDueToQuota.value) return // short-circuit uploads for this cycle
      try {
        await uploadFile(client, localRoot, nextRel, readOnlyWarned, stopUploadsDueToQuota, syncState)
      } catch (e) {
        console.error(`Error processing ${nextRel}:`, e?.message) // per-entry error
      }
    })

    for (const nextRel of dirRels) {
      if (stopUploadsDueToQuota.value) break // short-circuit uploads for this cycle
      try {
        await uploadDir(client, localRoot, nextRel, readOnlyWarned, stopUploadsDueToQuota, syncState) // recurse
      } catch (e) {
        if (!isNetworkError(e)) console.error(`Error processing ${nextRel}:`, e?.message) // per-entry error
        else throw e // bubble network errors to adjust backoff
      }
    }
  } catch (e) {
    if (!isNetworkError(e)) console.error(`Error uploading dir ${rel}:`, e?.message) // non-network
    throw e // bubble to adjust backoff
  }
}

// Simplified shouldUpload function
async function shouldUpload(client, localPath, remotePath, localStats = null) {
  try {
    const localSt = localStats ?? await fs.stat(localPath) // Local stat (reuse when already read)
    const remoteStats = await client.stat(remotePath) // Remote stat
    const remoteTime = new Date(remoteStats.lastmod) // Remote mtime
    const localTime = new Date(localSt.mtime) // Local mtime
    const timeDiff = localTime.getTime() - remoteTime.getTime() // Positive if local newer

    return timeDiff > TIMESTAMP_TOLERANCE // Upload if local is newer
  } catch {
    return true // Remote missing → upload
  }
}

// ---------- Helpers ----------
async function ensureRemoteDir(client, posixDir) {
  if (!posixDir || posixDir === '/' || posixDir === '.') return // Guard
  const parts = posixDir.split('/').filter(Boolean) // Components
  let cur = '' // Accumulator
  for (const p of parts) {
    cur += '/' + p // Build path
    try { await client.stat(cur) } // Exists
    catch { try { await client.createDirectory(cur) } catch (e) { console.warn(`Could not create dir ${cur}:`, e?.message) } } // Create
  }
}