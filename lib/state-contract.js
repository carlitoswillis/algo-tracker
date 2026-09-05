// The read/write contract for the stored log, shared by the production
// serverless route (api/state.js) and the dev server (vite.config.js). If those
// two disagree about how writes are validated, bugs only appear after a deploy.
//
// Pure: no Redis, no filesystem, no `fetch`.
import { isProblem } from "./schedule.js";

// A log written before revisions existed is revision 0.
export const readShape = (state) => ({
  rev: state?.rev ?? 0,
  updatedAt: state?.updatedAt ?? null,
  problems: state?.problems ?? [],
});

// How many previous revisions to retain. A revision-check stops a *stale* writer,
// but nothing stops a write that is current and simply wrong: a mistaken import,
// a delete you notice after the undo toast expired, a bug in the app. Redis holds
// one version, so without these there is nothing to roll back to.
export const SNAPSHOT_KEEP = 10;
export const snapshotSlot = (rev) => rev % SNAPSHOT_KEEP;
export const snapshotKey = (key, rev) => `${key}:prev:${snapshotSlot(rev)}`;
export const snapshotPrefix = (key) => `${key}:prev:`;

// Shape and revision-presence checks. Deliberately does NOT compare revisions:
// that comparison has to happen atomically next to the write, or two writers can
// both read rev 9, both pass, and the second silently erase the first.
//   -> { ok: true, rev, problems } | { ok: false, status, body }
export function validateWrite(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, body: { error: "Invalid state payload." } };
  }

  const { rev, problems } = body;

  if (!Number.isInteger(rev) || rev < 0) {
    return { ok: false, status: 400, body: { error: "Write must declare the revision it is based on." } };
  }

  // Defence in depth: never persist a log the app itself would refuse to load.
  if (!Array.isArray(problems) || !problems.every(isProblem)) {
    return { ok: false, status: 400, body: { error: "Refusing to persist a malformed log." } };
  }

  return { ok: true, rev, problems };
}

export const conflictResponse = (currentRev) => ({
  status: 409,
  body: { error: "Your copy of the log is out of date.", rev: currentRev },
});

export const nextState = (currentRev, problems) => ({
  rev: currentRev + 1,
  updatedAt: Date.now(),
  problems,
});

// Non-atomic plan, for the single-process dev server where no race exists.
// Production uses CAS_SCRIPT instead. Returns { status, body, next?, snapshot? }.
export function planWrite(current, body) {
  const v = validateWrite(body);
  if (!v.ok) return { status: v.status, body: v.body };

  const currentRev = current?.rev ?? 0;
  if (v.rev !== currentRev) return conflictResponse(currentRev);

  const next = nextState(currentRev, v.problems);
  return { status: 200, body: { rev: next.rev }, next, snapshot: current ?? null };
}

// Atomic compare-and-swap, plus a snapshot of the state being replaced.
//
// Everything happens inside one Redis call, so two writers cannot both observe
// revision 9 and both proceed. The loser is told the real revision and writes
// nothing.
//
//   KEYS[1] = the state key
//   ARGV[1] = the revision the writer believes is current
//   ARGV[2] = the JSON to store
//   ARGV[3] = snapshot key prefix
//   ARGV[4] = how many snapshot slots to rotate through
//
//   returns { 1, newRev } on success, { 0, currentRev } on conflict
export const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local curRev = 0
if cur then
  local ok, decoded = pcall(cjson.decode, cur)
  if ok and type(decoded) == 'table' and decoded.rev then
    curRev = tonumber(decoded.rev)
  end
end

if curRev ~= tonumber(ARGV[1]) then
  return { 0, curRev }
end

-- Keep the state we are about to replace, in a slot derived from its revision
-- so the ring rotates without needing a separate cursor.
if cur then
  local slot = curRev % tonumber(ARGV[4])
  redis.call('SET', ARGV[3] .. slot, cur)
end

redis.call('SET', KEYS[1], ARGV[2])
return { 1, curRev + 1 }
`.trim();
