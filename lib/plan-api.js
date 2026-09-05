// Read-only GET /api/plan — today's ranked session, as JSON, for other
// programs (the morning brief of a personal assistant, say) that want to show
// what this session holds without re-implementing any of the ranking.
//
// Nothing here decides anything. The ranking lives in lib/techniques.js and
// lib/schedule.js; this module only calls it and shapes the answer. If you
// find yourself writing a formula in this file, it belongs upstream instead —
// a second copy of the rules is exactly what the extension was built to avoid.
//
// The one rule this file *enforces* is the blind rep: a practice item never
// names its technique. Choosing the strategy from the problem alone is the
// skill being trained, so a brief that spoiled the move would quietly undo the
// whole point. `technique` is null, the `why` sentence is scrubbed, and the
// item's `key` is a digest rather than the readable `t:<technique>` — a
// consumer that prints an id it doesn't understand can't leak the answer.
import { createHash } from 'node:crypto'

import { migrate, BUDGET, dayStartOf, todayStart } from './schedule.js'
import { deriveTechniques, buildPlan, staleness, techniqueOf } from './techniques.js'
import { readStateFile } from './local-state.js'

// The session lengths the app itself offers (SESSION_SIZES). Anything else
// falls back to the default rather than 400ing: this is a read-only view, and
// a brief asking for an odd number should still get a session.
export const PLAN_MINUTES = [45, 60, 90, 120]
export const DEFAULT_MINUTES = 60

export const minutesFrom = (raw) => {
  const n = Number(raw)
  return PLAN_MINUTES.includes(n) ? n : DEFAULT_MINUTES
}

// A stable, opaque id for a technique. Callers need something to key rows by
// across polls; they must not be able to read the technique out of it, since
// half of these rows are blind reps. Same input, same id, forever.
const opaqueKey = (techKey) => createHash('sha1').update(techKey).digest('hex').slice(0, 12)

// Belt and braces: the plan's `why` sentences are written not to name the
// move, but if one ever does, the name comes out before it leaves the process.
const scrub = (sentence, label) => {
  if (!sentence || !label) return sentence ?? ''
  const pattern = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  return sentence.replace(pattern, 'this technique').trim()
}

const problemShape = (p) => ({
  name: p?.name ?? '',
  url: p?.url ?? null,
  difficulty: p?.difficulty ?? '',
})

// Skips are deliberately not applied. They live in the browser's
// localStorage — triage, per-device, never in the synced log — so the server
// cannot know about them, and inventing them here would put a second, silent
// copy of that state on the wrong side of the wire.
export function planFor(state, { minutes } = {}) {
  const budget = minutesFrom(minutes)
  const problems = (state?.problems ?? []).map(migrate)
  const techs = deriveTechniques(problems)
  const plan = buildPlan(techs, budget, {})

  const items = (plan.items ?? [])
    .filter((i) => i?.serve?.problem)
    .map(({ tech, serve, est, why }) => {
      const blind = tech.stage === 'practice'
      return {
        key: opaqueKey(tech.key),
        stage: tech.stage,
        category: tech.category ?? '',
        technique: blind ? null : tech.label,
        tier: tech.tier ?? null,
        problem: problemShape(serve.problem),
        budgetMin: BUDGET[serve.problem?.difficulty] ?? 30,
        estMin: est,
        why: blind ? scrub(why, tech.label) : (why ?? ''),
      }
    })

  return {
    rev: state?.rev ?? 0,
    updatedAt: state?.updatedAt ?? null,
    minutes: budget,
    session: { totalMin: plan.totalMin ?? 0, more: plan.more ?? 0, items },
    pressure: staleness(techs),
    leeches: techs
      .filter((t) => t.leech)
      .map((t) => ({ technique: t.label, category: t.category ?? '', lapses: t.lapses, tier: t.tier ?? 0 })),
    loggedToday: loggedToday(problems),
  }
}

// Every attempt whose timestamp falls on today's local calendar day, newest
// first — whatever logged it: this app, another tab, the extension. Naming the
// technique here is fine and is the point: logging the attempt is what reveals
// it.
function loggedToday(problems) {
  const start = todayStart()
  const rows = []
  for (const p of problems) {
    const t = techniqueOf(p)
    ;(p.log || []).forEach((ts, i) => {
      if (typeof ts !== 'number' || dayStartOf(ts) !== start) return
      rows.push({
        ts,
        problem: p.name ?? '',
        technique: t.label,
        category: t.category ?? '',
        outcome: p.history[i],
        minutes: p.times?.[i] ?? null,
      })
    })
  }
  return rows.sort((a, b) => b.ts - a.ts).map(({ ts, ...row }) => row)
}

// Handles GET /api/plan against the state file in `dir`, the same file
// lib/local-state.js reads. Returns true if it handled the request, false if
// the request wasn't a GET for /api/plan — same contract as
// handleStateRequest, so both servers can route them identically.
export function handlePlanRequest(req, res, { dir }) {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/api/plan') return false
  if (req.method !== 'GET') return false

  const body = planFor(readStateFile(dir), { minutes: url.searchParams.get('minutes') })
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}
