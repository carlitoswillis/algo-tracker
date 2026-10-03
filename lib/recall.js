// Recall: a short list of lines you type from memory, reference closed, at
// the start of a study day — the fix for "I knew useState was right but
// couldn't produce the line." Judgment is trained by the ranked session;
// recall is fingers, and fingers only come back by typing. Nothing here
// ranks or schedules in the Today sense: an item is simply due until it has
// been typed clean on two separate days in a row, and a miss sends it back.
//
// Pure: no React, no DOM, no filesystem. The rows live in
// <ALGO_DATA_DIR>/recall.json (lib/recall-api.js reads and writes it); this
// module is the meaning laid over them.
//
//   {
//     "version": 1,
//     "items": [{ "id": "py-01", "side": "python" | "node",
//                 "prompt": "one-line task", "answer": "runnable code",
//                 "note": "optional: what it is for, the trap, the thing to remember — shown after reveal" }],
//     "log":   [{ "date": "YYYY-MM-DD", "id": "py-01", "result": "clean" | "miss" }]
//   }
//
// The rules, in one place so the UI and the API can't drift:
//   - Retired: the item's two most recent results (by date) are both clean.
//     A miss anywhere later than those resets the streak; a never-attempted
//     item is due.
//   - One entry per item per day. Recording again the same day replaces the
//     earlier entry, so you can change your mind before the day is out.
//   - The log is appended to, never rewritten by these helpers: every function
//     returns a new object and leaves its input alone.

export const RECALL_EMPTY = { version: 1, items: [], log: [] };

export const RECALL_SIDES = ["python", "node"];
export const RECALL_RESULTS = ["clean", "miss"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- The log, per item ----------
// Entries for one item, oldest first. The sort is stable, so two entries on
// the same date (only possible in a hand-edited file) keep their file order
// and the later one in the file counts as the later result.
const entriesFor = (data, id) =>
  (data?.log ?? [])
    .filter((e) => e && e.id === id)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

const isRetired = (entries) =>
  entries.length >= 2 &&
  entries[entries.length - 1].result === "clean" &&
  entries[entries.length - 2].result === "clean";

// ---------- Queries ----------
// Every item of `side` that is not retired, in file order. Items already
// attempted today are still returned — the UI decides whether to show them
// again — flagged with `attemptedToday` and the result that was logged.
// `lastResult` / `lastDate` are the most recent entry, or null when the item
// has never been attempted.
export function dueItems(data, today, side) {
  const out = [];
  for (const item of data?.items ?? []) {
    if (side != null && item.side !== side) continue;
    const entries = entriesFor(data, item.id);
    if (isRetired(entries)) continue;
    const last = entries[entries.length - 1] ?? null;
    const todays = entries.filter((e) => e.date === today);
    const todayEntry = todays[todays.length - 1] ?? null;
    out.push({
      ...item,
      attemptedToday: todayEntry !== null,
      todayResult: todayEntry ? todayEntry.result : null,
      lastResult: last ? last.result : null,
      lastDate: last ? last.date : null,
    });
  }
  return out;
}

// Items of `side` whose most recent result is a miss, with the date it was
// missed on — the "carry-forward" row: what yesterday left for today.
export function carryForward(data, side) {
  const out = [];
  for (const item of data?.items ?? []) {
    if (side != null && item.side !== side) continue;
    const entries = entriesFor(data, item.id);
    const last = entries[entries.length - 1];
    if (last && last.result === "miss") out.push({ ...item, missedOn: last.date });
  }
  return out;
}

// ---------- Recording ----------
// A new data object with { date, id, result } appended. An existing entry for
// the same date and id is replaced in place, so a day never holds two
// verdicts for one item. Throws on a malformed entry or an id the file
// doesn't know, since either would be a bug upstream rather than user input.
export function recordResult(data, { date, id, result }) {
  if (typeof date !== "string" || !DATE_RE.test(date)) throw new Error(`recordResult: bad date “${date}”.`);
  if (typeof id !== "string" || !id) throw new Error("recordResult: an id is required.");
  if (!RECALL_RESULTS.includes(result)) throw new Error(`recordResult: result must be one of ${RECALL_RESULTS.join(", ")}, got “${result}”.`);
  const items = data?.items ?? [];
  if (!items.some((it) => it && it.id === id)) throw new Error(`recordResult: no item with id “${id}”.`);
  const entry = { date, id, result };
  const log = data?.log ?? [];
  const at = log.findIndex((e) => e && e.date === date && e.id === id);
  const nextLog = at === -1 ? [...log, entry] : log.map((e, i) => (i === at ? entry : e));
  return { ...data, version: 1, items, log: nextLog };
}

// ---------- History ----------
// Per-day counts for the last `days` calendar days ending on `today`, oldest
// first, with zeros for days nothing was logged. Dates are compared as text
// (YYYY-MM-DD sorts correctly) and stepped in UTC so the calendar never slips
// a day across a DST boundary.
const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export function history(data, days, today) {
  const n = Math.max(0, Math.floor(Number(days) || 0));
  const counts = new Map();
  for (const e of data?.log ?? []) {
    if (!e || !RECALL_RESULTS.includes(e.result)) continue;
    const row = counts.get(e.date) ?? { clean: 0, miss: 0 };
    row[e.result] += 1;
    counts.set(e.date, row);
  }
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const row = counts.get(date) ?? { clean: 0, miss: 0 };
    out.push({ date, clean: row.clean, miss: row.miss });
  }
  return out;
}

