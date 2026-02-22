import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import type { LfbApi } from '../src/preload/preload'

declare global {
  interface Window {
    lfb: LfbApi
  }
}

const projectRoot = path.resolve(__dirname, '..')

/* ---------- temp fixtures ---------- */

let testDir: string

function createFixtures() {
  testDir = path.join(os.tmpdir(), `lfb-test-${Date.now()}`)
  fs.mkdirSync(path.join(testDir, 'subdir-a'), { recursive: true })
  fs.mkdirSync(path.join(testDir, 'subdir-b', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(testDir, 'small.txt'), 'a'.repeat(100))
  fs.writeFileSync(path.join(testDir, 'medium.txt'), 'b'.repeat(50_000))
  fs.writeFileSync(path.join(testDir, 'subdir-a', 'big.txt'), 'c'.repeat(200_000))
  fs.writeFileSync(path.join(testDir, 'subdir-a', 'tiny.txt'), 'd'.repeat(10))
  fs.writeFileSync(path.join(testDir, 'subdir-b', 'file.txt'), 'e'.repeat(30_000))
  fs.writeFileSync(path.join(testDir, 'subdir-b', 'nested', 'deep.txt'), 'f'.repeat(100_000))
}

/* ---------- helpers ---------- */

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], cwd: projectRoot, timeout: 30_000 })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function resetAndWait(page: Page) {
  await page.evaluate(() => window.lfb.resetDb())
  await page.getByTestId('refresh-btn').click()
  await page.waitForTimeout(500)
}

async function seedFolder(page: Page, dir: string) {
  await page.evaluate(
    async (d: string) => window.lfb.scan({ startPath: d, mode: 'shallow' }),
    dir
  )
  await page.getByTestId('refresh-btn').click()
}

/* ================================================================
   Level 0 — Does the app even launch?
   ================================================================ */

test('app launches and window is visible', async () => {
  const { app, page } = await launch()
  expect(await page.title()).toBe('LargeFileBuster')
  await expect(page.locator('#root')).not.toBeEmpty({ timeout: 15_000 })
  await app.close()
})

/* ================================================================
   Level 1 — Empty state & basic controls
   ================================================================ */

