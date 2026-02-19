import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ChildRequest, ScanRequest, TopRequest, ListDirEntry, ListDirResponse, ScanStatus, DriveInfo } from '../shared/types'

// Select implementation based on environment variable
const USE_NATIVE = process.env.USE_NATIVE === 'true'

let dbModule: any
let scannerModule: any

if (USE_NATIVE) {
  console.log('[LFB] Using NATIVE C++ implementation')
  dbModule = require('./db-native')
  scannerModule = require('./scanner-native')
} else {
  console.log('[LFB] Using JavaScript implementation')
  dbModule = require('./db')
  scannerModule = require('./scanner')
}

const { getChildren, getRoots, getTop, openDatabase, resetDatabase } = dbModule
const { runScan, runScanAsync, activeScans } = scannerModule

let dbHandle: any
let dbPath: string
let dbReady: Promise<void> | null = null

function ensureDb() {
  if (!dbReady) {
    dbReady = openDatabase().then((res: { db: any; dbPath: string }) => {
      dbHandle = res.db
      dbPath = res.dbPath
    })
  }
  return dbReady
}

export function setupIpc(mainWindow: BrowserWindow) {
  ensureDb()

  /* ---- DB queries ---- */

  ipcMain.handle('children', async (_event, req: ChildRequest) => {
    await ensureDb()
    const parent = req.parent ?? null
    const doQuery = () => {
      if (parent === null) {
        return getRoots(dbHandle, req.limit ?? 200, req.sort ?? 'size_desc')
      }
      return getChildren(dbHandle, parent, req.limit ?? 200, req.offset ?? 0, req.sort ?? 'size_desc', req.includeFiles ?? true)
    }
    try {
      return doQuery()
    } catch (err: any) {
      if (String(err?.message ?? err).includes('datatype mismatch')) {
        const res = await resetDatabase(dbPath)
        dbHandle = res.db
        dbPath = res.dbPath
        return doQuery()
      }
      throw err
    }
  })

  ipcMain.handle('top', async (_event, req: TopRequest) => {
    await ensureDb()
    try {
      return getTop(dbHandle, req.type, req.limit ?? 100)
    } catch (err: any) {
      if (String(err?.message ?? err).includes('datatype mismatch')) {
        const res = await resetDatabase(dbPath)
        dbHandle = res.db
        dbPath = res.dbPath
        return getTop(dbHandle, req.type, req.limit ?? 100)
      }
      throw err
    }
  })

  /* ---- Drive enumeration ---- */

  ipcMain.handle('list-drives', async (): Promise<DriveInfo[]> => {
    const drives: DriveInfo[] = []
    // Check A-Z drive letters
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code)
      const drivePath = `${letter}:\\`
      try {
        fs.accessSync(drivePath)
        const stats = fs.statSync(drivePath)
        if (stats.isDirectory()) {
          drives.push({
            letter,
            path: drivePath,
            label: `${letter}:\\`,
            totalBytes: 0,
            freeBytes: 0
          })
        }
      } catch {
        // Drive not accessible, skip
      }
    }
    return drives
  })

  /* ---- FS listing (immediate, no DB) ---- */

  ipcMain.handle('list-dir', async (_event, dirPath: string): Promise<ListDirResponse> => {
    const resolved = path.resolve(dirPath)
    const parentPath = path.dirname(resolved)
    const entries: ListDirEntry[] = []
    try {
      const dirents = fs.readdirSync(resolved, { withFileTypes: true })
      for (const d of dirents) {
        const fullPath = path.join(resolved, d.name)
        try {
          const s = fs.statSync(fullPath)
          entries.push({
            name: d.name,
            isDirectory: d.isDirectory(),
            sizeBytes: d.isFile() ? s.size : 0,
            lastWriteUtc: new Date(s.mtimeMs).toISOString()
          })
        } catch {
          entries.push({
            name: d.name,
            isDirectory: d.isDirectory(),
            sizeBytes: 0,
            lastWriteUtc: new Date().toISOString()
          })
        }
      }
    } catch {
      /* inaccessible */
    }
    return { entries, parentPath: parentPath === resolved ? null : parentPath }
  })

  /* ---- Scanning (non-blocking) ---- */

  ipcMain.handle('scan', async (_event, req: ScanRequest) => {
    await ensureDb()
    const mode = req.mode ?? 'shallow'

    // For shallow scans (fast), run synchronously and return immediately
    if (mode === 'shallow') {
      const runId = runScan({ startPath: req.startPath, mode, db: dbHandle, dbPath })
      mainWindow.webContents.send('scan-status', {
        runId, state: 'completed', itemsScanned: 0
      } as ScanStatus)
      return { runId }
    }

    // For full (recursive) scans, fire-and-forget — return runId immediately
    const { randomUUID } = await import('node:crypto')
    const runId = randomUUID()

    // Start async scan without awaiting — progress comes via scan-status events
    runScanAsync({
      startPath: req.startPath,
      mode,
      db: dbHandle,
      dbPath,
      runId,
      skipScannedAfter: req.skipScannedAfter,
      onProgress: (info: { runId: string; state: string; message?: string; itemsScanned: number; currentPath: string }) => {
        mainWindow.webContents.send('scan-status', {
          runId: info.runId,
          state: info.state,
          message: info.message,
          itemsScanned: info.itemsScanned,
          currentPath: info.currentPath
        } as ScanStatus)
      }
    }).catch(() => { /* errors handled via onProgress */ })

    return { runId }
  })

  ipcMain.handle('cancel-scan', async (_event, runId: string) => {
    const scan = activeScans.get(runId)
    if (scan) {
      scan.cancel()
      return { ok: true }
    }
    return { ok: false, message: 'Scan not found or already completed' }
  })

  /* ---- Utility ---- */

  ipcMain.handle('reset-db', async () => {
    await ensureDb()
    const res = await resetDatabase(dbPath)
    dbHandle = res.db
    dbPath = res.dbPath
    return { ok: true }
  })

  ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle('show-in-explorer', async (_event, fullPath: string) => {
    shell.showItemInFolder(path.resolve(fullPath))
    return { ok: true }
  })
}
