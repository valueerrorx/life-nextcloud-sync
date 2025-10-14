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
const stateFile = path.join(localRoot, '.sync-state.json') // Path for sync state

let win // BrowserWindow ref
let tray // Tray ref
let client // WebDAV client
let syncTimer = null // Interval handle
let isSyncing = false // Re-entrancy lock
let isConnected = false // Network flag
let consecutiveErrors = 0 // Error counter
let baseInterval = null // Minutes
let currentInterval = null // Minutes
let skipRemoteDeletionOnce = null // one-cycle debounce for remote deletions
let readOnlyWarned = new Set() // remember warned dirs per session



const MAX_CONSECUTIVE_ERRORS = 3 // Backoff threshold
const BACKOFF_MULTIPLIER = 2 // Exponential factor
const TIMESTAMP_TOLERANCE = 5000 // 5s tolerance

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
    height: 680, // Height
    icon: path.join(__dirname, 'icon.png'), // Icon
    webPreferences:{ preload: path.join(__dirname, 'preload.js') } // Preload script
  })

  win.loadFile('index.html') // Load UI
  win.removeMenu() // Hide menu

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

ipcMain.handle('login', async (event, { server, username, password, interval }) => {
  if (syncTimer) clearInterval(syncTimer) // Prevent duplicate timers
  syncTimer = null // Reset timer ref
  isSyncing = false // Reset lock

  const base = `${server.replace(/\/+$/,'')}/remote.php/dav/files/${encodeURIComponent(username)}/` // Base URL
  client = createClient(base, { username, password }) // Create client

  try {
    await client.getDirectoryContents('/') // Probe root
    isConnected = true // Mark connected
    consecutiveErrors = 0 // Reset errors
    baseInterval = interval // Store base
    currentInterval = interval // Store current
    event.sender.send('login-result', { status:'ok', message:'Login erfolgreich, Sync startet' }) // Notify UI
    if (!fssync.existsSync(localRoot)) fssync.mkdirSync(localRoot,{recursive:true}) // Ensure local root
    setImmediate(() => startSync()) // Start loop
    return { status:'sync-loop-started' } // Ack
  } catch (e) {
    isConnected = false // Mark disconnected
    const msg = e?.message || 'Login fehlgeschlagen' // Message
    console.error('Login error:', msg) // Log
    event.sender.send('login-result', { status:'error', message: msg }) // Notify UI
    return { status:'failed' } // Ack
  }
})

ipcMain.handle('logout', async () => {
  if (syncTimer) clearInterval(syncTimer) // Stop loop
  syncTimer = null // Reset timer
  client = null // Drop client
  isConnected = false // Reset state
  isSyncing = false // Reset lock
  consecutiveErrors = 0 // Reset errors
  console.log('Logged out, sync stopped') // Log
  return { status: 'logged-out' } // Ack
})

ipcMain.handle('retry-sync', async () => {
  if (!client) return { status: 'no-client' } // Guard
  consecutiveErrors = 0 // Reset errors
  currentInterval = baseInterval // Reset interval
  if (syncTimer) clearInterval(syncTimer) // Clear timer
  syncTimer = null // Reset timer ref
  isSyncing = false // Reset lock
  await startSync() // Restart
  return { status: 'restarted' } // Ack
})

async function startSync() {
  if (!client) return // Guard against missing client
  await performSync() // Immediate sync

  syncTimer = setInterval(() => { // Periodic sync
    performSync().catch(e => console.error('Unhandled sync error:', e?.message)) // Safety catch
  }, currentInterval * 60 * 1000) // Minutes → ms
}

// ---------- Confirmation helper ----------
async function confirmMassDeletion(title, count, preview) {
  const detailList = preview.map(p => `• ${p}`).join('\n') // Build preview lines
  const { response, checkboxChecked } = await dialog.showMessageBox(win ?? null, { // Show modal
    type: 'warning', // Warning dialog
    buttons: ['Abbrechen', 'Fortfahren'], // Buttons
    defaultId: 0, // Default to cancel
    cancelId: 0, // Esc cancels
    title, // Title
    message: `${count} Dateien werden gelöscht. Fortfahren?`, // Short message
    detail: detailList.length ? `Beispiele:\n${detailList}` : undefined, // Show first items
    noLink: true // Native button style
  })
  return response === 1 // true if "Fortfahren"
}


