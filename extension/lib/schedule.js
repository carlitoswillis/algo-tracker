// Single source of truth for the practice rules and the problem shape.
//
// Imported by BOTH the web app (interview-grind-tracker.jsx) and the Chrome
// extension. Nothing in here may touch React, the DOM, or `window` — the
// extension's popup imports it directly, and `npm run ext:sync` copies this
// file into extension/lib/ so the two can never drift apart.
//
// ---------- The ethos ----------
// Interviews don't hand you a problem you've seen; they hand you a problem
// whose PATTERN you've seen. So the unit that gets practiced is the technique
// (e.g. "monotonic stack"), never the individual problem, and the rep is an
// UNSEEN problem: recognizing the pattern in a fresh disguise is the very
// skill being trained.
//
// Nothing here is ever "due". A calendar ladder (2/4/7/14/30/60 days) is false
// precision — no evidence sets those numbers for one person on one technique —
// and worse, it turns practice into debt you can be behind on. What replaces
// it is a MASTERY TIER: how hard a disguise a technique has earned, climbed
// only by unaided-optimal solves at interview pace on separate days, dropped
// by a fail. Time still matters, but only as pressure: the longer since you
// exercised a technique relative to how long that tier should survive, the
// higher it sorts in a session. It is a ranking, never a deadline.
//
// The rep is BLIND: the technique's name is hidden until the attempt is
// logged, because choosing the strategy from the problem alone is the part of
// the skill an interview actually tests. Logging captures which move you
// reached for (`guesses`) and how many minutes until you knew it (`knew`) —
// recognition data a right/wrong outcome throws away.
//
// A technique you have never attempted doesn't get thrown at you cold. It
// opens with a worked example: read the solution, then rewrite it from a blank
// file. That is what the research on worked examples says beginners need, and
// what expertise reversal says to stop giving them once they're started.

// ---------- Time ----------
import { CATALOG_DATA } from "./problem-data.js";

export const DAY = 24 * 60 * 60 * 1000;
export const dayStartOf = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const todayStart = () => dayStartOf(Date.now());
export const localDay = (ts) => Math.floor((ts - new Date(ts).getTimezoneOffset() * 60 * 1000) / DAY);
export const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// ---------- Vocabulary ----------
export const CATEGORIES = [
  "Arrays & Strings", "Hashmaps", "Two Pointers", "Sliding Window",
  "Binary Search", "Linked Lists", "Stacks & Queues", "Trees & BST",
  "Recursion / Backtracking", "Graphs (BFS/DFS)", "Heaps", "Greedy",
  "Dynamic Programming",
];

// Keys are persisted — only the copy changes. "Unaided": no hints, no notes.
// NEVER rename these keys: every history[] entry ever written depends on them.
export const OUTCOMES = {
  cold: { label: "Unaided, optimal", short: "OPT" },
  subopt: { label: "Unaided, suboptimal", short: "SUB" },
  hints: { label: "Needed hints", short: "HINT" },
  failed: { label: "Couldn't solve", short: "FAIL" },
};

// Interview pace budgets (minutes). Platform estimates for the general
// solver, not a personal target — but an unaided solve over budget isn't
// interview-ready yet, so pace gates the climb (see mastery below) and the
// plan uses these to size a session.
export const BUDGET = { Easy: 15, Medium: 30, Hard: 45, "Very Hard": 60 };

// The difficulties a technique can be served at, easiest first. Identical to
// the catalog's TIERS; a mastery tier IS an index into this.
export const TIERS_SERVED = ["Easy", "Medium", "Hard", "Very Hard"];

// Separate days of unaided-optimal-at-pace needed to climb one tier. Two,
// because one good night is noise and a criterion you can clear in an evening
// isn't a criterion.
export const CLIMB_STREAK = 2;

// Days per tier, used ONLY to normalise staleness into "how long should this
// tier survive untouched" so techniques can be ranked against each other.
// These are NOT due dates and nothing schedules from them.
export const STALE_SCALE = [3, 7, 14, 30];

// ---------- Mastery ----------
// Derived, never stored: walking a technique's attempts oldest-first always
// yields the same tier on every device, with no migration when the rules
// improve.
//
// A tier is an index into TIERS_SERVED — the hardest disguise the technique
// has earned the right to be tested in. It is not a schedule and it does not
// decay with time; only evidence moves it.
//
// A DAY of attempts is one event: the tier moves at most one step per day,
// whatever the order of solves within it. This is what makes warm-ups safe —
// an easy same-technique rep logged before the day's real serve can neither
// eat the climb nor double it.
//
// Rules, per day (attempts must be sorted oldest-first):
//   - any fail that day: drop one tier. Failing a fresh problem of the pattern
//     is exactly the evidence that the pattern hasn't transferred — but one
//     bad night shouldn't erase months, so it's a step down, not a reset;
//   - otherwise an unaided optimal AT PACE: +1 to the streak, and CLIMB_STREAK
//     such days climb a tier. Two separate days, because a single clean solve
//     is as likely to be a familiar problem as a mastered move;
//   - anything else (hints, suboptimal, or unaided-but-over-pace): the streak
//     breaks. Solving it eventually is not solving it in an interview.
export const atPace = (a) =>
  a.minutes == null || a.minutes <= (BUDGET[a.problem?.difficulty] ?? 30);