// ---------- Validation ----------
// The file is refused whole if any row is malformed: a bad item would render
// as a broken card, and a bad log entry as a streak that can't be counted.
export function validateRecall(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid recall payload." };
  const { items, log } = body;
  if (!Array.isArray(items)) return { ok: false, error: "`items` must be a list." };
  if (!Array.isArray(log)) return { ok: false, error: "`log` must be a list." };
  const ids = new Set();
  for (const [i, it] of items.entries()) {
    const where = `item ${i + 1}${it?.id ? ` (“${it.id}”)` : ""}`;
    if (!it || typeof it !== "object") return { ok: false, error: `${where} is not an object.` };
    if (typeof it.id !== "string" || !it.id.trim()) return { ok: false, error: `${where} has no id.` };
    if (ids.has(it.id)) return { ok: false, error: `${where} repeats the id “${it.id}”.` };
    ids.add(it.id);
    if (!RECALL_SIDES.includes(it.side)) return { ok: false, error: `${where} has a side that is not ${RECALL_SIDES.join(" or ")}.` };
    if (typeof it.prompt !== "string" || !it.prompt.trim()) return { ok: false, error: `${where} has no prompt.` };
    if (typeof it.answer !== "string") return { ok: false, error: `${where} has no answer.` };
    if (it.note !== undefined && typeof it.note !== "string") return { ok: false, error: `${where} has a note that is not text.` };
  }
  for (const [i, e] of log.entries()) {
    const where = `log entry ${i + 1}`;
    if (!e || typeof e !== "object") return { ok: false, error: `${where} is not an object.` };
    if (typeof e.date !== "string" || !DATE_RE.test(e.date)) return { ok: false, error: `${where} has a date that is not YYYY-MM-DD.` };
    if (typeof e.id !== "string" || !ids.has(e.id)) return { ok: false, error: `${where} names an item that is not in the file.` };
    if (!RECALL_RESULTS.includes(e.result)) return { ok: false, error: `${where} has a result that is not ${RECALL_RESULTS.join(" or ")}.` };
  }
  return { ok: true, data: { version: 1, items, log } };
}

export const isValidRecall = (data) => validateRecall(data).ok;

// Read shape: whatever is on disk, normalised, never throwing on an older or
// hand-edited file.
export const readRecallShape = (data) => ({
  version: 1,
  items: Array.isArray(data?.items) ? data.items : [],
  log: Array.isArray(data?.log) ? data.log : [],
});
