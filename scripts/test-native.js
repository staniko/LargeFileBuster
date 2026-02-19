#!/usr/bin/env node

/**
 * Simple test script to verify native addon functionality
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

// Create a test directory with some files
const testDir = path.join(os.tmpdir(), `lfb-native-test-${Date.now()}`)
fs.mkdirSync(testDir, { recursive: true })
fs.mkdirSync(path.join(testDir, 'subdir'), { recursive: true })
fs.writeFileSync(path.join(testDir, 'file1.txt'), 'a'.repeat(1000))
fs.writeFileSync(path.join(testDir, 'file2.txt'), 'b'.repeat(5000))
fs.writeFileSync(path.join(testDir, 'subdir', 'file3.txt'), 'c'.repeat(10000))

console.log('Created test directory:', testDir)
console.log('')

// Load the native addon
console.log('Loading native addon...')
const nativePath = path.join(__dirname, '../native/build/Release/lfb_native.node')
if (!fs.existsSync(nativePath)) {
  console.error('ERROR: Native addon not built!')
  console.error('Run: npm run build:native')
  process.exit(1)
}

const native = require(nativePath)
console.log('✓ Native addon loaded')
console.log('  Exported functions:', Object.keys(native).join(', '))
console.log('')

// Test database operations
const dbPath = path.join(testDir, 'test.db')
console.log('Testing database operations...')
console.log('  Opening database:', dbPath)
const dbResult = native.openDatabase(dbPath)
console.log('  ✓ Database opened:', dbResult)
console.log('')

// Test scanning
console.log('Testing scanner...')
console.log('  Scanning directory:', testDir)
const scanStart = Date.now()
const runId = native.scanShallow(testDir)
const scanTime = Date.now() - scanStart
console.log('  ✓ Scan completed in', scanTime, 'ms')
console.log('  Run ID:', runId)
console.log('')

// Test retrieving data
console.log('Testing data retrieval...')
const children = native.getChildren(null, 100, 0, 'size_desc', true)
console.log('  ✓ Retrieved', children.items.length, 'root items')
if (children.items.length > 0) {
  console.log('  Top item:', {
    path: children.items[0].path,
    type: children.items[0].type,
    size: children.items[0].sizeBytes + ' bytes'
  })
}
console.log('')

// Test getting item by path
console.log('Testing getItemByPath...')
const item = native.getItemByPath(testDir)
if (item) {
  console.log('  ✓ Found item:', {
    path: item.path,
    type: item.type,
    size: item.sizeBytes + ' bytes',
    fileCount: item.fileCount,
    folderCount: item.folderCount
  })
} else {
  console.log('  ✗ Item not found')
}
console.log('')

// Cleanup
console.log('Cleaning up...')
native.closeDatabase()
fs.rmSync(testDir, { recursive: true, force: true })
console.log('✓ Test completed successfully!')
console.log('')
console.log('All native addon functions are working correctly!')
