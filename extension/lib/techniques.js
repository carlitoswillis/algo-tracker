// The technique layer: turns the append-only problem log into the thing the
// tracker actually practices — one mastery tier per technique, and the ranked
// session that exercises them.
//
// Pure (no React, no DOM, no `window`); synced into extension/lib/ by
// `npm run ext:sync` alongside schedule.js and problems.js, so the popup can
// tell you what a logged solve did to its technique's tier.
//
// Nothing in here is "due". Techniques are RANKED — by how long since you
// exercised one relative to how long its tier should survive, by how badly it
// went last time, by whether it keeps beating you — and the session is the top
// of that ranking that fits the session's minutes. A technique you never got to is
// not a debt; it just ranks higher tomorrow.

import {
  DAY, todayStart, STALE_SCALE,
  mastery, staleDays, form, recognition, strength, isLeech, lapses,
  findExisting, BUDGET,
} from "./schedule.js";
import { CATALOG, TIERS, LIBRARY, LIBRARY_URL, entryFor } from "./problems.js";

// The curated catalog entry for a problem, or its bulk-library entry.
// Library entries may carry only a category (technique: null) — enough to
// prefill the log form and group an island, not enough to pool it.
// URL equality is only trusted for a problem's own task URL — the shared
// library URL identifies nothing.
export function lookupEntry(p) {
  const c = entryFor(p);
  if (c) return c;
  const u = (p.url || "").trim();
  const n = (p.name || "").trim().toLowerCase();
  return LIBRARY.find((e) =>
    (u && u !== LIBRARY_URL && e.url === u) || (n && e.name.toLowerCase() === n)) || null;
}

// Which technique a logged problem exercises: its catalog or library entry
// decides. A problem with no exact technique still counts, but it stands as
// its OWN island — one tier per problem, re-solves only. Lumping all of a
// pattern's unknowns into one shared tier would let a fail on one wipe credit
// earned on an unrelated other; islands keep the evidence honest.
// Marking the problem curated in the catalog merges its island into
// the technique's real pool.
export function techniqueOf(p) {
  const e = lookupEntry(p);
  if (e?.technique) return { key: `t:${e.technique}`, label: e.technique, category: e.category, cataloged: true };
  return { key: `u:${p.id ?? p.name}`, label: p.name, category: e?.category ?? p.category, cataloged: false };
}

// Every technique name the catalog knows, sorted — the vocabulary the UI
// offers when it asks which move you reached for. Includes techniques whose
// problems are all already seen: you can still reach for one.
export const TECHNIQUE_LABELS = [...new Set([
  ...CATALOG.map((c) => c.technique),
  ...LIBRARY.map((e) => e.technique),
].filter(Boolean))].sort((a, b) => a.localeCompare(b));

// Every technique the catalog knows about, with its problem pool — the
// curated catalog plus the technique-tagged slice of the imported library —
// plus an island per logged problem that has no exact technique. Problems the
// catalog marks `seen` are mapped but never pooled: they wouldn't be fresh.
function techniqueIndex() {
  const map = new Map();
  for (const c of CATALOG) {
    const key = `t:${c.technique}`;
    if (!map.has(key)) map.set(key, { key, label: c.technique, category: c.category, cataloged: true, pool: [] });
    map.get(key).pool.push(c);
  }
  for (const e of LIBRARY) {
    if (!e.technique || e.seen) continue;
    const key = `t:${e.technique}`;
    if (!map.has(key)) map.set(key, { key, label: e.technique, category: e.category, cataloged: true, pool: [] });
    map.get(key).pool.push(e);
  }
  return map;
}

// The pattern-level reserve: unseen library problems that mapped to a category
// but not to an exact technique. Served only when a technique's own pool is
// empty — an unseen problem of the same pattern beats re-solving, even if the
// technique claim is weaker.
function reserveByCategory(problems) {
  const map = {};
  for (const e of LIBRARY) {
    if (e.technique || e.seen || findExisting(problems, e)) continue;
    (map[e.category] ||= []).push(e);
  }
  return map;
}

