import { app, BrowserWindow, dialog, Menu } from 'electron'
import path from 'node:path'
import { setupIpc } from './ipc'

// Raise V8 heap limit to 4 GB for large scans (e.g. full C:\)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096')

const isDev = process.env.NODE_ENV === 'development'
process.env.VITE_PORT = process.env.VITE_PORT || '5173'

const iconPath = isDev
  ? path.join(process.cwd(), 'assets', 'icon.png')
  : path.join(process.resourcesPath, 'icon.png')

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  // Native menu bar
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Reset Database...',
          click: () => win.webContents.send('menu-reset-db')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About LargeFileBuster',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'About LargeFileBuster',
              message: 'LargeFileBuster',
              detail: [
                `Version ${require('../../package.json').version}`,
                '',
                'By Stanislaw Koltschin <stan.the.maker@koltschin.net>',
                '',
                'Find and manage large files on your drives.',
                '',
                'Licensed under the European Union Public Licence (EUPL) v1.2.',
                '',
                'Open-source components:',
                '  • Electron 35 — MIT License',
                '  • React 18 — MIT License',
                '  • sql.js 1.9 (SQLite via WebAssembly) — MIT License',
                '  • Vite 5 — MIT License',
                '  • Playwright (testing) — Apache 2.0',
                '  • Chromium — BSD 3-Clause License',
              ].join('\n'),
              buttons: ['OK']
            })
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  if (isDev) {
    win.loadURL(`http://localhost:${process.env.VITE_PORT}`)
    win.webContents.openDevTools({ mode: 'bottom' })
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  setupIpc(win)
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
