# Nextcloud Sync Client

A lightweight Electron-based desktop application that synchronizes files with a Nextcloud server over WebDAV.  
After login, files are mirrored under `~/Nextcloud-Temp`; sync is driven by login, manual actions, and app shutdown—not by a background timer.

## Features

- 🚀 Simple login form with immediate feedback on connection success or failure  
- 🔄 **Sync timing:** initial download from the server right after successful login; manual “Sync Down” / “Sync Up” in the UI; upload on graceful shutdown (SIGTERM / SIGINT) while connected—no periodic interval in the app  
- 🗂️ Local directory created in the user’s home folder  
- ⚡ Smart file handling: uploads/downloads only when the other copy is newer (mtime comparison with a small tolerance)  
- 💬 Status messages and UI feedback integrated in the frontend  

## Installation

```bash
git clone git@github.com:valueerrorx/life-nextcloud-sync.git
cd life-nextcloud-sync
npm install
npm run dev / npm run build
```

# technologies used
* electron
* electron-builder
* node
* bootstrap
* webdav




![screenshot](/ui.png)