// Derives the full technique table from the log: one row per technique that
// exists (in the catalog) or has evidence (in the log). Attempted techniques
// carry a derived tier; untouched ones are the ground you haven't broken.
// `stage` is what the technique needs next, not how well it's going:
//   "intro"    — never attempted: open it with a worked example, not a cold rep
//   "study"    — a leech: another blind attempt just burns a problem
//   "practice" — the normal blind rep
export function deriveTechniques(problems) {
  const map = techniqueIndex();
  const reserves = reserveByCategory(problems);

  // Group every attempt ever logged under its technique.
  for (const p of problems) {
    const t = techniqueOf(p);
    if (!map.has(t.key)) map.set(t.key, { ...t, pool: [] });
    const row = map.get(t.key);
    (row.tracked ||= []).push(p);
    p.history.forEach((outcome, i) => {
      (row.raw ||= []).push({
        t: p.log?.[i] ?? p.added ?? 0,
        outcome,
        minutes: p.times?.[i] ?? null,
        guess: p.guesses?.[i] ?? null,
        knew: p.knew?.[i] ?? null,
        problem: p,
      });
    });
  }

  return [...map.values()].map((row) => {
    const attempts = (row.raw || []).sort((a, b) => a.t - b.t);
    const tracked = row.tracked || [];
    const unseen = row.pool.filter((c) => !findExisting(problems, c));
    const base = {
      key: row.key, label: row.label, category: row.category, cataloged: row.cataloged,
      pool: row.pool, unseen, tracked, attempts,
      reserve: reserves[row.category] ?? [],
    };
    if (!attempts.length) {
      return {
        ...base, started: false, stage: "intro",
        tier: null, streak: 0, last: null, lastOutcome: null, staleDays: null,
        form: [], recognition: { n: 0, hits: 0, medianKnew: null },
        strength: 0, leech: false, lapses: 0,
      };
    }
    const { tier, streak, last, lastOutcome } = mastery(attempts);
    const leech = isLeech(attempts);
    return {
      ...base, started: true, stage: leech ? "study" : "practice",
      tier, streak, last, lastOutcome, staleDays: staleDays(last),
      form: form(attempts), recognition: recognition(attempts, row.label),
      strength: strength({ tier, streak, lastOutcome }),
      leech, lapses: lapses(attempts),
    };
  });
}

// ---------- Ranking ----------
// How much this technique wants a rep. Three pressures, added:
//   stale — days since you exercised it, over how long its tier should survive
//           untouched. 1.0 means "as long as this tier should last"; it keeps
//           climbing past that, so nothing can be forgotten forever, but it is
//           a ranking, never a deadline;
//   weak  — the last attempt is the freshest evidence there is: a fail says
//           the move isn't there, hints or suboptimal say it's shaky;
//   leech — it keeps beating you, so it outranks almost anything.
export function priority(tech) {
  if (!tech?.started) return 0;
  const stale = (tech.staleDays ?? 0) / STALE_SCALE[tech.tier ?? 0];
  const weak = tech.lastOutcome === "failed" ? 1
    : (tech.lastOutcome === "hints" || tech.lastOutcome === "subopt") ? 0.5 : 0;
  return stale + weak + (tech.leech ? 1 : 0);
}

// A skip is triage, not evidence: it hides a technique from the session
// and touches nothing else. Delays live outside the log (device-local), keyed
// by technique, holding the timestamp the skip runs out.
export const isSkipped = (tech, delays) => (delays?.[tech.key] ?? 0) > todayStart() + DAY - 1;

// One sentence for the UI: how much ground is slipping, and how much is still
// unbroken. `over` counts techniques past the point their tier should have
// survived untouched — pressure, not overdue debt.
export function staleness(techs) {
  const cataloged = techs.filter((t) => t.cataloged);
  return {
    over: techs.filter((t) => t.started && (t.staleDays ?? 0) / STALE_SCALE[t.tier ?? 0] >= 1).length,
    untouched: cataloged.filter((t) => !t.started).length,
    total: cataloged.length,
  };
}

// ---------- Serving ----------
// The disguise must not be predictable: a deterministic pick means you know
// the session's problem a day early, and can (even accidentally) pre-study it. So
// the serve is a SHUFFLE among the candidates — seeded by the day and the
// technique, so the card is stable across renders and reloads today and
// different tomorrow, with no stored state. `nonce` is the UI's reroll: each
// increment steps to the next candidate in the cycle.
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const shufflePick = (list, seed, nonce) =>
  list[(hash(seed) + nonce) % list.length];
const daySeed = (tech) => `${tech.key}:${Math.floor(todayStart() / DAY)}`;

const tierOf = (c) => TIERS.indexOf(c.difficulty);

