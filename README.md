# Nextcloud Sync Client

A lightweight Electron-based desktop application that provides background synchronization with a Nextcloud server.  
Users can log in with their server URL, username, and password, and the app automatically mirrors files to a local folder (`~/Nextcloud-Temp`).

## Features

- 🚀 Simple login form with immediate feedback on connection success or failure  
- 🔄 Automatic background synchronization every 5 minutes  
- 🗂️ Local directory created in the user’s home folder  
- ⚡ Smart file handling: only uploads/downloads files if they are newer locally or on the server  
- 💬 Status messages and UI feedback integrated in the frontend  

## Installation

```bash
git clone git@github.com:valueerrorx/life-nextcloud-sync.git
cd life-nextcloud-sync
npm install
npm run dev / npm run build

# technologies used
* electron
* electron-builder
* node
* bootstrap
* webdav




![screenshot](/ui.png)