function isPermissionError(error) { // detect read-only/permission issues
  const s = error?.response?.status || 0 // HTTP status
  return s === 401 || s === 403 || s === 405 || s === 423 // typical WebDAV perms
}



// ---------- Main sync pipeline ----------
// performSync: DO NOT abort when user cancels remote deletion; continue with upload/download
async function performSync() {
    if (isSyncing) { console.log('Sync already running, skipping'); return }
    isSyncing = true
    
    // Notify frontend that sync is starting
    win?.webContents?.send('sync-start')
    
    try {
      await reconcileRemoteDeletions(client, localRoot) // may skip applying but never blocks
      await fullUpload(client, localRoot) // push
      await fullDownload(client, localRoot) // pull
      isConnected = true
      consecutiveErrors = 0
      if (currentInterval !== baseInterval) {
        currentInterval = baseInterval
        if (syncTimer) clearInterval(syncTimer)
        syncTimer = setInterval(() => { performSync().catch(e => console.error('Unhandled sync error:', e?.message)) }, currentInterval * 60 * 1000)
        console.log(`Connection restored, sync interval reset to ${currentInterval}min`)
        win?.webContents?.send('sync-result', { status: 'info', message: `Verbindung wiederhergestellt - Sync-Intervall zurückgesetzt auf ${currentInterval}min` })
      }
      win?.webContents?.send('sync-result', { status: 'ok', message: 'Sync erfolgreich' })
    } catch (e) {
      consecutiveErrors++
      const msg = e?.message || 'Unknown error'
      const code = e?.code || ''
      console.error(`Sync failed (attempt ${consecutiveErrors}):`, msg, code)
      if (isNetworkError(e)) isConnected = false
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        currentInterval = Math.min(currentInterval * BACKOFF_MULTIPLIER, 60)
        if (syncTimer) clearInterval(syncTimer)
        syncTimer = setInterval(() => { performSync().catch(err => console.error('Unhandled sync error:', err?.message)) }, currentInterval * 60 * 1000)
        console.log(`Slowing down sync to every ${currentInterval} minutes due to errors`)
        win?.webContents?.send('sync-result', { status: 'warning', message: `Sync verlangsamt auf ${currentInterval}min aufgrund von Fehlern` })
        win?.webContents?.send('sync-result', { status: 'warning', message: `Verbindungsprobleme - Sync verlangsamt auf ${currentInterval}min` })
      } else {
        win?.webContents?.send('sync-result', { status: 'error', message: `Sync Fehler (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})` })
      }
    } finally {
      isSyncing = false
      skipRemoteDeletionOnce = null
    }
  }
  










function isNetworkError(error) {
  const networkCodes = ['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'] // Node codes
  const code = error?.code || '' // Code
  const status = error?.response?.status || 0 // HTTP status
  return networkCodes.includes(code) || status >= 500 || status === 423 // Treat as transient
}

app.on('before-quit', async () => { 
  if (syncTimer) clearInterval(syncTimer) // Stop loop
  syncTimer = null // Reset timer ref

  if (client && localRoot) { // Try final push
    console.log('Final upload attempt before quit...') // Log
    const uploadTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Upload timeout')), 10000)) // 10s cap
    try {
      await Promise.race([fullUpload(client, localRoot), uploadTimeout]) // Race upload vs timeout
      console.log('Final upload completed') // Log
    } catch (e) {
      console.error('Final upload failed:', e?.message) // Log
    }
  }
})

