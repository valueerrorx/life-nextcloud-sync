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


const MAX_CONSECUTIVE_ERRORS = 3 // Backoff threshold
const BACKOFF_MULTIPLIER = 2 // Exponential factor
const TIMESTAMP_TOLERANCE = 5000 // 5s tolerance

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

app.whenReady().then(() => { createWindow(); createTray() }) // Init app

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






// ---------- Main sync pipeline ----------
// performSync: DO NOT abort when user cancels remote deletion; continue with upload/download
async function performSync() {
    if (isSyncing) { console.log('Sync already running, skipping'); return }
    isSyncing = true
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
      }
      win?.webContents?.send('sync-status', { status: 'ok', message: 'Sync erfolgreich' })
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
        win?.webContents?.send('sync-status', { status: 'warning', message: `Verbindungsprobleme - Sync verlangsamt auf ${currentInterval}min` })
      } else {
        win?.webContents?.send('sync-status', { status: 'error', message: `Sync Fehler (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})` })
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
  await downloadDir(client, '', localRoot) // Recurse root
}

async function downloadDir(client, remoteRel, localRoot) {
  try {
    const list = await client.getDirectoryContents('/' + remoteRel) // List dir
    for (const item of list) {
      try {
        const rel = item.filename.replace(/^\//,'') // Normalize
        if (rel.includes('.conflict-')) continue // Skip conflict artifacts
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
      return false // Keep local (local wins)
    }
    return false // Similar or local newer
  } catch {
    return true // Local missing → download
  }
}

// ---------- Upload (with local deletions handling) ----------
async function fullUpload(client, localRoot) {
  console.log('Syncing from local to Nextcloud...') // Log
  const state = await loadSyncState() // Load previous state
  const localPaths = new Set() // Collect current local files (POSIX)
  await uploadDir(client, localRoot, '', localPaths) // Walk & upload

  const toDelete = [] // Build delete list from knownFiles that disappeared locally
  for (const knownPath in state.knownFiles) {
    if (!localPaths.has(knownPath) && !knownPath.includes('.conflict-')) toDelete.push(knownPath) // Missing local file
  }

  if (toDelete.length > 0) { // Ask confirmation for local deletions
    const proceed = await confirmMassDeletion('Lokale Löschung erkannt', toDelete.length, toDelete.slice(0, 10)) // Confirm
    if (!proceed) return // Abort without deleting remotely
  }

  for (const knownPath of toDelete) { // Delete remote files
    try {
      await client.deleteFile('/' + knownPath) // Delete
      console.log(`Deleted on remote: ${knownPath}`) // Log
      delete state.knownFiles[knownPath] // Update state
    } catch (e) {
      console.warn(`Could not delete remote ${knownPath}:`, e?.message) // Warn
    }
  }

  state.knownFiles = {} // Refresh knownFiles to current local set
  for (const p of localPaths) state.knownFiles[p] = true // Record presence

  await saveSyncState(state) // Persist state
}





async function uploadDir(client, localRoot, rel, localPaths) {
    try {
      const absDir = path.join(localRoot, rel) // local dir
      const entries = await fs.readdir(absDir, { withFileTypes: true }) // entries
  
      for (const e of entries) {
        try {
          if (e.name.includes('.conflict-')) continue // skip conflicts
          const nextRel = path.posix.join(rel, e.name) // POSIX rel
  
          if (e.isDirectory()) {
            // do NOT create remote dir here; recurse and only create if a file is uploaded
            await uploadDir(client, localRoot, nextRel, localPaths) // recurse
          } else {
            localPaths.add(nextRel) // remember file presence
            const localPath = path.join(localRoot, nextRel) // local file
  
            if (await shouldUpload(client, localPath, '/' + nextRel)) { // decide upload
              // lazily ensure parent dir exists only when we actually upload a file
              const parentPosix = path.posix.dirname('/' + nextRel) // remote parent
              if (parentPosix && parentPosix !== '/' && parentPosix !== '.') {
                await ensureRemoteDir(client, parentPosix) // ensure parent
              }
  
              const data = await fs.readFile(localPath) // read file
              await client.putFileContents('/' + nextRel, data, { overwrite: true }) // upload
  
              try {
                const remoteStats = await client.stat('/' + nextRel) // remote stat
                const remoteTime = new Date(remoteStats.lastmod) // remote mtime
                await fs.utimes(localPath, remoteTime, remoteTime) // align mtime
              } catch { console.warn(`Could not sync timestamp for ${nextRel}`) } // warn
  
              console.log(`Uploaded: ${nextRel}`) // log
            }
          }
        } catch (e) {
          console.error(`Error processing ${e.name}:`, e?.message) // per-entry error
        }
      }
    } catch (e) {
      if (!isNetworkError(e)) console.error(`Error uploading dir ${rel}:`, e?.message) // non-network error
      throw e // bubble up
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
      } catch (e) { console.warn(`Could not backup remote file:`, e?.message) } // Warn
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
        if (relPath.includes('.conflict-')) continue
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
        if (e.name.includes('.conflict-')) continue
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
      if (!remoteFiles.has(knownPath) && !knownPath.includes('.conflict-')) {
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
          try { await fs.unlink(path.join(localRoot, relPath)); delete state.knownFiles[relPath]; console.log(`Deleted locally (remote removed file): ${relPath}`) }
          catch (e) { console.warn(`Could not delete local file ${relPath}:`, e?.message) }
        }
        toDeleteLocalDirs.sort((a,b) => b.split('/').length - a.split('/').length)
        for (const dirRel of toDeleteLocalDirs) {
          try { await pruneEmptyDirTree(localRoot, dirRel); console.log(`Deleted locally (remote removed dir): ${dirRel}`) }
          catch (e) { console.warn(`Could not delete local dir ${dirRel}:`, e?.message) }
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
  