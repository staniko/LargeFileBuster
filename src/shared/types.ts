export type ItemType = 'File' | 'Folder'

export interface ItemRecord {
  path: string
  parent: string | null
  type: ItemType
  sizeBytes: number
  fileCount: number
  folderCount: number
  lastWriteUtc: string
  scannedUtc: string
  depth: number
  runId: string
}

export interface ChildRequest {
  parent: string | null
  limit?: number
  offset?: number
  sort?: 'size_desc' | 'name_asc'
  includeFiles?: boolean
}

export interface ChildResponse {
  items: ItemRecord[]
  total: number
}

export interface TopRequest {
  limit?: number
  type: 'File' | 'Folder'
}

export interface ScanRequest {
  startPath: string
  mode?: 'full' | 'shallow'
  /** Skip directories already deep-scanned after this ISO date. */
  skipScannedAfter?: string
}

export interface ScanResult {
  runId: string
}

export interface ScanStatus {
  runId: string
  state: 'running' | 'completed' | 'error' | 'cancelled'
  message?: string
  itemsScanned?: number
  currentPath?: string
}

export interface ListDirEntry {
  name: string
  isDirectory: boolean
  sizeBytes: number
  lastWriteUtc: string
}

export interface ListDirResponse {
  entries: ListDirEntry[]
  parentPath: string | null
}

export interface DriveInfo {
  letter: string
  path: string
  label: string
  totalBytes: number
  freeBytes: number
}
