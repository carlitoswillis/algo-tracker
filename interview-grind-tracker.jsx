import React, { useState, useEffect, useMemo, useRef } from "react";

// The ethos: interviews never hand you a problem you've seen — they hand you a
// problem whose PATTERN you've seen. So the unit of practice is the TECHNIQUE
// and the rep is an UNSEEN problem. Nothing here has a due date: a technique
// surfaces because it has gone longest without a rep, or because it beat you,
// never because a calendar says so.
//
// The technique stays hidden until the attempt is logged — choosing the move
// from the problem itself is the thing being trained, so this file must never
// render a blind item's technique label anywhere, title attributes included.
//
// The rules and the problem shape live in lib/schedule.js and lib/techniques.js
// — shared verbatim with the Chrome extension. Keep logic there, not here.
import {
  DAY, todayStart, fmtDate,
  CATEGORIES, OUTCOMES, BUDGET, TIERS_SERVED, CLIMB_STREAK, LEECH_WINDOW,
  overPace, parseProblemUrl, findExisting,
  newProblem, logAttempt, migrate, isProblem,
} from "./lib/schedule.js";

import { CATALOG, LIBRARY as IMPORTED_LIBRARY, TIERS, sourceOf, LIBRARY_URL } from "./lib/problems.js";
import {
  techniqueOf, lookupEntry, deriveTechniques, buildPlan,
  priority, isSkipped, staleness, TECHNIQUE_LABELS,
} from "./lib/techniques.js";

// The whole curriculum as one browsable list — every problem either source
// knows, whether or not the scheduler has ever served it. Built once: the
// module data never changes within a session.
// Sources are whatever the catalog says (a `source` field, else the link host).
const SOURCES = [...new Set(CATALOG.map(sourceOf))].sort();
const LIBRARY = [
  ...CATALOG.map((c) => ({ ...c, seen: false })),
  ...IMPORTED_LIBRARY,
].map((e) => ({ ...e, src: sourceOf(e) }))
  .sort((a, b) => a.category.localeCompare(b.category)
    || (a.technique ?? "~").localeCompare(b.technique ?? "~")
    || TIERS.indexOf(a.difficulty) - TIERS.indexOf(b.difficulty)
    || a.name.localeCompare(b.name));

// ---------- Words ----------
// Counts read as words in prose and as numerals in the ledger and the columns,
// the way a practice diary is written.
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh",
  "eighth", "ninth", "tenth", "eleventh", "twelfth"];

function numberWord(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)], o = n % 10;
    return o ? `${t}-${ONES[o]}` : t;
  }
  return n.toLocaleString();
}
const ordinalWord = (i) => ORDINALS[i] ?? `number ${i + 1}`;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const plural = (n, word) => `${word}${n === 1 ? "" : "s"}`;
const tierWord = (tier) => (TIERS_SERVED[tier] ?? TIERS_SERVED[0]).toLowerCase();

// "36 days ago" / "today" / "never" — the last time, never an appointment.
function lastWords(days) {
  if (days == null) return "never";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
const OUTCOME_WORD = { cold: "optimal", subopt: "suboptimal", hints: "hints", failed: "fail" };
const fmtLong = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

// Never hand an arbitrary string to href — `javascript:` and `data:` URLs execute
// on click. Only http(s) links through; anything else renders as plain text.
const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);

const countOf = (x) => (Array.isArray(x) ? x.length : Number.isFinite(x) ? x : 0);

// ---------- Storage ----------
const KEY = "grind-tracker-v1";

// Three outcomes, never conflated:
//   { ok: true,  source: "server" }  -> authoritative; safe to write back
//   { ok: true,  source: "backup" }  -> a local copy of unknown age; READ ONLY
//   { ok: false }                    -> nothing to show
//
// Treating a backup as authoritative is precisely how a log gets erased: the app
// loads an old snapshot, believes it, and saves it over the real one.
async function loadState() {
  try {
    const res = await window.storage.get(KEY);
    if (!res) return { ok: false };
    return { ok: true, source: res.source ?? "server", state: JSON.parse(res.value) };
  } catch (e) {
    console.error("load failed", e);
    return { ok: false };
  }
}

// Declares the revision it is based on; the server rejects it with 409 if that
// isn't the revision currently stored. Returns the outcome rather than throwing,
// so a failed write can never look like a successful one.
async function saveState(rev, problems) {
  try {
    return await window.storage.set(KEY, JSON.stringify({ rev, problems }));
  } catch (e) {
    console.error("save failed", e);
    return { ok: false, error: e.message };
  }
}

// The artifact sandbox provides a bare get/set, so guard on the capability
// rather than assuming the richer adapter is present.
const canRestore = () => typeof window.storage?.history === "function";

// Postponing a technique is triage, not evidence, so it stays out of the synced
// log — this browser only. Expired entries are pruned on load; losing one merely
// means a technique surfaces again, which is the safe direction.
const DELAYS_KEY = "grind-technique-delays";
function loadDelays() {
  try {
    const raw = JSON.parse(localStorage.getItem(DELAYS_KEY) || "{}");
    const now = todayStart();
    return Object.fromEntries(Object.entries(raw).filter(([, ts]) => Number.isFinite(ts) && ts > now));
  } catch { return {}; }
}

const BUDGET_KEY = "grind-plan-budget";
const SESSION_SIZES = [45, 60, 90, 120]; // minutes



// ---------- Figures ----------
// Every measured quantity in this app is set in the mono face and lands in the
// gutter at the rule: minutes, days, dates, counts, grades. Words are the
// grotesque; figures are the mono. The two never swap jobs.
const Fig = ({ children, unit }) => (
  <span className="fig">{children}{unit && <span className="figUnit">{unit}</span>}</span>
);

const Chevron = ({ dir = "right" }) => (
  <svg className="chev" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={dir === "left" ? "M10.5 3.5L5.5 8l5 4.5" : "M5.5 3.5L10.5 8l-5 4.5"} />
  </svg>
);

