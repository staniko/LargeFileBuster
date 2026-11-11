import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ListDirEntry, ListDirResponse, ScanStatus, DriveInfo } from '../shared/types'
import { getChildren, getRoots, getTop, openDatabase, resetDatabase } from './db'
import { runScan, runScanAsync, activeScans, ScanProgress } from './scanner'
import { isTrustedSender } from './security'
import { parseChildRequest, parseScanRequest, parseTopRequest, requireAbsolutePath, requireRunId } from './validate'

let dbHandle: any
let dbPath: string
let dbReady: Promise<void> | null = null

function ensureDb() {
  if (!dbReady) {
    dbReady = openDatabase().then((res) => {
      dbHandle = res.db
      dbPath = res.dbPath
    })
  }
  return dbReady
}

/**
 * Registers an IPC handler that only answers the app's own UI.
 * Arguments arrive as `unknown` so every handler has to validate them.
 */
function handle<T>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>) {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) {
      throw new Error(`Blocked "${channel}" request from an untrusted sender`)
    }
    return listener(event, ...args)
  })
}

let registered = false

export function setupIpc() {
  if (registered) return
  registered = true
  ensureDb()

  /* ---- DB queries ---- */

  handle('children', async (_event, rawReq) => {
    const req = parseChildRequest(rawReq)
    await ensureDb()
    const doQuery = () => {
      if (req.parent === null) {
        return getRoots(dbHandle, req.limit, req.sort)
      }
      return getChildren(dbHandle, req.parent, req.limit, req.offset, req.sort, req.includeFiles)
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

  handle('top', async (_event, rawReq) => {
    const req = parseTopRequest(rawReq)
    await ensureDb()
    try {
      return getTop(dbHandle, req.type, req.limit)
    } catch (err: any) {
      if (String(err?.message ?? err).includes('datatype mismatch')) {
        const res = await resetDatabase(dbPath)
        dbHandle = res.db
        dbPath = res.dbPath
        return getTop(dbHandle, req.type, req.limit)
      }
      throw err
    }
  })

  /* ---- Drive enumeration ---- */

  handle('list-drives', async (): Promise<DriveInfo[]> => {
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

  handle('list-dir', async (_event, rawPath): Promise<ListDirResponse> => {
    const resolved = requireAbsolutePath(rawPath, 'dirPath')
    const parentPath = path.dirname(resolved)
    const entries: ListDirEntry[] = []
    try {
      const dirents = fs.readdirSync(resolved, { withFileTypes: true })
      for (const d of dirents) {
        const fullPath = path.join(resolved, d.name)
        try {
          // lstat: describe the entry itself. Following a link here would let a
          // planted symlink make the app touch whatever it points to (for
          // example a remote share) just because its folder was opened.
          const s = fs.lstatSync(fullPath)
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

  handle('scan', async (event, rawReq) => {
    const req = parseScanRequest(rawReq)
    await ensureDb()

    const sender = event.sender
    const sendStatus = (status: ScanStatus) => {
      if (!sender.isDestroyed()) sender.send('scan-status', status)
    }

    // For shallow scans (fast), run synchronously and return immediately
    if (req.mode === 'shallow') {
      const runId = runScan({ startPath: req.startPath, db: dbHandle, dbPath })
      sendStatus({ runId, state: 'completed', itemsScanned: 0 })
      return { runId }
    }

    // For full (recursive) scans, fire-and-forget — return runId immediately
    const runId = randomUUID()

    // Start async scan without awaiting — progress comes via scan-status events
    let lastProgressSent = 0
    const PROGRESS_THROTTLE_MS = 200

    const sendProgress = (info: ScanProgress) => {
      if (info.state === 'running') {
        const now = Date.now()
        if (now - lastProgressSent < PROGRESS_THROTTLE_MS) return
        lastProgressSent = now
      }
      sendStatus({
        runId: info.runId,
        state: info.state,
        message: info.message,
        itemsScanned: info.itemsScanned,
        currentPath: info.currentPath
      })
    }

    runScanAsync({
      startPath: req.startPath,
      mode: req.mode,
      db: dbHandle,
      dbPath,
      runId,
      skipScannedAfter: req.skipScannedAfter,
      onProgress: sendProgress
    }).catch(() => { /* errors handled via onProgress */ })

    return { runId }
  })

  handle('cancel-scan', async (_event, rawRunId) => {
    const scan = activeScans.get(requireRunId(rawRunId))
    if (scan) {
      scan.cancel()
      return { ok: true }
    }
    return { ok: false, message: 'Scan not found or already completed' }
  })

  /* ---- Utility ---- */

  handle('reset-db', async () => {
    await ensureDb()
    const res = await resetDatabase(dbPath)
    dbHandle = res.db
    dbPath = res.dbPath
    return { ok: true }
  })

  handle('pick-folder', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { canceled: false, path: result.filePaths[0] }
  })

  handle('show-in-explorer', async (_event, rawPath) => {
    shell.showItemInFolder(requireAbsolutePath(rawPath, 'fullPath'))
    return { ok: true }
  })
}
