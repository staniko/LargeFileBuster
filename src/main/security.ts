import { app, protocol } from 'electron'
import type { IpcMainInvokeEvent, Session, WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/* ============================================================
   Trust model

   The renderer is the only web content this app ever shows, and it is
   shipped with the app. Everything below makes sure it stays that way:
   the UI is served from a private app:// origin instead of file://,
   the window cannot be navigated anywhere else, no other window can be
   opened, and IPC is only answered when it comes from that origin.
   ============================================================ */

/**
 * Development mode needs BOTH an unpackaged checkout and NODE_ENV=development.
 * A packaged build must never be switched into dev mode by its environment,
 * because dev mode loads the UI from a local HTTP server.
 */
export const isDev = !app.isPackaged && process.env.NODE_ENV === 'development'

const DEFAULT_DEV_PORT = 5173

function resolveDevPort(): number {
  const raw = process.env.VITE_PORT
  if (!raw) return DEFAULT_DEV_PORT
  const port = Number(raw)
  if (!/^\d{1,5}$/.test(raw) || port < 1 || port > 65535) {
    console.warn(`Ignoring invalid VITE_PORT, using ${DEFAULT_DEV_PORT}`)
    return DEFAULT_DEV_PORT
  }
  return port
}

const devPort = resolveDevPort()

export const APP_SCHEME = 'app'
export const APP_HOST = 'lfb'

/** The one URL the main window is allowed to show. */
export const APP_ENTRY_URL = isDev
  ? `http://localhost:${devPort}/`
  : `${APP_SCHEME}://${APP_HOST}/index.html`

function isDevServerUrl(url: URL, protocols: readonly string[]): boolean {
  return (
    isDev &&
    protocols.includes(url.protocol) &&
    url.hostname === 'localhost' &&
    url.port === String(devPort) &&
    url.username === '' &&
    url.password === ''
  )
}

/** True if `rawUrl` belongs to the app's own UI origin. */
export function isTrustedAppUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (isDev) return isDevServerUrl(url, ['http:'])
  return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST
}

/* ============================================================
   app:// protocol — serves the bundled renderer files
   ============================================================ */

/**
 * Policy sent with every app:// response. Nothing is allowed by default;
 * scripts, styles, images and fonts may only come from the app itself.
 * No inline script or style, no eval, no network, no framing.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

function responseHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache'
  }
}

function textResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: responseHeaders('text/plain; charset=utf-8') })
}

/**
 * Maps every file below `root` to its URL path ("/assets/index.js").
 * Requests are answered from this fixed list only, so a request can never
 * reach a file outside the renderer bundle, whatever its path looks like.
 */
function indexRendererFiles(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string, urlPrefix: string) => {
    for (const name of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, name)
      const urlPath = `${urlPrefix}/${name}`
      if (fs.statSync(fullPath).isDirectory()) {
        walk(fullPath, urlPath)
      } else {
        files.set(urlPath, fullPath)
      }
    }
  }
  walk(root, '')
  return files
}

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

/** Must run once the app is ready and before the first window loads. */
export function registerAppProtocol(rendererRoot: string): void {
  const files = indexRendererFiles(rendererRoot)

  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(405, 'Method not allowed')
    }

    let pathname: string
    try {
      const url = new URL(request.url)
      if (url.host !== APP_HOST) return textResponse(404, 'Not found')
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return textResponse(400, 'Bad request')
    }
    if (pathname === '/') pathname = '/index.html'

    const filePath = files.get(pathname)
    if (!filePath) return textResponse(404, 'Not found')

    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    try {
      const body = await fs.promises.readFile(filePath)
      return new Response(new Uint8Array(body), { status: 200, headers: responseHeaders(contentType) })
    } catch {
      return textResponse(404, 'Not found')
    }
  })
}

/* ============================================================
   Session and window hardening
   ============================================================ */

/** Schemes that reach out to a network. The app itself never needs any of them. */
const NETWORK_URL_PATTERNS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*']

/**
 * Denies every permission request (camera, microphone, location, notifications,
 * USB, …; Electron grants them all by default) and cuts the session off from
 * the network. In dev mode only the local Vite server stays reachable.
 */
export function hardenSession(ses: Session): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)

  ses.webRequest.onBeforeRequest({ urls: NETWORK_URL_PATTERNS }, (details, callback) => {
    let allowed = false
    try {
      allowed = isDevServerUrl(new URL(details.url), ['http:', 'ws:'])
    } catch {
      allowed = false
    }
    callback({ cancel: !allowed })
  })
}

/**
 * Keeps a window on the app's own origin: no navigation or redirect to
 * anything else, no popups, no <webview>.
 */
export function hardenWebContents(contents: WebContents): void {
  // DevTools run in their own internal web contents; leave those alone.
  if (contents.getType() !== 'window') return

  const blockForeignNavigation = (event: { url: string; preventDefault: () => void }) => {
    if (!isTrustedAppUrl(event.url)) event.preventDefault()
  }
  contents.on('will-navigate', blockForeignNavigation)
  contents.on('will-frame-navigate', blockForeignNavigation)
  contents.on('will-redirect', blockForeignNavigation)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

/**
 * IPC is answered only for the top-level frame of a window that is currently
 * showing the app's own UI. Anything else that might end up in a renderer
 * (another page, an embedded frame) gets no access to the file system API.
 */
export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null) return false
  return isTrustedAppUrl(frame.url)
}
