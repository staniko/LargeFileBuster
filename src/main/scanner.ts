import fs from 'node:fs'
import path from 'node:path'
import { ItemRecord } from '../shared/types'
import { upsertItems, persistDatabase, getItemByPath } from './db'
import { randomUUID } from 'node:crypto'

/* ============================================================
   Types
   ============================================================ */

interface ScanOptions {
  startPath: string
  mode: 'full' | 'shallow'
  db: any
  dbPath: string
  /** Skip directories already deep-scanned after this ISO date. */
  skipScannedAfter?: string
}

export interface AsyncScanOptions extends ScanOptions {
  /** Called periodically with progress. */
  onProgress?: (info: ScanProgress) => void
  /** If this returns true the scan is aborted. */
  isCancelled?: () => boolean
  /** Optional pre-generated runId. */
  runId?: string
}

export interface ScanProgress {
  runId: string
  itemsScanned: number
  currentPath: string
  state: 'running' | 'completed' | 'error' | 'cancelled'
  message?: string
}

/* ============================================================
   Helpers
   ============================================================ */

/** Returns the real filesystem parent, or null for a root path. */
function fsParent(p: string): string | null {
  const d = path.dirname(p)
  return d === p ? null : d
}

/** Quick stat of a directory's immediate file contents (no recursion). */
function statDirShallow(dirPath: string): {
  sizeBytes: number
  fileCount: number
  folderCount: number
  latestMs: number
} {
  let sizeBytes = 0,
    fileCount = 0,
    folderCount = 0,
    latestMs = 0
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile()) {
        try {
          const s = fs.statSync(path.join(dirPath, e.name))
          sizeBytes += s.size
          fileCount++
          latestMs = Math.max(latestMs, s.mtimeMs)
        } catch {
          /* skip inaccessible */
        }
      } else if (e.isDirectory()) {
        folderCount++
      }
    }
  } catch {
    /* skip inaccessible */
  }
  return { sizeBytes, fileCount, folderCount, latestMs }
}

/** Yield control to the event loop. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/* ============================================================
   Shallow scan (synchronous — fast enough for a single dir)
   ============================================================ */

function scanShallow(startPath: string, runId: string): ItemRecord[] {
  const root = path.resolve(startPath)
  const items: ItemRecord[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return items
  }

  let totalSize = 0,
    totalFiles = 0,
    totalFolders = 0,
    latest = 0

  for (const e of entries) {
    const childPath = path.join(root, e.name)
    if (e.isFile()) {
      try {
        const s = fs.statSync(childPath)
        totalSize += s.size
        totalFiles++
        latest = Math.max(latest, s.mtimeMs)
        items.push({
          path: childPath,
          parent: root,
          type: 'File',
          sizeBytes: s.size,
          fileCount: 1,
          folderCount: 0,
          lastWriteUtc: new Date(s.mtimeMs).toISOString(),
          scannedUtc: '',
          depth: 1,
          runId
        })
      } catch {
        continue
      }
    } else if (e.isDirectory()) {
      const di = statDirShallow(childPath)
      totalSize += di.sizeBytes
      totalFolders++
      latest = Math.max(latest, di.latestMs)
      items.push({
        path: childPath,
        parent: root,
        type: 'Folder',
        sizeBytes: di.sizeBytes,
        fileCount: di.fileCount,
        folderCount: di.folderCount,
        lastWriteUtc: new Date(di.latestMs || Date.now()).toISOString(),
        scannedUtc: '',
        depth: 1,
        runId
      })
    }
  }

  // Record the root folder itself
  try {
    const rs = fs.statSync(root)
    latest = Math.max(latest, rs.mtimeMs)
  } catch {
    /* ignore */
  }
  items.push({
    path: root,
    parent: fsParent(root),
    type: 'Folder',
    sizeBytes: totalSize,
    fileCount: totalFiles,
    folderCount: totalFolders,
    lastWriteUtc: new Date(latest || Date.now()).toISOString(),
    scannedUtc: '',
    depth: 0,
    runId
  })

  return items
}

/* ============================================================
   Full recursive scan — async with periodic yielding
   ============================================================ */

