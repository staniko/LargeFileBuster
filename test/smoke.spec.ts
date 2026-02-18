import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

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
    const { app, page } = await launch()
    await resetAndWait(page)
    await seedFolder(page, testDir)

    const dirName = path.basename(testDir)
    await page.locator(`[data-item-name="${dirName}"]`).dblclick()
    await expect(page.locator('[data-item-name="subdir-b"]')).toBeVisible({ timeout: 15_000 })

    // Before: shallow = file.txt only → 30 KB
    const row = page.locator('tr[data-item-name="subdir-b"]')
    await expect(row.getByTestId('item-size')).toHaveText('30 KB')

    // Right-click → Folder size check
    await page.locator('[data-item-name="subdir-b"]').click({ button: 'right' })
    await page.getByTestId('ctx-folder-size-check').click()

    // After recursive: 30K + 100K = 130 KB (wait for refresh after async scan)
    await expect(row.getByTestId('item-size')).toHaveText('130 KB', { timeout: 30_000 })
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
   Level 3 — Async scanning with real folder (C:\dev\tools)
   ================================================================ */

test.describe('async scanning', () => {
  const TOOLS_DIR = 'C:\\dev\\tools'

  test.beforeAll(() => {
    // Skip this test suite if C:\dev\tools doesn't exist
    if (!fs.existsSync(TOOLS_DIR)) {
      test.skip()
    }
  })

  test('full scan is non-blocking — UI stays responsive during scan', async () => {
    test.setTimeout(60_000)
    const { app, page } = await launch()
    await resetAndWait(page)

    // Navigate into C:\ drive
    await page.locator('[data-item-name="C:\\\\"]').dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })

    // Navigate into dev folder
    await page.locator('[data-item-name="dev"]').dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })

    // Navigate into tools folder
    await page.locator('[data-item-name="tools"]').dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })

    // Pick the first subfolder and right-click → Folder size check (full recursive scan)
    const firstFolder = page.locator('[data-item-type="Folder"]').first()
    const folderName = await firstFolder.getAttribute('data-item-name')
    expect(folderName).toBeTruthy()
    await firstFolder.click({ button: 'right' })
    await page.getByTestId('ctx-folder-size-check').click()

    // The scanning indicator should appear quickly (scan may also finish fast)
    const indicatorAppeared = await page.getByTestId('scanning-indicator')
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false)

    // Verify UI is responsive during scan: click up button
    await page.getByTestId('up-btn').click()
    // Should navigate up to C:\dev — items should appear
    await expect(page.locator('[data-item-name="tools"]')).toBeVisible({ timeout: 5_000 })

    // Navigate back to tools
    await page.locator('[data-item-name="tools"]').dblclick()
    await expect(page.getByTestId('item-row')).not.toHaveCount(0, { timeout: 10_000 })

    // Cancel the scan if still running
    const cancelBtn = page.getByTestId('cancel-scan-btn')
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click({ timeout: 2_000 }).catch(() => {})
    }

    // Scanning indicator should be gone
    await expect(page.getByTestId('scanning-indicator')).not.toBeVisible({ timeout: 15_000 })

    await app.close()
  })
})