// ---------- Download ----------
async function fullDownload(client, localRoot) {
  console.log('Syncing from Nextcloud to local...') // Log
  win?.webContents?.send('sync-result', { status: 'info', message: 'Download von Nextcloud...' })
  await downloadDir(client, '', localRoot) // Recurse root
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





async function shouldDownload(localPath, remoteItem) {
  try {
    const localStats = await fs.stat(localPath) // Local stat
    const remoteTime = new Date(remoteItem.lastmod) // Remote time
    const localTime = new Date(localStats.mtime) // Local time
    const timeDiff = remoteTime.getTime() - localTime.getTime() // Positive if remote newer

    if (timeDiff > TIMESTAMP_TOLERANCE) {
      const conflictName = await generateConflictName(localPath, 'remote') // Conflict name
      const buf = await client.getFileContents(remoteItem.filename) // Read remote
      await fs.writeFile(conflictName, buf) // Save conflict copy
      console.log(`Conflict: saved remote version as ${path.basename(conflictName)}`) // Log
      win?.webContents?.send('sync-result', { status: 'warning', message: `Konflikt: Remote-Version als ${path.basename(conflictName)} gespeichert` })
      return false // Keep local (local wins)
    }
    return false // Similar or local newer
  } catch {
    return true // Local missing → download
  }
}




// FULL FUNCTION (modified): handles read-only errors in delete loop
async function fullUpload(client, localRoot) {
  console.log('Syncing from local to Nextcloud...') // log
  win?.webContents?.send('sync-result', { status: 'info', message: 'Upload zu Nextcloud...' })
  const state = await loadSyncState() // load state
  const localPaths = new Set() // current local files
  await uploadDir(client, localRoot, '', localPaths) // walk & upload

  const toDelete = [] // files vanished locally
  for (const knownPath in state.knownFiles) {
    if (!localPaths.has(knownPath) && !shouldExcludePath(knownPath)) toDelete.push(knownPath) // collect
  }

  if (toDelete.length > 0) { // confirm remote deletes
    const proceed = await confirmMassDeletion('Lokale Löschung erkannt', toDelete.length, toDelete.slice(0, 10)) // ask
    if (!proceed) return // skip deletes
  }

  for (const knownPath of toDelete) { // attempt remote delete
    try {
      await client.deleteFile('/' + knownPath) // delete
      console.log(`Deleted on remote: ${knownPath}`) // log
      win?.webContents?.send('sync-result', { status: 'info', message: `Remote gelöscht: ${knownPath}` })
      delete state.knownFiles[knownPath] // update state
    } catch (e) {
      if (isPermissionError(e)) { // read-only share
        const dirRel = path.posix.dirname(knownPath) || '/' // dir
        if (!readOnlyWarned.has(dirRel)) { // warn once per dir
          readOnlyWarned.add(dirRel) // remember
          win?.webContents?.send('sync-result', { status: 'warning', message: `Kein Schreibrecht in „/${dirRel}“ – Remote-Löschungen werden dort übersprungen` }) // notify
        }
        console.warn(`Skip remote delete (read-only): ${knownPath}`) // warn
        win?.webContents?.send('sync-result', { status: 'warning', message: `Remote-Löschung übersprungen (read-only): ${knownPath}` })
        continue // keep syncing
      }
      console.warn(`Could not delete remote ${knownPath}:`, e?.message) // other error
      win?.webContents?.send('sync-result', { status: 'warning', message: `Remote-Löschung fehlgeschlagen: ${knownPath}` })
    }
  }

  state.knownFiles = {} // refresh known files
  for (const p of localPaths) state.knownFiles[p] = true // record
  await saveSyncState(state) // persist
}








// FULL FUNCTION (modified): skips uploads on 401/403/405/423, warns once per dir
async function uploadDir(client, localRoot, rel, localPaths) {
  try {
    const absDir = path.join(localRoot, rel) // local dir
    const entries = await fs.readdir(absDir, { withFileTypes: true }) // list

    for (const e of entries) {
      try {
        if (shouldExcludePath(e.name)) continue // skip excluded files
        const nextRel = path.posix.join(rel, e.name) // POSIX rel

        if (e.isDirectory()) {
          await uploadDir(client, localRoot, nextRel, localPaths) // recurse
        } else {
          localPaths.add(nextRel) // remember file
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
                  win?.webContents?.send('sync-result', { status: 'warning', message: `Kein Schreibrecht in „/${dirRel}“ – Uploads werden dort übersprungen` }) // notify
                }
                console.warn(`Skipped (read-only): ${nextRel}`) // log skip
                win?.webContents?.send('sync-result', { status: 'warning', message: `Upload übersprungen (read-only): ${nextRel}` })
                continue // keep loop
              }
              console.error(`Error uploading ${nextRel}:`, e?.message) // other error
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

  

async function shouldUpload(client, localPath, remotePath) {
  try {
    const localStats = await fs.stat(localPath) // Local stat
    const remoteStats = await client.stat(remotePath) // Remote stat
    const remoteTime = new Date(remoteStats.lastmod) // Remote mtime
    const localTime = new Date(localStats.mtime) // Local mtime
    const timeDiff = localTime.getTime() - remoteTime.getTime() // Positive if local newer

    if (timeDiff > TIMESTAMP_TOLERANCE) return true // Local newer
    if (timeDiff < -TIMESTAMP_TOLERANCE) { // Remote newer → local wins, backup remote
      try {
        const backupPath = await generateRemoteConflictName(remotePath) // Backup path
        await client.copyFile(remotePath, backupPath) // Backup
        console.log(`Conflict: backed up remote to ${backupPath}`) // Log
        win?.webContents?.send('sync-result', { status: 'warning', message: `Konflikt: Remote-Backup erstellt: ${backupPath}` })
      } catch (e) { 
        console.warn(`Could not backup remote file:`, e?.message) // Warn
        win?.webContents?.send('sync-result', { status: 'warning', message: 'Remote-Backup fehlgeschlagen' })
      }
      return true // Upload local anyway
    }
    return false // Similar
  } catch {
    return true // Remote missing → upload
  }
}

// collects remote files AND dirs (POSIX)
async function collectRemoteTree(client) {
    const files = new Set(), dirs = new Set() // remote snapshot
    async function walk(rel) {
      const list = await client.getDirectoryContents('/' + rel)
      for (const item of list) {
        const relPath = item.filename.replace(/^\//, '')
        if (shouldExcludePath(relPath)) continue
        if (item.type === 'directory') { dirs.add(relPath); await walk(relPath) } else { files.add(relPath) }
      }
    }
    await walk('')
    return { files, dirs }
  }
  
  


// collects local directories (POSIX), excluding root
async function collectLocalDirs(localRoot) {
    const result = new Set()
    async function walk(abs, rel) {
      const entries = await fs.readdir(abs, { withFileTypes: true })
      for (const e of entries) {
        if (shouldExcludePath(e.name)) continue
        if (e.isDirectory()) { const nextRel = path.posix.join(rel, e.name); result.add(nextRel); await walk(path.join(abs, e.name), nextRel) }
      }
    }
    await walk(localRoot, '')
    return result
  }
  



// applies remote deletions locally (files + dirs) with single confirmation per sync
async function reconcileRemoteDeletions(client, localRoot) {
    const state = await loadSyncState() // previous known files
    const { files: remoteFiles, dirs: remoteDirs } = await collectRemoteTree(client) // remote snapshot
  
    // files missing on remote
    const toDeleteLocalFiles = []
    for (const knownPath in state.knownFiles) {
      if (!remoteFiles.has(knownPath) && !shouldExcludePath(knownPath)) {
        try { await fs.stat(path.join(localRoot, knownPath)); toDeleteLocalFiles.push(knownPath) } catch {}
      }
    }
  
    // dirs missing on remote
    const localDirsNow = await collectLocalDirs(localRoot)
    const toDeleteLocalDirs = [...localDirsNow].filter(d => !remoteDirs.has(d))
  
    const totalCount = toDeleteLocalFiles.length + toDeleteLocalDirs.length
    if (totalCount > 0) {
      const fp = JSON.stringify({
        f: [...toDeleteLocalFiles].sort(), // stable fingerprint
        d: [...toDeleteLocalDirs].sort()
      })
  
      if (skipRemoteDeletionOnce === fp) {
        // same set in this cycle → skip asking once, do nothing this round
      } else {
        const preview = [...toDeleteLocalDirs.slice(0, 5), ...toDeleteLocalFiles.slice(0, 5)]
        const proceed = await confirmMassDeletion('Remote Löschung erkannt', totalCount, preview) // ask user
        if (!proceed) { skipRemoteDeletionOnce = fp; return } // remember for this cycle, continue sync
        // proceed: apply deletions now
        for (const relPath of toDeleteLocalFiles) {
          try { 
            await fs.unlink(path.join(localRoot, relPath)); delete state.knownFiles[relPath]; 
            console.log(`Deleted locally (remote removed file): ${relPath}`)
            win?.webContents?.send('sync-result', { status: 'info', message: `Lokal gelöscht (Remote entfernt): ${relPath}` })
          }
          catch (e) { 
            console.warn(`Could not delete local file ${relPath}:`, e?.message)
            win?.webContents?.send('sync-result', { status: 'warning', message: `Lokale Datei-Löschung fehlgeschlagen: ${relPath}` })
          }
        }
        toDeleteLocalDirs.sort((a,b) => b.split('/').length - a.split('/').length)
        for (const dirRel of toDeleteLocalDirs) {
          try { 
            await pruneEmptyDirTree(localRoot, dirRel); 
            console.log(`Deleted locally (remote removed dir): ${dirRel}`)
            win?.webContents?.send('sync-result', { status: 'info', message: `Lokales Verzeichnis gelöscht (Remote entfernt): ${dirRel}` })
          }
          catch (e) { 
            console.warn(`Could not delete local dir ${dirRel}:`, e?.message)
            win?.webContents?.send('sync-result', { status: 'warning', message: `Lokale Verzeichnis-Löschung fehlgeschlagen: ${dirRel}` })
          }
        }
        await saveSyncState(state) // persist updated knownFiles
      }
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



// helper: stable fingerprint for a deletion set
function deletionFingerprint(files, dirs) { // create stable id
    const f = [...files].sort()
    const d = [...dirs].sort()
    return JSON.stringify({ f, d })
  }
  






// removes a dir if empty, then prunes empty parents up to localRoot
async function pruneEmptyDirTree(localRoot, relDir) {
    let cur = path.join(localRoot, relDir)
    const root = path.resolve(localRoot)
    while (cur.startsWith(root)) {
      try {
        const entries = await fs.readdir(cur)
        if (entries.length === 0) { await fs.rmdir(cur); const next = path.dirname(cur); if (next === cur) break; cur = next; continue }
        break
      } catch { break }
    }
  }
  


// prune empty parent directories after deleting a file
async function removeEmptyParentDirs(localRoot, relFilePath) {
    let cur = path.join(localRoot, path.posix.dirname(relFilePath)) // start at parent dir
    const root = path.resolve(localRoot) // normalize root
    while (cur.startsWith(root)) { // climb up while inside root
      try {
        const entries = await fs.readdir(cur) // list current dir
        if (entries.length === 0) {
          await fs.rm(cur, { recursive: false, force: true }) // remove empty dir
          const next = path.dirname(cur) // go up
          if (next === cur) break // safety
          cur = next // continue upwards
          continue
        }
        break // stop if not empty
      } catch {
        break // stop on error/nonexistent
      }
    }
  }
  
  

async function generateConflictName(filePath, suffix) {
  const dir = path.dirname(filePath) // Dir
  const ext = path.extname(filePath) // Ext
  const base = path.basename(filePath, ext) // Base
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) // ISO-like
  let counter = 0 // Suffix counter
  let newPath = path.join(dir, `${base}.conflict-${suffix}-${timestamp}${ext}`) // Candidate
  while (fssync.existsSync(newPath)) { counter++; newPath = path.join(dir, `${base}.conflict-${suffix}-${timestamp}-${counter}${ext}`) } // Ensure unique
  return newPath // Unique path
}

async function generateRemoteConflictName(remotePath) {
  const dir = path.posix.dirname(remotePath) // POSIX dir
  const ext = path.posix.extname(remotePath) // POSIX ext
  const base = path.posix.basename(remotePath, ext) // POSIX base
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) // ISO-like
  return path.posix.join(dir, `${base}.conflict-remote-${timestamp}${ext}`) // POSIX-safe name
}

async function loadSyncState() {
    try {
      const raw = await fs.readFile(stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      return { knownFiles: parsed.knownFiles && typeof parsed.knownFiles === 'object' ? parsed.knownFiles : {} }
    } catch { return { knownFiles: {} } }
  }
  
  async function saveSyncState(state) {
    try {
      await fs.mkdir(path.dirname(stateFile), { recursive: true })
      await fs.writeFile(stateFile, JSON.stringify({ knownFiles: state.knownFiles || {} }, null, 2), 'utf8')
    } catch (e) { console.warn('Could not save sync state:', e?.message) }
  }
  
