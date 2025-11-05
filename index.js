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

ipcMain.handle('login', async (event, { server, username, password }) => {
  isSyncing = false // Reset lock

  const base = `${server.replace(/\/+$/,'')}/remote.php/dav/files/${encodeURIComponent(username)}/` // Base URL
  client = createClient(base, { username, password }) // Create client

  try {
    await client.getDirectoryContents('/') // Probe root
    isConnected = true // Mark as connected
    event.sender.send('login-result', { status:'ok', message:'Login erfolgreich, initialer Sync startet' }) // Notify UI
    if (!fssync.existsSync(localRoot)) fssync.mkdirSync(localRoot,{recursive:true}) // Ensure local root
    
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

// Initial sync function - overwrites local files without warning
async function performInitialSyncDown() {
  if (isSyncing) { console.log('Sync already running, skipping'); return }
  isSyncing = true
  
  win?.webContents?.send('sync-start')
  
  try {
    console.log('Initial sync from Nextcloud to local...')
    win?.webContents?.send('sync-result', { status: 'info', message: 'Initialer Download von Nextcloud...' })
    await downloadDirForce(client, '', localRoot)
    console.log('✅ Initialer Sync abgeschlossen')
    win?.webContents?.send('sync-result', { status: 'ok', message: 'Initialer Sync abgeschlossen' })
  } catch (e) {
    const msg = e?.message || 'Unknown error'
    console.error('Initial sync failed:', msg)
    win?.webContents?.send('sync-result', { status: 'error', message: `Initialer Sync Fehler: ${msg}` })
    throw e
  } finally {
    isSyncing = false
  }
}

// Regular sync down function - only downloads newer files
async function performSyncDown() {
  if (isSyncing) { console.log('Sync already running, skipping'); return }
  isSyncing = true
  
  win?.webContents?.send('sync-start')
  
  try {
    console.log('Syncing from Nextcloud to local...')
    win?.webContents?.send('sync-result', { status: 'info', message: 'Download von Nextcloud...' })
    await downloadDir(client, '', localRoot)
    console.log('✅ Sync Down (Server → Client) abgeschlossen')
    win?.webContents?.send('sync-result', { status: 'ok', message: 'Sync Down erfolgreich' })
  } catch (e) {
    const msg = e?.message || 'Unknown error'
    console.error('Sync down failed:', msg)
    win?.webContents?.send('sync-result', { status: 'error', message: `Sync Down Fehler: ${msg}` })
    throw e
  } finally {
    isSyncing = false
  }
}

async function performSyncUp() {
  if (isSyncing) { console.log('Sync already running, skipping'); return }
  isSyncing = true
  
  win?.webContents?.send('sync-start')
  
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
    
    await uploadDir(client, localRoot, '', new Set(), { value: false })
    console.log('✅ Sync Up (Client → Server) abgeschlossen')
    win?.webContents?.send('sync-result', { status: 'ok', message: 'Sync Up erfolgreich' })
  } catch (e) {
    const msg = e?.message || 'Unknown error'
    console.error('Sync up failed:', msg)
    win?.webContents?.send('sync-result', { status: 'error', message: `Sync Up Fehler: ${msg}` })
    throw e
  } finally {
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

// Force download function - overwrites local files without checking timestamps
async function downloadDirForce(client, remoteRel, localRoot) {
  try {
    const list = await client.getDirectoryContents('/' + remoteRel) // List dir
    for (const item of list) {
      try {
        const rel = item.filename.replace(/^\//,'') // Normalize
        if (shouldExcludePath(rel)) continue // Skip excluded files and patterns
        const abs = path.join(localRoot, rel) // Local path

        if (item.type === 'directory') {
          await fs.mkdir(abs, { recursive: true }) // Ensure dir
          await downloadDirForce(client, rel, localRoot) // Recurse
        } else {
          // Force download - always overwrite local files
          const buf = await client.getFileContents('/' + rel) // Read remote
          await fs.mkdir(path.dirname(abs), { recursive: true }) // Ensure parent
          await fs.writeFile(abs, buf) // Write file
          const remoteTime = new Date(item.lastmod) // Remote mtime
          await fs.utimes(abs, remoteTime, remoteTime) // Set mtime
          console.log(`Force downloaded: ${rel}`) // Log
          win?.webContents?.send('sync-result', { status: 'info', message: `Heruntergeladen: ${rel}` })
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

async function downloadDir(client, remoteRel, localRoot) {
  try {
    const list = await client.getDirectoryContents('/' + remoteRel) // List dir
    for (const item of list) {
      try {
        const rel = item.filename.replace(/^\//,'') // Normalize
        if (shouldExcludePath(rel)) continue // Skip excluded files and patterns
        const abs = path.join(localRoot, rel) // Local path

        if (item.type === 'directory') {
          await fs.mkdir(abs, { recursive: true }) // Ensure dir
          await downloadDir(client, rel, localRoot) // Recurse
        } else {
          if (await shouldDownload(abs, item)) { // Decide
            const buf = await client.getFileContents('/' + rel) // Read remote
            await fs.mkdir(path.dirname(abs), { recursive: true }) // Ensure parent
            await fs.writeFile(abs, buf) // Write file
            const remoteTime = new Date(item.lastmod) // Remote mtime
            await fs.utimes(abs, remoteTime, remoteTime) // Set mtime
            console.log(`Downloaded: ${rel}`) // Log
            win?.webContents?.send('sync-result', { status: 'info', message: `Heruntergeladen: ${rel}` })
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

// Upload function with permission checks
async function uploadDir(client, localRoot, rel, readOnlyWarned = new Set(), stopUploadsDueToQuota = { value: false }) {
  try {
    const absDir = path.join(localRoot, rel) // local dir
    const entries = await fs.readdir(absDir, { withFileTypes: true }) // list

    for (const e of entries) {
      try {
        if (stopUploadsDueToQuota.value) { // short-circuit uploads for this cycle
          break
        }
        if (shouldExcludePath(e.name)) continue // skip excluded files
        const nextRel = path.posix.join(rel, e.name) // POSIX rel

        if (e.isDirectory()) {
          await uploadDir(client, localRoot, nextRel, readOnlyWarned, stopUploadsDueToQuota) // recurse
        } else {
          const localPath = path.join(localRoot, nextRel) // abs path

          if (await shouldUpload(client, localPath, '/' + nextRel)) { // decide upload
            const parentPosix = path.posix.dirname('/' + nextRel) // remote parent
            if (parentPosix && parentPosix !== '/' && parentPosix !== '.') {
              await ensureRemoteDir(client, parentPosix) // ensure parent
            }

            try {
              const data = await fs.readFile(localPath) // read local
              await client.putFileContents('/' + nextRel, data, { overwrite: true }) // upload

              try {
                const remoteStats = await client.stat('/' + nextRel) // remote stat
                const remoteTime = new Date(remoteStats.lastmod) // mtime
                await fs.utimes(localPath, remoteTime, remoteTime) // align mtime
              } catch { 
                console.warn(`Could not sync timestamp for ${nextRel}`) // warn
                win?.webContents?.send('sync-result', { status: 'warning', message: `Zeitstempel-Sync fehlgeschlagen: ${nextRel}` })
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
                continue // keep loop
              }
              if (isQuotaError(e)) {
                if (!stopUploadsDueToQuota.value) {
                  stopUploadsDueToQuota.value = true
                  console.warn('Server storage exhausted (507). Skipping remaining uploads this cycle.')
                  win?.webContents?.send('sync-result', { status: 'warning', message: 'Server-Speicher erschöpft (507) – restliche Uploads werden übersprungen' })
                }
                continue
              }
              console.error(`Error uploading ${nextRel}:`, e?.message) // other error
              win?.webContents?.send('sync-result', { status: 'warning', message: `Upload fehlgeschlagen: ${nextRel}` })
              continue // keep loop
            }
          }
        }
      } catch (e) {
        console.error(`Error processing ${e.name}:`, e?.message) // per-entry error
      }
    }
  } catch (e) {
    if (!isNetworkError(e)) console.error(`Error uploading dir ${rel}:`, e?.message) // non-network
    throw e // bubble to adjust backoff
  }
}

// Simplified shouldUpload function
async function shouldUpload(client, localPath, remotePath) {
  try {
    const localStats = await fs.stat(localPath) // Local stat
    const remoteStats = await client.stat(remotePath) // Remote stat
    const remoteTime = new Date(remoteStats.lastmod) // Remote mtime
    const localTime = new Date(localStats.mtime) // Local mtime
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