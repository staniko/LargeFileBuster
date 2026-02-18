import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChildResponse, ItemRecord, ListDirEntry, ListDirResponse, ScanStatus, DriveInfo } from '../../shared/types'

/* ========== helpers ========== */

function formatSize(bytes: number): string {
  if (bytes < 0) return '—'
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`
  return `${bytes} B`
}

function pathName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

function parentDir(p: string): string | null {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  if (parts.length <= 1) return null
  let parent = parts.slice(0, -1).join('\\')
  // "C:" without backslash means CWD on that drive — always use "C:\"
  if (/^[A-Za-z]:$/.test(parent)) parent += '\\'
  return parent || null
}

function buildBreadcrumbs(current: string | null): { label: string; path: string | null }[] {
  const crumbs: { label: string; path: string | null }[] = [{ label: '\u{1F4BB} This PC', path: null }]
  if (!current) return crumbs
  const parts = current.split(/[\\/]/).filter(Boolean)
  let acc = ''
  for (let i = 0; i < parts.length; i++) {
    acc = i === 0 && parts[0].endsWith(':') ? parts[0] + '\\' : (i === 0 ? parts[0] : acc + '\\' + parts[i])
    crumbs.push({ label: parts[i], path: acc })
  }
  return crumbs
}

/** Merge FS listing with DB data: FS entries give immediate visibility,
 *  DB entries provide scanned sizes. */
interface DisplayItem {
  name: string
  fullPath: string
  isDirectory: boolean
  sizeBytes: number
  fileCount: number
  folderCount: number
  lastWriteUtc: string
  scannedUtc: string
  hasDbData: boolean
}

function mergeItems(
  fsEntries: ListDirEntry[] | null,
  dbItems: ItemRecord[],
  currentPath: string
): DisplayItem[] {
  const dbMap = new Map<string, ItemRecord>()
  for (const r of dbItems) dbMap.set(r.path.toLowerCase(), r)

  const seen = new Set<string>()
  const result: DisplayItem[] = []

  if (fsEntries) {
    for (const e of fsEntries) {
      // Normalize: avoid double backslashes when currentPath ends with \
      const sep = currentPath.endsWith('\\') || currentPath.endsWith('/') ? '' : '\\'
      const full = currentPath + sep + e.name
      seen.add(full.toLowerCase())
      const db = dbMap.get(full.toLowerCase())
      result.push({
        name: e.name,
        fullPath: full,
        isDirectory: db ? db.type === 'Folder' : e.isDirectory,
        sizeBytes: db ? db.sizeBytes : e.sizeBytes,
        fileCount: db ? db.fileCount : 0,
        folderCount: db ? db.folderCount : 0,
        lastWriteUtc: db ? db.lastWriteUtc : e.lastWriteUtc,
        scannedUtc: db ? db.scannedUtc : '',
        hasDbData: !!db
      })
    }
  }

  for (const r of dbItems) {
    if (!seen.has(r.path.toLowerCase())) {
      result.push({
        name: pathName(r.path),
        fullPath: r.path,
        isDirectory: r.type === 'Folder',
        sizeBytes: r.sizeBytes,
        fileCount: r.fileCount,
        folderCount: r.folderCount,
        lastWriteUtc: r.lastWriteUtc,
        scannedUtc: r.scannedUtc,
        hasDbData: true
      })
    }
  }

  return result
}

type SortKey = 'name' | 'size' | 'modified' | 'files' | 'folders' | 'lastDeepScan'
type SortDir = 'asc' | 'desc'

function sortItems(items: DisplayItem[], key: SortKey, dir: SortDir): DisplayItem[] {
  const folders = items.filter((i) => i.isDirectory)
  const files = items.filter((i) => !i.isDirectory)

  const cmp = (a: DisplayItem, b: DisplayItem): number => {
    let v = 0
    switch (key) {
      case 'name':
        v = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        break
      case 'size':
        v = a.sizeBytes - b.sizeBytes
        break
      case 'modified':
        v = new Date(a.lastWriteUtc).getTime() - new Date(b.lastWriteUtc).getTime()
        break
      case 'files':
        v = a.fileCount - b.fileCount
        break
      case 'folders':
        v = a.folderCount - b.folderCount
        break
      case 'lastDeepScan':
        v = (a.scannedUtc || '').localeCompare(b.scannedUtc || '')
        break
    }
    return dir === 'desc' ? -v : v
  }

  folders.sort(cmp)
  files.sort(cmp)
  return [...folders, ...files]
}

/* ========== CSS constants ========== */

const ROW_HEIGHT = 26
const HEADER_BG = '#f5f5f5'
const SELECTED_BG = '#cce5ff'
const HOVER_BG = '#e9e9e9'
const BORDER = '#e0e0e0'
const FONT = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif"

/* ========== App ========== */

export default function App() {
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [fsEntries, setFsEntries] = useState<ListDirEntry[] | null>(null)
  const [dbItems, setDbItems] = useState<ItemRecord[]>([])
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [topFolders, setTopFolders] = useState<ItemRecord[]>([])
  const [topFiles, setTopFiles] = useState<ItemRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState<string | null>(null)
  const [scanProgress, setScanProgress] = useState<{ itemsScanned: number; currentPath?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pathHistory, setPathHistory] = useState<(string | null)[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('size')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: DisplayItem } | null>(null)
  const [continueModal, setContinueModal] = useState<{ folderPath: string } | null>(null)
  const [continueCutoff, setContinueCutoff] = useState<string>('')
  const [sidebarTab, setSidebarTab] = useState<'folders' | 'files'>('folders')
  const [sidebarWidth, setSidebarWidth] = useState(320)
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null)

  const navIdRef = useRef(0)

  /* ---- data fetching ---- */

  const fetchDbItems = useCallback(async (parent: string | null): Promise<ItemRecord[]> => {
    try {
      const resp = (await window.lfb.children({
        parent, limit: 2000, sort: 'size_desc', includeFiles: true
      })) as ChildResponse
      return resp.items
    } catch { return [] }
  }, [])

  const fetchFsEntries = useCallback(async (dirPath: string): Promise<ListDirEntry[]> => {
    try {
      const resp = (await window.lfb.listDir(dirPath)) as ListDirResponse
      return resp.entries
    } catch { return [] }
  }, [])

  const fetchDrives = useCallback(async (): Promise<DriveInfo[]> => {
    try {
      return (await window.lfb.listDrives()) as DriveInfo[]
    } catch { return [] }
  }, [])

  const fetchTop = useCallback(async () => {
    try {
      const [folders, files] = await Promise.all([
        window.lfb.top({ type: 'Folder', limit: 50 }) as Promise<ItemRecord[]>,
        window.lfb.top({ type: 'File', limit: 50 }) as Promise<ItemRecord[]>
      ])
      setTopFolders(folders)
      setTopFiles(files)
    } catch { /* ignore */ }
  }, [])

  /* ---- navigation ---- */

  const navigateTo = useCallback(async (target: string | null, pushHistory = true) => {
    const id = ++navIdRef.current
    if (pushHistory) {
      setPathHistory((h) => [...h, currentPath])
    }
    setSelectedPath(null)
    setLoading(true)
    setError(null)

    try {
      let newFs: ListDirEntry[] | null = null
      let newDrives: DriveInfo[] | null = null
      if (target) {
        newFs = await fetchFsEntries(target)
      } else {
        newDrives = await fetchDrives()
      }

      const db = await fetchDbItems(target)
      if (id !== navIdRef.current) return

      // Swap everything atomically to avoid flash
      setCurrentPath(target)
      if (target) {
        setFsEntries(newFs)
      } else {
        setDrives(newDrives!)
      }
      setDbItems(db)

      // Auto-scan if not in DB yet
      if (target && db.length === 0) {
        window.lfb.scan({ startPath: target, mode: 'shallow' }).then(async () => {
          if (navIdRef.current !== id) return
          const freshDb = await fetchDbItems(target)
          if (navIdRef.current === id) setDbItems(freshDb)
        }).catch(() => {})
      }
    } catch (e: any) {
      if (id === navIdRef.current) {
        setCurrentPath(target)
        setError(e?.message ?? 'Failed to load')
      }
    } finally {
      if (id === navIdRef.current) setLoading(false)
    }

    fetchTop()
  }, [currentPath, fetchDbItems, fetchDrives, fetchFsEntries, fetchTop])

  const goBack = useCallback(() => {
    setPathHistory((h) => {
      if (h.length === 0) return h
      const prev = h[h.length - 1]
      navigateTo(prev, false)
      return h.slice(0, -1)
    })
  }, [navigateTo])

  const goUp = useCallback(() => {
    if (!currentPath) return
    navigateTo(parentDir(currentPath))
  }, [currentPath, navigateTo])

  /* ---- actions ---- */

  const pickFolder = useCallback(async () => {
    setError(null)
    const result = (await window.lfb.pickFolder()) as { canceled: boolean; path?: string }
    if (result.canceled || !result.path) return
    try {
      await window.lfb.scan({ startPath: result.path, mode: 'shallow' })
    } catch (e: any) {
      setError(e?.message ?? 'Scan failed')
    }
    navigateTo(result.path)
  }, [navigateTo])

  const resetDb = useCallback(async () => {
    setError(null)
    try {
      await window.lfb.resetDb()
      setCurrentPath(null)
      setPathHistory([])
      setFsEntries(null)
      setDbItems([])
      setTopFolders([])
      setTopFiles([])
    } catch (e: any) {
      setError(e?.message ?? 'Reset failed')
    }
  }, [])

  const folderSizeCheck = useCallback(async (folderPath: string) => {
    setError(null)
    try {
      const result = await window.lfb.scan({ startPath: folderPath, mode: 'full' }) as { runId: string }
      setScanning(result.runId)
    } catch (e: any) {
      setError(e?.message ?? 'Folder size check failed')
    }
  }, [])

  const folderSizeContinue = useCallback(async (folderPath: string, cutoffDate: string) => {
    setError(null)
    try {
      const result = await window.lfb.scan({
        startPath: folderPath,
        mode: 'full',
        skipScannedAfter: new Date(cutoffDate).toISOString()
      }) as { runId: string }
      setScanning(result.runId)
    } catch (e: any) {
      setError(e?.message ?? 'Continue scan failed')
    }
  }, [])

  const refreshCurrent = useCallback(() => {
    navigateTo(currentPath, false)
  }, [currentPath, navigateTo])

  /* ---- scan status ---- */

  useEffect(() => {
    const unsub = window.lfb.onScanStatus((status: ScanStatus) => {
      if (status.state === 'running') {
        setScanProgress({
          itemsScanned: status.itemsScanned ?? 0,
          currentPath: status.currentPath
        })
      } else if (status.state === 'completed' || status.state === 'error' || status.state === 'cancelled') {
        setScanning((prev) => (prev === status.runId ? null : prev))
        setScanProgress(null)
        if (status.state === 'error' && status.message) {
          setError(status.message)
        }
        // Re-fetch DB items + top lists without full navigation (avoids root listing bug)
        fetchDbItems(currentPath).then((fresh) => setDbItems(fresh))
        fetchTop()
      }
    })
    return () => { unsub() }
  }, [currentPath, fetchDbItems, fetchTop])

  const cancelScan = useCallback(async () => {
    if (scanning) {
      await window.lfb.cancelScan(scanning)
    }
  }, [scanning])

  /* ---- menu: reset DB ---- */

  useEffect(() => {
    const unsub = window.lfb.onMenuResetDb(() => {
      if (window.confirm('Reset the database? All scanned data will be lost.')) {
        resetDb()
      }
    })
    return () => { unsub() }
  }, [resetDb])

  /* ---- context menu ---- */

  const handleContextMenu = useCallback((e: React.MouseEvent, item: DisplayItem) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, item })
  }, [])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  /* ---- lifecycle ---- */

  useEffect(() => {
    navigateTo(null, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---- sorting ---- */

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortDir(key === 'name' ? 'asc' : 'desc')
      }
      return key
    })
  }, [])

  /* ---- derived ---- */

  const merged = currentPath
    ? mergeItems(fsEntries, dbItems, currentPath)
    : (() => {
        // At root: merge drives + DB roots
        const dbRoots = dbItems.map<DisplayItem>((r) => ({
          name: pathName(r.path), fullPath: r.path,
          isDirectory: r.type === 'Folder', sizeBytes: r.sizeBytes,
          fileCount: r.fileCount, folderCount: r.folderCount,
          lastWriteUtc: r.lastWriteUtc, scannedUtc: r.scannedUtc, hasDbData: true
        }))
        const seenPaths = new Set(dbRoots.map((r) => r.fullPath.toUpperCase()))
        const driveItems: DisplayItem[] = drives
          .filter((d) => !seenPaths.has(d.path.toUpperCase()))
          .map((d) => ({
            name: d.label, fullPath: d.path,
            isDirectory: true, sizeBytes: 0,
            fileCount: 0, folderCount: 0,
            lastWriteUtc: '', scannedUtc: '', hasDbData: false
          }))
        return [...driveItems, ...dbRoots]
      })()
  const sorted = sortItems(merged, sortKey, sortDir)
  const breadcrumbs = buildBreadcrumbs(currentPath)
  const isScanning = scanning !== null

  const sortArrow = (key: SortKey) => {
    if (sortKey !== key) return ''
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC'
  }

  /* ---- sidebar resize ---- */
  const onSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    sidebarDragRef.current = { startX: e.clientX, startW: sidebarWidth }
    const onMove = (ev: MouseEvent) => {
      if (!sidebarDragRef.current) return
      const delta = sidebarDragRef.current.startX - ev.clientX
      setSidebarWidth(Math.max(180, Math.min(800, sidebarDragRef.current.startW + delta)))
    }
    const onUp = () => {
      sidebarDragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [sidebarWidth])

  /* ========== render ========== */

  return (
    <div
      style={{ display: 'flex', height: '100vh', fontFamily: FONT, fontSize: 13, color: '#222' }}
      onClick={closeContextMenu}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Backspace') { e.preventDefault(); goBack() } }}
    >
      {/* Main Panel */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Toolbar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px',
          borderBottom: `1px solid ${BORDER}`, background: HEADER_BG, flexShrink: 0
        }}>
          <button data-testid="back-btn" onClick={goBack} disabled={pathHistory.length === 0}
            title="Back" style={btnStyle}>{'\u2190'}</button>
          <button data-testid="up-btn" onClick={goUp} disabled={!currentPath}
            title="Up one level" style={btnStyle}>{'\u2191'}</button>
          <button data-testid="refresh-btn" onClick={refreshCurrent} disabled={loading}
            title="Refresh" style={btnStyle}>{'\u27F3'}</button>

          {/* Address bar */}
          <div data-testid="breadcrumbs" style={{
            flex: 1, display: 'flex', alignItems: 'center', gap: 0,
            background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 3,
            padding: '2px 6px', overflow: 'hidden', whiteSpace: 'nowrap', minWidth: 0
          }}>
            {breadcrumbs.map((bc, i) => (
              <span key={bc.path ?? 'root'} style={{ display: 'inline-flex', alignItems: 'center' }}>
                {i > 0 && <span style={{ margin: '0 2px', color: '#aaa', fontSize: 10 }}>{'\u203A'}</span>}
                <a
                  href="#"
                  data-testid={`breadcrumb-${i}`}
                  onClick={(e) => { e.preventDefault(); navigateTo(bc.path) }}
                  style={{
                    fontWeight: i === breadcrumbs.length - 1 ? 600 : 400,
                    textDecoration: 'none', color: '#0078d4', fontSize: 12
                  }}
                >{bc.label}</a>
              </span>
            ))}
          </div>

          <button data-testid="pick-folder-btn" onClick={pickFolder} disabled={isScanning}
            style={btnStyle}>{isScanning ? '\u23F3' : '\uD83D\uDCC2'} Open</button>
        </div>

        {/* Status bar */}
        {(error || isScanning) && (
          <div style={{
            padding: '2px 8px', fontSize: 11, borderBottom: `1px solid ${BORDER}`,
            background: error ? '#fff0f0' : '#fffff0', flexShrink: 0,
            display: 'flex', alignItems: 'center', gap: 8
          }}>
            {error && <span data-testid="error-msg" style={{ color: 'red' }}>{error}</span>}
            {isScanning && (
              <>
                <button
                  data-testid="cancel-scan-btn"
                  onClick={cancelScan}
                  style={{ ...btnStyle, fontSize: 10, padding: '1px 6px', color: '#c00', borderColor: '#c00' }}
                >Cancel</button>
                <span data-testid="scanning-indicator" style={{ color: '#886' }}>
                  {scanProgress
                    ? `Scanning\u2026 ${scanProgress.itemsScanned.toLocaleString()} items`
                    : 'Scanning\u2026'}
                </span>
                {scanProgress?.currentPath && (
                  <span style={{ color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300, fontSize: 10 }}>
                    {scanProgress.currentPath}
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {/* Empty state */}
        {!loading && sorted.length === 0 && !isScanning && (
          <div data-testid="empty-state" style={{ padding: 24, textAlign: 'center', color: '#888' }}>
            {currentPath
              ? 'This folder is empty or has not been scanned yet.'
              : 'No drives found.'}
          </div>
        )}

        {/* Items list */}
        {sorted.length > 0 && (
          <div style={{ flex: 1, overflow: 'auto' }}>
            <table data-testid="item-table" style={{
              width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed'
            }}>
              <thead>
                <tr style={{
                  background: HEADER_BG, borderBottom: `1px solid ${BORDER}`,
                  position: 'sticky', top: 0, zIndex: 1
                }}>
                  <th style={{ ...thStyle, width: '45%', cursor: 'pointer' }} onClick={() => toggleSort('name')}>
                    Name{sortArrow('name')}
                  </th>
                  <th style={{ ...thStyle, width: 90, cursor: 'pointer', textAlign: 'right' }} onClick={() => toggleSort('size')}>
                    Size{sortArrow('size')}
                  </th>
                  <th style={{ ...thStyle, width: 50, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('files')}>
                    Files{sortArrow('files')}
                  </th>
                  <th style={{ ...thStyle, width: 60, textAlign: 'right', cursor: 'pointer' }} onClick={() => toggleSort('folders')}>
                    Folders{sortArrow('folders')}
                  </th>
                  <th style={{ ...thStyle, width: 130, cursor: 'pointer' }} onClick={() => toggleSort('modified')}>
                    Modified{sortArrow('modified')}
                  </th>
                  <th style={{ ...thStyle, width: 130, cursor: 'pointer' }} onClick={() => toggleSort('lastDeepScan')}>
                    Last Size Check{sortArrow('lastDeepScan')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* ".." row */}
                {currentPath && (
                  <tr
                    data-testid="up-row"
                    onDoubleClick={goUp}
                    style={{ height: ROW_HEIGHT, cursor: 'pointer', borderBottom: `1px solid ${BORDER}` }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = HOVER_BG)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                  >
                    <td style={tdStyle} colSpan={6}>
                      <span style={{ marginRight: 6 }}>{'\uD83D\uDCC1'}</span>
                      <span style={{ fontWeight: 600 }}>..</span>
                    </td>
                  </tr>
                )}
                {sorted.map((item) => {
                  const isSel = selectedPath === item.fullPath
                  return (
                    <tr
                      key={item.fullPath}
                      data-testid="item-row"
                      data-item-type={item.isDirectory ? 'Folder' : 'File'}
                      data-item-name={item.name}
                      onClick={() => setSelectedPath(item.fullPath)}
                      onDoubleClick={() => item.isDirectory && navigateTo(item.fullPath)}
                      onContextMenu={(e) => handleContextMenu(e, item)}
                      style={{
                        height: ROW_HEIGHT,
                        cursor: item.isDirectory ? 'pointer' : 'default',
                        borderBottom: `1px solid ${BORDER}`,
                        background: isSel ? SELECTED_BG : undefined
                      }}
                      onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = HOVER_BG }}
                      onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = '' }}
                    >
                      <td style={tdStyle}>
                        <span style={{ marginRight: 6, fontSize: 14, verticalAlign: 'middle' }}>
                          {item.isDirectory ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}
                        </span>
                        <span data-testid="item-name" title={item.fullPath} style={{
                          fontWeight: item.isDirectory ? 600 : 400,
                          opacity: item.hasDbData ? 1 : 0.6
                        }}>
                          {currentPath === null ? item.fullPath : item.name}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }} data-testid="item-size">
                        {item.sizeBytes > 0 || item.hasDbData ? formatSize(item.sizeBytes) : '\u2014'}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#888' }}>
                        {item.hasDbData ? item.fileCount : ''}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#888' }}>
                        {item.hasDbData ? item.folderCount : ''}
                      </td>
                      <td style={{ ...tdStyle, color: '#888', fontSize: 11 }}>
                        {item.lastWriteUtc ? new Date(item.lastWriteUtc).toLocaleString() : ''}
                      </td>
                      <td style={{ ...tdStyle, color: '#888', fontSize: 11 }}>
                        {item.scannedUtc ? new Date(item.scannedUtc).toLocaleString() : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer */}
        <div style={{
          padding: '3px 8px', fontSize: 11, color: '#888',
          borderTop: `1px solid ${BORDER}`, background: HEADER_BG, flexShrink: 0
        }}>
          {sorted.length} item{sorted.length !== 1 ? 's' : ''}
          {sorted.length > 0 && ` \u2014 ${formatSize(sorted.reduce((s, i) => s + Math.max(0, i.sizeBytes), 0))} total`}
        </div>
      </div>

      {/* Sidebar resize handle */}
      <div
        onMouseDown={onSidebarDragStart}
        style={{
          width: 5, cursor: 'col-resize', flexShrink: 0,
          background: 'transparent', position: 'relative', zIndex: 2,
          marginRight: -3, marginLeft: -2
        }}
        title="Drag to resize"
      />
      {/* Sidebar */}
      <div style={{
        width: sidebarWidth, borderLeft: `1px solid ${BORDER}`, overflow: 'auto',
        display: 'flex', flexDirection: 'column', fontSize: 12, flexShrink: 0
      }}>
        {/* Tabs */}
        <div style={{
          display: 'flex', borderBottom: `1px solid ${BORDER}`, background: HEADER_BG, flexShrink: 0
        }}>
          {(['folders', 'files'] as const).map((tab) => (
            <button
              key={tab}
              data-testid={`sidebar-tab-${tab}`}
              onClick={() => setSidebarTab(tab)}
              style={{
                flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 600,
                border: 'none', cursor: 'pointer',
                background: sidebarTab === tab ? '#fff' : 'transparent',
                borderBottom: sidebarTab === tab ? '2px solid #0078d4' : '2px solid transparent',
                color: sidebarTab === tab ? '#0078d4' : '#666'
              }}
            >{tab === 'folders' ? 'Top Folders' : 'Top Files'}</button>
          ))}
        </div>
        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 0 }}>
          {(() => {
            const items = sidebarTab === 'folders' ? topFolders : topFiles
            if (items.length === 0) return <p style={{ color: '#aaa', margin: 0, padding: '12px 10px' }}>No data</p>
            const maxSize = Math.max(...items.slice(0, 20).map((f) => f.sizeBytes), 1)
            return (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: HEADER_BG, borderBottom: `1px solid ${BORDER}` }}>
                    <th style={{ ...sideThStyle, width: 24, textAlign: 'right' }}>#</th>
                    <th style={{ ...sideThStyle, width: 64, textAlign: 'right' }}>Size</th>
                    <th style={{ ...sideThStyle }}>Path</th>
                  </tr>
                </thead>
                <tbody>
                  {items.slice(0, 20).map((f, i) => {
                    const pct = (f.sizeBytes / maxSize) * 100
                    return (
                      <tr key={f.path}
                        style={{ cursor: 'pointer', borderBottom: `1px solid ${BORDER}`, background: i % 2 === 0 ? '#fff' : '#fafafa' }}
                        onDoubleClick={() => sidebarTab === 'folders' ? navigateTo(f.path) : window.lfb.showInExplorer(f.path)}
                        onContextMenu={(e) => {
                          e.preventDefault(); e.stopPropagation()
                          setContextMenu({ x: e.clientX, y: e.clientY, item: {
                            name: pathName(f.path), fullPath: f.path, isDirectory: sidebarTab === 'folders',
                            sizeBytes: f.sizeBytes, fileCount: f.fileCount, folderCount: f.folderCount,
                            lastWriteUtc: f.lastWriteUtc, scannedUtc: f.scannedUtc, hasDbData: true
                          }})
                        }}
                      >
                        <td style={{ padding: '2px 4px', textAlign: 'right', color: '#aaa', fontSize: 10 }}>{i + 1}</td>
                        <td style={{ padding: '2px 6px', textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap', fontSize: 11 }}>{formatSize(f.sizeBytes)}</td>
                        <td style={{ padding: '2px 6px', position: 'relative', overflow: 'hidden' }}>
                          <div style={{
                            position: 'absolute', left: 0, top: 0, bottom: 0,
                            width: `${pct}%`, background: sidebarTab === 'folders' ? 'rgba(0,120,212,.10)' : 'rgba(212,100,0,.10)',
                            transition: 'width .2s'
                          }} />
                          <span style={{
                            position: 'relative', display: 'block',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            color: '#444', fontSize: 11
                          }} title={f.path}>{f.path}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          })()}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          data-testid="context-menu"
          style={{
            position: 'fixed', top: contextMenu.y, left: contextMenu.x,
            background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 4,
            boxShadow: '0 2px 10px rgba(0,0,0,.18)', zIndex: 1000,
            minWidth: 200, padding: '4px 0', fontSize: 13
          }}
        >
          {contextMenu.item.isDirectory && (
            <>
              <CtxItem testId="ctx-open-folder" label="Open" onClick={() => {
                const p = contextMenu.item.fullPath; closeContextMenu(); navigateTo(p)
              }} />
              <CtxItem testId="ctx-folder-size-check" label="Folder size check (recursive, full)" onClick={() => {
                const p = contextMenu.item.fullPath; closeContextMenu(); folderSizeCheck(p)
              }} />
              <CtxItem testId="ctx-folder-continue" label="Folder size check (recursive, incremental)" onClick={() => {
                const p = contextMenu.item.fullPath; closeContextMenu()
                // Default cutoff: 7 days ago
                const d = new Date(); d.setDate(d.getDate() - 7)
                setContinueCutoff(d.toISOString().slice(0, 16))
                setContinueModal({ folderPath: p })
              }} />
              <CtxItem testId="ctx-scan-shallow" label="Quick scan (shallow)" onClick={() => {
                const p = contextMenu.item.fullPath; closeContextMenu()
                window.lfb.scan({ startPath: p, mode: 'shallow' }).then(refreshCurrent)
              }} />
              <div style={{ borderTop: `1px solid ${BORDER}`, margin: '4px 0' }} />
            </>
          )}
          <CtxItem testId="ctx-open-explorer" label="Open in File Explorer" onClick={() => {
            const p = contextMenu.item.fullPath; closeContextMenu()
            window.lfb.showInExplorer(p)
          }} />
        </div>
      )}

      {/* Continue scan modal */}
      {continueModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000
        }}
          onClick={() => setContinueModal(null)}
        >
          <div style={{
            background: '#fff', borderRadius: 6, padding: 20, minWidth: 340,
            boxShadow: '0 4px 20px rgba(0,0,0,.25)', fontSize: 13
          }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Folder size check (incremental)</h3>
            <p style={{ margin: '0 0 12px', color: '#555' }}>
              Skip directories already scanned after:
            </p>
            <input
              data-testid="continue-cutoff"
              type="datetime-local"
              value={continueCutoff}
              onChange={(e) => setContinueCutoff(e.target.value)}
              style={{ width: '100%', padding: '4px 6px', fontSize: 13, marginBottom: 14 }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={btnStyle} onClick={() => setContinueModal(null)}>Cancel</button>
              <button
                data-testid="continue-scan-btn"
                style={{ ...btnStyle, background: '#0078d4', color: '#fff', borderColor: '#0078d4' }}
                onClick={() => {
                  const p = continueModal.folderPath
                  setContinueModal(null)
                  folderSizeContinue(p, continueCutoff)
                }}
              >Start</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---- small components ---- */

function CtxItem({ testId, label, onClick }: { testId: string; label: string; onClick: () => void }) {
  return (
    <div
      data-testid={testId}
      style={{ padding: '5px 14px', cursor: 'pointer' }}
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#e8e8e8')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {label}
    </div>
  )
}

/* ---- shared styles ---- */

const btnStyle: React.CSSProperties = {
  padding: '3px 8px', fontSize: 12, border: `1px solid ${BORDER}`,
  borderRadius: 3, background: '#fff', cursor: 'pointer', whiteSpace: 'nowrap'
}

const thStyle: React.CSSProperties = {
  padding: '3px 8px', fontSize: 11, fontWeight: 600, textAlign: 'left',
  whiteSpace: 'nowrap', userSelect: 'none', lineHeight: '20px'
}

const tdStyle: React.CSSProperties = {
  padding: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap', lineHeight: `${ROW_HEIGHT}px`, verticalAlign: 'middle'
}

const sideThStyle: React.CSSProperties = {
  padding: '3px 6px', fontSize: 10, fontWeight: 600, textAlign: 'left',
  whiteSpace: 'nowrap', userSelect: 'none', lineHeight: '18px'
}
