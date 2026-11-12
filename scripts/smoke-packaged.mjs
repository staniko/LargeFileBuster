#!/usr/bin/env node
/*
 * Smoke test for the PACKAGED app: the binary users actually install.
 *
 * The Playwright suite in test/ drives the unpackaged sources, so it cannot
 * notice a build that is broken or weakened by packaging (asar layout, fuses,
 * integrity check, resource paths). This script starts the unpacked build
 * produced by electron-builder and checks that
 *
 *   1. the Electron fuses in the binary match package.json "build.electronFuses",
 *   2. the app starts and renders its UI from app://lfb/ even though it is
 *      launched in a hostile environment: NODE_ENV=development,
 *      ELECTRON_RUN_AS_NODE, a NODE_OPTIONS preload and a fake sql-wasm.wasm
 *      planted in the working directory must all be ignored,
 *   3. the database (SQLite/WebAssembly) and the IPC bridge work,
 *   4. the renderer is locked down (no Node, no gc, CSP enforced).
 *
 * Usage: electron-builder --dir (or a full build), then `npm run smoke:packaged`.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))

const APP_URL = 'app://lfb/index.html'
const TIMEOUT_MS = 60_000

let failures = 0
function check(ok, label, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` (${detail})` : ''}`)
}

function findExecutable() {
  const outDir = path.join(projectRoot, pkg.build?.directories?.output ?? 'dist')
  const product = pkg.build?.productName ?? pkg.name
  const candidates = {
    win32: [path.join(outDir, 'win-unpacked', `${product}.exe`)],
    linux: [path.join(outDir, 'linux-unpacked', pkg.name)],
    darwin: ['mac', 'mac-arm64', 'mac-universal'].map((dir) =>
      path.join(outDir, dir, `${product}.app`, 'Contents', 'MacOS', product)
    )
  }[process.platform] ?? []
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error(`No unpacked build found. Looked for:\n  ${candidates.join('\n  ')}\nRun electron-builder first.`)
  }
  return found
}

// How a fuse is stored in the binary: the ASCII characters '0' and '1'.
const FUSE_DISABLED = 0x30
const FUSE_ENABLED = 0x31

async function checkFuses(executable) {
  const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses')
  const expected = pkg.build?.electronFuses ?? {}
  const wire = await getCurrentFuseWire(executable)
  for (const [key, enabled] of Object.entries(expected)) {
    const option = FuseV1Options[key[0].toUpperCase() + key.slice(1)]
    const state = wire[option]
    check(
      option !== undefined && state === (enabled ? FUSE_ENABLED : FUSE_DISABLED),
      `fuse ${key} = ${enabled}`,
      option === undefined ? 'unknown fuse' : `binary has ${state === FUSE_ENABLED ? 'enabled' : state === FUSE_DISABLED ? 'disabled' : state}`
    )
  }
  check(Object.keys(expected).length > 0, 'fuses are configured in package.json')
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect(port, child, deadline) {
  const { chromium } = require('@playwright/test')
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`App exited early with code ${child.exitCode}`)
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 })
    } catch (error) {
      lastError = error
      await sleep(500)
    }
  }
  throw new Error(`Could not connect to the app: ${lastError?.message ?? 'timeout'}`)
}

async function findAppPage(browser, deadline) {
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages())
    const page = pages.find((candidate) => candidate.url().startsWith('app://'))
    if (page) return page
    await sleep(250)
  }
  const urls = browser.contexts().flatMap((context) => context.pages()).map((page) => page.url())
  throw new Error(`The app window never showed an app:// page. Open pages: ${JSON.stringify(urls)}`)
}

function killTree(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

async function main() {
  const executable = findExecutable()
  console.log(`Packaged app: ${executable}`)

  console.log('\nFuses')
  await checkFuses(executable)

  if (process.platform !== 'win32' && process.getuid?.() === 0) {
    throw new Error('The sandboxed app cannot be started as root. Run this script as a regular user.')
  }

  // A hostile launch environment. A correct build ignores all of it.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-smoke-profile-'))
  const trapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-smoke-cwd-'))
  const plantedWasm = path.join(trapDir, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  fs.mkdirSync(path.dirname(plantedWasm), { recursive: true })
  fs.writeFileSync(plantedWasm, 'planted file, must never be loaded')
  const preloadMarker = path.join(trapDir, 'node-options-was-honoured')
  const preloadScript = path.join(trapDir, 'preload.cjs')
  fs.writeFileSync(preloadScript, `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'x')\n`)

  const port = await getFreePort()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`], {
    cwd: trapDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: `--require="${preloadScript.replaceAll('\\', '/')}"`,
      // Not part of the attack: makes the app explain itself if it fails to start.
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })

  let browser
  let crashed = false
  try {
    const deadline = Date.now() + TIMEOUT_MS
    browser = await connect(port, child, deadline)
    const page = await findAppPage(browser, deadline)
    await page.waitForSelector('[data-testid="breadcrumbs"]', { timeout: Math.max(1_000, deadline - Date.now()) })

    console.log('\nStartup')
    check(page.url() === APP_URL, `UI is served from ${APP_URL}`, page.url())
    check((await page.title()) === 'LargeFileBuster', 'window title is set')
    check(!fs.existsSync(preloadMarker), 'NODE_OPTIONS is ignored')

    console.log('\nDatabase and IPC')
    const top = await page.evaluate(() => window.lfb.top({ type: 'File', limit: 1 }))
    check(Array.isArray(top), 'database answers queries (bundled SQLite WebAssembly loaded)')
    const dbFile = path.join(profileDir, 'data', 'lfb.sqlite')
    check(fs.existsSync(dbFile), 'database lives in the user data directory', dbFile)
    check(!fs.existsSync(path.join(trapDir, 'data')), 'nothing is written to the working directory')
    const drives = await page.evaluate(() => window.lfb.listDrives())
    check(Array.isArray(drives), 'drive listing works')
    if (process.platform === 'win32') {
      check(drives.length > 0, 'at least one drive is found', drives.map((drive) => drive.path).join(' '))
    }
    const listing = await page.evaluate((dir) => window.lfb.listDir(dir), trapDir)
    check(
      listing.entries.some((entry) => entry.name === 'preload.cjs'),
      'directory listing works'
    )
    const rejected = await page.evaluate(() =>
      window.lfb.listDir('relative/path').then(() => false, () => true)
    )
    check(rejected, 'relative paths are rejected')

    console.log('\nRenderer lockdown')
    const lockdown = await page.evaluate(async () => {
      const violations = []
      document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective))
      const script = document.createElement('script')
      script.textContent = 'window.__inlineScriptRan = true'
      document.head.appendChild(script)
      await new Promise((resolve) => setTimeout(resolve, 200))
      return {
        node: typeof window.process !== 'undefined' || typeof window.require !== 'undefined',
        gc: typeof window.gc !== 'undefined',
        inlineScriptRan: window.__inlineScriptRan === true,
        violations,
        popup: window.open('https://example.com/') !== null
      }
    })
    check(!lockdown.node, 'no Node.js in the renderer')
    check(!lockdown.gc, 'no gc() in the renderer')
    check(!lockdown.inlineScriptRan && lockdown.violations.length > 0, 'CSP blocks inline scripts', lockdown.violations.join(', '))
    check(!lockdown.popup, 'window.open is denied')
  } catch (error) {
    crashed = true
    throw error
  } finally {
    await browser?.close().catch(() => {})
    killTree(child)
    await sleep(500)
    for (const dir of [profileDir, trapDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // best effort: a temp directory is not worth failing for
      }
    }
    if ((failures > 0 || crashed) && output.trim()) {
      console.log(`\nApp output:\n${output.trim().split('\n').slice(-40).join('\n')}`)
    }
  }
}

main().then(
  () => {
    console.log(failures === 0 ? '\nPackaged app smoke test passed.' : `\nPackaged app smoke test FAILED (${failures} problem(s)).`)
    process.exit(failures === 0 ? 0 : 1)
  },
  (error) => {
    console.error(`\nPackaged app smoke test FAILED: ${error.message}`)
    process.exit(1)
  }
)
