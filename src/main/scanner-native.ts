import { ItemRecord } from '../shared/types'
import { upsertItems, persistDatabase } from './db-native'
import { native } from './native'

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
   Public API
   ============================================================ */

/** Synchronous scan (shallow only). Returns runId. */
export function runScan({ startPath, mode, db, dbPath }: ScanOptions): string {
  if (mode !== 'shallow') {
    throw new Error('runScan only supports shallow mode. Use runScanAsync for full scans.')
  }
  
  // Native scanner already upserts to database
  return native.scanShallow(startPath)
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
  if (mode === 'shallow') {
    const runId = native.scanShallow(startPath)
    onProgress?.({
      runId,
      itemsScanned: 0,
      currentPath: startPath,
      state: 'completed'
    })
    return runId
  }

  // For full scans, we still need to implement the async version in native code
  // For now, fall back to shallow scan as a placeholder
  // TODO: Implement full async scan in native addon
  const runId = native.scanShallow(startPath)
  onProgress?.({
    runId,
    itemsScanned: 0,
    currentPath: startPath,
    state: 'completed',
    message: 'Using shallow scan (full async scan not yet implemented in native)'
  })
  return runId
}
