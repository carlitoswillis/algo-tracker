// File-backed /api/sets handler, shared by the Vite dev server
// (vite.config.js) and the standalone production server (server.mjs), the
// same way lib/local-state.js backs /api/state. Custom sets live in
// <ALGO_DATA_DIR>/sets.json (see lib/data-dir.js), next to the catalog: they
// are your problem picks, not the program, so they stay out of the source tree.
//
//   GET  /api/sets   -> { version, sets }
//   POST /api/sets   <- { sets }  replaces the file whole, after validation
//
// There is no revision check here, unlike the log: a set is a short list you
// author in one sitting, and the log — the evidence — is never touched by
// this route. The previous file is kept once, as sets.json.prev, so a
// mistaken save is one rename away from undone.
import fs from 'node:fs'
import path from 'node:path'
import { resolveData } from './data-dir.js'
import { validateSets, readSetsShape, SETS_EMPTY } from './sets.js'

export const setsFileFor = (dir) => path.join(resolveData(dir).dir, 'sets.json')

const CORRUPT = Symbol('corrupt')
const readJson = (p, fallback) => {
  if (!fs.existsSync(p)) return fallback
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return CORRUPT }
}

const writeJsonAtomic = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, filePath)
}

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const MAX_BODY_BYTES = 500_000

export function readSetsFile(dir) {
  const raw = readJson(setsFileFor(dir), SETS_EMPTY)
  return raw === CORRUPT ? CORRUPT : readSetsShape(raw)
}

// Returns true if it handled the request, false if the request wasn't for
// /api/sets — the same contract as handleStateRequest and handlePlanRequest.
export function handleSetsRequest(req, res, { dir }) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/api/sets') return false
  const filePath = setsFileFor(dir)

  if (req.method === 'GET') {
    const data = readSetsFile(dir)
    if (data === CORRUPT) {
      send(res, 500, { error: `${filePath} exists but is not valid JSON. Fix or remove it by hand.` })
      return true
    }
    send(res, 200, data)
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
      const v = validateSets(parsed)
      if (!v.ok) return send(res, 400, { error: v.error })
      const prev = readJson(filePath, null)
      if (prev !== null && prev !== CORRUPT) {
        try { fs.writeFileSync(`${filePath}.prev`, JSON.stringify(prev, null, 2) + '\n', 'utf-8') } catch { /* best effort */ }
      }
      const next = { version: 1, sets: v.sets }
      writeJsonAtomic(filePath, next)
      send(res, 200, next)
    })
    return true
  }

  return false
}