export function mastery(attempts) {
  let tier = 0, streak = 0, last = null, lastOutcome = null;
  for (let i = 0; i < attempts.length; ) {
    const day = dayStartOf(attempts[i].t);
    let cold = false, failed = false;
    for (; i < attempts.length && dayStartOf(attempts[i].t) === day; i++) {
      if (attempts[i].outcome === "cold" && atPace(attempts[i])) cold = true;
      if (attempts[i].outcome === "failed") failed = true;
      lastOutcome = attempts[i].outcome;
      last = attempts[i].t;
    }
    if (failed) { tier = Math.max(0, tier - 1); streak = 0; }
    else if (cold) {
      streak += 1;
      if (streak >= CLIMB_STREAK) { tier = Math.min(TIERS_SERVED.length - 1, tier + 1); streak = 0; }
    } else streak = 0;
  }
  return { tier, streak, last, lastOutcome, attempts: attempts.length };
}

// Whole days since the technique was last exercised. Pressure, not a debt —
// the plan divides this by STALE_SCALE[tier] to rank, and nothing else reads
// it.
export const staleDays = (last) =>
  last == null ? null : Math.floor((todayStart() - dayStartOf(last)) / DAY);

// The last three outcomes, newest last: the shape of a technique's recent
// evidence, which a single tier number flattens away.
export const form = (attempts) => attempts.slice(-3).map((a) => a.outcome);

// Did you reach for the right move, and how long did it take to see it? Only
// attempts where a guess was actually recorded count — a blank guess is a
// missing measurement, not a miss.
export function recognition(attempts, label) {
  const want = (label || "").trim().toLowerCase();
  const guessed = attempts.filter((a) => a.guess != null && String(a.guess).trim() !== "");
  const hits = guessed.filter((a) => String(a.guess).trim().toLowerCase() === want).length;
  const knew = guessed.map((a) => a.knew).filter((k) => k != null).sort((a, b) => a - b);
  const mid = knew.length
    ? (knew.length % 2 ? knew[(knew.length - 1) / 2] : (knew[knew.length / 2 - 1] + knew[knew.length / 2]) / 2)
    : null;
  return { n: guessed.length, hits, medianKnew: mid };
}

// A monotone 0..1 summary of tier + progress toward the next one, discounted
// by the freshest evidence. A heuristic for bars and sorting — never a
// probability of recall, and nothing schedules from it.
export function strength({ tier, streak, lastOutcome }) {
  const base = ((tier ?? 0) + (streak ?? 0) / CLIMB_STREAK + 1) / (TIERS_SERVED.length + 1);
  const mod = lastOutcome === "cold" ? 1 : lastOutcome === "subopt" ? 0.85 : lastOutcome === "hints" ? 0.7 : 0.4;
  return Math.min(1, base * mod);
}

// ---------- Leeches ----------
// A technique you keep failing is fighting you. Serving yet another fresh
// problem of it just burns reps — the fix is to study worked solutions and
// rewrite them from memory. Counted over a sliding window of the technique's
// attempts: failures from months ago say nothing about a pattern you have
// since consolidated, and it must sustain its recovery to clear the flag.
export const LEECH_WINDOW = 6; // attempts considered
export const LEECH_LAPSES = 3; // failures within the window

export const lapses = (attempts) =>
  attempts.slice(-LEECH_WINDOW).filter((a) => a.outcome === "failed").length;
export const isLeech = (attempts) => lapses(attempts) >= LEECH_LAPSES;

// ---------- Fluency (never scheduling) ----------
export const lastTime = (p) => {
  const t = (p.times || []).filter((x) => x != null);
  return t.length ? t[t.length - 1] : null;
};
export const overPace = (p) => {
  const t = lastTime(p), b = BUDGET[p.difficulty];
  return t != null && b != null && t > b;
};

// ---------- Problem links ----------
// Many practice sites publish a question at <origin>/questions/<slug>, where
// the slug is the question name. Pasting such a link is enough to name the
// problem; any other link is kept verbatim and named by hand.
export const ACRONYMS = new Set(["bst", "bfs", "dfs", "lru", "lfu", "lca", "dp", "ap", "api", "gcd", "lcm", "xor", "ii", "iii", "iv"]);

