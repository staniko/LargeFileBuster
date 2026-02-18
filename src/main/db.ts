import initSqlJs from 'sql.js'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { ItemRecord, ItemType } from '../shared/types'

const isDev = process.env.NODE_ENV === 'development'
  || !app.isPackaged

/** Prefix object keys with `:` for sql.js named-parameter binding. */
function sqlBind(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[`:${k}`] = v
  }
  return out
}

// In dev, store DB alongside project; in production, use appData
const defaultDbPath = isDev
  ? path.resolve(process.cwd(), 'data', 'lfb.sqlite')
  : path.join(app.getPath('userData'), 'data', 'lfb.sqlite')
let SQL: any

function locateWasmFile(file: string): string {
  // Probe several potential locations for the WASM file
  const candidates = [
    path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
    path.resolve(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
    path.resolve(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
    path.join(process.resourcesPath, file)
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return candidates[candidates.length - 1] // fallback (will error)
}

async function loadSql() {
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: locateWasmFile })
  }
  return SQL
}

function applySchema(db: any) {
  db.run(`
    CREATE TABLE IF NOT EXISTS items (
      path TEXT PRIMARY KEY,
      parent TEXT,
      type TEXT NOT NULL,
      sizeBytes INTEGER NOT NULL,
      fileCount INTEGER NOT NULL,
      folderCount INTEGER NOT NULL,
      lastWriteUtc TEXT NOT NULL,
      scannedUtc TEXT NOT NULL,
      depth INTEGER NOT NULL,
      runId TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent);
    CREATE INDEX IF NOT EXISTS idx_items_size ON items(sizeBytes DESC);
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
  `)
}

export async function openDatabase(dbPath = defaultDbPath) {
  await loadSql()
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const loadDb = () => {
    if (fs.existsSync(dbPath)) {
      const data = fs.readFileSync(dbPath)
      return new SQL.Database(new Uint8Array(data))
    }
    return new SQL.Database()
  }

  let db = loadDb()
  let needsPersist = false

  try {
    applySchema(db)
    // sanity check schema
    const probe = db.prepare('SELECT path, type, sizeBytes FROM items LIMIT 1')
    if (probe.step()) {
      const row = probe.getAsObject() as Record<string, any>
      if (typeof row.type !== 'string' || row.type.length === 0) {
        throw new Error('invalid type column')
      }
    }
  } catch {
    // reset corrupted/old DB
    db.close()
    db = new SQL.Database()
    applySchema(db)
    needsPersist = true
  }

  if (needsPersist || !fs.existsSync(dbPath)) {
    persistDatabase(db, dbPath)
  }

  return { db, dbPath }
}

export async function resetDatabase(dbPath = defaultDbPath) {
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath)
    } catch {
      // ignore
    }
  }
  return openDatabase(dbPath)
}

export function persistDatabase(db: any, dbPath: string) {
  const data: Uint8Array = db.export()
  fs.writeFileSync(dbPath, data)
}

export function upsertItems(db: any, dbPath: string, items: ItemRecord[], persist = true) {
  const valid = items.filter((it) => it.type === 'File' || it.type === 'Folder')
  if (valid.length === 0) return

  const stmt = db.prepare(
    `INSERT INTO items (path, parent, type, sizeBytes, fileCount, folderCount, lastWriteUtc, scannedUtc, depth, runId)
     VALUES (:path, :parent, :type, :sizeBytes, :fileCount, :folderCount, :lastWriteUtc, :scannedUtc, :depth, :runId)
     ON CONFLICT(path) DO UPDATE SET
      parent=excluded.parent,
      type=excluded.type,
      sizeBytes=excluded.sizeBytes,
      fileCount=excluded.fileCount,
      folderCount=excluded.folderCount,
      lastWriteUtc=excluded.lastWriteUtc,
      scannedUtc=CASE WHEN excluded.scannedUtc = '' THEN items.scannedUtc ELSE excluded.scannedUtc END,
      depth=excluded.depth,
      runId=excluded.runId;`
  )
  db.run('BEGIN')
  for (const item of valid) {
    stmt.run(sqlBind(item as any))
  }
  db.run('COMMIT')
  if (persist) persistDatabase(db, dbPath)
}

export function getChildren(db: any, parent: string | null, limit = 200, offset = 0, sort: 'size_desc' | 'name_asc' = 'size_desc', includeFiles = true) {
  const sortClause = sort === 'name_asc' ? 'ORDER BY path ASC' : 'ORDER BY sizeBytes DESC'
  const typeFilter = includeFiles ? '' : "AND type = 'Folder'"
  const paramName = parent ? ':parent' : null
  const where = parent ? `parent = ${paramName}` : 'parent IS NULL'
  const query = `SELECT * FROM items WHERE ${where} ${typeFilter} ${sortClause} LIMIT :limit OFFSET :offset`
  const stmt = db.prepare(query)
  const rows = [] as ItemRecord[]
  const bindObj: Record<string, any> = { ':limit': limit, ':offset': offset }
  if (parent !== null) bindObj[':parent'] = parent
  stmt.bind(bindObj)
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as ItemRecord)
  }
  const countBindObj: Record<string, any> = {}
  if (parent !== null) countBindObj[':parent'] = parent
  const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM items WHERE ${where} ${typeFilter}`)
  countStmt.bind(countBindObj)
  const countRow = countStmt.step() ? (countStmt.getAsObject() as any) : { cnt: 0 }
  return { items: rows, total: countRow.cnt as number }
}

export function getRoots(db: any, limit = 200, sort: 'size_desc' | 'name_asc' = 'size_desc') {
  const sortClause = sort === 'name_asc' ? 'ORDER BY path ASC' : 'ORDER BY sizeBytes DESC'
  // Show items whose parent is NULL (drive roots) plus orphans whose parent
  // isn't in the DB — but only if no existing root is already an ancestor
  // of the orphan's path (prevents deep scanned folders duplicating at root).
  const query = `
    SELECT * FROM items
    WHERE parent IS NULL
       OR (
         parent NOT IN (SELECT path FROM items)
         AND NOT EXISTS (
           SELECT 1 FROM items r
           WHERE r.parent IS NULL
             AND items.path LIKE r.path || '%'
         )
       )
    ${sortClause} LIMIT :limit`
  const stmt = db.prepare(query)
  const rows = [] as ItemRecord[]
  stmt.bind({ ':limit': limit })
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as ItemRecord)
  }
  return { items: rows, total: rows.length }
}

export function getTop(db: any, type: ItemType, limit = 100) {
  const stmt = db.prepare(`SELECT * FROM items WHERE type = :type ORDER BY sizeBytes DESC LIMIT :limit`)
  const rows = [] as ItemRecord[]
  stmt.bind({ ':type': type, ':limit': limit })
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as ItemRecord)
  }
  return rows
}

/** Look up a single item by path (case-sensitive). Returns null if not found. */
export function getItemByPath(db: any, itemPath: string): ItemRecord | null {
  const stmt = db.prepare('SELECT * FROM items WHERE path = :path LIMIT 1')
  stmt.bind({ ':path': itemPath })
  if (stmt.step()) {
    return stmt.getAsObject() as ItemRecord
  }
  return null
}
