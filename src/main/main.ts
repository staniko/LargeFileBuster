import { app, BrowserWindow, dialog, Menu, session } from 'electron'
import path from 'node:path'
import { setupIpc } from './ipc'
import {
  APP_ENTRY_URL,
  hardenSession,
  hardenWebContents,
  isDev,
  registerAppProtocol,
  registerAppScheme
} from './security'

// Raise the V8 heap limit for renderer processes. Switches appended here only
// reach child processes, so nothing that weakens the renderer (such as
// --expose-gc) belongs in this list.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096')

// Every renderer runs in the Chromium sandbox, whatever a window asks for.
app.enableSandbox()

// The UI is served from app://lfb/ instead of file://.
registerAppScheme()

// Applies to every window this app will ever create.
app.on('web-contents-created', (_event, contents) => hardenWebContents(contents))

const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(app.getAppPath(), 'assets', 'icon.png')

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false
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
                `Version ${app.getVersion()}`,
                '',
                'By Stanislaw Koltschin <stan.the.maker@koltschin.net>',
                '',
                'Find and manage large files on your drives.',
                '',
                'Licensed under the European Union Public Licence (EUPL) v1.2.',
                '',
                'Open-source components:',
                `  • Electron ${process.versions.electron} — MIT License`,
                `  • Chromium ${process.versions.chrome} — BSD 3-Clause License`,
                '  • React — MIT License',
                '  • sql.js (SQLite via WebAssembly) — MIT License',
                '  • Vite — MIT License',
                '  • Playwright (testing) — Apache 2.0'
              ].join('\n'),
              buttons: ['OK']
            })
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  win.loadURL(APP_ENTRY_URL)
  if (isDev) {
    win.webContents.openDevTools({ mode: 'bottom' })
  }
}

app.whenReady().then(() => {
  hardenSession(session.defaultSession)
  if (!isDev) {
    registerAppProtocol(path.join(__dirname, '../renderer'))
  }
  setupIpc()

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