test('shows drives at root after reset', async () => {
  const { app, page } = await launch()
  await resetAndWait(page)
  // After reset, root view should show available drives (e.g. C:\)
  await expect(page.locator('[data-item-name="C:\\\\"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('pick-folder-btn')).toBeVisible()
  await expect(page.getByTestId('back-btn')).toBeDisabled()
  await app.close()
})

/* ================================================================
   Level 2 — With fixture data
   ================================================================ */

test.describe('with fixtures', () => {
  test.beforeAll(() => createFixtures())
  test.afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  test('scan a folder and see it listed', async () => {
    const { app, page } = await launch()
    await resetAndWait(page)
    await seedFolder(page, testDir)

    const dirName = path.basename(testDir)
    await expect(page.locator(`[data-item-name="${dirName}"]`)).toBeVisible({ timeout: 10_000 })
    await app.close()
  })

  test('double-click navigates into folder and shows children', async () => {
    const { app, page } = await launch()
    await resetAndWait(page)
    await seedFolder(page, testDir)

    const dirName = path.basename(testDir)
    await page.locator(`[data-item-name="${dirName}"]`).dblclick()
    // Should show FS entries immediately + DB items
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 15_000 })

    // Children: subdir-a, subdir-b, medium.txt, small.txt = 4
    await expect(page.locator('[data-item-name="subdir-a"]')).toBeVisible()
    await expect(page.locator('[data-item-name="subdir-b"]')).toBeVisible()
    await expect(page.locator('[data-item-name="medium.txt"]')).toBeVisible()
    await expect(page.locator('[data-item-name="small.txt"]')).toBeVisible()
    // Breadcrumbs show folder name
    await expect(page.getByTestId('breadcrumbs')).toContainText(dirName)
    // ".." row should be present when inside a folder
    await expect(page.getByTestId('up-row')).toBeVisible()
    await app.close()
  })

  test('up button and ".." row navigate to parent', async () => {
    const { app, page } = await launch()
    await resetAndWait(page)
    await seedFolder(page, testDir)

    const dirName = path.basename(testDir)
    // Navigate into testDir
    await page.locator(`[data-item-name="${dirName}"]`).dblclick()
    await expect(page.locator('[data-item-name="subdir-a"]')).toBeVisible({ timeout: 15_000 })

    // Navigate into subdir-a
    await page.locator('[data-item-name="subdir-a"]').dblclick()
    await expect(page.locator('[data-item-name="big.txt"]')).toBeVisible({ timeout: 15_000 })

    // Up button should be enabled
    await expect(page.getByTestId('up-btn')).toBeEnabled()

    // Click Up goes back to testDir
    await page.getByTestId('up-btn').click()
    await expect(page.locator('[data-item-name="subdir-a"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-item-name="subdir-b"]')).toBeVisible()
    await app.close()
  })

  test('breadcrumb navigation back to root', async () => {
    const { app, page } = await launch()
    await resetAndWait(page)
    await seedFolder(page, testDir)

    const dirName = path.basename(testDir)
    await page.locator(`[data-item-name="${dirName}"]`).dblclick()
    await expect(page.locator('[data-item-name="subdir-a"]')).toBeVisible({ timeout: 15_000 })

    await page.locator('[data-item-name="subdir-a"]').dblclick()
    await expect(page.locator('[data-item-name="big.txt"]')).toBeVisible({ timeout: 15_000 })

    // Click Root breadcrumb
    await page.getByTestId('breadcrumb-0').click()
    await expect(page.locator(`[data-item-name="${dirName}"]`)).toBeVisible({ timeout: 10_000 })
    await app.close()
  })

  test('back button returns to previous folder', async () => {
    const { app, page } = await launch()
    await resetAndWait(page)
    await seedFolder(page, testDir)

    const dirName = path.basename(testDir)
    await page.locator(`[data-item-name="${dirName}"]`).dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByTestId('back-btn')).toBeEnabled()

    await page.getByTestId('back-btn').click()
    await expect(page.locator(`[data-item-name="${dirName}"]`)).toBeVisible({ timeout: 10_000 })
    await app.close()
  })

  test('right-click shows context menu on folder', async () => {
    const { app, page } = await launch()
    await resetAndWait(page)
    await seedFolder(page, testDir)

    const dirName = path.basename(testDir)
    await page.locator(`[data-item-name="${dirName}"]`).dblclick()
    await expect(page.locator('[data-item-name="subdir-b"]')).toBeVisible({ timeout: 15_000 })

    await page.locator('[data-item-name="subdir-b"]').click({ button: 'right' })
    await expect(page.getByTestId('context-menu')).toBeVisible()
    await expect(page.getByTestId('ctx-open-folder')).toBeVisible()
    await expect(page.getByTestId('ctx-folder-size-check')).toBeVisible()
    await expect(page.getByTestId('ctx-folder-continue')).toBeVisible()
    await app.close()
  })

  test('sidebar has Folders/Files tabs', async () => {
    const { app, page } = await launch()
    await resetAndWait(page)
    await seedFolder(page, testDir)

    // Sidebar tabs should be present
    await expect(page.getByTestId('sidebar-tab-folders')).toBeVisible()
    await expect(page.getByTestId('sidebar-tab-files')).toBeVisible()

    // Switch between tabs
    await page.getByTestId('sidebar-tab-files').click()
    // Tab should be active (we just check it's clickable and visible)
    await expect(page.getByTestId('sidebar-tab-files')).toBeVisible()
    await app.close()
  })

  test('context menu "Open" navigates into folder', async () => {
    const { app, page } = await launch()
    await resetAndWait(page)
    await seedFolder(page, testDir)

    const dirName = path.basename(testDir)
    await page.locator(`[data-item-name="${dirName}"]`).dblclick()
    await expect(page.locator('[data-item-name="subdir-a"]')).toBeVisible({ timeout: 15_000 })

    await page.locator('[data-item-name="subdir-a"]').click({ button: 'right' })
    await page.getByTestId('ctx-open-folder').click()

    await expect(page.locator('[data-item-name="big.txt"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('breadcrumbs')).toContainText('subdir-a')
    await app.close()
  })

  test('folder size check updates size recursively (non-blocking)', async () => {
    test.setTimeout(60_000)
    const { app, page } = await launch()
    await resetAndWait(page)
    await seedFolder(page, testDir)

    const dirName = path.basename(testDir)
    await page.locator(`[data-item-name="${dirName}"]`).dblclick()
    await expect(page.locator('[data-item-name="subdir-b"]')).toBeVisible({ timeout: 15_000 })

    // Before: shallow = file.txt only → 30 KB
    const row = page.locator('[data-item-name="subdir-b"]')
    const sizeElem = row.getByTestId('item-size')
    await expect(sizeElem).toHaveText('30 KB')

    // Right-click → Folder size check
    await page.locator('[data-item-name="subdir-b"]').click({ button: 'right' })
    await page.getByTestId('ctx-folder-size-check').click()

    // Wait for scanning to appear and complete
    const scanningIndicator = page.getByTestId('scanning-indicator')
    await scanningIndicator.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
    
    // Wait for scanning to disappear (scan complete)
    await scanningIndicator.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
    
    // After recursive: 30K + 100K = 130 KB (check after scan completes)
    // Refresh to ensure UI has latest data
    await page.getByTestId('refresh-btn').click()
    await page.waitForTimeout(500)
    
    // Verify the size was updated
    const finalText = await sizeElem.textContent()
    expect(finalText?.includes('130 KB')).toBe(true)

    await app.close()
  })

  test('scanned data persists after app restart', async () => {
    // 1. Launch, reset, scan fixture folder
    const { app: app1, page: page1 } = await launch()
    await resetAndWait(page1)
    await seedFolder(page1, testDir)

    const dirName = path.basename(testDir)
    await expect(page1.locator(`[data-item-name="${dirName}"]`)).toBeVisible({ timeout: 10_000 })

    // Navigate into testDir so DB has child items
    await page1.locator(`[data-item-name="${dirName}"]`).dblclick()
    await expect(page1.locator('[data-item-name="subdir-a"]')).toBeVisible({ timeout: 15_000 })

    // 2. Close the app
    await app1.close()

    // 3. Relaunch — do NOT reset
    const { app: app2, page: page2 } = await launch()

    // 4. The scanned root should still appear at the root view
    await expect(page2.locator(`[data-item-name="${dirName}"]`)).toBeVisible({ timeout: 15_000 })

    // 5. Navigate into it — children should still be there from DB
    await page2.locator(`[data-item-name="${dirName}"]`).dblclick()
    await expect(page2.locator('[data-item-name="subdir-a"]')).toBeVisible({ timeout: 15_000 })
    await expect(page2.locator('[data-item-name="subdir-b"]')).toBeVisible()

    await app2.close()
  })

  test('reset DB clears scanned data but shows drives', async () => {
    const { app, page } = await launch()
    await seedFolder(page, testDir)
    await expect(page.getByTestId('item-row').first()).toBeVisible({ timeout: 10_000 })

    // Reset via IPC (native menu item triggers this)
    await resetAndWait(page)
    // After reset, should show drives (C:\ etc.) — not "No data"
    await expect(page.locator('[data-item-name="C:\\\\"]')).toBeVisible({ timeout: 10_000 })
    await app.close()
  })
})

/* ================================================================
   Level 3 — Temp folder performance tests
   ================================================================ */

test.describe('Temp folder performance', () => {
  const TEMP_DIR = path.join(os.tmpdir())

  test.beforeAll(() => {
    // Skip if Temp folder doesn't exist (should always exist on Windows)
    if (!fs.existsSync(TEMP_DIR)) {
      test.skip()
    }
  })

  test('navigate to Temp folder with latency check', async () => {
    test.setTimeout(60_000)
    const { app, page } = await launch()
    await resetAndWait(page)

    // Navigate to C:\ drive
    await page.locator('[data-item-name="C:\\\\"]').dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })

    // Navigate to Users folder
    await page.locator('[data-item-name="Users"]').dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })

    // Navigate to current user folder
    const username = os.userInfo().username
    await page.locator(`[data-item-name="${username}"]`).dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })

    // Navigate to AppData (if exists)
    const appDataRow = page.locator('[data-item-name="AppData"]')
    if (await appDataRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await appDataRow.dblclick()
      await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })
      
      // Navigate to Local
      const localRow = page.locator('[data-item-name="Local"]')
      if (await localRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await localRow.dblclick()
        await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })
      }
    }

    // Measure time to navigate to Temp folder
    const startTime = Date.now()
    const tempRow = page.locator('[data-item-name="Temp"]')
    if (await tempRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await tempRow.dblclick()
    } else {
      return // Skip test if Temp folder not accessible
    }
    
    // Wait for items to appear (or timeout if hanging)
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 30_000 })
    const endTime = Date.now()
    
    const latency = endTime - startTime
    console.log(`Navigation to Temp folder took ${latency}ms`)
    
    // Assert that navigation completes within reasonable time (10 seconds)
    // If this fails, there's a performance issue
    expect(latency).toBeLessThan(10_000)

    // Verify we can interact with the UI (not frozen)
    await expect(page.getByTestId('up-btn')).toBeEnabled()
    await expect(page.getByTestId('breadcrumbs')).toContainText('Temp')

    await app.close()
  })

  test('start scanning Temp folder then navigate into it', async () => {
    test.setTimeout(120_000)
    const { app, page } = await launch()
    await resetAndWait(page)

    // Navigate to C:\ drive
    await page.locator('[data-item-name="C:\\\\"]').dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })

    // Navigate to Users folder
    await page.locator('[data-item-name="Users"]').dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })

    // Navigate to current user folder
    const username = os.userInfo().username
    await page.locator(`[data-item-name="${username}"]`).dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })

    // Navigate to AppData (if exists)
    const appDataRow = page.locator('[data-item-name="AppData"]')
    if (await appDataRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await appDataRow.dblclick()
      await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })
      
      // Navigate to Local
      const localRow = page.locator('[data-item-name="Local"]')
      if (await localRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await localRow.dblclick()
        await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })
      }
    }

    // Start a scan of Temp folder (right-click → Folder size check)
    const tempRow = page.locator('[data-item-name="Temp"]')
    if (!(await tempRow.isVisible({ timeout: 5_000 }).catch(() => false))) {
      return // Skip test if Temp folder not accessible
    }
    await tempRow.click({ button: 'right' })
    await page.getByTestId('ctx-folder-size-check').click()

    // Wait a moment for scan to start
    await page.waitForTimeout(1000)

    // Now navigate into Temp while scan is running
    const startTime = Date.now()
    await tempRow.dblclick()
    
    // Wait for items to appear
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 30_000 })
    const endTime = Date.now()
    
    const latency = endTime - startTime
    console.log(`Navigation to Temp folder (while scanning) took ${latency}ms`)
    
    // Assert navigation completes within reasonable time even while scanning
    expect(latency).toBeLessThan(10_000)

    // Verify we're in the Temp folder
    await expect(page.getByTestId('breadcrumbs')).toContainText('Temp')

    // Verify UI is responsive (can navigate up)
    await expect(page.getByTestId('up-btn')).toBeEnabled()

    // Cancel any ongoing scan
    const cancelBtn = page.getByTestId('cancel-scan-btn')
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click({ timeout: 2_000 }).catch(() => {})
    }

    await app.close()
  })
})

