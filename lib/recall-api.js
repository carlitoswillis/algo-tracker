// File-backed /api/recall handler, shared by the Vite dev server
// (vite.config.js) and the standalone production server (server.mjs), the
// same way lib/sets-api.js backs /api/sets. The recall list and its log live
// in <ALGO_DATA_DIR>/recall.json (see lib/data-dir.js), next to the catalog:
// they are your lines and your misses, not the program, so they stay out of
// the source tree.
//
//   GET  /api/recall   -> { version, items, log }   (RECALL_EMPTY if no file)
//   PUT  /api/recall   <- { items, log }  replaces the file whole, after validation
//
// There is no revision check here, unlike the log: the file is small, one
// person edits it, and a day's results are recorded by sending the whole
// thing back. The previous file is kept once, as recall.json.prev, so a
// mistaken save is one rename away from undone.
import fs from 'node:fs'
import path from 'node:path'
import { resolveData } from './data-dir.js'
import { validateRecall, readRecallShape, RECALL_EMPTY } from './recall.js'

export const recallFileFor = (dir) => path.join(resolveData(dir).dir, 'recall.json')

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

export function readRecallFile(dir) {
  const raw = readJson(recallFileFor(dir), RECALL_EMPTY)
  return raw === CORRUPT ? CORRUPT : readRecallShape(raw)
}

// Returns true if it handled the request, false if the request wasn't for
// /api/recall — the same contract as handleStateRequest and handleSetsRequest.
export function handleRecallRequest(req, res, { dir }) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/api/recall') return false
  const filePath = recallFileFor(dir)

  if (req.method === 'GET') {
    const data = readRecallFile(dir)
    if (data === CORRUPT) {
      send(res, 500, { error: `${filePath} exists but is not valid JSON. Fix or remove it by hand.` })
      return true
    }
    send(res, 200, data)
    return true
  }

  if (req.method === 'PUT') {
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
      const v = validateRecall(parsed)
      if (!v.ok) return send(res, 400, { error: v.error })
      const prev = readJson(filePath, null)
      if (prev !== null && prev !== CORRUPT) {
        try { fs.writeFileSync(`${filePath}.prev`, JSON.stringify(prev, null, 2) + '\n', 'utf-8') } catch { /* best effort */ }
      }
      const next = v.data
      writeJsonAtomic(filePath, next)
      send(res, 200, next)
    })
    return true
  }

  return false
}
