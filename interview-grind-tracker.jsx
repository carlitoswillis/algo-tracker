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
  CATEGORIES, OUTCOMES, BUDGET, budgetOf, editAttempt, TIERS_SERVED, CLIMB_STREAK, LEECH_WINDOW,
  overPace, parseProblemUrl, findExisting,
  newProblem, logAttempt, migrate, isProblem,
} from "./lib/schedule.js";

import { CATALOG, LIBRARY as IMPORTED_LIBRARY, TIERS, sourceOf, LIBRARY_URL } from "./lib/problems.js";
import {
  techniqueOf, lookupEntry, deriveTechniques, buildPlan,
  priority, isSkipped, staleness, TECHNIQUE_LABELS,
} from "./lib/techniques.js";
import {
  parseSetText, formatSetText, entryForItem, problemForItem, setId, validateSets,
} from "./lib/sets.js";
import {
  dueItems, carryForward, recordResult, history as recallHistory, RECALL_EMPTY, RECALL_SIDES,
} from "./lib/recall.js";

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

// The other direction: what you type into the clock. "12:30" is minutes and
// seconds, "12" or "12.5" is minutes — the numeric keypad has no colon.
const unclock = (text) => {
  const t = text.trim();
  let m;
  if ((m = /^(\d{1,3}):(\d{1,2})$/.exec(t))) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  if ((m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(t))) return Math.round(parseFloat(`${m[1]}.${m[2] || 0}`) * 60);
  return null;
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
  const TABS = ["today", "sets", "recall", "techniques", "library", "log"];
  const [tab, setTabState] = useState(() => {
    const h = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#/, "").split("/")[0];
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

  // Custom sets: hand-picked problems on one clock. Their own file and their
  // own fetch — the log's revision check never has to know they exist. The
  // open set lives in the hash (#sets/<id>) so a set page can be reloaded.
  const [openSet, setOpenSetState] = useState(() => {
    const h = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#/, "");
    const [base, id] = h.split("/");
    return base === "sets" && id ? decodeURIComponent(id) : null;
  });
  const setOpenSet = (id) => {
    setOpenSetState(id);
    try { history.replaceState(null, "", id ? `#sets/${encodeURIComponent(id)}` : "#sets"); } catch { /* fine */ }
  };
  const [sets, setSets] = useState(null); // null = loading
  const [setsError, setSetsError] = useState(null);
  const loadSets = React.useCallback(() => {
    fetch("/api/sets").then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setSets(Array.isArray(body.sets) ? body.sets : []);
      setSetsError(null);
    }).catch((e) => { setSets([]); setSetsError(e.message); });
  }, []);
  useEffect(loadSets, [loadSets]);
  async function saveSets(next) {
    const r = await fetch("/api/sets", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sets: next }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    setSets(Array.isArray(body.sets) ? body.sets : next);
  }

  // Recall: the lines you type from memory before a session. Its own file
  // and its own fetch, like the sets; a day's verdicts go back as the whole
  // file, and the log's revision check never sees them.
  const [recall, setRecall] = useState(null); // null = loading
  const [recallError, setRecallError] = useState(null);
  const recallRef = useRef(RECALL_EMPTY);       // the latest data, for back-to-back verdicts
  const recallWrites = useRef(Promise.resolve()); // PUTs land in the order they were clicked
  const loadRecall = React.useCallback(() => {
    fetch("/api/recall").then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      const data = {
        version: 1,
        items: Array.isArray(body.items) ? body.items : [],
        log: Array.isArray(body.log) ? body.log : [],
      };
      recallRef.current = data;
      setRecall(data);
      setRecallError(null);
    }).catch((e) => { setRecall(RECALL_EMPTY); setRecallError(e.message); });
  }, []);
  useEffect(loadRecall, [loadRecall]);
  // Optimistic: the drill advances on the click and the file follows it to
  // the server. A failed write is said, not swallowed, and the next verdict
  // carries the earlier one with it since the whole file goes each time.
  function recordRecall(entry) {
    const next = recordResult(recallRef.current, entry);
    recallRef.current = next;
    setRecall(next);
    recallWrites.current = recallWrites.current.then(async () => {
      const r = await fetch("/api/recall", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: next.items, log: next.log }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setRecallError(null);
    }).catch((e) => setRecallError(`Not saved: ${e.message}. The verdict is only on this screen.`));
  }

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
    commit(`Edited ${data.name}.`, problems.map((p) => {
      if (p.id !== id) return p;
      const { budget, ...rest } = data;
      const next = { ...p, ...rest };
      if (budget) next.budget = budget; else delete next.budget;
      return next;
    }));
    setEditing(null);
  }

  // Correcting one attempt after the fact: the timer ran on, or the wrong
  // outcome got tapped. The technique's tier re-derives from the fixed row.
  function fixAttempt(id, i, patch) {
    commit("Corrected the attempt.", problems.map((p) => (p.id === id ? editAttempt(p, i, patch) : p)));
  }

  // The pace budget is the one descriptive field editable mid-rep, because
  // that is when you find out the tier estimate is wrong for this problem.
  function setProblemBudget(id, budget) {
    commit(budget ? `Budget set to ${budget} minutes.` : "Budget back to the tier estimate.",
      problems.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p };
        if (budget) next.budget = budget; else delete next.budget;
        return next;
      }));
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
    const { guess = null, knew = null, insight = "", budget = null } = extra;
    const existing = findExisting(problems, entry);
    commit(`Logged ${entry.name}.`, existing
      ? problems.map((p) => (p.id === existing.id
        ? { ...logAttempt(p, outcome, minutes, { guess, knew }), ...(budget ? { budget } : {}) }
        : p))
      : [newProblem({
          name: entry.name, url: entry.url, category: entry.category,
          difficulty: entry.difficulty, insight, outcome, minutes, guess, knew, budget,
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
  useEffect(() => { if (tab !== "today" && tab !== "sets" && tab !== "recall") setFocused(false); }, [tab]);


  const head = tab === "today"
    ? { title: fmtLong(Date.now()), meta: null }
    : tab === "sets"
    ? { title: (openSet && sets?.find((s) => s.id === openSet)?.name) || "Sets",
        meta: sets ? `${sets.length} ${plural(sets.length, "set")} on file` : null }
    : tab === "recall"
    ? { title: "Recall", meta: recall ? `${recall.items.length} ${plural(recall.items.length, "line")} on file` : null }
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
            pickBudget={pickBudget} focused={focused} setFocused={setFocused} setProblemBudget={setProblemBudget}
            recordFresh={recordFresh} recordAttempt={recordAttempt} delayTech={delayTech} />
        ) : tab === "sets" ? (
          <SetsView sets={sets} setsError={setsError} saveSets={saveSets} reloadSets={loadSets}
            openId={openSet} setOpenId={setOpenSet}
            problems={problems} techs={techs} ready={ready} setFocused={setFocused}
            recordFresh={recordFresh} recordAttempt={recordAttempt} />
        ) : tab === "recall" ? (
          <RecallView data={recall} error={recallError} reload={loadRecall} record={recordRecall}
            setFocused={setFocused} />
        ) : tab === "techniques" ? (
          <TechniquesView techs={techs} delays={delays} />
        ) : tab === "library" ? (
          <LibraryView problems={problems} ready={ready} openLog={(prefill) => setShowAdd(prefill)} />
        ) : (
          <LogView problems={problems} removeProblem={removeProblem} setEditing={setEditing}
            recordAttempt={recordAttempt} fixAttempt={fixAttempt} ready={ready} exportJSON={exportJSON}
            importJSON={() => fileInput.current?.click()}
            openHistory={canRestore() ? () => setShowHistory(true) : null} />
        )}

        <input ref={fileInput} type="file" accept="application/json,.json" style={{ display: "none" }}
          onChange={(e) => { importJSON(e.target.files?.[0]); e.target.value = ""; }} />
      </div>

      {!focused && (
        <nav className="strip" aria-label="Sections">
          {[["today", "Today"], ["sets", "Sets"], ["recall", "Recall"], ["techniques", "Moves"]].map(([k, label]) => (
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
  focused, setFocused, recordFresh, recordAttempt, delayTech, setProblemBudget }) {
  // Reroll counters, per technique. Session-only state: the base pick is
  // day-seeded, so a reload simply returns to it.
  const [nonces, setNonces] = useState({});
  const [openKey, setOpenKey] = useState(null); // the rep being worked, if any
  const [postponing, setPostponing] = useState(false);
  // What a technique's tier was at the moment its attempt was logged, so the
  // reveal can say the tier moved. In memory, this session only.
  const [logged, setLogged] = useState({});
  // A budget typed on the rep screen for a problem that isn't tracked yet; it
  // travels with the first attempt. Tracked problems are written straight away.
  const [pending, setPending] = useState({});
  // The attempt just logged, shown on its own screen before Today comes back.
  const [done, setDone] = useState(null);

  const plan = useMemo(() => buildPlan(techs, budget, delays, nonces), [techs, budget, delays, nonces]);
  const items = useMemo(() => (plan.items ?? []).filter((i) => i?.serve?.problem), [plan]);
  const idx = items.findIndex((i) => i.tech.key === openKey);
  const open = idx >= 0 ? items[idx] : null;

  useEffect(() => { setFocused(!!open || !!done); }, [open, done, setFocused]);

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

  const isTracked = (item) => item.serve.mode === "resolve" || item.serve.mode === "study";

  function record(item, outcome, minutes, guess, knew) {
    const t = item.tech, p = item.serve.problem;
    const budget = pending[t.key] ?? null;
    setLogged((m) => ({ ...m, [t.key]: { tier: t.tier ?? 0, why: item.why, label: t.label } }));
    setDone({
      key: t.key, tier: t.tier ?? 0, why: item.why, name: p.name,
      id: isTracked(item) ? p.id : null, entry: { url: p.url, name: p.name },
      outcome, minutes, guess, knew, budget: budget ?? item.est,
    });
    if (isTracked(item))
      recordAttempt(p.id, outcome, minutes, { guess, knew });
    else
      recordFresh(p, outcome, minutes, { guess, knew, budget });
    setOpenKey(null);
    setPostponing(false);
  }

  function changeBudget(item, n) {
    if (isTracked(item)) setProblemBudget(item.serve.problem.id, n);
    else setPending((m) => ({ ...m, [item.tech.key]: n }));
  }

  if (done) {
    return (
      <RepDone done={done} problems={problems} techs={techs} remaining={items.length}
        onNext={() => { setDone(null); setOpenKey(items[0].tech.key); }}
        onBack={() => setDone(null)} />
    );
  }

  if (open) {
    return (
      <RepScreen key={open.tech.key + ":" + (nonces[open.tech.key] ?? 0)}
        item={open} position={idx} total={items.length} ready={ready}
        postponing={postponing} setPostponing={setPostponing}
        ownBudget={pending[open.tech.key] ?? open.serve.problem.budget ?? null}
        onBudget={(n) => changeBudget(open, n)}
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
          Nothing is waiting. Every technique you have started has had a rep today or
          recently enough, and any you postponed comes back on its own. Browse the library
          if you want extra ground.
          {plan.spent >= budget && ` Today's goal is met: ${numberWord(plan.spent)} minutes logged against the ${numberWord(budget)} you set.`}
        </p>
      ) : null}

      {items.length > 0 && (
        <>
          <Head count={`${plan.totalMin} min`}>
            {plan.spent >= budget ? "Extra, goal met" : `${numberWord(items.length)} ${plural(items.length, "rep")} today`}
          </Head>
          {plan.spent > 0 && (
            <p className="note">
              {plan.spent >= budget
                ? `Today's goal is met: ${numberWord(plan.spent)} minutes logged against the ${numberWord(budget)} you set. Everything below is extra.`
                : `${cap(numberWord(plan.spent))} of today's ${numberWord(budget)} minutes are logged, ${numberWord(budget - plan.spent)} to go.`}
            </p>
          )}
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
  ownBudget, onBudget, onBack, onReroll, onPostpone, onRecord,
  backLabel = "Today", banner = null, canPostpone = true }) {
  const { tech, serve } = item;
  const p = serve.problem;
  // The budget is editable right here: the tier estimate is a guess about the
  // general solver, and mid-rep is exactly when you learn it's wrong for this
  // one. The track follows what's typed; blur writes it.
  const tierEst = BUDGET[p.difficulty] ?? 30;
  const [budgetText, setBudgetText] = useState(ownBudget != null ? String(ownBudget) : "");
  const est = (parseInt(budgetText, 10) || null) ?? tierEst;
  const saveBudget = () => {
    const n = parseInt(budgetText, 10) || null;
    if (n !== (ownBudget ?? null)) onBudget(n);
  };
  const href = safeUrl(p.url);
  const src = sourceOf(p);
  const [secs, setSecs] = useState(0);
  const [running, setRunning] = useState(false);
  const [knewAt, setKnewAt] = useState(null); // seconds at which the move landed
  // The clock is typeable: solving happens in another tab, or on paper, and
  // the time is something you know rather than something the app watched.
  // While a draft is open the timer is paused and the clock shows the draft.
  const [draft, setDraft] = useState(null);

  // Elapsed is wall-clock, not a count of ticks: a backgrounded tab on the
  // iPad stops ticking, and the time you spent should not stop with it.
  useEffect(() => {
    if (!running) return;
    const from = Date.now() - secs * 1000;
    const tick = () => setSecs(Math.floor((Date.now() - from) / 1000));
    const t = setInterval(tick, 500);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const openDraft = () => { setRunning(false); setDraft(clock(secs)); };
  const closeDraft = () => {
    const n = draft == null ? null : unclock(draft);
    if (n != null) {
      setSecs(n);
      if (knewAt != null && knewAt > n) setKnewAt(null);
    }
    setDraft(null);
  };

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
      <button className="back" onClick={onBack} aria-label={`Back to ${backLabel.toLowerCase()}`}>
        <Chevron dir="left" />{backLabel}
      </button>
      {banner && <p className="repBanner">{banner}</p>}

      <h1 className="repName">{p.name}</h1>
      <p className="repMeta">
        {(p.difficulty || "medium").toLowerCase()}, rep {position + 1} of {total},
        {" "}budget{" "}
        <input className="budgetIn fig" inputMode="numeric" aria-label="Pace budget in minutes"
          value={budgetText} placeholder={String(tierEst)}
          onChange={(e) => setBudgetText(e.target.value.replace(/\D/g, ""))}
          onBlur={saveBudget}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        {" "}minutes
        {est !== tierEst && <>, tier estimate <span className="fig">{tierEst}</span></>}
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
        <input className="splitClock fig" inputMode="decimal" spellCheck={false}
          aria-label="Time so far, as minutes and seconds or as minutes"
          value={draft ?? clock(secs)}
          onFocus={openDraft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={closeDraft}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }} />
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
        {!running && !secs && draft == null && (
          <p className="splitHint">Or tap the clock and type the time you took.</p>
        )}
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
          ) : !canPostpone ? null : (
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

// What just happened, on the rep's own screen: the verdict on the guess, the
// time against the budget, and whether the technique moved. Today is one tap
// away, but it shouldn't be where you first learn what the move was.
function RepDone({ done, problems, techs, remaining, onNext, onBack,
  backLabel = "Today", lastWords = "That was the last rep that fit today." }) {
  const p = done.id ? problems.find((x) => x.id === done.id) : findExisting(problems, done.entry);
  const tech = techs.find((t) => t.key === done.key);
  const budget = done.fixedBudget ?? (p ? budgetOf(p) : done.budget);
  const over = done.minutes != null && done.minutes > budget;
  const moved = tech && tech.tier != null && tech.tier !== done.tier;
  return (
    <div className="rep">
      <button className="back" onClick={onBack} aria-label={`Back to ${backLabel.toLowerCase()}`}>
        <Chevron dir="left" />{backLabel}
      </button>

      <h1 className="repName">{p?.name ?? done.name}</h1>
      <p className="repMeta">
        Logged as {OUTCOMES[done.outcome].label.toLowerCase()}
        {done.minutes != null
          ? <>, <span className="fig">{done.minutes}</span> minutes against a <span className="fig">{budget}</span> minute budget</>
          : null}.
      </p>

      <p className="repSay">
        {p && <Verdict p={p} guess={done.guess} knew={done.knew} />}
        {over && done.outcome === "cold" && "Unaided and optimal, but over pace, so it does not count toward the climb. "}
        {done.why && `Served because: ${done.why}.`}
      </p>
      {done.note && (
        <p className="repSay"><span className="named">The trap.</span> {done.note}</p>
      )}

      {tech && tech.tier != null && (
        <div className="movedRow doneRow">
          <Grade tier={tech.tier} />
          <span className="meta">
            {cap(tech.label)} {moved ? "now serves" : "still serves"} {tierWord(tech.tier)} problems
          </span>
        </div>
      )}

      <div className="repActions doneActions">
        {remaining > 0
          ? <button className="btn btnStrong" onClick={onNext}>Next rep</button>
          : <span className="meta">{lastWords}</span>}
        <button className="btn btnBare" onClick={onBack}>Back to {backLabel.toLowerCase()}</button>
      </div>
    </div>
  );
}

// The recording form, in the order the attempt happens: what you reached for,
// when you knew, how long it took, then how it went. Both minute fields are
// prefilled from the split when it ran, and stay editable — the clock is a
// convenience, never the record.
function AttemptForm({ onRecord, footer, disabled, compact, autoMinutes = null, autoKnew = null }) {
  const [guess, setGuess] = useState("");
  // null means untouched, so the clock's prefill shows through; once typed
  // (even to empty) the field is yours and the clock stops overwriting it.
  const [knew, setKnew] = useState(null);
  const [minutes, setMinutes] = useState(null);
  const digits = (v) => v.replace(/\D/g, "");
  const num = (v) => (v ? parseInt(v, 10) : null);
  const knewVal = knew ?? (autoKnew != null ? String(autoKnew) : "");
  const minVal = minutes ?? (autoMinutes != null ? String(autoMinutes) : "");

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

// Whether a guess names the technique. Labels come from a datalist, but a
// typed one shouldn't fail on a stray space or a capital.
const sameMove = (a, b) =>
  a != null && b != null
  && a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// The verdict on a guess, said plainly. `after` is the split, if one was taken.
function Verdict({ p, guess, knew }) {
  const id = techniqueOf(p);
  const after = knew != null ? ` after ${knew} ${plural(knew, "minute")}` : "";
  if (!id.cataloged) {
    return (
      <>{guess ? <>You reached for {guess}{after}. </> : null}
      This one isn’t in the catalog, so it stands on its own rather than feeding a move. </>
    );
  }
  if (!guess) return <>The move was <span className="named">{id.label}</span>. </>;
  return sameMove(guess, id.label)
    ? <><span className="named">Right call.</span> You reached for {id.label}{after}. </>
    : <><span className="named">Wrong call.</span> You reached for {guess}{after}; it was <span className="named">{id.label}</span>. </>;
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
          const budget = budgetOf(r.p);

          return (
            <div key={r.p.id + ":" + r.i} className="rec">
              <span className="gutter">
                {r.minutes != null ? <Fig unit="min">{r.minutes}</Fig> : <Fig>—</Fig>}
              </span>
              <span className="stack">
                <ProblemName p={r.p} />
                <span className="meta">
                  <Verdict p={r.p} guess={r.guess} knew={r.knew} />
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

// ---------- Sets ----------
// A custom set: problems you picked, in the order you picked them, on one
// clock — the shape of a particular assessment rather than the ranked session
// Today builds. Each rep is the same rep screen Today uses and logs the same
// way, so the technique tiers see the evidence; the set adds only the order
// and the clock. An item's note travels hidden until the attempt is logged,
// for the same reason the technique does.
const setClockKey = (id) => `grind-set-clock:${id}`;
function readSetClock(id) {
  try {
    const v = parseInt(sessionStorage.getItem(setClockKey(id)) ?? "", 10);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}
function writeSetClock(id, ts) {
  try {
    if (ts == null) sessionStorage.removeItem(setClockKey(id));
    else sessionStorage.setItem(setClockKey(id), String(ts));
  } catch { /* session only */ }
}

// Today's attempts on one problem record, oldest first.
function todaysAttempts(p) {
  if (!p) return [];
  const start = todayStart();
  return (p.log || [])
    .map((ts, i) => ({ ts, i, outcome: p.history[i], minutes: p.times?.[i] ?? null }))
    .filter((a) => a.ts >= start);
}

// Each item of a set against the catalog and the log: the problem it serves,
// the record it already has (if any), and what was logged on it today.
function resolveSet(set, problems) {
  const items = (set.items ?? []).map((it, i) => {
    const entry = problemForItem(it, LIBRARY);
    const tracked = findExisting(problems, entry);
    return { it, i, entry, tracked, today: todaysAttempts(tracked), minutes: it.minutes ?? budgetOf(entry) };
  });
  return {
    items,
    totalMin: items.reduce((s, r) => s + r.minutes, 0),
    doneCount: items.filter((r) => r.today.length).length,
  };
}

export function SetsView({ sets, setsError, saveSets, reloadSets, openId, setOpenId,
  problems, techs, ready, setFocused, recordFresh, recordAttempt }) {
  const [editing, setEditing] = useState(null); // null | "new" | a set id
  const open = openId && sets ? sets.find((s) => s.id === openId) ?? null : null;

  useEffect(() => { if (!open) setFocused(false); }, [open, setFocused]);

  async function upsert(set) {
    const list = sets ?? [];
    const next = list.some((s) => s.id === set.id)
      ? list.map((s) => (s.id === set.id ? set : s))
      : [...list, set];
    await saveSets(next);
    setEditing(null);
    setOpenId(set.id);
  }

  async function remove(id) {
    const s = (sets ?? []).find((x) => x.id === id);
    if (s && !window.confirm(`Remove the set ${s.name}? Attempts you logged from it stay in the log.`)) return;
    await saveSets((sets ?? []).filter((x) => x.id !== id));
    setOpenId(null);
  }

  // Groups in order of first appearance, ungrouped sets last with no heading;
  // finished sets leave their groups and gather under one Done section.
  const doneSets = (sets ?? []).filter((s) => s.done === true);
  const groups = useMemo(() => {
    const order = [], by = new Map();
    for (const s of sets ?? []) {
      if (s.done === true) continue;
      const g = (s.group || "").trim() || null;
      if (!by.has(g)) { by.set(g, []); order.push(g); }
      by.get(g).push(s);
    }
    const named = order.filter((g) => g != null);
    return [...named, ...(by.has(null) ? [null] : [])].map((g) => ({ name: g, sets: by.get(g) }));
  }, [sets]);

  const editor = editing && (
    <SetEditor set={editing === "new" ? null : (sets ?? []).find((s) => s.id === editing) ?? null}
      sets={sets} onClose={() => setEditing(null)} onSave={upsert} />
  );

  if (open) {
    return (
      <>
        <SetPage set={open} problems={problems} techs={techs} ready={ready} setFocused={setFocused}
          recordFresh={recordFresh} recordAttempt={recordAttempt}
          onBack={() => setOpenId(null)} onEdit={() => setEditing(open.id)} onRemove={() => remove(open.id)} />
        {editor}
      </>
    );
  }

  return (
    <div>
      {setsError && (
        <Notice title="Your sets could not be read">
          <p>{setsError}</p>
          <div className="noticeActions"><button className="btn" onClick={reloadSets}>Try again</button></div>
        </Notice>
      )}
      <p className="prose">
        A set is problems you picked, in the order you picked them, against one clock: the
        shape of a particular assessment, rather than the ranked session Today builds. Every
        rep in a set logs exactly as a Today rep does.
      </p>
      {sets == null ? (
        <p className="note">Loading your sets.</p>
      ) : sets.length === 0 ? (
        <p className="note">No sets yet. Make one from a list of problem names, one per line.</p>
      ) : (
        <>
          <Head count={sets.length}>{plural(sets.length, "Set")} on file{doneSets.length ? `, ${doneSets.length} done` : ""}</Head>
          {groups.map((g) => (
            <div key={g.name ?? ""}>
              {g.name && <Head count={g.sets.length}>{g.name}</Head>}
              <div className="entries">
                {g.sets.map((s) => <SetEntry key={s.id} set={s} problems={problems} onOpen={() => setOpenId(s.id)} />)}
              </div>
            </div>
          ))}
          {doneSets.length > 0 && (
            <div>
              <Head count={doneSets.length}>Done</Head>
              <div className="entries">
                {doneSets.map((s) => <SetEntry key={s.id} set={s} problems={problems} compact onOpen={() => setOpenId(s.id)} />)}
              </div>
            </div>
          )}
        </>
      )}
      <div className="setActions">
        <button className="btn" disabled={!ready} onClick={() => setEditing("new")}>New set</button>
      </div>
      {editor}
    </div>
  );
}

function SetEntry({ set, problems, onOpen, compact }) {
  const r = resolveSet(set, problems);
  const n = r.items.length;
  if (compact) {
    return (
      <button className="entry entryDone entryLine" onClick={onOpen} aria-label={`Open the set ${set.name}`}>
        <span className="gutter setGroupGutter">{set.group || <Fig unit="min">{set.minutes ?? r.totalMin}</Fig>}</span>
        <span className="stack">
          <span className="entryFoot">
            <span className="entryName">{set.name}</span>
            <span className="entryGo">open<Chevron /></span>
          </span>
        </span>
      </button>
    );
  }
  return (
    <button className="entry" onClick={onOpen} aria-label={`Open the set ${set.name}`}>
      <span className="gutter"><Fig unit="min">{set.minutes ?? r.totalMin}</Fig></span>
      <span className="stack">
        <span className="entryName">{set.name}</span>
        <span className="entryFoot">
          <span className="meta">
            {numberWord(n)} {plural(n, "problem")}
            {r.doneCount ? `, ${numberWord(r.doneCount)} logged today` : ""}
          </span>
          <span className="entryGo">open<Chevron /></span>
        </span>
      </span>
    </button>
  );
}

// One set's page: its clock, its problems in order, and what today has logged
// against each. Opening a problem hands it to the ordinary rep screen.
function SetPage({ set, problems, techs, ready, setFocused, recordFresh, recordAttempt, onBack, onEdit, onRemove }) {
  const r = useMemo(() => resolveSet(set, problems), [set, problems]);
  const [openIdx, setOpenIdx] = useState(null);
  const [done, setDone] = useState(null);
  // The set's clock is wall-clock from the moment you start it, kept for this
  // browser session only: it survives opening reps and reloading the page,
  // and is gone tomorrow, which is what a drill clock should be.
  const [start, setStart] = useState(() => readSetClock(set.id));
  const [now, setNow] = useState(Date.now());
  const total = set.minutes ?? r.totalMin;

  useEffect(() => { setFocused(openIdx != null || !!done); }, [openIdx, done, setFocused]);
  useEffect(() => {
    if (start == null) return;
    const tick = () => setNow(Date.now());
    const t = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [start]);

  const startClock = () => { const ts = Date.now(); writeSetClock(set.id, ts); setStart(ts); setNow(ts); };
  const resetClock = () => { writeSetClock(set.id, null); setStart(null); };
  const elapsed = start == null ? 0 : Math.floor((now - start) / 1000);
  const left = total * 60 - elapsed;
  const banner = start == null ? null
    : left >= 0 ? <><span className="fig">{clock(left)}</span> left of the set’s <span className="fig">{clock(total * 60)}</span></>
    : <>over the set’s <span className="fig">{clock(total * 60)}</span> by <span className="fig">{clock(-left)}</span></>;

  const nextUndone = (after) =>
    r.items.find((x) => x.i > after && !x.today.length)
    ?? r.items.find((x) => x.i !== after && !x.today.length)
    ?? null;

  function record(row, outcome, minutes, guess, knew) {
    const p = row.tracked ?? row.entry;
    const id = techniqueOf(p);
    const tech = techs.find((t) => t.key === id.key);
    setDone({
      key: id.key, tier: tech?.tier ?? 0, why: null, name: p.name, note: row.it.note ?? null,
      id: row.tracked ? row.tracked.id : null, entry: { url: p.url, name: p.name },
      outcome, minutes, guess, knew, budget: row.minutes, fixedBudget: row.minutes, idx: row.i,
    });
    if (row.tracked) recordAttempt(row.tracked.id, outcome, minutes, { guess, knew });
    else recordFresh(p, outcome, minutes, { guess, knew });
    setOpenIdx(null);
  }

  if (done) {
    const next = nextUndone(done.idx);
    return (
      <RepDone done={done} problems={problems} techs={techs} remaining={next ? 1 : 0}
        backLabel="Set" lastWords="That was the last problem in the set."
        onNext={() => { setDone(null); setOpenIdx(next.i); }}
        onBack={() => setDone(null)} />
    );
  }

  const row = openIdx != null ? r.items[openIdx] : null;
  if (row) {
    const p = row.tracked ?? row.entry;
    const item = {
      tech: { key: `set:${set.id}:${row.i}`, label: p.name, stage: "practice", tier: null, lapses: 0 },
      serve: { mode: row.tracked ? "resolve" : "fresh", problem: p, alts: 1, blind: true },
      est: row.minutes, why: null,
    };
    return (
      <RepScreen key={`${set.id}:${row.i}`} item={item} position={row.i} total={r.items.length} ready={ready}
        postponing={false} setPostponing={() => {}} canPostpone={false}
        backLabel="Set" banner={banner}
        ownBudget={row.minutes} onBudget={() => {}}
        onBack={() => setOpenIdx(null)} onReroll={() => {}} onPostpone={() => {}}
        onRecord={(outcome, minutes, guess, knew) => record(row, outcome, minutes, guess, knew)} />
    );
  }

  return (
    <div>
      <button className="back" onClick={onBack} aria-label="Back to sets"><Chevron dir="left" />Sets</button>
      {set.note && <p className="prose">{set.note}</p>}

      <div className="setClock">
        <span className="setClockFig fig">
          {start == null ? clock(total * 60) : left >= 0 ? clock(left) : `-${clock(-left)}`}
        </span>
        <span className="meta">
          {start == null
            ? `${numberWord(total)} minutes for ${numberWord(r.items.length)} ${plural(r.items.length, "problem")}, in order. Start the clock as you open the first one.`
            : left >= 0 ? `left of ${numberWord(total)} minutes` : `over the ${numberWord(total)} minutes`}
        </span>
        <div className="setClockBtns">
          {start == null
            ? <button className="btn btnStrong" onClick={startClock}>Start the clock</button>
            : <button className="btn btnSm btnBare" onClick={resetClock}>Reset the clock</button>}
        </div>
      </div>

      <Head count={`${r.totalMin} min`}>
        {numberWord(r.items.length)} {plural(r.items.length, "problem")}
        {r.doneCount ? `, ${numberWord(r.doneCount)} logged today` : ""}
      </Head>
      <div className="entries">
        {r.items.map((x) => {
          const p = x.tracked ?? x.entry;
          const last = x.today[x.today.length - 1];
          return (
            <button key={x.i} className={`entry${last ? " entryDone" : ""}`} onClick={() => setOpenIdx(x.i)}
              aria-label={`${last ? "Repeat" : "Start"} ${p.name}, ${(p.difficulty || "medium").toLowerCase()}, ${x.minutes} minutes`}>
              <span className="gutter"><Fig unit="min">{x.minutes}</Fig></span>
              <span className="stack">
                <span className="entryName">{p.name}</span>
                <span className="entryFoot">
                  <span className="meta">
                    {(p.difficulty || "medium").toLowerCase()}, {x.entry.unlisted ? "not in the catalog" : sourceOf(p)}
                    {last
                      ? <>, logged {OUTCOMES[last.outcome].label.toLowerCase()}
                          {last.minutes != null && <> in <span className="fig">{last.minutes}</span> min</>}</>
                      : x.tracked ? ", solved before" : ", never solved"}
                  </span>
                  <span className="entryGo">{last ? "again" : "start"}<Chevron /></span>
                </span>
                {last && x.it.note && (
                  <span className="meta setNote"><span className="named">The trap.</span> {x.it.note}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <p className="note">
        A note on a problem stays hidden until its attempt is logged, for the same reason
        the technique does. Logging here is logging: the log and the moves see every rep.
      </p>
      <div className="setActions">
        <button className="btn btnSm" onClick={onEdit}>Edit the set</button>
        <button className="btn btnSm btnBare" onClick={onRemove}>Remove the set</button>
      </div>
    </div>
  );
}

// Making a set is typing a list: one problem per line, a name and optionally a
// minute budget, a link, and a note, separated by pipes. Each line is matched
// against the catalog as you type, so a misspelt name shows up before it is
// saved rather than as a rep that opens nowhere.
function SetEditor({ set, sets, onClose, onSave }) {
  const [name, setName] = useState(set?.name ?? "");
  const [minutes, setMinutes] = useState(set?.minutes ? String(set.minutes) : "45");
  const [note, setNote] = useState(set?.note ?? "");
  const [group, setGroup] = useState(set?.group ?? "");
  const [finished, setFinished] = useState(set?.done === true);
  const [text, setText] = useState(set ? formatSetText(set) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const parsed = useMemo(() => parseSetText(text), [text]);
  const rows = useMemo(() => parsed.items.map((it) => ({ it, entry: entryForItem(it, LIBRARY) })), [parsed]);
  const canSave = !!name.trim() && parsed.items.length > 0 && !busy;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const taken = new Set((sets ?? []).map((s) => s.id).filter((id) => id !== set?.id));
      const id = set?.id ?? setId(name, taken);
      const m = parseInt(minutes, 10) || null;
      const next = {
        id, name: name.trim(),
        ...(m ? { minutes: m } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(group.trim() ? { group: group.trim() } : {}),
        ...(finished ? { done: true } : {}),
        items: parsed.items,
      };
      const v = validateSets({ sets: [next] });
      if (!v.ok) throw new Error(v.error);
      await onSave(next);
    } catch (e) {
      setError(e.message || "The set could not be saved.");
      setBusy(false);
    }
  }

  return (
    <Sheet label={set ? "Edit the set" : "New set"} title={set ? set.name : "New set"} onClose={onClose}
      bar={
        <>
          <button className="btn btnStrong" disabled={!canSave} onClick={save}>
            {busy ? "Saving" : set ? "Save" : "Make the set"}
          </button>
          <button className="btn btnBare" onClick={onClose}>Cancel</button>
        </>
      }>
      <label className="field">
        <span className="fieldLabel">Name</span>
        <input className="line" value={name} onChange={(e) => setName(e.target.value)} placeholder="CodeSignal, set D" />
      </label>
      <label className="field">
        <span className="fieldLabel">Minutes for the whole set</span>
        <input className="line fig" inputMode="numeric" value={minutes}
          onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} />
      </label>
      <label className="field">
        <span className="fieldLabel">Group: the company or assessment it is shaped for</span>
        <input className="line" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Chime" />
      </label>
      <label className="field checkField">
        <input type="checkbox" checked={finished} onChange={(e) => setFinished(e.target.checked)} />
        <span className="fieldLabel">Done: the assessment has happened; keep the set for reference</span>
      </label>
      <label className="field">
        <span className="fieldLabel">Why this set exists, shown on its page</span>
        <textarea className="line area" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="field">
        <span className="fieldLabel">
          Problems, one per line: name | minutes | note. A link after the name opens the problem there.
        </span>
        <textarea className="line area setText" value={text} spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Run Length Encoding | 10 | runs longer than 9 must split\nValid Ip Addresses | 20"} />
      </label>

      {rows.length > 0 && (
        <div className="recs">
          {rows.map(({ it, entry }, i) => (
            <div key={i} className="rec">
              <span className="gutter"><Fig unit="min">{it.minutes ?? (entry ? budgetOf(entry) : "—")}</Fig></span>
              <span className="stack">
                <span className="recName">{entry?.name ?? it.name}</span>
                <span className="meta">
                  {entry
                    ? `${entry.difficulty.toLowerCase()}, ${entry.category.toLowerCase()}, ${sourceOf(entry)}`
                    : it.url
                    ? "not in the catalog; opens by the link you gave"
                    : "not in the catalog and no link, so it opens nowhere; the name still logs"}
                  {it.note ? "; note hidden until logged" : ""}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {parsed.problems.map((m, i) => <p key={i} className="note">Skipped {m}.</p>)}
      {error && <p className="note mark">{error}</p>}
    </Sheet>
  );
}

// ---------- Recall ----------
// Lines you type from memory, reference closed, before the session: the fix
// for knowing the move and not being able to produce the line. Judgment is
// what Today trains; this is fingers. A line is due until it has been typed
// clean on two separate days running, and a miss sends it back — the rules
// are in lib/recall.js. Nothing here touches the log or the moves.
const RECALL_SIDE_KEY = "grind-recall-side";
const RECALL_MINUTES = 10;
const RECALL_SIDE_LABEL = { python: "Python", node: "Node" };
function readRecallSide() {
  try {
    const v = localStorage.getItem(RECALL_SIDE_KEY);
    return RECALL_SIDES.includes(v) ? v : RECALL_SIDES[0];
  } catch { return RECALL_SIDES[0]; }
}

// The local calendar day as YYYY-MM-DD: a line typed at ten to midnight
// belongs to the day you typed it, not to UTC's.
const localYmd = (ts = Date.now()) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const ymdNoon = (ymd) => new Date(`${ymd}T12:00:00`).getTime();
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sideWord = (side) => RECALL_SIDE_LABEL[side] ?? side;

// A prompt is prose with code in backticks; the code is set in the mono face.
function Ticks({ text }) {
  const parts = String(text ?? "").split("`");
  return parts.map((s, i) => (i % 2 ? <code key={i} className="recallTick">{s}</code> : s));
}

export function RecallView({ data, error, reload, record, setFocused }) {
  const [side, setSideState] = useState(readRecallSide);
  const [drill, setDrill] = useState(null); // null | { n, items }
  const today = localYmd();
  const setSide = (s) => {
    setSideState(s);
    try { localStorage.setItem(RECALL_SIDE_KEY, s); } catch { /* preference only */ }
  };
  useEffect(() => { setFocused(!!drill); }, [drill, setFocused]);

  const due = useMemo(() => (data ? dueItems(data, today, side) : []), [data, today, side]);
  // The queue: due lines not yet typed today, in id order.
  const queue = useMemo(() => due.filter((i) => !i.attemptedToday).sort(byId), [due]);
  // Today's verdicts come off the log, not the due list: the second clean of
  // a pair retires a line, and it should still count as done today.
  const doneToday = useMemo(() => {
    if (!data) return { clean: 0, miss: 0, misses: [] };
    const mine = new Map(data.items.filter((i) => i.side === side).map((i) => [i.id, i]));
    const latest = new Map();
    for (const e of data.log) if (e.date === today && mine.has(e.id)) latest.set(e.id, e.result);
    let clean = 0, miss = 0;
    const misses = [];
    for (const [id, result] of latest) {
      if (result === "clean") clean += 1;
      else { miss += 1; misses.push({ ...mine.get(id), lastResult: "miss", lastDate: today }); }
    }
    return { clean, miss, misses: misses.sort(byId) };
  }, [data, today, side]);
  // What earlier days left for today; today's own misses are listed above.
  const carried = useMemo(
    () => (data ? carryForward(data, side).filter((i) => i.missedOn < today).sort(byId) : []),
    [data, side, today]);
  const week = useMemo(() => {
    if (!data) return [];
    const mine = new Set(data.items.filter((i) => i.side === side).map((i) => i.id));
    return recallHistory({ ...data, log: data.log.filter((e) => mine.has(e.id)) }, 7, today);
  }, [data, side, today]);

  const start = (items) => setDrill({ n: (drill?.n ?? 0) + 1, items });

  if (drill) {
    return (
      <RecallDrill key={drill.n} items={drill.items} side={side} error={error}
        onRecord={(id, result) => record({ date: localYmd(), id, result })}
        onBack={() => setDrill(null)} />
    );
  }

  const weekLabel = (ymd) => new Date(ymdNoon(ymd)).toLocaleDateString(undefined, { weekday: "narrow" });
  const n = data?.items.filter((i) => i.side === side).length ?? 0;

  return (
    <div>
      {error && (
        <Notice title="Your lines could not be reached">
          <p>{error}</p>
          <div className="noticeActions"><button className="btn" onClick={reload}>Try again</button></div>
        </Notice>
      )}
      <div className="dial" role="group" aria-label="Side">
        <span className="dialLabel">Side</span>
        {RECALL_SIDES.map((s) => (
          <button key={s} onClick={() => setSide(s)}
            className={`dialBtn${side === s ? " dialBtnOn" : ""}`}
            aria-pressed={side === s}>{sideWord(s)}</button>
        ))}
      </div>
      <p className="prose">
        Lines you type from memory, reference closed, before the session. Ten minutes, one
        line at a time: type it, reveal, and say whether it was clean. A line retires after
        two clean days running; a miss brings it back.
      </p>

      {data == null ? (
        <p className="note">Loading your lines.</p>
      ) : n === 0 ? (
        <p className="note">
          No {sideWord(side)} lines on file. Put them in recall.json in the data folder; examples/recall.json shows the shape.
        </p>
      ) : (
        <>
          <Head count={queue.length}>
            {queue.length === 0 ? "Nothing left today" : `${cap(numberWord(queue.length))} ${plural(queue.length, "line")} due`}
          </Head>
          <p className="note">
            {queue.length === 0
              ? `Every ${sideWord(side)} line that is due has been typed today.`
              : `${cap(numberWord(due.length))} of ${numberWord(n)} ${sideWord(side)} ${plural(n, "line")} ${due.length === 1 ? "is" : "are"} still due${n > due.length ? `; ${numberWord(n - due.length)} ${n - due.length === 1 ? "has" : "have"} retired` : ""}.`}
            {(doneToday.clean + doneToday.miss) > 0 && (
              <> Done today: <span className="fig">{doneToday.clean}</span> clean, <span className="fig">{doneToday.miss}</span> {doneToday.miss === 1 ? "miss" : "misses"}.</>
            )}
          </p>
          <div className="setActions">
            <button className="btn btnStrong" disabled={!queue.length} onClick={() => start(queue)}>Start</button>
            {doneToday.misses.length > 0 && (
              <button className="btn" onClick={() => start(doneToday.misses)}>Redo a miss</button>
            )}
          </div>

          {carried.length > 0 && (
            <>
              <Head count={carried.length}>Carried forward</Head>
              <div className="recs">
                {carried.map((i) => {
                  const f = dayFig(ymdNoon(i.missedOn));
                  return (
                    <div key={i.id} className="rec">
                      <span className="gutter"><Fig unit={f.month}>{f.day}</Fig></span>
                      <span className="stack">
                        <span className="recName"><Ticks text={i.prompt} /></span>
                        <span className="meta">missed, comes back until it is typed clean twice</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <Head>Last seven days</Head>
          <table className="recallWeek">
            <thead>
              <tr>
                <th scope="row" />
                {week.map((d) => (
                  <th key={d.date} scope="col" className={d.date === today ? "on" : undefined}
                    aria-label={d.date}>{weekLabel(d.date)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {["clean", "miss"].map((k) => (
                <tr key={k}>
                  <th scope="row">{k}</th>
                  {week.map((d) => (
                    <td key={d.date} className={`fig${d.date === today ? " on" : ""}`}>{d[k] || "·"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// The drill: ten minutes on the clock, one line at a time, verdict by key.
// The queue is fixed when the drill starts, so a verdict landing in the file
// never reorders what is still to come.
function RecallDrill({ items, side, error, onRecord, onBack }) {
  const [idx, setIdx] = useState(0);
  const [results, setResults] = useState([]); // [{ item, result }], in order
  const [skipped, setSkipped] = useState(0);
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  const item = items[idx] ?? null;
  const left = RECALL_MINUTES * 60 - Math.floor((now - start) / 1000);
  const over = left <= 0 || !item;

  // Wall-clock, like the rep screen: a backgrounded tab must not stop the clock.
  useEffect(() => {
    if (over) return;
    const tick = () => setNow(Date.now());
    const t = setInterval(tick, 500);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [over]);

  function verdict(result) {
    onRecord(item.id, result);
    setResults((r) => [...r, { item, result }]);
    setIdx((i) => i + 1);
  }
  const skip = () => { setSkipped((k) => k + 1); setIdx((i) => i + 1); };

  if (over) {
    const clean = results.filter((r) => r.result === "clean").length;
    const misses = results.filter((r) => r.result === "miss").map((r) => r.item);
    return (
      <div className="rep">
        <button className="back" onClick={onBack} aria-label="Back to recall"><Chevron dir="left" />Recall</button>
        <h1 className="repName">{left <= 0 ? "Time" : "Done"}</h1>
        <p className="repMeta">
          <span className="fig">{results.length}</span> of {items.length} {plural(items.length, "line")} typed,
          {" "}<span className="fig">{clean}</span> clean, <span className="fig">{misses.length}</span> missed
          {skipped > 0 && <>, <span className="fig">{skipped}</span> skipped</>}.
        </p>
        {misses.length > 0 && (
          <>
            <Head count={misses.length}>Missed</Head>
            <div className="recs">
              {misses.map((i) => (
                <div key={i.id} className="rec">
                  <span className="gutter"><Fig>{i.id}</Fig></span>
                  <span className="stack">
                    <span className="recName"><Ticks text={i.prompt} /></span>
                    <pre className="recallPre meta">{i.answer}</pre>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        <p className="repSay">
          {misses.length > 0
            ? "A miss comes back tomorrow, and the day after, until it has been typed clean on two days running. Redo it now from the Recall page if the line is still warm."
            : results.length > 0
            ? "Every line typed clean. Each one needs a second clean day before it retires."
            : "Nothing was typed."}
        </p>
        {error && <p className="note mark">{error}</p>}
        <div className="repActions doneActions">
          <button className="btn btnStrong" onClick={onBack}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="rep">
      <button className="back" onClick={onBack} aria-label="Back to recall"><Chevron dir="left" />Recall</button>
      <p className="repBanner"><span className="fig">{clock(left)}</span> left of {numberWord(RECALL_MINUTES)} minutes</p>
      <RecallCard key={item.id} item={item} position={idx} total={items.length} side={side}
        onClean={() => verdict("clean")} onMiss={() => verdict("miss")} onSkip={skip} />
      {error && <p className="note mark">{error}</p>}
    </div>
  );
}

// One line: the prompt, a blank editor, the reveal, the verdict. Enter in the
// editor is a newline, because the line may be several; Cmd or Ctrl with
// Enter reveals, and after the reveal 1 is clean and 2 is a miss.
function RecallCard({ item, position, total, side, onClean, onMiss, onSkip }) {
  const [typed, setTyped] = useState("");
  const [revealed, setRevealed] = useState(false);
  const area = useRef(null);
  useEffect(() => { area.current?.focus(); }, []);
  useEffect(() => {
    if (!revealed) return;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") { e.preventDefault(); onClean(); }
      else if (e.key === "2") { e.preventDefault(); onMiss(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, onClean, onMiss]);

  return (
    <>
      <h1 className="repName recallPrompt"><Ticks text={item.prompt} /></h1>
      <p className="repMeta">
        {sideWord(side).toLowerCase()}, line {position + 1} of {total}
        {item.lastResult === "miss" && item.lastDate && <>, missed on {fmtDate(ymdNoon(item.lastDate))}</>}
        {item.lastResult === "clean" && <>, clean once</>}
        {!item.lastResult && <>, never typed</>}
      </p>
      <label className="field">
        <span className="fieldLabel">
          {revealed ? "What you typed" : "From memory. Cmd or Ctrl and Enter reveals the line."}
        </span>
        <textarea ref={area} className="line area recallArea" value={typed} readOnly={revealed}
          spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setRevealed(true); }
          }} />
      </label>
      {revealed ? (
        <>
          <div className="field">
            <span className="fieldLabel">The line</span>
            <pre className="recallPre">{item.answer}</pre>
          </div>
          <div className="repActions doneActions">
            <button className="btn btnStrong" onClick={onClean}>Clean<span className="fig recallKey">1</span></button>
            <button className="btn" onClick={onMiss}>Miss<span className="fig recallKey">2</span></button>
          </div>
        </>
      ) : (
        <div className="repActions doneActions">
          <button className="btn btnStrong" onClick={() => setRevealed(true)}>Reveal</button>
          <button className="btn btnBare" onClick={onSkip}>Skip for now</button>
        </div>
      )}
    </>
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
export function LogView({ problems, removeProblem, setEditing, recordAttempt, fixAttempt,
  ready, exportJSON, importJSON, openHistory }) {
  const [reviewing, setReviewing] = useState(null);
  // The last attempt recorded from this screen, so the guess gets its verdict
  // here rather than only under Today. Session-only.
  const [revealed, setRevealed] = useState(null); // { id, guess, knew }
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
              <HistoryTimeline p={p} ready={ready} fixAttempt={fixAttempt} />
              {revealed?.id === p.id && reviewing !== p.id && (
                <span className="meta"><Verdict p={p} guess={revealed.guess} knew={revealed.knew} /></span>
              )}
              {reviewing === p.id && (
                <AttemptForm compact
                  onRecord={(outcome, minutes, guess, knew) => {
                    recordAttempt(p.id, outcome, minutes, { guess, knew });
                    setRevealed({ id: p.id, guess, knew });
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
  const budget = budgetOf(p);
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

function HistoryTimeline({ p, ready, fixAttempt }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // index of the attempt being corrected
  const rows = attemptRows(p);
  const one = rows.length === 1;

  return (
    <div className="timelineWrap">
      <button className="btn btnSm btnBare" onClick={() => { setOpen(!open); setEditing(null); }} aria-expanded={open}>
        {open ? (one ? "Hide the attempt" : "Hide the attempts") : (one ? "Show the attempt" : `Show all ${rows.length} attempts`)}
      </button>
      {open && (
        <div className="timeline">
          {rows.map((r, i) => (
            editing === i ? (
              <AttemptEditor key={i} row={r}
                onSave={(patch) => { fixAttempt(p.id, i, patch); setEditing(null); }}
                onCancel={() => setEditing(null)} />
            ) : (
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
              {fixAttempt && (
                <button className="btn btnSm btnBare timelineEdit" disabled={!ready}
                  aria-label={`Correct the attempt from ${r.at ? fmtDate(r.at) : "an unknown date"}`}
                  onClick={() => setEditing(i)}>Correct</button>
              )}
            </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}

// One attempt, opened for correction. The date stays: moving an attempt in
// time would reorder the evidence, and that is a different, rarer mistake.
function AttemptEditor({ row, onSave, onCancel }) {
  const [outcome, setOutcome] = useState(row.outcome);
  const [minutes, setMinutes] = useState(row.minutes != null ? String(row.minutes) : "");
  const [knew, setKnew] = useState(row.knew != null ? String(row.knew) : "");
  const [guess, setGuess] = useState(row.guess ?? "");
  const digits = (v) => v.replace(/\D/g, "");
  const num = (v) => (v ? parseInt(v, 10) : null);
  return (
    <div className="record recordCompact attemptEdit">
      <span className="meta">Correcting the attempt from {row.at ? fmtDate(row.at) : "an unknown date"}</span>
      <label className="field">
        <span className="fieldLabel">Which move did you reach for?</span>
        <input className="line" list="technique-labels" value={guess} spellCheck={false}
          onChange={(e) => setGuess(e.target.value)} placeholder="start typing a technique" />
      </label>
      <div className="fields2">
        <label className="field">
          <span className="fieldLabel">Minutes until you knew</span>
          <input className="line fig" inputMode="numeric" value={knew}
            onChange={(e) => setKnew(digits(e.target.value))} />
        </label>
        <label className="field">
          <span className="fieldLabel">Minutes in total</span>
          <input className="line fig" inputMode="numeric" value={minutes}
            onChange={(e) => setMinutes(digits(e.target.value))} />
        </label>
      </div>
      <label className="field">
        <span className="fieldLabel">How it went</span>
        <select className="line" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {Object.entries(OUTCOMES).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}
        </select>
      </label>
      <div className="repActions">
        <button className="btn btnSm btnStrong"
          onClick={() => onSave({ outcome, minutes: num(minutes), knew: num(knew), guess: guess.trim() || null })}>
          Save the correction
        </button>
        <button className="btn btnSm btnBare" onClick={onCancel}>Cancel</button>
      </div>
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
  const [budget, setBudget] = useState(problem?.budget ? String(problem.budget) : "");

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
    const ownBudget = parseInt(budget, 10) || null;
    if (editMode) data.budget = ownBudget;
    else if (ownBudget) data.budget = ownBudget;
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

      <label className="field">
        <span className="fieldLabel">Pace budget, minutes</span>
        <input id="pm-budget" className="line fig" inputMode="numeric" value={budget}
          onChange={(e) => setBudget(e.target.value.replace(/\D/g, ""))}
          placeholder={String(BUDGET[difficulty] ?? 30)} />
      </label>
      <p className="note">
        {budget && parseInt(budget, 10) > 0
          ? `Overrides the ${BUDGET[difficulty] ?? 30} minute ${difficulty.toLowerCase()} estimate for this problem only. Clear it to go back.`
          : `Blank uses the ${difficulty.toLowerCase()} estimate. Set one when the platform's number is plainly wrong for this problem.`}
      </p>

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
.budgetIn { width: 3.2ch; box-sizing: content-box; text-align: center; font: inherit; font-size: 14px;
  color: var(--ink); background: transparent; border: 0; border-radius: 0;
  border-bottom: 1px solid var(--rule-ink); padding: 3px 3px; margin: 0; -webkit-appearance: none; }
.budgetIn:focus { outline: none; border-bottom-color: var(--ink); }
.doneRow { margin: 18px 16px 0; }
.doneActions { padding: 18px 11px 0; }
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
  color: var(--ink); display: block; width: 100%; max-width: 8ch; margin: 0; padding: 0 0 2px;
  border: 0; border-bottom: 1px solid transparent; border-radius: 0; background: transparent;
  -webkit-appearance: none; }
.splitClock:focus { outline: none; border-bottom-color: var(--mark); }
.paceWrap { margin-top: 14px; }
.pace { position: relative; height: 10px; border-bottom: 1px solid var(--rule-ink); }
.paceFill { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--ink-2); }
.paceBudget { position: absolute; bottom: -3px; width: 1px; height: 13px; background: var(--ink); }
.paceKnew { position: absolute; bottom: -1px; width: 2px; height: 9px; background: var(--mark); }
.paceEnds { display: flex; justify-content: space-between; gap: 12px; margin-top: 7px;
  font-size: 12.5px; color: var(--ink-3); }
.splitHint { margin: 12px 0 0; font-size: 12.5px; color: var(--ink-3); }
.splitBtns { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }

/* Fields sit on a rule, the way a form on paper does. */
.record { display: flex; flex-direction: column; padding-top: 4px; }
.recordCompact { padding-top: 0; }
.field { display: flex; flex-direction: column; gap: 4px; padding: 10px 16px; }
.fieldLabel { font-size: 13px; color: var(--ink-2); }
.checkField { flex-direction: row; align-items: center; gap: 10px; }
.checkField input { flex: none; margin: 0; accent-color: var(--ink); }
.entryLine .stack { padding: 10px 0 10px 14px; }
.setGroupGutter { padding: 10px 11px 10px 0; font-size: 12px; line-height: 1.3; overflow-wrap: anywhere; }
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
.timelineEdit { margin: -8px 0 -8px auto; }
.attemptEdit { margin-top: 4px; }

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

/* ── Sets ───────────────────────────────────────────────────────────────── */
.entryDone { opacity: 0.62; }
.setNote { margin-top: 4px; }
.setClock { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px;
  padding: 14px 16px 2px; }
.setClockFig { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
.setClockBtns { flex-basis: 100%; padding-top: 8px; }
.setActions { display: flex; gap: 8px; flex-wrap: wrap; padding: 18px 16px 4px; }
.setText { min-height: 170px; font-family: var(--mono); font-size: 13px; line-height: 1.55; }
.repBanner { margin: 4px 16px 0; font-size: 13.5px; color: var(--ink-2); }

/* ── Recall ─────────────────────────────────────────────────────────────── */
.recallPrompt { font-size: 22px; }
.recallTick { font-family: var(--mono); font-size: 0.92em; font-weight: 500; }
.recallArea { min-height: 150px; font-family: var(--mono); font-size: 13.5px; line-height: 1.55;
  tab-size: 4; }
.recallArea[readonly] { color: var(--ink-2); border-bottom-color: var(--rule); }
.recallPre { margin: 0; padding: 8px 0 0; font-family: var(--mono); font-size: 13.5px;
  line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; color: var(--ink); }
.recallPre.meta { color: var(--ink-3); font-size: 12.5px; padding-top: 4px; }
.recallKey { margin-left: 8px; color: var(--ink-3); font-weight: 400; }
.recallWeek { width: calc(100% - 32px); margin: 8px 16px 0; border-collapse: collapse; font-size: 13px; }
.recallWeek th, .recallWeek td { text-align: right; padding: 6px 4px; font-weight: 400; }
.recallWeek thead th { color: var(--ink-3); border-bottom: 1px solid var(--rule-ink); }
.recallWeek td { border-bottom: 1px solid var(--rule); color: var(--ink-2); }
.recallWeek tbody th { text-align: left; padding-left: 0; color: var(--ink-3);
  border-bottom: 1px solid var(--rule); }
.recallWeek .on { color: var(--ink); font-weight: 700; }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