interface AggResult {
  sizeBytes: number
  fileCount: number
  folderCount: number
  latestMs: number
}

/** How often (in items) to yield to the event loop & send progress. */
const YIELD_INTERVAL = 200

/** How often (in items) to persist the DB to disk (frees sql.js write buffers). */
const PERSIST_INTERVAL = 5_000

/**
 * Minimum file size (bytes) to store as an individual DB record.
 * Smaller files still count toward their parent folder's totals.
 * This dramatically reduces memory for full-drive scans where millions
 * of tiny files would otherwise bloat the in-memory sql.js database.
 */
const MIN_FILE_SIZE_FOR_DB = 100 * 1024 // 100 KB

/**
 * Async full recursive scan. Yields control to the event loop every
 * YIELD_INTERVAL items so IPC / rendering stays responsive.
 */
async function scanFullAsync(
  dirPath: string,
  depth: number,
  runId: string,
  db: any,
  dbPath: string,
  counter: { count: number; lastYield: number },
  onProgress?: (info: ScanProgress) => void,
  isCancelled?: () => boolean,
  skipScannedAfter?: string
): Promise<AggResult> {
  if (isCancelled?.()) {
    return { sizeBytes: 0, fileCount: 0, folderCount: 0, latestMs: 0 }
  }

  const resolved = path.resolve(dirPath)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true })
  } catch {
    return { sizeBytes: 0, fileCount: 0, folderCount: 0, latestMs: 0 }
  }

  const batchItems: ItemRecord[] = []
  let totalSize = 0,
    totalFiles = 0,
    totalFolders = 0,
    latest = 0

  for (const e of entries) {
    if (isCancelled?.()) {
      // Persist what we have so far before bailing out — but do NOT mark
      // this folder as fully scanned (scannedUtc='') since it was cancelled.
      if (batchItems.length > 0) {
        batchItems.push({
          path: resolved,
          parent: fsParent(resolved),
          type: 'Folder',
          sizeBytes: totalSize,
          fileCount: totalFiles,
          folderCount: totalFolders,
          lastWriteUtc: new Date(latest || Date.now()).toISOString(),
          scannedUtc: '',
          depth,
          runId
        })
        upsertItems(db, dbPath, batchItems)
      }
      return { sizeBytes: totalSize, fileCount: totalFiles, folderCount: totalFolders, latestMs: latest }
    }

    const childPath = path.join(resolved, e.name)
    if (e.isFile()) {
      try {
        const s = fs.statSync(childPath)
        totalSize += s.size
        totalFiles++
        latest = Math.max(latest, s.mtimeMs)
        counter.count++
        // Only store files large enough to matter individually
        if (s.size >= MIN_FILE_SIZE_FOR_DB) {
          batchItems.push({
            path: childPath,
            parent: resolved,
            type: 'File',
            sizeBytes: s.size,
            fileCount: 1,
            folderCount: 0,
            lastWriteUtc: new Date(s.mtimeMs).toISOString(),
            scannedUtc: new Date().toISOString(),
            depth: depth + 1,
            runId
          })
        }
      } catch {
        continue
      }
    } else if (e.isDirectory()) {
      // Skip re-scanning directories already scanned after the cutoff
      if (skipScannedAfter) {
        const existing = getItemByPath(db, childPath)
        if (existing && existing.scannedUtc && existing.scannedUtc >= skipScannedAfter) {
          // Use cached values instead of recursing
          totalSize += existing.sizeBytes
          totalFiles += existing.fileCount
          totalFolders += existing.folderCount + 1
          latest = Math.max(latest, new Date(existing.lastWriteUtc).getTime())
          continue
        }
      }

      // Flush batch BEFORE recursing to keep stack-frame memory low
      if (batchItems.length > 0) {
        upsertItems(db, dbPath, batchItems, false)
        batchItems.length = 0
      }

      // Recurse
      const sub = await scanFullAsync(childPath, depth + 1, runId, db, dbPath, counter, onProgress, isCancelled, skipScannedAfter)
      totalSize += sub.sizeBytes
      totalFiles += sub.fileCount
      totalFolders += sub.folderCount + 1
      latest = Math.max(latest, sub.latestMs)
    }

    // Periodically yield to the event loop, flush batch, and send progress
    if (counter.count - counter.lastYield >= YIELD_INTERVAL) {
      counter.lastYield = counter.count
      // Flush accumulated items to free memory
      if (batchItems.length > 0) {
        upsertItems(db, dbPath, batchItems, false)
        batchItems.length = 0
      }
      onProgress?.({
        runId,
        itemsScanned: counter.count,
        currentPath: resolved,
        state: 'running'
      })
      // Periodically persist DB to disk to free sql.js internal write buffers
      if (counter.count % PERSIST_INTERVAL < YIELD_INTERVAL) {
        persistDatabase(db, dbPath)
      }
      await yieldToEventLoop()
    }
  }

  // Record this directory — only mark as scanned if not cancelled
  const wasCancelled = isCancelled?.() ?? false
  try {
    const ds = fs.statSync(resolved)
    latest = Math.max(latest, ds.mtimeMs)
  } catch {
    /* ignore */
  }
  batchItems.push({
    path: resolved,
    parent: fsParent(resolved),
    type: 'Folder',
    sizeBytes: totalSize,
    fileCount: totalFiles,
    folderCount: totalFolders,
    lastWriteUtc: new Date(latest || Date.now()).toISOString(),
    scannedUtc: wasCancelled ? '' : new Date().toISOString(),
    depth,
    runId
  })
  counter.count++

  // Persist this batch (defer disk write — pass false)
  upsertItems(db, dbPath, batchItems, false)

  return { sizeBytes: totalSize, fileCount: totalFiles, folderCount: totalFolders, latestMs: latest }
}