// The candidates a technique may serve from a pool: everything unseen at the
// tier its mastery has earned, padded with the tier below when that's thin
// (small pools would otherwise make "shuffle" a no-op) — never with easier
// tiers wholesale, or the shuffle would quietly bias the test downward. If the
// pool only has harder problems left, the gentlest tier above.
function tierCandidates(list, tier) {
  const target = Math.min(TIERS.length - 1, Math.max(0, tier ?? 0));
  let cands = [];
  for (let t = target; t >= 0 && cands.length < 3; t--)
    cands = cands.concat(list.filter((c) => tierOf(c) === t));
  if (!cands.length && list.length) {
    const above = Math.min(...list.map(tierOf));
    cands = list.filter((c) => tierOf(c) === above);
  }
  return cands;
}

// The easiest unseen problems a technique has, shuffled among themselves —
// where a first meeting with a move starts.
function easiestCandidates(list) {
  if (!list.length) return [];
  const low = Math.min(...list.map(tierOf));
  return list.filter((c) => tierOf(c) === low);
}

// A connected warm-up: an easier problem of the SAME technique to solve right
// before the real serve — greasing the move before the harder disguise.
// Unseen problems preferred (they're evidence too); an already-tracked one is
// offered as a re-solve when nothing easier is unseen. Safe to log in either
// order: a day's attempts are one event, so a warm-up can never eat the climb.
function warmupFor(tech, served, nonce) {
  const cap = tierOf(served);
  if (cap <= 0) return null;
  const unseen = tech.unseen.filter((c) => tierOf(c) < cap && c.name !== served.name);
  if (unseen.length) {
    const cands = easiestCandidates(unseen);
    return { mode: "fresh", problem: shufflePick(cands, daySeed(tech) + ":warmup", nonce) };
  }
  const tracked = tech.tracked.filter((p) => tierOf(p) < cap);
  if (!tracked.length) return null;
  const stalest = [...tracked].sort(
    (a, b) => (a.log?.[a.log.length - 1] ?? 0) - (b.log?.[b.log.length - 1] ?? 0))[0];
  return { mode: "resolve", problem: stalest };
}

// What a technique's card offers, in preference order. `blind` says whether
// the technique's name must stay hidden until the attempt is logged — true for
// every real rep, because picking the strategy from the problem alone IS the
// skill; false when the point is to read the move, not find it.
//   { mode: "intro",   problem, blind: false } — never attempted: its easiest
//                                         unseen problem, opened with a worked
//                                         solution rather than a cold rep.
//   { mode: "study",   problem, blind: false } — leech: study solutions,
//                                         don't attempt cold.
//   { mode: "fresh",   problem, alts, blind } — an unseen problem from the
//                                         technique's own pool: the real test.
//                                         `alts` = candidate count, so the UI
//                                         knows a reroll would change it.
//   { mode: "related", problem, alts, blind } — pool exhausted: an unseen
//                                         same-pattern problem from the
//                                         pattern reserve. The technique
//                                         claim is weaker (pattern-level), but
//                                         an unseen relative beats a re-solve.
//   { mode: "resolve", problem, blind }  — nothing unseen left (or an island):
//                                         re-solve the stalest problem; after a
//                                         real gap it's cold again in practice.
export function serveFor(tech, nonce = 0) {
  if (tech.stage === "intro") {
    const cands = easiestCandidates(tech.unseen);
    if (cands.length) {
      return { mode: "intro", problem: shufflePick(cands, daySeed(tech), nonce), alts: cands.length, blind: false };
    }
  }
  if (tech.leech) {
    const worst = [...tech.tracked].sort((a, b) =>
      b.history.filter((h) => h === "failed").length - a.history.filter((h) => h === "failed").length)[0];
    return { mode: "study", problem: worst ?? null, alts: 1, blind: false };
  }
  const fresh = tierCandidates(tech.unseen, tech.tier);
  if (fresh.length) {
    const problem = shufflePick(fresh, daySeed(tech), nonce);
    return { mode: "fresh", problem, alts: fresh.length, blind: true, warmup: warmupFor(tech, problem, nonce) };
  }
  // Islands skip the reserve: their technique is unknown, so "same pattern"
  // would be a claim about a category the problem may only nominally sit in.
  if (tech.cataloged) {
    const related = tierCandidates(tech.reserve, tech.tier);
    if (related.length) {
      const problem = shufflePick(related, daySeed(tech), nonce);
      return { mode: "related", problem, alts: related.length, blind: true, warmup: warmupFor(tech, problem, nonce) };
    }
  }
  const stalest = [...tech.tracked].sort(
    (a, b) => (a.log?.[a.log.length - 1] ?? 0) - (b.log?.[b.log.length - 1] ?? 0))[0];
  return stalest ? { mode: "resolve", problem: stalest, alts: 1, blind: true } : null;
}

