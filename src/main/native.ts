import path from 'node:path'
import { ItemRecord } from '../shared/types'

// Load the native addon
const nativeAddon = require(path.join(__dirname, '../../native/build/Release/lfb_native.node'))

export interface NativeDatabase {
  openDatabase(dbPath: string): { success: boolean; dbPath: string }
  closeDatabase(): boolean
  resetDatabase(): boolean
  upsertItems(items: ItemRecord[]): boolean
  getChildren(parent: string | null, limit?: number, offset?: number, sort?: string, includeFiles?: boolean): { items: ItemRecord[]; total: number }
  getItemByPath(path: string): ItemRecord | null
  getRoots(limit?: number, sort?: string): { items: ItemRecord[]; total: number }
  getTop(type: string, limit?: number): ItemRecord[]
  scanShallow(startPath: string): string
}

export const native: NativeDatabase = nativeAddon
