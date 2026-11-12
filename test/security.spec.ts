import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LfbApi } from '../src/preload/preload'

declare global {
  interface Window {
    lfb: LfbApi
  }
}

/*
 * Security regression tests. Each one pins down a way the app could be
 * turned against its user, and fails if that door opens again.
 */

const projectRoot = path.resolve(__dirname, '..')
const APP_URL = 'app://lfb/index.html'

async function launch(cwd = projectRoot): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env } as Record<string, string>
  delete env.NODE_ENV // dev mode would load the UI from the Vite server instead
  const app = await electron.launch({ args: [projectRoot], cwd, env, timeout: 30_000 })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('breadcrumbs')).toBeVisible({ timeout: 15_000 })
  return { app, page }
}

/** Runs `call` in the page. Returns the error text if it fails, or null if it succeeds. */
async function rejection(page: Page, call: (arg: any) => Promise<unknown>, arg?: unknown): Promise<string | null> {
  try {
    await page.evaluate(call, arg)
    return null
  } catch (error) {
    return String(error)
  }
}

let tempDir: string
let foreignPageUrl: string

test.beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-sec-'))
  const foreignPage = path.join(tempDir, 'foreign.html')
  fs.writeFileSync(foreignPage, '<!doctype html><title>Foreign page</title><p>not the app</p>')
  foreignPageUrl = pathToFileURL(foreignPage).toString()
  fs.mkdirSync(path.join(tempDir, 'scanned'))
  fs.writeFileSync(path.join(tempDir, 'scanned', 'file.bin'), Buffer.alloc(4096))
})

