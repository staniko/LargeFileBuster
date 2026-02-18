import { contextBridge, ipcRenderer } from 'electron'
import { ChildRequest, ScanRequest, TopRequest } from '../shared/types'

const api = {
  children: (req: ChildRequest) => ipcRenderer.invoke('children', req),
  top: (req: TopRequest) => ipcRenderer.invoke('top', req),
  scan: (req: ScanRequest) => ipcRenderer.invoke('scan', req),
  listDir: (dirPath: string) => ipcRenderer.invoke('list-dir', dirPath),
  listDrives: () => ipcRenderer.invoke('list-drives'),
  cancelScan: (runId: string) => ipcRenderer.invoke('cancel-scan', runId),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  resetDb: () => ipcRenderer.invoke('reset-db'),
  showInExplorer: (fullPath: string) => ipcRenderer.invoke('show-in-explorer', fullPath),
  onScanStatus: (cb: (status: any) => void) => {
    const handler = (_event: any, status: any) => cb(status)
    ipcRenderer.on('scan-status', handler)
    return () => ipcRenderer.removeListener('scan-status', handler)
  },
  onMenuResetDb: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('menu-reset-db', handler)
    return () => ipcRenderer.removeListener('menu-reset-db', handler)
  }
}

contextBridge.exposeInMainWorld('lfb', api)

export type LfbApi = typeof api

declare global {
  interface Window {
    lfb: LfbApi
  }
}
