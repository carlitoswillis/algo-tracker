// Standalone production server. Replaces the Vercel deployment: no edge
// functions, no Redis, no password — this is meant to run on a private
// network (e.g. behind Tailscale) under pm2.
//
// The log and the catalog are read from the data directory (ALGO_DATA_DIR,
// default ./data) — see lib/data-dir.js — so nothing this server serves is
// kept in the source tree.
//
// Serves the built `dist/` directory statically, and backs /api/state with
// the SAME file-backed handler the Vite dev server uses (lib/local-state.js),
// so the client and the browser extension see identical behaviour whether
// they're talking to `npm run dev` or this server. /api/plan is served the
// same way: one read-only view of today's ranked session, for other programs.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleStateRequest } from './lib/local-state.js'
import { handlePlanRequest } from './lib/plan-api.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distDir = path.join(__dirname, 'dist')

const PORT = Number(process.env.ALGO_TRACKER_PORT ?? 7790)
// Loopback by default — with no auth on /api/state (see the header comment
// above), binding wider than that hands read/write access to anyone who can
// reach the port. Opt in explicitly for a shared machine (Tailscale, LAN)
// with ALGO_TRACKER_LAN=1, or set ALGO_TRACKER_HOST directly for full control.
const HOST = process.env.ALGO_TRACKER_HOST ?? (process.env.ALGO_TRACKER_LAN === '1' ? '0.0.0.0' : '127.0.0.1')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// Any origin is allowed on the API routes: the extension calls /api/state
// cross-origin, and with no password on a private network there is nothing to
// protect. Authorization is allowed through, not checked: this server never
// reads it, but a reverse proxy sitting in front of it (see
// openwiki/deployment/authentication.md) might, and the extension will send
// the password the user configured either way.
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

// Resolve a URL pathname to a file inside dist/, guarding against directory
// traversal — the resolved path must stay inside distDir.
function resolveStatic(pathname) {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return null }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const resolved = path.resolve(distDir, rel)
  if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) return null
  return resolved
}

// Vite hashes everything under assets/, so those can be cached forever; the
// HTML that names them must always be revalidated, or a rebuild is invisible
// until the browser feels like checking.
function serveFile(res, filePath) {
  const ext = path.extname(filePath)
  const contentType = MIME[ext] ?? 'application/octet-stream'
  const body = fs.readFileSync(filePath)
  const hashed = filePath.startsWith(path.join(distDir, 'assets') + path.sep)
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  res.end(body)
}

function serveIndexFallback(res) {
  const indexPath = path.join(distDir, 'index.html')
  if (fs.existsSync(indexPath)) {
    serveFile(res, indexPath)
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found. Run `npm run build` first.')
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/api/state' || url.pathname === '/api/plan') {
    setCors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const handle = url.pathname === '/api/plan' ? handlePlanRequest : handleStateRequest
    const handled = handle(req, res, { dir: __dirname })
    if (handled) return
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed.' }))
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' })
    res.end('Method not allowed.')
    return
  }

  const resolved = resolveStatic(url.pathname)
  if (!resolved) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('Bad request.')
    return
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    serveFile(res, resolved)
    return
  }

  // Unknown non-API path: fall back to index.html (SPA routing) if dist/
  // exists at all.
  serveIndexFallback(res)
})

server.listen(PORT, HOST, () => {
  console.log(`algo-tracker listening on http://${HOST}:${PORT}`)
})