test.afterAll(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

test.describe('renderer lockdown', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    ({ app, page } = await launch())
  })
  test.afterAll(async () => {
    await app.close()
  })

  test('UI is served from the private app:// origin', async () => {
    expect(page.url()).toBe(APP_URL)
    expect(await page.evaluate(() => window.location.origin)).toBe('app://lfb')
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true)
  })

  test('renderer is sandboxed and has no Node.js access', async () => {
    const renderer = await app.evaluate(({ app, BrowserWindow }) => {
      const pid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
      const metric = app.getAppMetrics().find((candidate) => candidate.pid === pid)
      return {
        sandboxForced: app.commandLine.hasSwitch('enable-sandbox'),
        type: metric?.type,
        sandboxed: metric?.sandboxed,
        integrityLevel: metric?.integrityLevel
      }
    })
    expect(renderer.sandboxForced).toBe(true)
    expect(renderer.type).toBe('Tab')
    // The operating system's own view of the process (not reported on Linux).
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(renderer.sandboxed).toBe(true)
    }
    if (process.platform === 'win32') {
      expect(['untrusted', 'low']).toContain(renderer.integrityLevel)
    }

    const globals = await page.evaluate(() => ({
      process: typeof (window as any).process,
      require: typeof (window as any).require,
      module: typeof (window as any).module,
      gc: typeof (window as any).gc
    }))
    expect(globals).toEqual({ process: 'undefined', require: 'undefined', module: 'undefined', gc: 'undefined' })
  })

  test('app starts without violating its own Content-Security-Policy', async () => {
    const cspErrors: string[] = []
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) cspErrors.push(message.text())
    })
    await page.reload()
    await expect(page.getByTestId('breadcrumbs')).toBeVisible({ timeout: 15_000 })
    // The stylesheet that replaced the former inline <style> must be applied.
    const sheets = await page.evaluate(() => Array.from(document.styleSheets).map((sheet) => sheet.href))
    expect(sheets.some((href) => href?.startsWith('app://lfb/assets/'))).toBe(true)
    expect(cspErrors).toEqual([])
    page.removeAllListeners('console')
  })

  test('Content-Security-Policy blocks inline code, eval and network access', async () => {
    const result = await page.evaluate(async () => {
      const violations: string[] = []
      document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective))

      const script = document.createElement('script')
      script.textContent = 'window.__inlineScriptRan = true'
      document.head.appendChild(script)

      const style = document.createElement('style')
      style.textContent = 'body { outline: 3px solid red }'
      document.head.appendChild(style)

      // eval must be tested outside this evaluate() call: the debugger that
      // runs it is allowed to bypass the policy, page code is not.
      const evalBlocked = await new Promise<boolean>((resolve) => {
        setTimeout(() => {
          try {
            ;(0, eval)('1 + 1')
            resolve(false)
          } catch {
            resolve(true)
          }
        }, 0)
      })

      const fetchBlocked = await fetch('https://example.com/').then(() => false, () => true)
      await new Promise((resolve) => setTimeout(resolve, 100))

      return {
        inlineScriptRan: (window as any).__inlineScriptRan === true,
        inlineStyleApplied: getComputedStyle(document.body).outlineStyle === 'solid',
        evalBlocked,
        fetchBlocked,
        violations
      }
    })
    expect(result.inlineScriptRan).toBe(false)
    expect(result.inlineStyleApplied).toBe(false)
    expect(result.evalBlocked).toBe(true)
    expect(result.fetchBlocked).toBe(true)
    expect(result.violations).toEqual(expect.arrayContaining(['script-src-elem', 'style-src-elem', 'connect-src']))
  })

  test('permission requests are denied', async () => {
    expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied')
    const geolocation = await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)
    expect(geolocation).toBe('denied')
  })

  test('window.open is denied', async () => {
    // Includes targets Chromium itself would allow: a blank window and the app's own page.
    for (const target of ['about:blank', APP_URL, 'https://example.com/', foreignPageUrl]) {
      const opened = await page.evaluate((url) => window.open(url) !== null, target)
      expect(opened, target).toBe(false)
    }
    await page.waitForTimeout(500)
    const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(windowCount).toBe(1)
  })

  test('the window cannot be navigated away from the app', async () => {
    for (const target of [foreignPageUrl, 'https://example.com/', 'app://elsewhere/index.html']) {
      await page.evaluate((url) => { window.location.href = url }, target).catch(() => {})
      await page.waitForTimeout(500)
      expect(page.url()).toBe(APP_URL)
    }
    // …and the app is still alive afterwards.
    expect(Array.isArray(await page.evaluate(() => window.lfb.listDrives()))).toBe(true)
  })

  test('the session cannot reach the network', async () => {
    const outcome = await app.evaluate(async ({ net }) => {
      try {
        const response = await net.fetch('https://example.com/')
        return `reached the network: HTTP ${response.status}`
      } catch (error) {
        return String((error as Error).message)
      }
    })
    expect(outcome).toContain('ERR_BLOCKED_BY_CLIENT')
  })

  test('app:// serves the bundled UI and nothing else', async () => {
    const fetchStatus = (url: string) =>
      app.evaluate(async ({ net }, target) => {
        const response = await net.fetch(target)
        return { status: response.status, csp: response.headers.get('content-security-policy') ?? '' }
      }, url)

    const index = await fetchStatus(APP_URL)
    expect(index.status).toBe(200)
    expect(index.csp).toContain("default-src 'none'")
    expect(index.csp).not.toContain('unsafe')

    const outside = [
      'app://lfb/../../package.json',
      'app://lfb/..%2f..%2fpackage.json',
      'app://lfb/%2e%2e/%2e%2e/package.json',
      'app://lfb/assets/..%5c..%5c..%5cpackage.json',
      'app://lfb/assets/../../main/main.js',
      'app://lfb//etc/passwd',
      'app://lfb/C:/Windows/win.ini',
      'app://lfb/index.html%00.js',
      'app://elsewhere/index.html'
    ]
    for (const url of outside) {
      expect((await fetchStatus(url)).status, url).toBe(404)
    }
  })
})

test('IPC is refused for any page that is not the app', async () => {
  const { app, page } = await launch()
  // Only the main process can put a foreign page into the window at all
  // (navigation is blocked). Even then the page must not get file system access.
  await app.evaluate(async ({ BrowserWindow }, url) => {
    await BrowserWindow.getAllWindows()[0].loadURL(url)
  }, foreignPageUrl)
  await page.waitForLoadState('domcontentloaded')
  expect(await page.title()).toBe('Foreign page')

  const root = path.parse(tempDir).root
  expect(await rejection(page, (dir) => window.lfb.listDir(dir), root)).toContain('untrusted sender')
  expect(await rejection(page, (dir) => window.lfb.scan({ startPath: dir, mode: 'shallow' }), root)).toContain('untrusted sender')
  expect(await rejection(page, () => window.lfb.top({ type: 'File' }))).toContain('untrusted sender')
  expect(await rejection(page, () => window.lfb.resetDb())).toContain('untrusted sender')
  await app.close()
})

