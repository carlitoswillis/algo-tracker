// File-backed /api/state handler, shared by the Vite dev server
// (vite.config.js) and the standalone production server (server.mjs), so dev
// and prod behave identically against the log in the data directory. Where
// that directory is, and the fallback to an older install's file at the
// repository root, is lib/data-dir.js's business — not this file's. Uses the
// SAME write contract as everything else — lib/state-contract.js.
import fs from 'fs'
import { planWrite, readShape, SNAPSHOT_KEEP } from './state-contract.js'
import { resolveData } from './data-dir.js'

// Missing is a legitimate fallback (a fresh install has no state file yet);
// present-but-unparseable is not, and must never be silently treated as an
// empty log — that reads as rev 0 and lets the next write erase real history.
export const CORRUPT = Symbol('corrupt')
const readJson = (p, fallback) => {
  if (!fs.existsSync(p)) return fallback
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return CORRUPT }
}

// Writes filePath via a temp file plus rename, so a crash or full disk mid-write
// can never leave a truncated file in place of the real one.
const writeJsonAtomic = (filePath, data) => {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

// The one place that says where the log lives on disk, so anything else that
// wants to read it (lib/plan-api.js) reads the same file the same way.
export const stateFileFor = (dir) => resolveData(dir).statePath
export const readStateFile = (dir) => readJson(stateFileFor(dir), null)

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// A corrupt file on disk must 500, never fall back to an empty log — see the
// CORRUPT comment above. Returns true (and has already responded) if `value`
// is the corrupt sentinel.
const sendIfCorrupt = (res, value, path) => {
  if (value !== CORRUPT) return false
  send(res, 500, { error: `${path} exists but is not valid JSON. Fix or remove it by hand before writing again.` })
  return true
}

// Above this, something is wrong (the on-disk state is ~12KB): refuse before
// buffering the rest, rather than let an unauthenticated POST grow the
// process's memory without bound.
const MAX_BODY_BYTES = 1_000_000

// Handles GET/POST /api/state against the two JSON files in `dir`. Returns
// true if it handled the request (caller should not fall through to any
// other handling), false if the request wasn't for /api/state.
export function handleStateRequest(req, res, { dir }) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/api/state') return false

  const { statePath: filePath, snapshotsPath: snapsPath } = resolveData(dir)
  const readState = () => readStateFile(dir)
  const readSnaps = () => {
    const raw = readJson(snapsPath, [])
    return raw === CORRUPT ? CORRUPT : raw.sort((a, b) => b.rev - a.rev)
  }

  if (req.method === 'GET') {
    if (url.searchParams.has('history')) {
      const snaps = readSnaps()
      if (sendIfCorrupt(res, snaps, snapsPath)) return true
      send(res, 200, {
        keep: SNAPSHOT_KEEP,
        snapshots: snaps.map((s) => ({
          rev: s.rev, updatedAt: s.updatedAt ?? null, count: s.problems?.length ?? 0,
        })),
      })
      return true
    }
    if (url.searchParams.has('rev')) {
      const snaps = readSnaps()
      if (sendIfCorrupt(res, snaps, snapsPath)) return true
      const want = Number(url.searchParams.get('rev'))
      const snap = snaps.find((s) => s.rev === want)
      if (!snap) send(res, 404, { error: `Revision ${want} is no longer retained.` })
      else send(res, 200, readShape(snap))
      return true
    }
    const state = readState()
    if (sendIfCorrupt(res, state, filePath)) return true
    send(res, 200, readShape(state))
    return true
  }

  if (req.method === 'POST') {
    let body = ''
    let bytes = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        done = true
        send(res, 413, { error: 'Request body too large.' })
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (done) return
      let parsed
      try { parsed = JSON.parse(body) } catch { return send(res, 400, { error: 'Invalid JSON' }) }

      const state = readState()
      if (sendIfCorrupt(res, state, filePath)) return
      const plan = planWrite(state, parsed)
      if (plan.next) {
        // Keep the state being replaced, newest first, capped at SNAPSHOT_KEEP.
        if (plan.snapshot) {
          const snaps = readSnaps()
          if (sendIfCorrupt(res, snaps, snapsPath)) return
          const kept = [plan.snapshot, ...snaps.filter((s) => s.rev !== plan.snapshot.rev)]
          writeJsonAtomic(snapsPath, kept.slice(0, SNAPSHOT_KEEP))
        }
        writeJsonAtomic(filePath, plan.next)
      }
      send(res, plan.status, plan.body)
    })
    return true
  }

  return false
}