/* ============================================================
   Public API
   ============================================================ */

/** Synchronous scan (shallow only). Returns runId. */
export function runScan({ startPath, mode, db, dbPath }: ScanOptions): string {
  const runId = randomUUID()
  const items = scanShallow(startPath, runId)
  if (items.length > 0) {
    upsertItems(db, dbPath, items)
  }
  return runId
}

/** Active scans that can be cancelled. */
export const activeScans = new Map<string, { cancel: () => void }>()

/** Async scan (full recursive). Returns runId. Yields to event loop periodically. */
export async function runScanAsync({
  startPath,
  mode,
  db,
  dbPath,
  onProgress,
  isCancelled: externalCancel,
  runId: providedRunId,
  skipScannedAfter
}: AsyncScanOptions): Promise<string> {
  const runId = providedRunId ?? randomUUID()

  if (mode === 'shallow') {
    const items = scanShallow(startPath, runId)
    if (items.length > 0) {
      upsertItems(db, dbPath, items)
    }
    onProgress?.({
      runId,
      itemsScanned: items.length,
      currentPath: startPath,
      state: 'completed'
    })
    return runId
  }

  // Full async scan with cancellation support
  let cancelled = false
  activeScans.set(runId, { cancel: () => { cancelled = true } })
  const isCancelled = () => cancelled || (externalCancel?.() ?? false)

  const counter = { count: 0, lastYield: 0 }
  onProgress?.({
    runId,
    itemsScanned: 0,
    currentPath: startPath,
    state: 'running'
  })

  try {
    await scanFullAsync(startPath, 0, runId, db, dbPath, counter, onProgress, isCancelled, skipScannedAfter)

    if (isCancelled()) {
      onProgress?.({
        runId,
        itemsScanned: counter.count,
        currentPath: startPath,
        state: 'cancelled',
        message: `Scan cancelled after ${counter.count} items`
      })
    } else {
      onProgress?.({
        runId,
        itemsScanned: counter.count,
        currentPath: startPath,
        state: 'completed'
      })
    }
  } catch (err: any) {
    onProgress?.({
      runId,
      itemsScanned: counter.count,
      currentPath: startPath,
      state: 'error',
      message: err?.message ?? String(err)
    })
  } finally {
    activeScans.delete(runId)
    // Persist DB to disk once at end of scan
    persistDatabase(db, dbPath)
  }

  return runId
}