// mm:ss, always two digits — a split you read digit by digit.
const clock = (secs) => {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// The gutter figure for "how long since": the sort key on the moves ledger,
// short enough to sit in 44px of mono.
const sinceFig = (days) => (days == null ? "—" : days <= 0 ? "0d" : `${days}d`);

// A date in the figure column is set the way a log book sets one: the day, with
// its month beneath, so every line in the column keeps the same width.
const dayFig = (ts) => {
  const d = new Date(ts);
  return { day: d.toLocaleDateString(undefined, { day: "numeric" }),
    month: d.toLocaleDateString(undefined, { month: "short" }) };
};

// ---------- App ----------
export default function GrindTracker() {
  const [problems, setProblems] = useState([]);
  // loading | ready | stale (backup shown, read-only) | error | conflict
  const [status, setStatus] = useState("loading");
  const [saving, setSaving] = useState(null); // null | "saving" | "saved" | { error }
  // The tab lives in the URL hash so a view can be linked to and reloaded.
  const TABS = ["today", "techniques", "library", "log"];
  const [tab, setTabState] = useState(() => {
    const h = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#/, "");
    return TABS.includes(h) ? h : "today";
  });
  const setTab = (k) => {
    setTabState(k);
    try { history.replaceState(null, "", k === "today" ? window.location.pathname : `#${k}`); } catch { /* fine */ }
  };
  const [showAdd, setShowAdd] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState(null); // problem id being edited
  const [undo, setUndo] = useState(null); // { label, snapshot } — in memory only
  const [delays, setDelays] = useState(loadDelays);
  // A preference, not log data — it stays out of the synced state on purpose.
  const [budget, setBudget] = useState(() => {
    const v = parseInt(localStorage.getItem(BUDGET_KEY) ?? "", 10);
    return SESSION_SIZES.includes(v) ? v : 90;
  });
  const fileInput = useRef(null);

  const revRef = useRef(0);        // the revision this tab last read or wrote
  const savedRef = useRef(null);   // serialised problems already on the server

  const load = React.useCallback(() => {
    setStatus("loading");
    setSaving(null);
    loadState().then((r) => {
      if (!r.ok) return setStatus("error");
      const list = (r.state?.problems ?? []).map(migrate);
      setProblems(list);
      revRef.current = r.state?.rev ?? 0;
      // Remember what the server already has, so mounting doesn't immediately
      // POST back the very state we just read.
      savedRef.current = r.source === "server" ? JSON.stringify(list) : null;
      setStatus(r.source === "server" ? "ready" : "stale");
    });
  }, []);

  useEffect(load, [load]);

  // Persist only from an authoritative read. Writing while "error" would push the
  // empty array we failed to fill; writing while "stale" would promote a local
  // backup of unknown age over the real log. Both erase data.
  useEffect(() => {
    if (status !== "ready") return;
    const serialised = JSON.stringify(problems);
    if (serialised === savedRef.current) return; // nothing changed since the last write

    let cancelled = false;
    setSaving("saving");
    saveState(revRef.current, problems).then((res) => {
      if (cancelled) return;
      if (res.conflict) {
        // Someone else wrote since we read. Refuse to clobber them.
        setStatus("conflict");
        setSaving(null);
        return;
      }
      if (!res.ok) {
        setSaving({ error: res.error || "unknown error" });
        return;
      }
      revRef.current = res.rev ?? revRef.current + 1;
      savedRef.current = serialised;
      setSaving("saved");
    });
    return () => { cancelled = true; };
  }, [problems, status]);

  // The undo offer is transient: it expires rather than lingering into a
  // later session where restoring it would be a surprise.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 12000);
    return () => clearTimeout(t);
  }, [undo]);

  // Every log mutation goes through here, so nothing is ever unrecoverable.
  function commit(label, next) {
    setUndo({ label, snapshot: problems });
    setProblems(next);
  }

  const techs = useMemo(() => deriveTechniques(problems), [problems]);

  function pickBudget(m) {
    setBudget(m);
    try { localStorage.setItem(BUDGET_KEY, String(m)); } catch { /* preference only */ }
  }

  function addProblem(data) {
    const existing = findExisting(problems, data);
    // The modal warns about duplicates but doesn't block; if the user insists
    // on a name that's already tracked, log it as an attempt on that record —
    // a second copy would split the technique's evidence in two.
    commit(`Logged ${data.name}.`, existing
      ? problems.map((p) => (p.id === existing.id
        ? logAttempt(p, data.outcome, data.minutes, { guess: data.guess, knew: data.knew })
        : p))
      : [newProblem(data), ...problems]);
    setShowAdd(false);
  }

  // Edits only touch descriptive fields — never the attempt history.
  function updateProblem(id, data) {
    commit(`Edited ${data.name}.`, problems.map((p) => (p.id === id ? { ...p, ...data } : p)));
    setEditing(null);
  }

  // One more attempt on an already-tracked problem (a re-solve serving an
  // exhausted pool, a leech rewrite, or a voluntary rep from the log).
  function recordAttempt(id, outcome, minutes, extra = {}) {
    const { guess = null, knew = null, insight = "" } = extra;
    commit(`Recorded ${OUTCOMES[outcome].label.toLowerCase()}.`,
      problems.map((p) => (p.id === id
        ? { ...logAttempt(p, outcome, minutes, { guess, knew }), ...(insight ? { insight } : {}) }
        : p)));
  }

  // A problem served for a technique that has never been attempted here. It
  // enters the log as an ordinary first attempt; the technique's tier picks the
  // outcome up on the next derivation. If it turned out to be tracked already
  // (logged from the extension popup in the same session), append instead — a
  // second copy would split the evidence.
  function recordFresh(entry, outcome, minutes, extra = {}) {
    const { guess = null, knew = null, insight = "" } = extra;
    const existing = findExisting(problems, entry);
    commit(`Logged ${entry.name}.`, existing
      ? problems.map((p) => (p.id === existing.id
        ? logAttempt(p, outcome, minutes, { guess, knew })
        : p))
      : [newProblem({
          name: entry.name, url: entry.url, category: entry.category,
          difficulty: entry.difficulty, insight, outcome, minutes, guess, knew,
        }), ...problems]);
  }

  // Postponing records nothing and cannot touch a tier; it only keeps the
  // technique out of the plan for a few days. Never synced, never undoable —
  // redoing it costs a click.
  function delayTech(key, days) {
    const next = { ...delays, [key]: todayStart() + days * DAY };
    setDelays(next);
    try { localStorage.setItem(DELAYS_KEY, JSON.stringify(next)); } catch { /* preference only */ }
  }

  function removeProblem(id) {
    const p = problems.find((x) => x.id === id);
    if (p && !window.confirm(`Remove ${p.name} and its attempts? Its technique is re-derived without them.`)) return;
    commit(`Removed ${p.name}.`, problems.filter((x) => x.id !== id));
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify({ problems }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `grind-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Restoring is an ordinary write: it goes through the same revision check, and
  // the state it replaces is itself snapshotted. So a restore is undoable too.
  function restoreSnapshot(rev, list) {
    commit(`Restored revision ${rev}.`, list.map(migrate));
    setShowHistory(false);
  }

  async function importJSON(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data?.problems;
      if (!Array.isArray(list) || !list.length || !list.every(isProblem))
        throw new Error("that file isn’t an Algo Tracker export");
      if (!window.confirm(`Replace all ${problems.length} tracked problems with the ${list.length} in this file?`)) return;
      commit(`Imported ${list.length} ${plural(list.length, "problem")}.`, list.map(migrate));
    } catch (e) {
      window.alert(`Import failed: ${e.message}. Nothing was changed.`);
    }
  }

  const startedCount = techs.filter((t) => t.cataloged && t.started).length;
  const catalogedCount = techs.filter((t) => t.cataloged).length;
  const editProblem = problems.find((p) => p.id === editing);
  const ready = status === "ready";


  // The rep screen takes the whole viewport: while you are working a problem the
  // header, the nav and the rest of the session are noise.
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (tab !== "today") setFocused(false); }, [tab]);


  const head = tab === "today"
    ? { title: fmtLong(Date.now()), meta: null }
    : tab === "techniques"
    ? { title: "Moves", meta: `${startedCount} of ${catalogedCount} started` }
    : tab === "library"
    ? { title: "Library", meta: `${LIBRARY.length.toLocaleString()} problems the scheduler can serve` }
    : { title: "Log", meta: `${problems.length} ${plural(problems.length, "problem")} logged` };

  return (
    <div className={`app${focused ? " isFocused" : ""}`}>
      <style>{CSS}</style>
      <datalist id="technique-labels">
        {(TECHNIQUE_LABELS || []).map((l) => <option key={l} value={l} />)}
      </datalist>

      <div className="sheetPage">
        {!focused && (
          <header className="masthead">
            <h1 className="mastheadTitle">{head.title}</h1>
            <p className="mastheadMeta">
              {head.meta && <span>{head.meta}</span>}
              <SaveIndicator saving={saving} status={status} />
            </p>
          </header>
        )}

        {status === "stale" && (
          <Notice title="Showing a local backup, read only">
            <p>
              The server could not be reached, so this is the copy your browser kept.
              It may be out of date, and nothing you do here will be saved.
              Export it if it looks newer than the server’s, then try again.
            </p>
            <div className="noticeActions">
              <button className="btn" onClick={load}>Try again</button>
              <button className="btn" onClick={exportJSON}>Export this view</button>
            </div>
          </Notice>
        )}

        {status === "conflict" && (
          <Notice title="Your log changed somewhere else">
            <p>
              Another tab, device, or the extension wrote to your log after this page
              loaded. Your last change was not saved, and nothing here has overwritten
              that newer version. Export this view if you need it, then reload.
            </p>
            <div className="noticeActions">
              <button className="btn" onClick={load}>Load the latest</button>
              <button className="btn" onClick={exportJSON}>Export this view</button>
            </div>
          </Notice>
        )}

        {status === "loading" ? (
          <p className="prose">Loading your log.</p>
        ) : status === "error" ? (
          <Notice title="Your log could not be reached">
            <p>
              Nothing has been changed, and nothing will be saved from here, because an empty
              tracker must never be written over a real one. Check your connection and
              try again.
            </p>
            <div className="noticeActions">
              <button className="btn" onClick={load}>Try again</button>
            </div>
          </Notice>
        ) : tab === "today" ? (
          <TodayView techs={techs} problems={problems} delays={delays} ready={ready} budget={budget}
            pickBudget={pickBudget} focused={focused} setFocused={setFocused}
            recordFresh={recordFresh} recordAttempt={recordAttempt} delayTech={delayTech} />
        ) : tab === "techniques" ? (
          <TechniquesView techs={techs} delays={delays} />
        ) : tab === "library" ? (
          <LibraryView problems={problems} ready={ready} openLog={(prefill) => setShowAdd(prefill)} />
        ) : (
          <LogView problems={problems} removeProblem={removeProblem} setEditing={setEditing}
            recordAttempt={recordAttempt} ready={ready} exportJSON={exportJSON}
            importJSON={() => fileInput.current?.click()}
            openHistory={canRestore() ? () => setShowHistory(true) : null} />
        )}

        <input ref={fileInput} type="file" accept="application/json,.json" style={{ display: "none" }}
          onChange={(e) => { importJSON(e.target.files?.[0]); e.target.value = ""; }} />
      </div>

      {!focused && (
        <nav className="strip" aria-label="Sections">
          {[["today", "Today"], ["techniques", "Moves"]].map(([k, label]) => (
            <button key={k} className={`stripTab${tab === k ? " stripTabOn" : ""}`} onClick={() => setTab(k)}
              aria-current={tab === k ? "page" : undefined}>{label}</button>
          ))}
          <button className="stripTab" disabled={!ready} onClick={() => setShowAdd(true)}
            aria-label="Add a solve to the log">Add</button>
          {[["library", "Library"], ["log", "Log"]].map(([k, label]) => (
            <button key={k} className={`stripTab${tab === k ? " stripTabOn" : ""}`} onClick={() => setTab(k)}
              aria-current={tab === k ? "page" : undefined}>{label}</button>
          ))}
        </nav>
      )}

      {showHistory && <HistoryModal onClose={() => setShowHistory(false)} onRestore={restoreSnapshot} />}

      {showAdd && <ProblemModal problems={problems} prefill={typeof showAdd === "object" ? showAdd : null}
        onClose={() => setShowAdd(false)} onSave={addProblem} />}
      {editProblem && (
        <ProblemModal problem={editProblem} problems={problems}
          onClose={() => setEditing(null)}
          onSave={(data) => updateProblem(editProblem.id, data)} />
      )}

      {undo && (
        <div className="undo" role="status">
          <span className="undoSay">{undo.label}</span>
          <button className="btn btnSm btnStrong"
            onClick={() => { setProblems(undo.snapshot); setUndo(null); }}>Undo</button>
          <button className="btn btnSm btnBare" onClick={() => setUndo(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

// How long the session is. It sizes the plan and nothing else — no technique is
// ever rescheduled by it, because nothing is scheduled at all.
function SessionLength({ budget, onPick }) {
  return (
    <div className="dial" role="group" aria-label="Session length in minutes">
      <span className="dialLabel">Session</span>
      {SESSION_SIZES.map((m) => (
        <button key={m} onClick={() => onPick(m)}
          className={`dialBtn fig${budget === m ? " dialBtnOn" : ""}`}
          aria-pressed={budget === m}>{m}</button>
      ))}
      <span className="dialLabel">minutes</span>
    </div>
  );
}

// Persistence used to be invisible: a failed POST looked exactly like a saved
// one, because both only ever reached console.error. Now it says so.
function SaveIndicator({ saving, status }) {
  if (status === "stale" || status === "error" || status === "conflict")
    return <span className="mark" title="Nothing is being written from this view">not saving</span>;
  if (saving === "saving") return <span>saving</span>;
  if (saving && saving.error)
    return <span className="mark" title={saving.error}>not saved, still only in this browser</span>;
  return <span>saved</span>;
}

// Bad news gets a rule and the marking pen, not a coloured box.
function Notice({ title, children }) {
  return (
    <section className="notice" role="alert">
      <h2 className="noticeTitle">{title}</h2>
      {children}
    </section>
  );
}

// A column head: the words on the left, the count in the figure column, and the
// rule that opens the section.
function Head({ children, count }) {
  return (
    <div className="colhead">
      <span className="colheadName">{children}</span>
      {count != null && <span className="fig colheadCount">{count}</span>}
    </div>
  );
}

// ---------- Today ----------
// The session as a log sheet: the minutes each rep is worth stand in the figure
// column at the rule, the problem is written beside it, and the technique is
// nowhere, because choosing the move from the problem alone is the rep.
export function TodayView({ techs, problems, delays, ready, budget, pickBudget,
  focused, setFocused, recordFresh, recordAttempt, delayTech }) {
  // Reroll counters, per technique. Session-only state: the base pick is
  // day-seeded, so a reload simply returns to it.
  const [nonces, setNonces] = useState({});
  const [openKey, setOpenKey] = useState(null); // the rep being worked, if any
  const [postponing, setPostponing] = useState(false);
  // What a technique's tier was at the moment its attempt was logged, so the
  // reveal can say the tier moved. In memory, this session only.
  const [logged, setLogged] = useState({});

  const plan = useMemo(() => buildPlan(techs, budget, delays, nonces), [techs, budget, delays, nonces]);
  const items = useMemo(() => (plan.items ?? []).filter((i) => i?.serve?.problem), [plan]);
  const idx = items.findIndex((i) => i.tech.key === openKey);
  const open = idx >= 0 ? items[idx] : null;

  useEffect(() => { setFocused(!!open); }, [open, setFocused]);

  // Everything logged today, whatever logged it — this page, another tab, the
  // extension. "Logged today" is the day's evidence, not this session's.
  const tonight = useMemo(() => {
    const start = todayStart();
    const rows = [];
    for (const p of problems) {
      (p.log || []).forEach((ts, i) => {
        if (ts >= start) rows.push({
          p, i, ts,
          outcome: p.history[i],
          minutes: p.times?.[i] ?? null,
          guess: p.guesses?.[i] ?? null,
          knew: p.knew?.[i] ?? null,
        });
      });
    }
    return rows.sort((a, b) => b.ts - a.ts);
  }, [problems]);

  const reroll = (key) => setNonces((n) => ({ ...n, [key]: (n[key] ?? 0) + 1 }));

  function record(item, outcome, minutes, guess, knew) {
    const t = item.tech;
    setLogged((m) => ({ ...m, [t.key]: { tier: t.tier ?? 0, why: item.why, label: t.label } }));
    if (item.serve.mode === "resolve" || item.serve.mode === "study")
      recordAttempt(item.serve.problem.id, outcome, minutes, { guess, knew });
    else
      recordFresh(item.serve.problem, outcome, minutes, { guess, knew });
    setOpenKey(null);
    setPostponing(false);
  }

  if (open) {
    return (
      <RepScreen key={open.tech.key + ":" + (nonces[open.tech.key] ?? 0)}
        item={open} position={idx} total={items.length} ready={ready}
        postponing={postponing} setPostponing={setPostponing}
        onBack={() => { setOpenKey(null); setPostponing(false); }}
        onReroll={() => reroll(open.tech.key)}
        onPostpone={(days) => { delayTech(open.tech.key, days); setOpenKey(null); setPostponing(false); }}
        onRecord={(outcome, minutes, guess, knew) => record(open, outcome, minutes, guess, knew)} />
    );
  }

  const st = staleness(techs);
  const blind = items.some((i) => i.serve.blind);

  return (
    <div>
      <SessionLength budget={budget} onPick={pickBudget} />

      {problems.length === 0 ? (
        <p className="prose">
          Nothing is logged yet. Log every problem you attempt: the tracker keeps track of
          the techniques those problems exercise, and hands you an unseen problem for the
          move you have gone longest without.
        </p>
      ) : items.length === 0 ? (
        <p className="prose">
          Nothing is waiting. Every technique you have started has had a rep recently
          enough, and any you postponed comes back on its own. Browse the library if you
          want extra ground.
        </p>
      ) : null}

      {items.length > 0 && (
        <>
          <Head count={`${plan.totalMin} min`}>
            {numberWord(items.length)} {plural(items.length, "rep")} today
          </Head>
          <div className="entries">
            {items.map((item) => <Entry key={item.tech.key} item={item} onOpen={() => setOpenKey(item.tech.key)} />)}
          </div>
          <p className="note">
            {blind
              ? "The technique stays hidden until you log the attempt, because naming it is the rep."
              : "Each of these opens a move you have never tried, so it starts with a worked solution."}
            {plan.more > 0 && ` ${cap(numberWord(plan.more))} more would not fit in ${budget} minutes.`}
          </p>
        </>
      )}

      <LoggedToday rows={tonight} techs={techs} logged={logged} />

      <p className="note spaced">
        Nothing here is overdue, because nothing has a due date.
        {st.over > 0
          ? ` ${cap(numberWord(st.over))} of your ${numberWord(st.total)} techniques have gone longer without a rep than their tier should survive, so they surface first over the next few sessions.`
          : " Every technique you have started has had a rep recently enough for its tier."}
        {st.untouched > 0 &&
          ` ${cap(numberWord(st.untouched))} you have never started, and each one opens with a worked solution.`}
      </p>
    </div>
  );
}

// A rep you can start: the only kind of entry in the app that is ruled on all
// four sides. Everything else in the app is a record, and records are not boxed.
function Entry({ item, onOpen }) {
  const { serve, est } = item;
  const p = serve.problem;
  const state = serve.mode === "study" ? "study first"
    : serve.mode === "intro" ? "worked solution first"
    : serve.mode === "resolve" ? "solved before"
    : "never solved";
  return (
    <button className="entry" onClick={onOpen}
      aria-label={`Start ${p.name}, ${(p.difficulty || "medium").toLowerCase()}, about ${est} minutes`}>
      <span className="gutter"><Fig unit="min">{est}</Fig></span>
      <span className="stack">
        <span className="entryName">{p.name}</span>
        <span className="entryFoot">
          <span className="meta">
            {(p.difficulty || "medium").toLowerCase()}, {state}
            {serve.mode === "intro" && `, first time with ${item.tech.label}`}
            {serve.mode === "study" && `, ${item.tech.label} keeps beating you`}
          </span>
          <span className="entryGo">start<Chevron /></span>
        </span>
      </span>
    </button>
  );
}

// The rep screen. One problem, the split against its pace budget, and four ways
// it can have gone. A blind item's technique appears nowhere in here — not in
// the copy, not in a title, not in an aria-label.
function RepScreen({ item, position, total, ready, postponing, setPostponing,
  onBack, onReroll, onPostpone, onRecord }) {
  const { tech, serve, est } = item;
  const p = serve.problem;
  const href = safeUrl(p.url);
  const src = sourceOf(p);
  const [secs, setSecs] = useState(0);
  const [running, setRunning] = useState(false);
  const [knewAt, setKnewAt] = useState(null); // seconds at which the move landed

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  // Minutes are only ever a prefill: a number you can see and change before it
  // is written, never one the app records behind your back.
  const mins = (s) => (s >= 30 ? Math.max(1, Math.round(s / 60)) : null);

  // The track runs to half again the budget, so the budget mark sits two thirds
  // along and going over is something you can see rather than something you are
  // told afterwards.
  const span = est * 90;
  const pct = (s) => `${Math.min(100, (s / span) * 100)}%`;

  return (
    <div className="rep">
      <button className="back" onClick={onBack} aria-label="Back to today">
        <Chevron dir="left" />Today
      </button>

      <h1 className="repName">{p.name}</h1>
      <p className="repMeta">
        {(p.difficulty || "medium").toLowerCase()}, rep {position + 1} of {total},
        {" "}budget <span className="fig">{est}</span> minutes
      </p>

      {href && (
        <a className="btn btnOpen" href={href} target="_blank" rel="noopener noreferrer">
          Open on {src}
        </a>
      )}

      <p className="repSay">
        {serve.mode === "intro" && (
          <>First time with {tech.label}. Read a worked solution, then close it and rewrite
          the whole thing from a blank file. Log that as needed hints. That is what it is,
          and it does not count against you.</>
        )}
        {serve.mode === "study" && (
          <>{cap(tech.label)} has beaten you {numberWord(tech.lapses ?? 0)} times in its last {LEECH_WINDOW} attempts,
          so attempting another one cold just burns a rep. Read this solution, understand the
          invariant, rewrite it from a blank file, and log the rewrite honestly as needed hints.</>
        )}
        {serve.mode === "resolve" && (
          <>You have solved this one before. Nothing unseen is left for this move, so
          solve it again from a blank editor. After this long it is close to cold anyway.</>
        )}
        {(serve.mode === "fresh" || serve.mode === "related") && (
          <>
            You have never solved this one.
            {serve.mode === "related" && " Nothing unseen was left for this move, so this is a problem from the same pattern instead."}
            {p.inLibrary && ` You haven’t opened it on ${sourceOf(p)} yet, so the link lands in the library already searched to it.`}
            {" "}Solve it from a blank editor, out loud, and note the minute you knew what it was.
          </>
        )}
      </p>

      <div className="split">
        <div className="splitClock fig">{clock(secs)}</div>
        <div className="paceWrap">
          <div className="pace" role="img"
            aria-label={`${clock(secs)} of a ${est} minute budget`}>
            <span className="paceFill" style={{ width: pct(secs) }} />
            <span className="paceBudget" style={{ left: pct(est * 60) }} />
            {knewAt != null && <span className="paceKnew" style={{ left: pct(knewAt) }} />}
          </div>
          <div className="paceEnds">
            <span>{knewAt == null ? "no split yet" : <>knew it at <span className="fig">{clock(knewAt)}</span></>}</span>
            <span>budget <span className="fig">{clock(est * 60)}</span></span>
          </div>
        </div>
        <div className="splitBtns">
          <button className="btn" onClick={() => setRunning(!running)}>
            {running ? "Pause" : secs ? "Resume" : "Start"}
          </button>
          <button className="btn" disabled={!secs || knewAt != null}
            onClick={() => setKnewAt(secs)}>
            {knewAt == null ? "I know the move" : "Split taken"}
          </button>
        </div>
      </div>

      <AttemptForm
        disabled={!ready}
        autoMinutes={mins(secs)}
        autoKnew={knewAt == null ? null : mins(knewAt)}
        footer={
          postponing ? (
            <div className="repActions">
              <span className="meta">Bring it back</span>
              <button className="btn btnSm btnBare" onClick={() => onPostpone(1)}>Tomorrow</button>
              <button className="btn btnSm btnBare" onClick={() => onPostpone(3)}>In three days</button>
              <button className="btn btnSm btnBare" onClick={() => onPostpone(7)}>In a week</button>
              <button className="btn btnSm btnBare" onClick={() => setPostponing(false)}>Keep it</button>
            </div>
          ) : (
            <div className="repActions">
              {serve.alts > 1 && (
                <button className="btn btnSm btnBare" onClick={onReroll}>Serve something else</button>
              )}
              <button className="btn btnSm btnBare" onClick={() => setPostponing(true)}>Come back to this later</button>
            </div>
          )
        }
        onRecord={onRecord} />
    </div>
  );
}

// The recording form, in the order the attempt happens: what you reached for,
// when you knew, how long it took, then how it went. Both minute fields are
// prefilled from the split when it ran, and stay editable — the clock is a
// convenience, never the record.
function AttemptForm({ onRecord, footer, disabled, compact, autoMinutes = null, autoKnew = null }) {
  const [guess, setGuess] = useState("");
  const [knew, setKnew] = useState("");
  const [minutes, setMinutes] = useState("");
  const digits = (v) => v.replace(/\D/g, "");
  const num = (v) => (v ? parseInt(v, 10) : null);
  const knewVal = knew || (autoKnew != null ? String(autoKnew) : "");
  const minVal = minutes || (autoMinutes != null ? String(autoMinutes) : "");

  return (
    <div className={`record${compact ? " recordCompact" : ""}`}>
      <label className="field">
        <span className="fieldLabel">Which move did you reach for?</span>
        <input className="line" list="technique-labels" value={guess} spellCheck={false}
          onChange={(e) => setGuess(e.target.value)} placeholder="start typing a technique" />
      </label>
      <div className="fields2">
        <label className="field">
          <span className="fieldLabel">Minutes until you knew</span>
          <input className="line fig" inputMode="numeric" value={knewVal}
            onChange={(e) => setKnew(digits(e.target.value))} />
        </label>
        <label className="field">
          <span className="fieldLabel">Minutes in total</span>
          <input className="line fig" inputMode="numeric" value={minVal}
            onChange={(e) => setMinutes(digits(e.target.value))} />
        </label>
      </div>

      <Head>How did it go? Unaided means no hints and no notes</Head>
      <div className="outcomes">
        {Object.entries(OUTCOMES).map(([k, o]) => (
          <button key={k} disabled={disabled} className="btn btnBlock outcome"
            onClick={() => onRecord(k, num(minVal), guess.trim() || null, num(knewVal))}>
            {o.label}
          </button>
        ))}
      </div>

      {footer}
    </div>
  );
}

// The reveal. Only here does a blind item's technique get named, and the name
// is set in full ink where everything around it is grey — the emphasis is
// weight, not a colour that would read as a mark out of ten.
function LoggedToday({ rows, techs, logged }) {
  if (!rows.length) return null;
  const byKey = new Map(techs.map((t) => [t.key, t]));

  return (
    <>
      <Head count={rows.length}>Logged today</Head>
      <div className="recs">
        {rows.map((r) => {
          const id = techniqueOf(r.p);
          const tech = byKey.get(id.key);
          const before = logged[id.key];
          const moved = before && tech && tech.tier != null && before.tier !== tech.tier;
          const budget = BUDGET[r.p.difficulty];
          const hit = r.guess && id.cataloged
            && r.guess.trim().toLowerCase() === id.label.trim().toLowerCase();
          const after = r.knew != null ? ` after ${r.knew} ${plural(r.knew, "minute")}` : "";

          return (
            <div key={r.p.id + ":" + r.i} className="rec">
              <span className="gutter">
                {r.minutes != null ? <Fig unit="min">{r.minutes}</Fig> : <Fig>—</Fig>}
              </span>
              <span className="stack">
                <ProblemName p={r.p} />
                <span className="meta">
                  {!id.cataloged ? (
                    <>{r.guess ? <>You reached for {r.guess}{after}. </> : null}
                    This one isn’t in the catalog, so it stands on its own rather than feeding a move. </>
                  ) : hit ? (
                    <>You reached for <span className="named">{id.label}</span>{after}, and that is the move. </>
                  ) : r.guess ? (
                    <>You reached for {r.guess}{after}, it was actually <span className="named">{id.label}</span>. </>
                  ) : (
                    <>The move was <span className="named">{id.label}</span>. </>
                  )}
                  {OUTCOMES[r.outcome].label}
                  {r.minutes != null && budget
                    ? <>, against a <span className="fig">{budget}</span> minute budget.</>
                    : "."}
                  {before?.why && ` Served because: ${before.why}.`}
                </span>
                {moved && (
                  <span className="movedRow">
                    <Grade tier={tech.tier} />
                    <span className="meta">{cap(id.label)} now serves {tierWord(tech.tier)} problems</span>
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

// The grade: four steps, filled up to the hardest disguise the move currently
// serves. A scale, not a score — it has no colour and no maximum worth chasing.
function Grade({ tier }) {
  const cur = Math.max(0, Math.min(TIERS_SERVED.length - 1, tier ?? 0));
  return (
    <span className="grade" role="img" aria-label={`Serving ${tierWord(cur)} problems`}>
      {TIERS_SERVED.map((t, i) => <span key={t} className={`gradeStep${i <= cur ? " on" : ""}`} />)}
    </span>
  );
}

// ---------- Moves ----------
// The mastery picture as one ledger, ranked by pressure, with the days since
// the last rep standing in the figure column — the sort key is always what the
// gutter holds. No count anywhere is coloured into a verdict, and the moves you
// have never touched are a column you choose to open rather than seventy-odd
// grey lines meeting you at the door.
export function TechniquesView({ techs, delays }) {
  const [seg, setSeg] = useState("started");
  const pri = (t) => (t.started ? (priority(t) ?? 0) : -1);

  const started = useMemo(() => techs.filter((t) => t.started)
    .sort((a, b) => pri(b) - pri(a) || a.label.localeCompare(b.label)), [techs]);
  const fresh = useMemo(() => techs.filter((t) => t.cataloged && !t.started)
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category)
      || a.label.localeCompare(b.label)), [techs]);

  // The tier counts, as one sentence rather than a row of big numerals: how
  // hard a disguise your started techniques can currently take.
  const byTier = [0, 0, 0, 0];
  for (const t of techs) if (t.cataloged && t.started) byTier[t.tier ?? 0] += 1;
  const tiersHeld = [3, 2, 1, 0].filter((i) => byTier[i] > 0);
  const tierPhrases = tiersHeld.map((i, n) =>
    n === 0
      ? `${cap(numberWord(byTier[i]))} of the moves you have started serve ${tierWord(i)} problems`
      : `${numberWord(byTier[i])} serve ${tierWord(i)}`);

  return (
    <div>
      <div className="dial" role="group" aria-label="Which moves to show">
        <button className={`dialBtn${seg === "started" ? " dialBtnOn" : ""}`}
          aria-pressed={seg === "started"} onClick={() => setSeg("started")}>
          Started <span className="fig">{started.length}</span>
        </button>
        <button className={`dialBtn${seg === "fresh" ? " dialBtnOn" : ""}`}
          aria-pressed={seg === "fresh"} onClick={() => setSeg("fresh")}>
          Not started <span className="fig">{fresh.length}</span>
        </button>
      </div>

      {seg === "started" ? (
        <>
          <Head>Ranked by pressure</Head>
          <div className="recs">
            {started.map((t) => {
              const form = (t.form ?? []).map((o) => OUTCOME_WORD[o] ?? o).join(", ");
              const unseen = countOf(t.unseen);
              const serving = !t.cataloged ? "re-solves only, no pool"
                : t.leech ? "worked solution first"
                : unseen === 0 ? "pool used up, re-solves from here"
                : `${unseen} unseen in pool`;
              const postponed = isSkipped(t, delays);
              return (
                <div key={t.key} className="rec">
                  <span className="gutter"><Fig>{sinceFig(t.staleDays)}</Fig></span>
                  <span className="stack">
                    <span className="recName">
                      {cap(t.label)}
                      {t.leech && <span className="flag">study first</span>}
                    </span>
                    <span className="meta">
                      {t.category.toLowerCase()}, {serving}
                      {!t.cataloged && ", not in the catalog, so it stands alone"}
                      {postponed && `, postponed until ${fmtDate(delays[t.key])}`}
                    </span>
                    {form && <span className="meta">{form}</span>}
                  </span>
                  <span className="recRight">
                    <Grade tier={t.tier} />
                    <span className="meta">{tierWord(t.tier ?? 0)}</span>
                  </span>
                </div>
              );
            })}
          </div>
          <p className="note spaced">
            Pressure is how long a move has gone without a rep against how long its grade
            should survive untouched, plus the freshest evidence there is, plus a large bump
            if it keeps beating you. The figure column is days since the last rep, a fact
            about the past rather than an appointment. The grade is the hardest tier a move
            currently serves: it climbs after {numberWord(CLIMB_STREAK)} unaided optimal solves
            in a row at pace, and drops a step on a fail.
            {tierPhrases.length > 0 && (
              <> {tierPhrases.slice(0, -1).join(", ")}
              {tierPhrases.length > 1 ? " and " : ""}{tierPhrases[tierPhrases.length - 1]}.</>
            )}
          </p>
        </>
      ) : (
        <>
          <Head count={fresh.length}>Waiting for a first rep</Head>
          <div className="recs">
            {fresh.map((t) => (
              <div key={t.key} className="rec">
                <span className="gutter"><Fig>{countOf(t.unseen)}</Fig></span>
                <span className="stack">
                  <span className="recName">{cap(t.label)}</span>
                  <span className="meta">{t.category.toLowerCase()}, problems in pool</span>
                </span>
              </div>
            ))}
          </div>
          <p className="note spaced">
            A move you have never tried opens with a worked solution to read and rewrite from a
            blank file, because failing cold at something nobody taught you teaches nothing. A
            session opens at most {numberWord(3)} of these at a time, so this column comes down
            slowly and on purpose.
          </p>
        </>
      )}
    </div>
  );
}

// ---------- Library ----------
// The whole curriculum, browsable — the answer to "what's even in there?".
// Everything the scheduler could ever serve, whether it has or not.
export function LibraryView({ problems, ready, openLog }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [technique, setTechnique] = useState("all");
  const [difficulty, setDifficulty] = useState("all");
  const [src, setSrc] = useState("all");
  const [state, setState] = useState("all"); // all | untried | tried
  const CAP = 250;

  // Techniques offered in the dropdown follow the selected pattern.
  const techniques = useMemo(() => {
    const s = new Set();
    for (const e of LIBRARY) if ((category === "all" || e.category === category) && e.technique) s.add(e.technique);
    return [...s].sort();
  }, [category]);
  useEffect(() => { setTechnique("all"); }, [category]);

  const tried = useMemo(() => {
    const m = new Map();
    for (const e of LIBRARY) m.set(e, e.seen || !!findExisting(problems, e));
    return m;
  }, [problems]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return LIBRARY.filter((e) =>
      (category === "all" || e.category === category)
      && (technique === "all" || e.technique === technique)
      && (difficulty === "all" || e.difficulty === difficulty)
      && (src === "all" || e.src === src)
      && (state === "all" || (state === "tried") === tried.get(e))
      && (!q || e.name.toLowerCase().includes(q) || (e.technique || "").includes(q)));
  }, [query, category, technique, difficulty, src, state, tried]);

  const untriedCount = useMemo(() => [...tried.values()].filter((v) => !v).length, [tried]);

  return (
    <div>
      <input className="search" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search problems and techniques" aria-label="Search problems and techniques" />
      <div className="filters">
        <select className="pick" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Pattern">
          <option value="all">All patterns</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="pick" value={technique} onChange={(e) => setTechnique(e.target.value)} aria-label="Technique">
          <option value="all">Any technique</option>
          {techniques.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="pick" value={difficulty} onChange={(e) => setDifficulty(e.target.value)} aria-label="Difficulty">
          <option value="all">Any tier</option>
          {TIERS.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select className="pick" value={src} onChange={(e) => setSrc(e.target.value)} aria-label="Source">
          <option value="all">Any source</option>
          {SOURCES.map((x) => <option key={x}>{x}</option>)}
        </select>
        <select className="pick" value={state} onChange={(e) => setState(e.target.value)} aria-label="Tried or untried">
          <option value="all">Tried and untried</option>
          <option value="untried">Untried</option>
          <option value="tried">Tried</option>
        </select>
      </div>

      <Head count={shown.length > CAP ? CAP : shown.length}>
        {shown.length > CAP
          ? `First ${CAP} of ${shown.length.toLocaleString()} matches`
          : `${plural(shown.length, "match")}, ${untriedCount.toLocaleString()} never touched`}
      </Head>

      {shown.length === 0 && <p className="note">Nothing matches those filters. Widen one and they come back.</p>}

      <div className="recs">
        {shown.slice(0, CAP).map((e) => (
          <div key={e.url + e.name} className="rec">
            <span className="gutter"><Fig unit="min">{BUDGET[e.difficulty] ?? "—"}</Fig></span>
            <span className="stack">
              <ProblemName p={e} />
              <span className="meta">
                {e.category.toLowerCase()}, {e.technique ? e.technique : "pattern-level"},
                {" "}{(e.difficulty || "").toLowerCase()}, {e.src}
                {tried.get(e) && ", tried"}
              </span>
            </span>
            <button className="btn btnSm" disabled={!ready}
              aria-label={`Log a solve of ${e.name}`}
              onClick={() => openLog({ name: e.name, url: e.url, category: e.category, difficulty: e.difficulty })}>
              Log this
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Log ----------
const SORTS = {
  recent: { label: "Recent attempt", fn: (a, b) => (b.log?.[b.log.length - 1] ?? 0) - (a.log?.[a.log.length - 1] ?? 0) },
  added: { label: "Recently added", fn: (a, b) => (b.added || 0) - (a.added || 0) },
  name: { label: "Name", fn: (a, b) => a.name.localeCompare(b.name) },
};

const FLAGS = {
  all: { label: "Everything", fn: () => true },
  overpace: { label: "Over pace", fn: overPace },
  failed: { label: "Last attempt failed", fn: (p) => p.history[p.history.length - 1] === "failed" },
};

// The evidence: every problem ever attempted, with its attempt chain. Nothing
// here is due — this is where the attempts that move a technique live. The
// recovery controls sit at the foot of this screen, next to the evidence they
// protect, rather than under every screen in the app.
export function LogView({ problems, removeProblem, setEditing, recordAttempt,
  ready, exportJSON, importJSON, openHistory }) {
  const [reviewing, setReviewing] = useState(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [difficulty, setDifficulty] = useState("all");
  const [flag, setFlag] = useState("all");
  const [sort, setSort] = useState("recent");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return problems
      .filter((p) => (category === "all" || p.category === category)
        && (difficulty === "all" || p.difficulty === difficulty)
        && FLAGS[flag].fn(p)
        && (!q || p.name.toLowerCase().includes(q) || (p.insight || "").toLowerCase().includes(q)))
      .sort(SORTS[sort].fn);
  }, [problems, query, category, difficulty, flag, sort]);

  const recovery = (
    <>
      <Head>Backup</Head>
      <div className="recovery">
        <button className="btn btnSm" onClick={exportJSON} disabled={!problems.length}>Export a backup</button>
        <button className="btn btnSm" onClick={importJSON} disabled={!ready}>Import one</button>
        {openHistory && (
          <button className="btn btnSm" onClick={openHistory} disabled={!ready}>Restore an earlier revision</button>
        )}
      </div>
      <p className="note">
        Every write snapshots the state it replaced, and the last ten revisions are restorable.
        An export is a copy you keep off this machine.
      </p>
    </>
  );

  if (!problems.length) {
    return (
      <div>
        <p className="prose">
          No solves are logged yet. Add the first one from Add in the bar below, or from a
          line in the library.
        </p>
        {recovery}
      </div>
    );
  }

  return (
    <div>
      <input className="search" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search names and notes" aria-label="Search names and notes" />
      <div className="filters">
        <select className="pick" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Pattern">
          <option value="all">All patterns</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="pick" value={difficulty} onChange={(e) => setDifficulty(e.target.value)} aria-label="Difficulty">
          <option value="all">Any tier</option>
          {TIERS.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select className="pick" value={flag} onChange={(e) => setFlag(e.target.value)} aria-label="Filter">
          {Object.entries(FLAGS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
        </select>
        <select className="pick" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
      </div>

      <Head count={shown.length}>
        {shown.length === problems.length
          ? "Every attempt feeds the move it exercises"
          : `of ${problems.length} shown`}
      </Head>

      {shown.length === 0 && <p className="note">Nothing matches those filters. Widen one and they come back.</p>}

      <div className="recs">
        {shown.map((p) => {
        const t = techniqueOf(p);
        const last = p.log?.[p.log.length - 1] ?? null;
        return (
          <div key={p.id} className="rec recWide">
            <span className="gutter">
              {last ? <Fig unit={dayFig(last).month}>{dayFig(last).day}</Fig> : <Fig>—</Fig>}
            </span>
            <div className="stack">
              <ProblemName p={p} />
              <span className="meta">
                {p.category.toLowerCase()}{t.cataloged ? `, ${t.label}` : ", not in the catalog"},
                {" "}{(p.difficulty || "").toLowerCase()},
                {" "}{p.history.map((h) => OUTCOME_WORD[h] ?? h).join(", ")}
              </span>
              {p.insight && <span className="insight">{p.insight}</span>}
              <TimeTrend p={p} />
              <HistoryTimeline p={p} />
              {reviewing === p.id && (
                <AttemptForm compact
                  onRecord={(outcome, minutes, guess, knew) => {
                    recordAttempt(p.id, outcome, minutes, { guess, knew });
                    setReviewing(null);
                  }}
                  footer={
                    <div className="repActions">
                      <button className="btn btnSm btnBare" onClick={() => setReviewing(null)}>Cancel</button>
                    </div>
                  } />
              )}
              <div className="recActions">
                {reviewing !== p.id && (
                  <button className="btn btnSm" onClick={() => setReviewing(p.id)}
                    aria-label={`Log another attempt on ${p.name}`}>Solved it again</button>
                )}
                <button className="btn btnSm btnBare" onClick={() => setEditing(p.id)}
                  aria-label={`Edit ${p.name}`}>Edit</button>
                <button className="btn btnSm btnBare" onClick={() => removeProblem(p.id)}
                  aria-label={`Remove ${p.name}`}>Remove</button>
              </div>
            </div>
          </div>
        );
        })}
      </div>

      {recovery}
    </div>
  );
}

// The name doubles as the link to the question when we have one.
function ProblemName({ p }) {
  const href = safeUrl(p.url);
  if (!href) return <span className="recName">{p.name}</span>;
  return (
    <a className="recName recLink" href={href} target="_blank" rel="noopener noreferrer">{p.name}</a>
  );
}

// Fluency, not schedule: solve times across attempts against the pace budget
// for the tier. Informational only — minutes never decide what gets served.
function TimeTrend({ p }) {
  const times = (p.times || []).filter((t) => t != null);
  if (!times.length) return null;
  const budget = BUDGET[p.difficulty];
  const slow = overPace(p);
  return (
    <span className="meta">
      {times.map((t, i) => (
        <React.Fragment key={i}>{i > 0 && ", then "}<span className="fig">{t}</span> min</React.Fragment>
      ))}
      {budget && (
        <span className={slow ? "miss" : undefined}>
          {slow ? ", over the " : ", inside the "}<span className="fig">{budget}</span> minute pace
        </span>
      )}
    </span>
  );
}

// `history`, `times`, `log`, `guesses` and `knew` are parallel arrays, one entry
// per attempt. Older logs may carry `via` entries from the transfer-test era —
// outcomes earned on a sibling problem; they're shown as-was, since they're
// still honest evidence about the technique.
function attemptRows(p) {
  return p.history.map((outcome, i) => {
    const at = p.log?.[i] ?? null;
    const prev = i > 0 ? p.log?.[i - 1] : null;
    return {
      outcome, at,
      minutes: p.times?.[i] ?? null,
      guess: p.guesses?.[i] ?? null,
      knew: p.knew?.[i] ?? null,
      gap: at && prev ? Math.round((at - prev) / DAY) : null,
      via: p.via?.[i] ?? null,
    };
  });
}

function HistoryTimeline({ p }) {
  const [open, setOpen] = useState(false);
  if (p.history.length < 2) return null; // a single attempt has no trend to show
  const rows = attemptRows(p);

  return (
    <div className="timelineWrap">
      <button className="btn btnSm btnBare" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "Hide the attempts" : `Show all ${rows.length} attempts`}
      </button>
      {open && (
        <div className="timeline">
          {rows.map((r, i) => (
            <div key={i} className="timelineRow">
              <span className="timelineDate fig">{r.at ? fmtDate(r.at) : "unknown"}</span>
              <span className={r.outcome === "failed" ? "miss" : undefined}>
                {OUTCOME_WORD[r.outcome] ?? r.outcome}
              </span>
              <span className="meta">
                {r.gap != null ? <><span className="fig">{r.gap}</span> days later</> : "first attempt"}
                {r.minutes != null && <>, <span className="fig">{r.minutes}</span> min</>}
                {r.guess && `, reached for ${r.guess}${r.knew != null ? ` in ${r.knew} min` : ""}`}
                {r.via && `, via ${r.via}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Sheets ----------
// One shell for both sheets: a bottom sheet on a phone, a centred panel once
// there is room for one. Escape closes; a tap on the scrim closes.
function Sheet({ label, title, children, bar, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="card" role="dialog" aria-modal="true" aria-label={label}
        onClick={(e) => e.stopPropagation()}>
        <div className="cardHead">
          <h2 className="cardTitle">{title}</h2>
          <button className="btn btnSm btnBare" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div className="cardScroll">{children}</div>
        <div className="cardBar">{bar}</div>
      </div>
    </div>
  );
}

// ---------- Revision history ----------
// The revision check stops a *stale* writer, but nothing stops a write that is
// current and simply wrong — a mistaken import, a delete you notice after the
// undo offer expired, a bug. This is the rollback.
function HistoryModal({ onClose, onRestore }) {
  const [snapshots, setSnapshots] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    window.storage.history().then((r) => {
      if (r.ok) setSnapshots(r.snapshots);
      else setError(r.error);
    });
  }, []);

  async function restore(rev, count) {
    if (!window.confirm(`Replace your log with revision ${rev} (${count} ${plural(count, "problem")})?\n\nThe current state is snapshotted first, so this is reversible.`)) return;
    setBusy(rev);
    const r = await window.storage.snapshot(rev);
    if (!r.ok) { setError(r.error); setBusy(null); return; }
    onRestore(rev, r.state.problems ?? []);
  }

  return (
    <Sheet label="Revision history" title="Revision history" onClose={onClose}
      bar={<button className="btn btnBare" onClick={onClose}>Close</button>}>
      <p className="note">
        Every write snapshots the state it replaced. Restoring is itself a write, so it is
        snapshotted too, and you can always come back.
      </p>

      {error && <p className="note mark">The history could not be loaded: {error}. Your log is untouched.</p>}
      {!error && snapshots === null && <p className="note">Loading.</p>}
      {!error && snapshots?.length === 0 && (
        <p className="note">No previous revisions yet. They accumulate as you log.</p>
      )}

      {snapshots?.map((s) => (
        <div key={s.rev} className="rec">
          <span className="gutter"><Fig>{s.rev}</Fig></span>
          <span className="stack">
            <span className="recName">Revision <span className="fig">{s.rev}</span></span>
            <span className="meta">
              <span className="fig">{s.count}</span> {plural(s.count, "problem")}
              {s.updatedAt ? `, ${new Date(s.updatedAt).toLocaleString()}` : ""}
            </span>
          </span>
          <button className="btn btnSm" disabled={busy != null} onClick={() => restore(s.rev, s.count)}>
            {busy === s.rev ? "Restoring" : "Restore this one"}
          </button>
        </div>
      ))}
    </Sheet>
  );
}

