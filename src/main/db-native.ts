import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { ItemRecord, ItemType } from '../shared/types'
import { native } from './native'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// In dev, store DB alongside project; in production, use appData
const defaultDbPath = isDev
  ? path.resolve(process.cwd(), 'data', 'lfb.sqlite')
  : path.join(app.getPath('userData'), 'data', 'lfb.sqlite')

let dbOpen = false
let currentDbPath = defaultDbPath

export async function openDatabase(dbPath = defaultDbPath) {
  // Ensure directory exists
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const result = native.openDatabase(dbPath)
  if (result.success) {
    dbOpen = true
    currentDbPath = dbPath
    return { db: null, dbPath }  // db is managed by native code
  }
  throw new Error('Failed to open native database')
}

export async function resetDatabase(dbPath = defaultDbPath) {
  if (fs.existsSync(dbPath)) {
    try {
      if (dbOpen) {
        native.closeDatabase()
        dbOpen = false
      }
      fs.unlinkSync(dbPath)
    } catch {
      // ignore
    }
  }
  return openDatabase(dbPath)
}

export function persistDatabase(_db: any, _dbPath: string) {
  // No-op for native SQLite - it persists automatically
}

export function upsertItems(_db: any, _dbPath: string, items: ItemRecord[], _persist = true) {
  if (!dbOpen) {
    throw new Error('Database not open')
  }
  native.upsertItems(items)
}

export function getChildren(
  _db: any,
  parent: string | null,
  limit = 200,
  offset = 0,
  sort: 'size_desc' | 'name_asc' = 'size_desc',
  includeFiles = true
) {
  if (!dbOpen) {
    return { items: [], total: 0 }
  }
  return native.getChildren(parent, limit, offset, sort, includeFiles)
}

export function getRoots(_db: any, limit = 200, sort: 'size_desc' | 'name_asc' = 'size_desc') {
  if (!dbOpen) {
    return { items: [], total: 0 }
  }
  return native.getRoots(limit, sort)
}

export function getTop(_db: any, type: ItemType, limit = 100) {
  if (!dbOpen) {
    return []
  }
  return native.getTop(type, limit)
}

export function getItemByPath(_db: any, itemPath: string): ItemRecord | null {
  if (!dbOpen) {
    return null
  }
  return native.getItemByPath(itemPath)
}
