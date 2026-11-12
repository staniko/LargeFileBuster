import path from 'node:path'
import { ChildRequest, ScanRequest, TopRequest } from '../shared/types'

/* ============================================================
   Validation of everything that arrives over IPC.

   The renderer is trusted, but the main process still checks every
   argument: wrong types must never reach the file system or the
   database layer (a non-numeric LIMIT, for example, makes SQLite
   report "datatype mismatch", which the caller treats as a corrupt
   database and wipes it).
   ============================================================ */

/** Longest path Windows can represent; anything longer is not a real path. */
const MAX_PATH_LENGTH = 32_767

const MAX_CHILD_LIMIT = 10_000
const MAX_TOP_LIMIT = 1_000

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(message: string): never {
  throw new TypeError(`Invalid request: ${message}`)
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function requirePathString(value: unknown, name: string): string {
  if (typeof value !== 'string') fail(`${name} must be a string`)
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) fail(`${name} has an invalid length`)
  if (value.includes('\0')) fail(`${name} must not contain NUL characters`)
  return value
}

/**
 * On Windows only two shapes are accepted: drive paths ("C:\Users") and UNC
 * shares ("\\server\share\dir"). That rules out drive-relative ("C:temp") and
 * root-relative ("\temp") paths, whose meaning depends on the process' current
 * directory, as well as device namespaces ("\\.\PhysicalDrive0", "\\?\…").
 */
function isSupportedAbsolutePath(value: string): boolean {
  if (process.platform !== 'win32') return path.isAbsolute(value)
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+/.test(value)
}

/** Returns the normalised absolute path, or throws. */
export function requireAbsolutePath(value: unknown, name: string): string {
  const raw = requirePathString(value, name)
  if (!isSupportedAbsolutePath(raw)) fail(`${name} must be an absolute path`)
  return path.resolve(raw)
}

function optionalInteger(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') fail(`${name} must be a boolean`)
  return value
}

function optionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${name} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

export function parseChildRequest(value: unknown): Required<ChildRequest> {
  const req = requireObject(value, 'request')
  return {
    // A database key, compared as-is: it is never used to touch the file system.
    parent: req.parent === undefined || req.parent === null ? null : requirePathString(req.parent, 'parent'),
    limit: optionalInteger(req.limit, 'limit', 1, MAX_CHILD_LIMIT, 200),
    offset: optionalInteger(req.offset, 'offset', 0, Number.MAX_SAFE_INTEGER, 0),
    sort: optionalEnum(req.sort, 'sort', ['size_desc', 'name_asc'] as const, 'size_desc'),
    includeFiles: optionalBoolean(req.includeFiles, 'includeFiles', true)
  }
}

export function parseTopRequest(value: unknown): Required<TopRequest> {
  const req = requireObject(value, 'request')
  if (req.type !== 'File' && req.type !== 'Folder') fail('type must be File or Folder')
  return {
    type: req.type,
    limit: optionalInteger(req.limit, 'limit', 1, MAX_TOP_LIMIT, 100)
  }
}

export function parseScanRequest(value: unknown): Required<Pick<ScanRequest, 'startPath' | 'mode'>> & Pick<ScanRequest, 'skipScannedAfter'> {
  const req = requireObject(value, 'request')
  let skipScannedAfter: string | undefined
  if (req.skipScannedAfter !== undefined && req.skipScannedAfter !== null) {
    const raw = req.skipScannedAfter
    const ms = typeof raw === 'string' && raw.length <= 64 ? Date.parse(raw) : NaN
    if (Number.isNaN(ms)) fail('skipScannedAfter must be an ISO date')
    skipScannedAfter = new Date(ms).toISOString()
  }
  return {
    startPath: requireAbsolutePath(req.startPath, 'startPath'),
    mode: optionalEnum(req.mode, 'mode', ['shallow', 'full'] as const, 'shallow'),
    skipScannedAfter
  }
}

export function requireRunId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('runId must be a UUID')
  return value
}
