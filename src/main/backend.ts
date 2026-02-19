/**
 * Configuration for selecting database and scanner implementation.
 * Set USE_NATIVE=true to use C++ native addon for better performance.
 * Set USE_NATIVE=false to use original TypeScript/sql.js implementation.
 */

const USE_NATIVE = process.env.USE_NATIVE === 'true'

// Import appropriate implementations based on configuration
let dbModule: any
let scannerModule: any

if (USE_NATIVE) {
  console.log('[LFB] Using NATIVE C++ implementation for database and scanner')
  dbModule = require('./db-native')
  scannerModule = require('./scanner-native')
} else {
  console.log('[LFB] Using JavaScript implementation for database and scanner')
  dbModule = require('./db')
  scannerModule = require('./scanner')
}

export const {
  openDatabase,
  resetDatabase,
  persistDatabase,
  upsertItems,
  getChildren,
  getRoots,
  getTop,
  getItemByPath
} = dbModule

export const {
  runScan,
  runScanAsync,
  activeScans
} = scannerModule

export { USE_NATIVE }