// ---------- The session ----------
// A ranked list, cut to the minutes you have. Started techniques come first in
// priority order; whatever budget survives goes to breaking new ground.
const MAX_NEW = 3; // even a long session shouldn't drown in novelty

const estServe = (serve) =>
  serve?.problem ? (BUDGET[serve.problem.difficulty] ?? 30) : 30;

// The one-line reason, shown only AFTER the attempt is logged — telling you
// "you keep failing this" before a blind rep is telling you the answer.
function whyFor(tech, serve) {
  if (serve?.mode === "intro") return "first time with this move";
  if (tech.leech) return "keeps beating you";
  const stale = (tech.staleDays ?? 0) / STALE_SCALE[tech.tier ?? 0];
  const weak = tech.lastOutcome === "failed" ? 1
    : (tech.lastOutcome === "hints" || tech.lastOutcome === "subopt") ? 0.5 : 0;
  if (weak && weak >= stale) return tech.lastOutcome === "failed" ? "beat you last time" : "shakier than it looks";
  return "longest since you exercised it";
}

// Interleaving is the point, not a garnish: blocked practice (all the graph
// problems, then all the DP) inflates how well you think it's going and
// transfers worse than mixing patterns. So we walk the ranking but refuse two
// consecutive items from the same category while another category still has
// something worth doing.
function interleave(cands) {
  const rest = [...cands];
  const out = [];
  let lastCat = null;
  while (rest.length) {
    let i = 0;
    if (rest[0].tech.category === lastCat) {
      const j = rest.findIndex((c) => c.tech.category !== lastCat && c.priority >= 0.5);
      if (j > 0) i = j;
    }
    out.push(rest[i]);
    lastCat = rest[i].tech.category;
    rest.splice(i, 1);
  }
  return out;
}

export function buildPlan(techs, budgetMin, delays, nonces = {}) {
  const ranked = techs
    .filter((t) => t.started && !isSkipped(t, delays))
    .map((t) => ({ tech: t, priority: priority(t) }))
    .sort((a, b) => b.priority - a.priority || a.tech.label.localeCompare(b.tech.label))
    .map((c) => ({ ...c, serve: serveFor(c.tech, nonces[c.tech.key] ?? 0) }))
    .filter((c) => c.serve?.problem);

  let left = budgetMin;
  const items = [];
  const fitted = new Set();
  for (const c of interleave(ranked)) {
    const est = estServe(c.serve);
    if (est > left) continue; // it may still fit a shorter one after this
    items.push({ tech: c.tech, serve: c.serve, est, why: whyFor(c.tech, c.serve) });
    fitted.add(c.tech.key);
    left -= est;
  }
  const more = ranked.filter((c) => c.priority >= 1 && !fitted.has(c.tech.key)).length;

  // Category coverage decides where new ground helps most: patterns with the
  // least started ground come first, and no pattern gets a second new
  // technique in one session until every other pattern has had its first.
  const byCat = {};
  for (const t of techs.filter((x) => x.cataloged)) {
    (byCat[t.category] ||= { started: 0, total: 0 }).total += 1;
    if (t.started) byCat[t.category].started += 1;
  }
  const coverage = (cat) => { const c = byCat[cat]; return c ? c.started / c.total : 1; };

  const easiest = (t) => Math.min(...t.unseen.map(tierOf));
  const candidates = techs
    .filter((t) => t.cataloged && !t.started && t.unseen.length && !isSkipped(t, delays))
    .sort((a, b) => coverage(a.category) - coverage(b.category) || easiest(a) - easiest(b));

  let intros = 0;
  const pickedCats = new Set();
  for (const pass of [0, 1]) {
    for (const t of candidates) {
      if (intros >= MAX_NEW || left <= 0) break;
      if (fitted.has(t.key)) continue;
      if (pass === 0 && pickedCats.has(t.category)) continue;
      const serve = serveFor(t, nonces[t.key] ?? 0);
      if (!serve?.problem) continue;
      const est = estServe(serve);
      if (est > left) continue;
      items.push({ tech: t, serve, est, why: whyFor(t, serve) });
      fitted.add(t.key);
      pickedCats.add(t.category);
      intros += 1;
      left -= est;
    }
  }

  return { items, totalMin: items.reduce((s, i) => s + i.est, 0), more };
}