export function titleFromSlug(slug) {
  return slug.split("-").filter(Boolean)
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// Returns { url, name } for anything shaped like <origin>/questions/<slug>,
// or null. Accepts a bare host (no scheme) so a half-copied link still works.
export function parseProblemUrl(raw) {
  const text = (raw || "").trim();
  if (!text) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  const m = /^\/questions\/([^/]+)\/?$/.exec(u.pathname);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).toLowerCase();
  return { url: `${u.origin}/questions/${slug}`, name: titleFromSlug(slug) };
}

// ---------- Cross-source aliases ----------
// The same problem exists under different names across sources — one site
// renames another's classic, or retells it with a new story. A card claiming
// "fresh — never attempted" must not serve a renamed twin of a problem already
// in the log, so name matching treats each group in the catalog's `aliases`
// list as one problem.
//
// Only mechanical identity belongs in a group: the same task retold verbatim
// or trivially mirrored. A different STORY around the same algorithm (a course
// schedule versus a cycle in a graph) is exactly the disguise transfer tests
// exist to serve, and stays un-aliased. Never put two catalog problems in one
// group — groups are transitive, and that would merge two distinct records'
// evidence.
const ALIAS_GROUPS = (CATALOG_DATA.aliases ?? []).filter((g) => Array.isArray(g) && g.length > 1);

const aliasIndex = new Map();
ALIAS_GROUPS.forEach((g, i) => g.forEach((n) => aliasIndex.set(n.toLowerCase(), i)));

// The identity a name matches under: its alias group when it has one, itself
// otherwise.
export const nameKey = (name) => {
  const n = (name || "").trim().toLowerCase();
  const g = aliasIndex.get(n);
  return g != null ? `alias:${g}` : n;
};

// One problem, one record. A second copy would split its attempt history in
// two, and the derived technique tier would see half the evidence twice.
// Match on the canonical URL first, then the (alias-aware) name.
export function findExisting(problems, { url, name }) {
  const u = parseProblemUrl(url)?.url;
  const n = (name || "").trim() ? nameKey(name) : null;
  return (problems || []).find((p) =>
    (u && p.url === u) || (n && nameKey(p.name) === n)) || null;
}

// ---------- Mutations ----------
export const uid = () => Math.random().toString(36).slice(2, 9);

// A problem record is a container for attempts — nothing on it schedules.
// `guess` (the technique you reached for) and `knew` (minutes until you knew
// the move) are the blind rep's real payload; both are optional, because the
// extension logs from a page that never asked.
export function newProblem({ name, url, category, difficulty, insight, outcome, minutes, guess, knew }) {
  return {
    id: uid(), name, url, category, difficulty, insight,
    history: [outcome], times: [minutes ?? null], log: [Date.now()],
    guesses: [guess ?? null], knew: [knew ?? null],
    added: Date.now(),
  };
}

// Appends one attempt. Every array stays index-aligned with `history`; the
// technique's tier picks it up the next time the table is derived.
export function logAttempt(p, outcome, minutes, { guess, knew } = {}) {
  return {
    ...p,
    history: [...p.history, outcome],
    times: [...(p.times || []), minutes ?? null],
    log: [...(p.log || []), Date.now()],
    guesses: [...(p.guesses || []), guess ?? null],
    knew: [...(p.knew || []), knew ?? null],
  };
}

// ---------- Validation ----------
// Every per-attempt array is padded to history.length with nulls — null means
// "not recorded that session", which is exactly true of every attempt logged
// before the field existed. Older entries also only stored `minutes` from the
// first attempt. `step`, `due`, and `via` from the per-problem-scheduling era
// are left in place untouched — old revisions must stay restorable
// byte-for-byte — but nothing reads them anymore.
export function migrate(p) {
  const n = p.history?.length ?? 0;
  const pad = (arr) => [...arr, ...Array(Math.max(0, n - arr.length)).fill(null)];
  const times = p.times
    ? pad(p.times)
    : pad([p.minutes ? parseInt(p.minutes, 10) || null : null]);
  const guesses = pad(p.guesses || []);
  const knew = pad(p.knew || []);
  if (p.times && p.guesses?.length === n && p.knew?.length === n && p.times.length === n) return p;
  return { ...p, times, guesses, knew };
}

// A file is only importable if every entry has the fields the derivation
// depends on. Anything less would corrupt the derived tiers, so we refuse the
// whole file. `guesses`/`knew` are deliberately NOT required — migrate()
// backfills them — and neither are `step`/`due` from the old era (old records
// still validate; extra fields are fine).
export function isProblem(p) {
  if (!p || typeof p !== "object") return false;
  return typeof p.id === "string" && typeof p.name === "string"
    && Array.isArray(p.history) && p.history.length > 0
    && p.history.every((h) => h in OUTCOMES);
}