// ---------- Add / edit ----------
// Passing a `problem` switches to edit mode: descriptive fields only, since the
// first attempt is already part of the history. `prefill` seeds the add form
// (from a Library row) without becoming an edit — everything stays changeable,
// and it is still logged as a first attempt.
function ProblemModal({ problem, prefill, problems = [], onClose, onSave }) {
  const editMode = !!problem;
  const [name, setName] = useState(problem?.name ?? prefill?.name ?? "");
  const [url, setUrl] = useState(problem?.url ?? prefill?.url ?? "");
  const [category, setCategory] = useState(problem?.category ?? prefill?.category ?? CATEGORIES[0]);
  const [difficulty, setDifficulty] = useState(problem?.difficulty ?? prefill?.difficulty ?? "Medium");
  const [outcome, setOutcome] = useState("cold");
  const [minutes, setMinutes] = useState("");
  const [guess, setGuess] = useState("");
  const [knew, setKnew] = useState("");
  const [insight, setInsight] = useState(problem?.insight ?? "");

  const valid = name.trim().length > 0;
  const badUrl = url.trim().length > 0 && !parseProblemUrl(url);

  // A tracked problem gets its attempt appended to the existing record — a
  // second copy would split the technique's evidence in two. Say so.
  const dupe = useMemo(
    () => findExisting(problems.filter((p) => p.id !== problem?.id), { url, name }),
    [problems, problem, url, name]
  );

  // The catalog may know this problem; showing what it
  // knows makes the unit of practice visible right where the entry is made.
  const catalogHit = useMemo(() => lookupEntry({ url, name }), [url, name]);

  // A library hit brings its own pattern and tier — prefill them the moment the
  // name matches, mirroring what a pasted AlgoExpert link does.
  useEffect(() => {
    if (!editMode && catalogHit) { setCategory(catalogHit.category); setDifficulty(catalogHit.difficulty); }
  }, [catalogHit, editMode]);

  // A pasted link fills in the name, but never clobbers one you've already typed.
  function onUrlChange(value) {
    setUrl(value);
    const parsed = parseProblemUrl(value);
    if (parsed && !name.trim()) applyCatalog(parsed.name, value);
  }

  // Pasting the link into the name field does the right thing too.
  function onNameChange(value) {
    const parsed = parseProblemUrl(value);
    if (parsed) { setUrl(parsed.url); applyCatalog(parsed.name, parsed.url); }
    else setName(value);
  }

  function applyCatalog(newName, newUrl) {
    setName(newName);
    const c = lookupEntry({ url: newUrl, name: newName });
    if (c) { setCategory(c.category); setDifficulty(c.difficulty); }
  }

  function submit() {
    const data = {
      name: name.trim(),
      url: parseProblemUrl(url)?.url ?? url.trim(),
      category, difficulty, insight: insight.trim(),
    };
    onSave(editMode ? data : {
      ...data,
      outcome,
      minutes: minutes ? parseInt(minutes, 10) : null,
      guess: guess.trim() || null,
      knew: knew ? parseInt(knew, 10) : null,
    });
  }

  return (
    <Sheet label={editMode ? "Edit problem" : "Log a solve"}
      title={editMode ? "Edit problem" : "Log a solve"} onClose={onClose}
      bar={
        <>
          <button className="btn btnStrong" disabled={!valid} onClick={submit}>
            {editMode ? "Save changes" : "Save the attempt"}
          </button>
          <button className="btn btnBare" onClick={onClose}>Cancel</button>
        </>
      }>
      <label className="field">
        <span className="fieldLabel">Link</span>
        <input id="pm-url" className="line" value={url} onChange={(e) => onUrlChange(e.target.value)}
          placeholder="algoexpert.io/questions/two-number-sum"
          autoFocus={!editMode} spellCheck={false} />
      </label>
      <p className="note">
        {badUrl
          ? "That isn’t a …/questions/<name> link, so it is saved exactly as typed."
          : "Paste an AlgoExpert link and the name fills itself in."}
      </p>

      <label className="field">
        <span className="fieldLabel">Problem name</span>
        <input id="pm-name" className="line" value={name} onChange={(e) => onNameChange(e.target.value)}
          placeholder="Longest Substring Without Duplication" autoFocus={editMode} />
      </label>
      {dupe && !editMode && (
        <p className="note mark">
          Already in the log as {dupe.name}. Saving records another attempt on that record
          rather than a second copy.
        </p>
      )}
      {catalogHit && (
        <p className="note">
          {catalogHit.technique
            ? `This one exercises ${catalogHit.technique}, and the attempt feeds that move.`
            : `Known from the library (${catalogHit.category}), with no exact technique tag, so it stands on its own.`}
        </p>
      )}

      <div className="fields2">
        <label className="field">
          <span className="fieldLabel">Pattern</span>
          <select id="pm-cat" className="line" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="fieldLabel">Difficulty</span>
          <select id="pm-diff" className="line" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            {TIERS.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
      </div>

      {!editMode && (
        <>
          <label className="field">
            <span className="fieldLabel">Which move did you reach for?</span>
            <input id="pm-guess" className="line" list="technique-labels" value={guess}
              spellCheck={false} onChange={(e) => setGuess(e.target.value)}
              placeholder="start typing a technique" />
          </label>

          <div className="fields2">
            <label className="field">
              <span className="fieldLabel">Minutes until you knew</span>
              <input id="pm-knew" className="line fig" inputMode="numeric" value={knew}
                onChange={(e) => setKnew(e.target.value.replace(/\D/g, ""))} />
            </label>
            <label className="field">
              <span className="fieldLabel">Minutes in total</span>
              <input id="pm-min" className="line fig" inputMode="numeric" value={minutes}
                onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} />
            </label>
          </div>

          <Head>How did it go? Unaided means no hints and no notes</Head>
          <div className="outcomes">
            {Object.entries(OUTCOMES).map(([k, o]) => (
              <button key={k} onClick={() => setOutcome(k)} aria-pressed={outcome === k}
                className={`btn btnBlock outcome${outcome === k ? " outcomeOn" : ""}`}>
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}

      <label className="field">
        <span className="fieldLabel">The one-line insight</span>
        {editMode ? (
          <textarea id="pm-insight" className="line area" value={insight}
            onChange={(e) => setInsight(e.target.value)}
            placeholder="shrink the window while a duplicate exists" />
        ) : (
          <input id="pm-insight" className="line" value={insight}
            onChange={(e) => setInsight(e.target.value)}
            placeholder="shrink the window while a duplicate exists" />
        )}
      </label>
    </Sheet>
  );
}

// ---------- Styles ----------
// A training log, printed. The subject is measured quantities against budgets
// over time — minutes, days, grades, splits — so the sheet is ruled the way a
// coach's log book is ruled: a narrow figure column on the left, a vertical
// rule, and the words to the right of it. The figure in that column is always
// whatever the list is ranked by, which is why the column is worth reading
// first on every screen.
//
// Ink on cool card stock, and a negative of the same book after dark. Every
// measured figure is set in the mono face, every word in the grotesque, and the
// two never swap jobs. There is exactly one hue in the whole application — the
// red a coach marks with — and it marks where you ARE, never how you did: an
// outcome is never coloured, because a colour-graded log is one you start
// writing for the colours.
const CSS = `
:root {
  color-scheme: light dark;
  --paper: #e7e8e3;
  --sheet: #f4f4f0;
  --rule: #cbcdc4;
  --rule-ink: #9b9d93;
  --ink: #191b17;
  --ink-2: #4d5049;
  --ink-3: #6f7269;
  --mark: #9e3b2f;
  --scrim: rgba(25, 27, 23, 0.42);
  --sans: 'Chivo', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --mono: 'Chivo Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  --press: 90ms;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #1a1b18;
    --sheet: #232420;
    --rule: #34362f;
    --rule-ink: #63665c;
    --ink: #eceae2;
    --ink-2: #b3b5aa;
    --ink-3: #8b8e83;
    --mark: #cd6152;
    --scrim: rgba(8, 9, 7, 0.62);
  }
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); }
.app { min-height: 100dvh; background: var(--paper); color: var(--ink);
  font-family: var(--sans); font-size: 15px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
.sheetPage { max-width: 700px; margin: 0 auto;
  padding-bottom: calc(72px + env(safe-area-inset-bottom)); }
.isFocused .sheetPage { padding-bottom: 40px; }

/* Figures: the mono face, tabular, everywhere a quantity is printed. */
.fig { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 0.92em;
  letter-spacing: -0.01em; }
.figUnit { display: block; font-size: 10px; line-height: 1.3; color: var(--ink-3);
  letter-spacing: 0; }
.mark { color: var(--mark); }
.named { color: var(--ink); font-weight: 600; }
.chev { flex: none; }

/* The masthead: the date or the screen, set large and tight in the grotesk.
   There is no serif anywhere in this application. */
.masthead { padding: 26px 16px 12px; }
.mastheadTitle { font-size: 27px; line-height: 1.08; font-weight: 700; letter-spacing: -0.022em;
  margin: 0; }
.mastheadMeta { display: flex; gap: 14px; flex-wrap: wrap; margin: 8px 0 0;
  font-size: 13px; color: var(--ink-3); }

/* A column head opens a section: words left, the count in the figure column. */
.colhead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  margin: 22px 16px 0; padding-bottom: 5px; border-bottom: 1px solid var(--ink); }
.colheadName { font-size: 14px; font-weight: 700; letter-spacing: -0.005em; }
.colheadCount { font-size: 13px; color: var(--ink-3); }

/* ── The ruled sheet ────────────────────────────────────────────────────
   A figure column, a vertical rule, then the entry. A rep you can start is
   ruled on four sides; a record is ruled only by the column, and the column
   runs unbroken down the whole list. */
.gutter { flex: none; width: 54px; padding: 14px 11px 14px 0; text-align: right;
  border-right: 1px solid var(--rule-ink); color: var(--ink-2); font-size: 14px; }
.stack { flex: 1 1 auto; min-width: 0; padding: 14px 0 14px 14px; display: flex;
  flex-direction: column; gap: 3px; }
.meta { font-size: 13.5px; line-height: 1.45; color: var(--ink-3); }
.recName { font-size: 16px; line-height: 1.3; font-weight: 500; color: var(--ink);
  text-decoration: none; }
a.recLink:hover { text-decoration: underline; text-underline-offset: 3px; }

.entries { display: flex; flex-direction: column; gap: 8px; padding: 10px 16px 4px; }
.entry { display: flex; align-items: stretch; width: 100%; text-align: left; cursor: pointer;
  padding: 0 14px 0 0; background: var(--sheet); color: inherit; font-family: inherit;
  border: 1px solid var(--rule); border-radius: 2px; transition: transform var(--press) linear; }
.entry:active { transform: scale(0.994); }
.entry .gutter { width: 68px; }
.entryName { font-size: 16px; line-height: 1.3; font-weight: 500; }
.entryFoot { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.entryGo { flex: none; display: flex; align-items: center; gap: 3px; font-size: 13px;
  color: var(--ink-2); }

.recs { display: flex; flex-direction: column; padding: 2px 16px 0; }
.rec { display: flex; align-items: stretch; }
.recWide { align-items: stretch; }
.recRight { padding-top: 14px; }
.recRight { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 5px;
  padding: 14px 0 0 12px; }
.recActions { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 0 -10px; }
.movedRow { display: flex; align-items: center; gap: 10px; margin-top: 5px; }
.flag { margin-left: 9px; font-size: 13px; font-weight: 400; color: var(--ink-2); }
.insight { font-size: 13.5px; color: var(--ink-2); }

/* The grade: four steps, filled to the hardest disguise a move now serves. */
.grade { display: inline-flex; gap: 2px; }
.gradeStep { width: 13px; height: 9px; border: 1px solid var(--rule-ink); background: transparent; }
.gradeStep.on { background: var(--ink-2); border-color: var(--ink-2); }

/* Prose. */
.prose { padding: 14px 16px; margin: 0; max-width: 62ch; color: var(--ink-2); }
.note { padding: 10px 16px 14px; margin: 0; max-width: 62ch; font-size: 13.5px; line-height: 1.5;
  color: var(--ink-3); }
.spaced { margin-top: 14px; }

/* Buttons: ruled, never filled, never coloured by outcome. */
button, input, select, textarea { font-family: inherit; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; min-width: 44px; padding: 0 14px; border: 1px solid var(--rule-ink);
  border-radius: 2px; background: transparent; color: var(--ink); font-size: 14px;
  cursor: pointer; text-decoration: none; transition: transform var(--press) linear; }
.btn:active { transform: scale(0.99); }
.btn:disabled { opacity: 0.42; cursor: not-allowed; }
.btnSm { font-size: 13px; padding: 0 11px; }
.btnBare { border-color: transparent; color: var(--ink-2); }
.btnStrong { border-color: var(--ink); color: var(--ink); font-weight: 700; }
.btnBlock { width: 100%; justify-content: flex-start; min-height: 52px; padding: 0 15px; }

/* The dial: session length, and started against not started. */
.dial { display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none;
  padding: 4px 16px 0; margin-top: 2px; border-bottom: 1px solid var(--rule); }
.dial::-webkit-scrollbar { display: none; }
.dialLabel { flex: none; font-size: 13px; color: var(--ink-3); padding-right: 5px; }
.dialBtn { flex: none; min-height: 44px; min-width: 44px; padding: 0 10px; border: 0;
  background: none; color: var(--ink-3); font-size: 14px; cursor: pointer; }
.dialBtnOn { color: var(--ink); font-weight: 700; box-shadow: inset 0 -2px 0 var(--ink); }

/* ── The rep screen ─────────────────────────────────────────────────────── */
.rep { padding-bottom: 32px; }
.back { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; margin: 6px 0 0;
  padding: 0 12px; border: 0; background: none; color: var(--ink-2); font-size: 13.5px;
  cursor: pointer; }
.repName { font-size: 26px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em;
  margin: 4px 16px 0; }
.repMeta { font-size: 13.5px; color: var(--ink-3); margin: 8px 16px 0; }
.btnOpen { width: calc(100% - 32px); margin: 15px 16px 0; min-height: 52px; padding: 0 15px;
  justify-content: flex-start; }
.repSay { font-size: 13.5px; line-height: 1.55; color: var(--ink-2); margin: 16px 16px 0;
  max-width: 62ch; }
.repActions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 5px 0; }

/* The split. The one graphic in the application, and it is the thing the
   application measures: elapsed against the pace budget, with a tick at the
   minute the move landed. The budget mark sits two thirds along, so going over
   is something you watch happen rather than something you are told after. */
.split { margin-top: 22px; padding: 16px; background: var(--sheet);
  border-top: 1px solid var(--rule-ink); border-bottom: 1px solid var(--rule-ink); }
.splitClock { font-size: 46px; line-height: 1; font-weight: 400; letter-spacing: -0.03em;
  color: var(--ink); }
.paceWrap { margin-top: 14px; }
.pace { position: relative; height: 10px; border-bottom: 1px solid var(--rule-ink); }
.paceFill { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--ink-2); }
.paceBudget { position: absolute; bottom: -3px; width: 1px; height: 13px; background: var(--ink); }
.paceKnew { position: absolute; bottom: -1px; width: 2px; height: 9px; background: var(--mark); }
.paceEnds { display: flex; justify-content: space-between; gap: 12px; margin-top: 7px;
  font-size: 12.5px; color: var(--ink-3); }
.splitBtns { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }

/* Fields sit on a rule, the way a form on paper does. */
.record { display: flex; flex-direction: column; padding-top: 4px; }
.recordCompact { padding-top: 0; }
.field { display: flex; flex-direction: column; gap: 4px; padding: 10px 16px; }
.fieldLabel { font-size: 13px; color: var(--ink-2); }
.fields2 { display: grid; grid-template-columns: 1fr 1fr; }
.line { width: 100%; border: 0; border-bottom: 1px solid var(--rule-ink); border-radius: 0;
  background: transparent; padding: 9px 0; font-size: 16px; color: var(--ink);
  caret-color: var(--mark); }
.line::placeholder { color: var(--ink-3); }
.line:focus { border-bottom-color: var(--mark); outline: none; }
select.line { appearance: none; padding-right: 20px;
  background-image: linear-gradient(45deg, transparent 50%, var(--ink-3) 50%),
    linear-gradient(135deg, var(--ink-3) 50%, transparent 50%);
  background-position: calc(100% - 10px) calc(50% + 1px), calc(100% - 5px) calc(50% + 1px);
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
.area { min-height: 78px; resize: vertical; line-height: 1.5; }
.outcomes { display: flex; flex-direction: column; gap: 8px; padding: 10px 16px 8px; }
.outcomeOn { border-color: var(--ink); box-shadow: inset 2px 0 0 var(--ink); }

/* Search and filters. */
.search { width: 100%; border: 0; border-bottom: 1px solid var(--rule); border-radius: 0;
  background: transparent; padding: 15px 16px; font-size: 16px; color: var(--ink);
  caret-color: var(--mark); }
.search::placeholder { color: var(--ink-3); }
.search:focus { border-bottom-color: var(--mark); outline: none; }
.filters { display: flex; gap: 8px; padding: 10px 16px; overflow-x: auto; scrollbar-width: none;
  -webkit-mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%);
  mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%); }
.filters::-webkit-scrollbar { display: none; }
.pick { flex: none; min-height: 44px; padding: 0 26px 0 11px; border: 1px solid var(--rule-ink);
  border-radius: 2px; background-color: transparent; color: var(--ink-2); font-size: 16px;
  appearance: none; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--ink-3) 50%),
    linear-gradient(135deg, var(--ink-3) 50%, transparent 50%);
  background-position: calc(100% - 14px) calc(50% + 1px), calc(100% - 9px) calc(50% + 1px);
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
.recovery { display: flex; gap: 8px; padding: 10px 16px; flex-wrap: wrap; }

/* The attempt timeline. */
.timelineWrap { margin-top: 6px; margin-left: -11px; }
.timeline { display: flex; flex-direction: column; gap: 6px; margin: 8px 0 4px 11px; }
.timelineRow { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--ink-2); }
.timelineDate { color: var(--ink-3); min-width: 58px; }

/* Notices: the marking pen, a rule, and no coloured box. */
.notice { margin: 12px 16px; padding: 14px 15px; background: var(--sheet);
  border: 1px solid var(--rule); border-left: 2px solid var(--mark); border-radius: 2px; }
.noticeTitle { font-size: 15px; font-weight: 700; color: var(--mark); margin: 0 0 6px; }
.notice p { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--ink-2); max-width: 62ch; }
.noticeActions { display: flex; gap: 10px; margin-top: 13px; flex-wrap: wrap; }

/* The strip: five destinations in words, the one you are on ruled in red. */
.strip { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; display: flex;
  background: var(--paper); border-top: 1px solid var(--rule);
  padding-bottom: env(safe-area-inset-bottom); }
.stripTab { flex: 1 1 0; min-height: 52px; border: 0; border-top: 2px solid transparent;
  margin-top: -1px; background: none; color: var(--ink-3); font-size: 13px; cursor: pointer;
  transition: transform var(--press) linear; }
.stripTab:active { transform: scale(0.99); }
.stripTab:disabled { opacity: 0.42; }
.stripTabOn { color: var(--ink); font-weight: 700; border-top-color: var(--mark); }

/* Undo: transient, and it never decorates the reversal. */
.undo { position: fixed; z-index: 40; left: 16px; right: 16px; max-width: 500px;
  bottom: calc(64px + env(safe-area-inset-bottom)); margin: 0 auto; display: flex;
  align-items: center; gap: 8px; padding: 6px 8px 6px 14px; font-size: 13.5px;
  background: var(--sheet); border: 1px solid var(--rule-ink); border-radius: 2px; }
.undoSay { flex: 1 1 auto; color: var(--ink); }

/* A loose sheet laid over the book. */
.scrim { position: fixed; inset: 0; z-index: 50; background: var(--scrim);
  display: flex; align-items: flex-end; justify-content: center; }
.card { display: flex; flex-direction: column; width: 100%; max-width: 560px; max-height: 92dvh;
  background: var(--sheet); border: 1px solid var(--rule-ink); border-bottom: 0;
  border-radius: 2px 2px 0 0; }
.cardHead { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 6px 8px 6px 16px; border-bottom: 1px solid var(--ink); }
.cardTitle { font-size: 16px; font-weight: 700; margin: 0; }
.cardScroll { flex: 1 1 auto; overflow-y: auto; padding-bottom: 8px; }
.cardBar { display: flex; gap: 10px; border-top: 1px solid var(--rule);
  padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); }

a { color: var(--ink); }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

@media (max-width: 540px) {
  .entry .gutter { width: 58px; }
  .recActions { margin-left: -10px; }
}

/* With a window and a pointer the strip moves to the head of the book. */
@media (min-width: 620px) {
  .filters { flex-wrap: wrap; overflow: visible; -webkit-mask-image: none; mask-image: none; }
}

@media (min-width: 900px) {
  .strip { top: 0; bottom: auto; justify-content: center; border-top: 0;
    border-bottom: 1px solid var(--rule); padding-bottom: 0; }
  .stripTab { flex: 0 0 auto; min-width: 118px; min-height: 50px; border-top: 0;
    border-bottom: 2px solid transparent; margin: 0 0 -1px; font-size: 14px; }
  .stripTabOn { border-bottom-color: var(--mark); }
  .sheetPage { padding-top: 50px; padding-bottom: 48px; }
  .isFocused .sheetPage { padding-top: 8px; }
  .undo { bottom: 24px; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