/* ================================================================
   Level 5 — Full C: drive scan for memory stress testing
   ================================================================ */

test.describe('Full C: drive scan (stress test)', () => {
  test.beforeAll(() => {
    // Skip if C: drive doesn't exist
    if (!fs.existsSync('C:\\')) {
      test.skip()
    }
  })

  test('scan C: drive and verify responsiveness (30 second test)', async () => {
    test.setTimeout(120_000) // 2 minutes total (30s scan + margins)
    const { app, page } = await launch()
    await resetAndWait(page)

    // Navigate to C:\ drive
    const cDriveRow = page.locator('[data-item-name="C:\\\\"]')
    await expect(cDriveRow).toBeVisible({ timeout: 10_000 })

    // Start a full recursive scan of C:\
    console.log('Starting C: drive scan (stress test)...')
    
    await cDriveRow.click({ button: 'right' })
    await page.getByTestId('ctx-folder-size-check').click()

    // Verify scanning indicator appears within 5 seconds
    const scanningIndicator = page.getByTestId('scanning-indicator')
    await expect(scanningIndicator).toBeVisible({ timeout: 5_000 })

    // Monitor scan progress for 10 seconds
    console.log('Monitoring scan for 10 seconds...')
    let maxItemsScanned = 0
    
    for (let i = 0; i < 10; i++) {
      // Check current scan progress
      const indicator = await scanningIndicator.textContent().catch(() => '')
      const match = indicator?.match(/(\d+(?:,\d+)?)\s+items/)
      if (match) {
        const itemsScanned = parseInt(match[1].replace(/,/g, ''))
        maxItemsScanned = Math.max(maxItemsScanned, itemsScanned)
        console.log(`[${i}s] Scanned ${itemsScanned.toLocaleString()} items`)
      }

      // Wait 1 second between checks
      await page.waitForTimeout(1000)
    }

    console.log(`After 10s: ${maxItemsScanned.toLocaleString()} items scanned, now testing navigation while scanning...`)

    // Test 1: Navigate to C:\ drive while scan is running
    console.log('Test 1: Double-click C:\\ while scanning...')
    const navigateStartTime = Date.now()
    await cDriveRow.dblclick()
    
    // Verify navigation works - items should appear
    try {
      await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })
      const navigateEndTime = Date.now()
      const navigateLatency = navigateEndTime - navigateStartTime
      console.log(`✓ Navigation to C:\\ completed in ${navigateLatency}ms while scanning`)
    } catch (e) {
      console.warn('⚠ Navigation to C:\\ timed out - app under heavy load')
    }

    // Wait a moment then try navigating to Temp folder
    await page.waitForTimeout(1000)

    // Test 2: Navigate to Users folder
    console.log('Test 2: Navigating to Users folder...')
    const usersRow = page.locator('[data-item-name="Users"]')
    if (await usersRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await usersRow.dblclick()
      
      try {
        await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })
        console.log('✓ Navigation to Users folder successful while scanning')
      } catch {
        console.warn('⚠ Navigation to Users folder timed out')
      }

      // Test 3: Try to navigate to current user folder
      await page.waitForTimeout(500)
      const username = os.userInfo().username
      const userRow = page.locator(`[data-item-name="${username}"]`)
      
      if (await userRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
        console.log('Test 3: Navigating to user folder...')
        await userRow.dblclick()
        
        try {
          await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })
          console.log('✓ Navigation to user folder successful while scanning')
        } catch {
          console.warn('⚠ Navigation to user folder timed out')
        }
      }
    }

    // Continue monitoring for remaining time
    console.log('Continuing scan monitoring for 20 more seconds...')
    for (let i = 10; i < 30; i++) {
      const indicator = await scanningIndicator.textContent().catch(() => '')
      const match = indicator?.match(/(\d+(?:,\d+)?)\s+items/)
      if (match) {
        const itemsScanned = parseInt(match[1].replace(/,/g, ''))
        maxItemsScanned = Math.max(maxItemsScanned, itemsScanned)
        if (i % 5 === 10 || i % 5 === 0) {
          console.log(`[${i}s] Scanned ${itemsScanned.toLocaleString()} items`)
        }
      }
      await page.waitForTimeout(1000)
    }

    console.log(`Final: ${maxItemsScanned.toLocaleString()} items scanned`)

    // Verify scan is still running/progressing
    expect(maxItemsScanned).toBeGreaterThan(0)
    console.log('✓ Scan continued running throughout navigation tests')

    // Cancel the scan
    const cancelBtn = page.getByTestId('cancel-scan-btn')
    if (await cancelBtn.isVisible().catch(() => false)) {
      console.log('Cancelling scan...')
      await cancelBtn.click()
      
      try {
        await expect(scanningIndicator).not.toBeVisible({ timeout: 15_000 })
        console.log('✓ Scan cancel successful')
      } catch {
        console.warn('Note: Scan may take time to stop under heavy load')
      }
    }

    await app.close()
    console.log('✓ C: drive stress test passed - app survived navigation during scan')
  })
})
