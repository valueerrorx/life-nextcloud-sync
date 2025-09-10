import { app, BrowserWindow, ipcMain, Tray, Menu } from 'electron'

import os from 'os'
import { createClient } from 'webdav'                      // WebDAV Client
import fs from 'fs/promises'                               // FS async
import fssync from 'fs'                                    // FS sync (mkdirp exists)
import path from 'path'
import { fileURLToPath } from 'url'



const __filename = fileURLToPath(import.meta.url)  // current file path
const __dirname = path.dirname(__filename)        // current dir
const localRoot = path.join(os.homedir(), 'Nextcloud-Temp')  // user home dir

let win
let tray
let client
let syncTimer = null                                       // interval handle

function createWindow() {
  win = new BrowserWindow({
    title: "My Electron App",
    width: 600,
    height: 680,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences:{  
      preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadFile('index.html')
  win.removeMenu()
  //win.webContents.openDevTools()

  win.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault()
      win.hide()
    }
  })
}

function createTray() {
    tray = new Tray(path.join(__dirname, 'trayicon.png'))  // absolute path now
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show App', click: () => win.show() },
        { label: 'Quit', click: () => {
            app.isQuiting = true
            app.quit()
        }
        }
    ])
    tray.setToolTip('My Electron App')
    tray.setContextMenu(contextMenu)
    tray.on('click', () => {
        if (win.isVisible()) {
            win.hide()   // toggle
        } else {
         win.show()
        }
    })
}

app.whenReady().then(() => {
  createWindow()
  createTray()
})




/**
 * NEXTCLOUD LOGIN
 * startet den nextcloud daemon prozess
 * nextcloud-desktop muss installiert sein
 */



ipcMain.handle('login', async (event, { server, username, password, interval }) => {
  
    const base = `${server.replace(/\/+$/,'')}/remote.php/dav/files/${encodeURIComponent(username)}/`
    client = createClient(base, { username, password })

    try {
        await client.getDirectoryContents('/')  // nur Login testen
        event.sender.send('login-result', { status:'ok', message:'Login erfolgreich, Sync startet' })
        
        if (!fssync.existsSync(localRoot)) fssync.mkdirSync(localRoot,{recursive:true})

        // Sync asynchron starten → blockiert UI nicht
        setImmediate(() => startSync(client, localRoot, interval))

        return { status:'sync-loop-started' }
    } 
    catch (e) {
        event.sender.send('login-result', { status:'error', message: e?.message || 'Login fehlgeschlagen' })
        return { status:'failed' }   // kein Sync starten
    }
})

// eigene Sync-Funktion
async function startSync(client, localRoot, interval) {
    try {
        await fullDownload(client, localRoot)
        await fullUpload(client, localRoot)
        syncTimer = setInterval(async () => {
            try {
                await fullDownload(client, localRoot)
                await fullUpload(client, localRoot)
            } catch (e) { console.error('Interval sync failed:', e?.message) }
        }, interval * 60 * 1000)
    } catch (e) {
        console.error('Initial sync failed:', e?.message)
    }
}






app.on('before-quit', async () => { 
    if (syncTimer) clearInterval(syncTimer)
    if (client && localRoot) await fullUpload(client, localRoot)
}) 



// -------- helpers (optimized sync with timestamp tolerance) --------

const TIMESTAMP_TOLERANCE = 2000 // 2 seconds tolerance for timestamp differences

async function fullDownload(client, localRoot) {
    console.log('Syncing from Nextcloud to local...')
    await downloadDir(client, '', localRoot)                    // recursive download
}

async function downloadDir(client, remoteRel, localRoot) {
    const list = await client.getDirectoryContents('/' + remoteRel) // list current dir
    for (const item of list) {
        const rel = item.filename.replace(/^\//,'')               // normalize
        const abs = path.join(localRoot, rel)                     // local path
        if (item.type === 'directory') {
            await fs.mkdir(abs, { recursive: true })                // ensure local dir
            await downloadDir(client, rel, localRoot)               // recurse
        } else {
            // Only download if remote version is significantly newer
            if (await isRemoteNewer(client, rel, abs, item)) {
                const buf = await client.getFileContents('/' + rel)     // get file
                await fs.mkdir(path.dirname(abs), { recursive: true })  // ensure parent
                await fs.writeFile(abs, buf)                            // overwrite file
                
                // Set local file timestamp to match remote timestamp to prevent loops
                const remoteTime = new Date(item.lastmod)
                await fs.utimes(abs, remoteTime, remoteTime)
                
                console.log(`Downloaded newer remote file: ${rel}`)
            }
        }
    }
}

async function fullUpload(client, localRoot) {
    console.log('Syncing from local to Nextcloud...')
    await uploadDir(client, localRoot, '')                      // recursive upload
}

async function uploadDir(client, localRoot, rel) {
    const absDir = path.join(localRoot, rel)                    // current local dir
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    for (const e of entries) {
        const nextRel = path.posix.join(rel, e.name)              // posix path on DAV
        if (e.isDirectory()) {
            await ensureRemoteDir(client, '/' + nextRel)            // ensure remote dir
            await uploadDir(client, localRoot, nextRel)             // recurse
        } else {
            // Only upload if local version is significantly newer
            if (await isLocalNewer(client, nextRel, path.join(localRoot, nextRel))) {
                const localPath = path.join(localRoot, nextRel)
                const data = await fs.readFile(localPath) // read local file
                await client.putFileContents('/' + nextRel, data, { overwrite: true }) // overwrite
                
                // Get remote timestamp after upload and sync local timestamp
                try {
                    const remoteStats = await client.stat('/' + nextRel)
                    const remoteTime = new Date(remoteStats.lastmod)
                    await fs.utimes(localPath, remoteTime, remoteTime)
                } catch (error) {
                    console.warn(`Could not sync timestamp for ${nextRel}:`, error.message)
                }
                
                console.log(`Uploaded newer local file: ${nextRel}`)
            }
        }
    }
}

// Check if remote file is significantly newer than local file
async function isRemoteNewer(client, remotePath, localPath, remoteItem) {
    try {
        const localStats = await fs.stat(localPath)
        const remoteLastModified = new Date(remoteItem.lastmod)
        const localLastModified = new Date(localStats.mtime)
        
        // Remote is newer if its modification time is significantly after local modification time
        const timeDiff = remoteLastModified.getTime() - localLastModified.getTime()
        return timeDiff > TIMESTAMP_TOLERANCE
    } catch (error) {
        // Local file doesn't exist, remote is "newer"
        return true
    }
}

// Check if local file is significantly newer than remote file
async function isLocalNewer(client, remotePath, localPath) {
    try {
        const localStats = await fs.stat(localPath)
        const remoteStats = await client.stat('/' + remotePath)
        const remoteLastModified = new Date(remoteStats.lastmod)
        const localLastModified = new Date(localStats.mtime)
        
        // Local is newer if its modification time is significantly after remote modification time
        const timeDiff = localLastModified.getTime() - remoteLastModified.getTime()
        return timeDiff > TIMESTAMP_TOLERANCE
    } catch (error) {
        // Remote file doesn't exist, local is "newer"
        return true
    }
}

async function ensureRemoteDir(client, posixDir) {
    if (!posixDir || posixDir === '/' || posixDir === '.') return // nothing
    const parts = posixDir.split('/').filter(Boolean)         // split by /
    let cur = ''
    for (const p of parts) {
        cur += '/' + p
        try { await client.stat(cur) } catch { await client.createDirectory(cur) } // mkdir -p on DAV
    }
}