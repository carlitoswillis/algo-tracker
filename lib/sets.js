// Custom sets: a hand-picked list of problems worked in order against one
// clock — a timed drill shaped like a specific assessment, rather than the
// ranked session Today builds. Nothing here schedules anything: a set is
// yours, it names problems (not techniques), and each attempt is logged the
// same way a Today rep is, so the technique tiers see the evidence either way.
//
// Pure: no React, no DOM, no filesystem. The rows live in
// <ALGO_DATA_DIR>/sets.json (lib/sets-api.js reads and writes it); this
// module is the meaning laid over them — the file shape, the one-line text
// form a set is typed in, and how an item finds its catalog entry.
//
//   {
//     "version": 1,
//     "sets": [{
//       "id": "codesignal-a", "name": "CodeSignal, set A", "minutes": 45,
//       "note": "why this set exists, shown on its page",
//       "group": "Linktree CodeSignal",   // optional: the company or assessment it is shaped for
//       "done": true,                     // optional: the assessment has happened; kept for reference
//       "items": [{ "name": "Run Length Encoding", "minutes": 10, "note": "the trap" }]
//     }]
//   }
//
// An item is matched to the catalog by name (alias-aware, case-insensitive)
// or by its own `url`; an item the catalog doesn't know still works — it
// opens by `url` if given, and logs as a problem outside the catalog. Notes
// are revealed only after the attempt is logged: a note that says "use a
// frequency map" before the rep would name the move, and naming the move is
// the rep.

import { nameKey, parseProblemUrl } from "./schedule.js";

export const SETS_EMPTY = { version: 1, sets: [] };

const slug = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const setId = (name, taken = new Set()) => {
  const base = slug(name) || "set";
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
};

// ---------- The text form ----------
// One problem per line, fields separated by a pipe:
//
//   Run Length Encoding | 10 | runs longer than 9 must split
//
// The first field is the name; a bare number anywhere after it is the minute
// budget; an http(s) link anywhere after it is the problem's own URL; whatever
// is left is the note. Blank lines and lines starting with # are skipped.
export function parseSetText(text) {
  const items = [];
  const problems = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [first, ...rest] = line.split("|").map((s) => s.trim());
    if (!first) { problems.push(`a line with no name: “${line}”`); continue; }
    const item = { name: first };
    const noteParts = [];
    for (const f of rest) {
      if (!f) continue;
      if (/^\d{1,3}$/.test(f)) item.minutes = parseInt(f, 10);
      else if (/^https?:\/\//i.test(f)) item.url = f;
      else noteParts.push(f);
    }
    if (noteParts.length) item.note = noteParts.join(" | ");
    items.push(item);
  }
  return { items, problems };
}

export const formatSetText = (set) =>
  (set?.items ?? []).map((it) => [
    it.name,
    it.minutes != null ? String(it.minutes) : null,
    it.url || null,
    it.note || null,
  ].filter(Boolean).join(" | ")).join("\n");

// ---------- Resolution ----------
// `library` is every catalog row the client knows (curated and imported).
// Match the item's own URL first, then its name — the same order the log
// uses, so a set item and a logged problem agree on which problem they mean.
export function entryForItem(item, library) {
  const u = parseProblemUrl(item.url)?.url || (item.url || "").trim() || null;
  const n = nameKey(item.name);
  return (library || []).find((e) =>
    (u && e.url === u) || (n && nameKey(e.name) === n)) || null;
}

// The problem a set item serves: the catalog entry when there is one (URL,
// pattern, tier all come from it), else a bare record from the item itself so
// it can still be opened and logged.
export function problemForItem(item, library) {
  const e = entryForItem(item, library);
  if (e) return { ...e, url: item.url || e.url };
  return {
    name: item.name,
    url: item.url || null,
    category: item.category || "Arrays & Strings",
    difficulty: item.difficulty || "Medium",
    technique: null,
    curated: false,
    seen: false,
    source: null,
    unlisted: true,
  };
}

// ---------- Validation ----------
// The file is refused whole if any set is malformed: a bad set would render
// as a broken page, and a bad item as a rep that cannot be logged.
const isMin = (m) => m == null || (Number.isInteger(m) && m > 0 && m < 1000);

export function validateSets(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid sets payload." };
  const sets = body.sets;
  if (!Array.isArray(sets)) return { ok: false, error: "`sets` must be a list." };
  const ids = new Set();
  for (const [i, s] of sets.entries()) {
    const where = `set ${i + 1}${s?.name ? ` (“${s.name}”)` : ""}`;
    if (!s || typeof s !== "object") return { ok: false, error: `${where} is not an object.` };
    if (typeof s.id !== "string" || !s.id.trim()) return { ok: false, error: `${where} has no id.` };
    if (ids.has(s.id)) return { ok: false, error: `${where} repeats the id “${s.id}”.` };
    ids.add(s.id);
    if (typeof s.name !== "string" || !s.name.trim()) return { ok: false, error: `${where} has no name.` };
    if (!isMin(s.minutes)) return { ok: false, error: `${where} has an impossible minute budget.` };
    if (s.note != null && typeof s.note !== "string") return { ok: false, error: `${where} has a non-text note.` };
    if (s.group != null && typeof s.group !== "string") return { ok: false, error: `${where} has a non-text group.` };
    if (s.done != null && typeof s.done !== "boolean") return { ok: false, error: `${where} has a done flag that is not true or false.` };
    if (!Array.isArray(s.items) || !s.items.length) return { ok: false, error: `${where} has no problems.` };
    for (const [j, it] of s.items.entries()) {
      const w = `${where}, problem ${j + 1}`;
      if (!it || typeof it !== "object") return { ok: false, error: `${w} is not an object.` };
      if (typeof it.name !== "string" || !it.name.trim()) return { ok: false, error: `${w} has no name.` };
      if (!isMin(it.minutes)) return { ok: false, error: `${w} has an impossible minute budget.` };
      if (it.url != null && (typeof it.url !== "string" || !/^https?:\/\//i.test(it.url)))
        return { ok: false, error: `${w} has a link that is not http(s).` };
      if (it.note != null && typeof it.note !== "string") return { ok: false, error: `${w} has a non-text note.` };
    }
  }
  return { ok: true, sets };
}

// Read shape: whatever is on disk, normalised, never throwing on an older or
// hand-edited file.
export const readSetsShape = (data) => ({
  version: 1,
  sets: Array.isArray(data?.sets) ? data.sets : [],
});