test('IPC arguments are validated and cannot wipe the database', async () => {
  const { app, page } = await launch()
  const scanned = path.join(tempDir, 'scanned')
  await page.evaluate(() => window.lfb.resetDb())
  await page.evaluate((dir) => window.lfb.scan({ startPath: dir, mode: 'shallow' }), scanned)
  const countFiles = async () => (await page.evaluate(() => window.lfb.top({ type: 'File', limit: 10 }))).length
  expect(await countFiles()).toBe(1)

  // A non-numeric limit used to surface as SQLite's "datatype mismatch",
  // which the app treated as a corrupt database and deleted.
  const badLimit = await rejection(page, (dir) => window.lfb.children({ parent: dir, limit: 'abc' as any }), scanned)
  expect(badLimit).toContain('Invalid request')
  expect(await countFiles()).toBe(1)

  const invalid: Array<[string, (arg: any) => Promise<unknown>]> = [
    ['children: null request', () => window.lfb.children(null as any)],
    ['children: negative limit', (dir) => window.lfb.children({ parent: dir, limit: -1 })],
    ['children: unknown sort', (dir) => window.lfb.children({ parent: dir, sort: 'path; DROP TABLE items' as any })],
    ['top: unknown type', () => window.lfb.top({ type: "File' OR 1=1 --" as any })],
    ['scan: relative path', () => window.lfb.scan({ startPath: '.', mode: 'shallow' })],
    ['scan: unknown mode', (dir) => window.lfb.scan({ startPath: dir, mode: 'everything' as any })],
    ['scan: bad date', (dir) => window.lfb.scan({ startPath: dir, mode: 'full', skipScannedAfter: 'yesterday-ish' })],
    ['listDir: relative path', () => window.lfb.listDir('..')],
    ['listDir: not a string', () => window.lfb.listDir(42 as any)],
    ['listDir: NUL byte', (dir) => window.lfb.listDir(`${dir}\0`)],
    ['showInExplorer: relative path', () => window.lfb.showInExplorer('some/file')],
    ['cancelScan: not a run id', () => window.lfb.cancelScan('../../etc/passwd')]
  ]
  for (const [label, call] of invalid) {
    expect(await rejection(page, call, scanned), label).toContain('Invalid request')
  }
  if (process.platform === 'win32') {
    const windowsOnly: Array<[string, (arg: any) => Promise<unknown>]> = [
      ['drive-relative path', () => window.lfb.listDir('C:temp')],
      ['root-relative path', () => window.lfb.listDir('\\Windows')],
      ['device namespace', () => window.lfb.listDir('\\\\.\\C:\\')],
      ['verbatim namespace', () => window.lfb.listDir('\\\\?\\C:\\')]
    ]
    for (const [label, call] of windowsOnly) {
      expect(await rejection(page, call), label).toContain('Invalid request')
    }
  }

  // Valid requests still work.
  const listing = await page.evaluate((dir) => window.lfb.listDir(dir), scanned)
  expect(listing.entries.map((entry: { name: string }) => entry.name)).toEqual(['file.bin'])
  const children = await page.evaluate((dir) => window.lfb.children({ parent: dir, limit: 2000, sort: 'size_desc', includeFiles: true }), scanned)
  expect(children.items.length).toBe(1)
  expect(await countFiles()).toBe(1)

  await page.evaluate(() => window.lfb.resetDb())
  await app.close()
})

test('listing a folder does not follow links', async () => {
  // Opening a folder must only describe the entries themselves. Following a
  // planted link would make the app touch whatever it points to, for example
  // a remote share.
  const dir = path.join(tempDir, 'links')
  const target = path.join(tempDir, 'link-target')
  fs.mkdirSync(dir)
  fs.mkdirSync(target)
  const longAgo = new Date('2001-01-01T00:00:00Z')
  fs.utimesSync(target, longAgo, longAgo)
  // A junction on Windows (needs no privileges), a symbolic link elsewhere.
  fs.symlinkSync(target, path.join(dir, 'link'), 'junction')

  const { app, page } = await launch()
  const listing = await page.evaluate((folder) => window.lfb.listDir(folder), dir)
  expect(listing.entries).toHaveLength(1)
  expect(listing.entries[0].name).toBe('link')
  // The link's own timestamp, not the one of the folder it points to.
  expect(new Date(listing.entries[0].lastWriteUtc).getUTCFullYear()).toBeGreaterThan(2001)
  await app.close()
})

test('SQLite WebAssembly is never loaded from the working directory', async () => {
  // Starting the app from a folder that contains a look-alike sql.js used to
  // make it load that file instead of its own.
  const trapDir = path.join(tempDir, 'trap')
  const planted = path.join(trapDir, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  fs.mkdirSync(path.dirname(planted), { recursive: true })
  fs.writeFileSync(planted, 'planted file, must never be loaded')

  const { app, page } = await launch(trapDir)
  const top = await page.evaluate(() => window.lfb.top({ type: 'File', limit: 1 }))
  expect(Array.isArray(top)).toBe(true)
  expect(fs.existsSync(path.join(trapDir, 'data'))).toBe(false)
  await app.close()
})
