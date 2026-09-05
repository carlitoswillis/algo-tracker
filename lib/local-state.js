// File-backed /api/state handler, shared by the Vite dev server
// (vite.config.js) and the standalone production server (server.mjs), so dev
// and prod behave identically against the log in the data directory. Where
// that directory is, and the fallback to an older install's file at the
// repository root, is lib/data-dir.js's business — not this file's. Uses the
// SAME write contract as everything else — lib/state-contract.js.
import fs from 'fs'
import { planWrite, readShape, SNAPSHOT_KEEP } from './state-contract.js'
import { resolveData } from './data-dir.js'

const readJson = (p, fallback) => {
  if (!fs.existsSync(p)) return fallback
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return fallback }
}

// The one place that says where the log lives on disk, so anything else that
// wants to read it (lib/plan-api.js) reads the same file the same way.
export const stateFileFor = (dir) => resolveData(dir).statePath
export const readStateFile = (dir) => readJson(stateFileFor(dir), null)

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Handles GET/POST /api/state against the two JSON files in `dir`. Returns
// true if it handled the request (caller should not fall through to any
// other handling), false if the request wasn't for /api/state.
export function handleStateRequest(req, res, { dir }) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/api/state') return false

  const { statePath: filePath, snapshotsPath: snapsPath } = resolveData(dir)
  const readState = () => readStateFile(dir)
  const readSnaps = () => readJson(snapsPath, []).sort((a, b) => b.rev - a.rev)

  if (req.method === 'GET') {
    if (url.searchParams.has('history')) {
      send(res, 200, {
        keep: SNAPSHOT_KEEP,
        snapshots: readSnaps().map((s) => ({
          rev: s.rev, updatedAt: s.updatedAt ?? null, count: s.problems?.length ?? 0,
        })),
      })
      return true
    }
    if (url.searchParams.has('rev')) {
      const want = Number(url.searchParams.get('rev'))
      const snap = readSnaps().find((s) => s.rev === want)
      if (!snap) send(res, 404, { error: `Revision ${want} is no longer retained.` })
      else send(res, 200, readShape(snap))
      return true
    }
    send(res, 200, readShape(readState()))
    return true
  }

  if (req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let parsed
      try { parsed = JSON.parse(body) } catch { return send(res, 400, { error: 'Invalid JSON' }) }

      const plan = planWrite(readState(), parsed)
      if (plan.next) {
        // Keep the state being replaced, newest first, capped at SNAPSHOT_KEEP.
        if (plan.snapshot) {
          const kept = [plan.snapshot, ...readSnaps().filter((s) => s.rev !== plan.snapshot.rev)]
          fs.writeFileSync(snapsPath, JSON.stringify(kept.slice(0, SNAPSHOT_KEEP), null, 2), 'utf-8')
        }
        fs.writeFileSync(filePath, JSON.stringify(plan.next, null, 2), 'utf-8')
      }
      send(res, plan.status, plan.body)
    })
    return true
  }

  return false
}
