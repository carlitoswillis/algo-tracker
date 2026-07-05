import React, { useState, useEffect, useMemo } from "react";

// ---------- Spaced repetition logic ----------
// Outcome determines the next interval (days). Solving cold advances the ladder;
// needing hints holds it; failing resets it.
const LADDER = [2, 4, 7, 14, 30, 60];

const CATEGORIES = [
  "Arrays & Strings", "Hashmaps", "Two Pointers", "Sliding Window",
  "Binary Search", "Linked Lists", "Stacks & Queues", "Trees & BST",
  "Recursion / Backtracking", "Graphs (BFS/DFS)", "Heaps", "Greedy",
  "Dynamic Programming",
];

const OUTCOMES = {
  cold: { label: "Solved cold, optimal", short: "COLD" },
  subopt: { label: "Cold, but suboptimal", short: "SUB" },
  hints: { label: "Needed hints", short: "HINT" },
  failed: { label: "Couldn't solve", short: "FAIL" },
};

// Interview pace budgets (minutes). Time never changes the schedule — outcomes do —
// but a cold solve over budget isn't interview-ready yet, so we surface it.
const BUDGET = { Easy: 15, Medium: 30, Hard: 45 };

const DAY = 24 * 60 * 60 * 1000;
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const localDay = (ts) => Math.floor((ts - new Date(ts).getTimezoneOffset() * 60 * 1000) / DAY);

// Only an optimal cold solve climbs the ladder. A suboptimal cold solve or a
// hinted one holds the current rung; a fail resets it.
function nextStep(step, outcome) {
  if (outcome === "cold") return Math.min(step + 1, LADDER.length - 1);
  if (outcome === "subopt" || outcome === "hints") return Math.max(step, 0);
  return 0;
}

function scheduleFrom(step) {
  return todayStart() + LADDER[step] * DAY;
}

// Recall strength per problem: 0..1 based on ladder position and last outcome
function strength(p) {
  const base = (p.step + 1) / LADDER.length;
  const last = p.history[p.history.length - 1];
  const mod = last === "cold" ? 1 : last === "subopt" ? 0.85 : last === "hints" ? 0.7 : 0.35;
  return Math.min(1, base * mod + (last === "cold" ? 0.15 : 0));
}

const uid = () => Math.random().toString(36).slice(2, 9);
const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// Older entries only stored `minutes` from the first attempt; `times` is a
// per-review array aligned with `history` (null = not recorded that session).
function migrate(p) {
  if (p.times) return p;
  const first = p.minutes ? parseInt(p.minutes, 10) || null : null;
  return { ...p, times: [first, ...Array(Math.max(0, p.history.length - 1)).fill(null)] };
}

// ---------- Storage ----------
const KEY = "grind-tracker-v1";

async function loadState() {
  try {
    const res = await window.storage.get(KEY);
    return res ? JSON.parse(res.value) : null;
  } catch { return null; }
}
async function saveState(state) {
  try { await window.storage.set(KEY, JSON.stringify(state)); } catch (e) { console.error("save failed", e); }
}

// ---------- App ----------
export default function GrindTracker() {
  const [problems, setProblems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("today");
  const [showAdd, setShowAdd] = useState(false);
  const [reviewing, setReviewing] = useState(null); // problem id being reviewed

  useEffect(() => {
    loadState().then((s) => { if (s?.problems) setProblems(s.problems.map(migrate)); setLoaded(true); });
  }, []);

  useEffect(() => {
    if (loaded) saveState({ problems });
  }, [problems, loaded]);

  const due = useMemo(
    () => problems.filter((p) => p.due <= todayStart() + DAY - 1).sort((a, b) => a.due - b.due),
    [problems]
  );

  const byCategory = useMemo(() => {
    const m = {};
    CATEGORIES.forEach((c) => (m[c] = []));
    problems.forEach((p) => { (m[p.category] = m[p.category] || []).push(p); });
    return m;
  }, [problems]);

  const streak = useMemo(() => {
    const days = new Set(problems.flatMap((p) => p.log || []).map(localDay));
    let s = 0, d = localDay(Date.now());
    if (!days.has(d)) d -= 1; // streak survives if you haven't logged yet today
    while (days.has(d)) { s++; d--; }
    return s;
  }, [problems]);

  const totalMinutes = useMemo(
    () => problems.reduce((s, p) => s + (p.times || []).reduce((a, t) => a + (t || 0), 0), 0),
    [problems]
  );

  function addProblem(data) {
    const step = data.outcome === "cold" ? 1 : 0;
    const p = {
      id: uid(), name: data.name, category: data.category, difficulty: data.difficulty,
      insight: data.insight,
      step, history: [data.outcome], times: [data.minutes], log: [Date.now()],
      due: scheduleFrom(step), added: Date.now(),
    };
    setProblems((prev) => [p, ...prev]);
    setShowAdd(false);
  }

  function recordReview(id, outcome, minutes) {
    setProblems((prev) => prev.map((p) => {
      if (p.id !== id) return p;
      const step = nextStep(p.step, outcome);
      return {
        ...p, step,
        history: [...p.history, outcome],
        times: [...(p.times || []), minutes],
        log: [...(p.log || []), Date.now()],
        due: scheduleFrom(step),
      };
    }));
    setReviewing(null);
  }

  function removeProblem(id) {
    const p = problems.find((x) => x.id === id);
    if (p && !window.confirm(`Remove “${p.name}” and its history?`)) return;
    setProblems((prev) => prev.filter((x) => x.id !== id));
  }

  const solvedCold = problems.filter((p) => p.history[p.history.length - 1] === "cold").length;

  return (
    <div style={S.app}>
      <style>{CSS}</style>

      <header style={S.header}>
        <div>
          <div style={S.eyebrow}>NIGHT SHIFT · INTERVIEW PREP</div>
          <h1 style={S.title}>Grind Log</h1>
        </div>
        <div style={S.headerStats}>
          <Stat label="streak" value={`${streak}d`} accent />
          <Stat label="tracked" value={problems.length} />
          <Stat label="cold" value={solvedCold} />
          <Stat label="grind time" value={totalMinutes >= 60 ? `${(totalMinutes / 60).toFixed(1)}h` : `${totalMinutes}m`} />
        </div>
      </header>

      <nav style={S.nav}>
        {[
          ["today", `Due today${due.length ? ` · ${due.length}` : ""}`],
          ["patterns", "Patterns"],
          ["all", "All problems"],
        ].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className="navBtn" style={{ ...S.navBtn, ...(tab === k ? S.navBtnActive : {}) }}>
            {label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="primary" style={S.primary} onClick={() => setShowAdd(true)}>+ Log a problem</button>
      </nav>

      {!loaded ? (
        <div style={S.empty}>Loading your log…</div>
      ) : tab === "today" ? (
        <TodayView due={due} reviewing={reviewing} setReviewing={setReviewing} recordReview={recordReview} problems={problems} />
      ) : tab === "patterns" ? (
        <PatternsView byCategory={byCategory} />
      ) : (
        <AllView problems={problems} removeProblem={removeProblem} />
      )}

      {showAdd && <AddModal onClose={() => setShowAdd(false)} onSave={addProblem} />}
    </div>
  );
}

// ---------- Views ----------
function TodayView({ due, reviewing, setReviewing, recordReview, problems }) {
  const [minutes, setMinutes] = useState("");
  const startReview = (id) => { setMinutes(""); setReviewing(id); };
  const finish = (id, outcome) => recordReview(id, outcome, minutes ? parseInt(minutes, 10) : null);

  if (problems.length === 0)
    return (
      <div style={S.empty}>
        <div style={{ fontSize: 15, marginBottom: 8, color: "#E8EAED" }}>Nothing logged yet.</div>
        Log every problem you attempt — the tracker schedules re-solves at expanding intervals.
        Failed or hinted problems come back in 2 days, cold solves in 4.
      </div>
    );
  if (due.length === 0)
    return (
      <div style={S.empty}>
        <div style={{ fontSize: 15, marginBottom: 8, color: "#E8EAED" }}>Queue cleared. 🔒</div>
        No reviews due. Go attempt new problems in your current category, then log them here.
      </div>
    );
  return (
    <div>
      <p style={S.hint}>Re-solve each from a blank editor, out loud, before marking the outcome. Honesty is the whole system.</p>
      {due.map((p) => {
        const overdueDays = Math.floor((todayStart() - p.due) / DAY);
        return (
          <div key={p.id} style={S.card} className="card">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.cardTop}>
                <span style={S.badge(p.difficulty)}>{p.difficulty}</span>
                <span style={S.cardName}>{p.name}</span>
                {overdueDays > 0 && <span style={S.overdue}>overdue {overdueDays}d</span>}
              </div>
              <div style={S.cardMeta}>{p.category} · due {fmtDate(p.due)} · interval {LADDER[p.step]}d</div>
              {p.insight && <div style={S.insight}>“{p.insight}”</div>}
              <TimeTrend p={p} />
              <Ladder p={p} />
            </div>
            {reviewing === p.id ? (
              <div style={S.outcomeCol}>
                <input
                  style={{ ...S.input, width: 96, padding: "7px 10px", fontSize: 11 }}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))}
                  placeholder="minutes"
                  inputMode="numeric"
                  autoFocus
                />
                {Object.entries(OUTCOMES).map(([k, o]) => (
                  <button key={k} className="outcomeBtn" style={S.outcome(k)} onClick={() => finish(p.id, k)}>{o.label}</button>
                ))}
              </div>
            ) : (
              <button className="ghost" style={S.ghost} onClick={() => startReview(p.id)}>Re-solved it →</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PatternsView({ byCategory }) {
  return (
    <div>
      <p style={S.hint}>Aim for 8–12 problems per pattern before moving on. Bars show average recall strength.</p>
      {CATEGORIES.map((c) => {
        const list = byCategory[c] || [];
        const avg = list.length ? list.reduce((s, p) => s + strength(p), 0) / list.length : 0;
        return (
          <div key={c} style={S.patternRow}>
            <div style={S.patternName}>{c}</div>
            <div style={S.barTrack}>
              <div style={{ ...S.barFill, width: `${Math.round(avg * 100)}%` }} />
            </div>
            <div style={S.patternCount}>{list.length ? `${list.length} · ${Math.round(avg * 100)}%` : "—"}</div>
          </div>
        );
      })}
    </div>
  );
}

function AllView({ problems, removeProblem }) {
  if (!problems.length) return <div style={S.empty}>No problems logged yet.</div>;
  return (
    <div>
      {[...problems].sort((a, b) => a.due - b.due).map((p) => (
        <div key={p.id} style={{ ...S.card, alignItems: "center" }} className="card">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={S.cardTop}>
              <span style={S.badge(p.difficulty)}>{p.difficulty}</span>
              <span style={S.cardName}>{p.name}</span>
            </div>
            <div style={S.cardMeta}>
              {p.category} · next {fmtDate(p.due)} · {p.history.map((h) => OUTCOMES[h].short).join(" → ")}
            </div>
            {p.insight && <div style={S.insight}>“{p.insight}”</div>}
            <TimeTrend p={p} />
            <Ladder p={p} />
          </div>
          <button className="ghost" style={{ ...S.ghost, color: "#8B93A1" }} onClick={() => removeProblem(p.id)}>remove</button>
        </div>
      ))}
    </div>
  );
}

// Fluency signal: solve times across reviews, checked against the interview
// pace budget for the difficulty. Informational only — never moves the schedule.
function TimeTrend({ p }) {
  const times = (p.times || []).filter((t) => t != null);
  if (!times.length) return null;
  const budget = BUDGET[p.difficulty];
  const last = times[times.length - 1];
  const overPace = budget && last > budget;
  return (
    <div style={S.timeTrend}>
      ⏱ {times.map((t) => `${t}m`).join(" → ")}
      {budget && (
        <span style={{ color: overPace ? "#E88AAB" : "#4FB8A8", marginLeft: 8 }}>
          {overPace ? `over ${budget}m pace` : `on pace (${budget}m)`}
        </span>
      )}
    </div>
  );
}

function Ladder({ p }) {
  return (
    <div style={S.ladder} title="Interval ladder: 2 → 4 → 7 → 14 → 30 → 60 days">
      {LADDER.map((d, i) => (
        <span key={d} style={{
          ...S.dot,
          background: i < p.step ? "#E8A33D" : i === p.step ? "#4FB8A8" : "#2A313C",
        }}>{i === p.step ? d : ""}</span>
      ))}
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ ...S.statVal, color: accent ? "#E8A33D" : "#E8EAED" }}>{value}</div>
      <div style={S.statLabel}>{label}</div>
    </div>
  );
}

// ---------- Add modal ----------
function AddModal({ onClose, onSave }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [difficulty, setDifficulty] = useState("Medium");
  const [outcome, setOutcome] = useState("cold");
  const [minutes, setMinutes] = useState("");
  const [insight, setInsight] = useState("");

  const valid = name.trim().length > 0;

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={S.modalTitle}>Log a problem</h2>

        <label style={S.label}>Problem name</label>
        <input style={S.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Longest Substring Without Repeating Characters" autoFocus />

        <div style={S.row2}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Pattern</label>
            <select style={S.input} value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ width: 110 }}>
            <label style={S.label}>Difficulty</label>
            <select style={S.input} value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
              <option>Easy</option><option>Medium</option><option>Hard</option>
            </select>
          </div>
        </div>

        <label style={S.label}>How did the first attempt go?</label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {Object.entries(OUTCOMES).map(([k, o]) => (
            <button key={k} className="outcomeBtn"
              style={{ ...S.outcome(k), opacity: outcome === k ? 1 : 0.45 }}
              onClick={() => setOutcome(k)}>{o.label}</button>
          ))}
        </div>

        <div style={S.row2}>
          <div style={{ width: 110 }}>
            <label style={S.label}>Minutes</label>
            <input style={S.input} value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} placeholder="30" inputMode="numeric" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>The one-line insight</label>
            <input style={S.input} value={insight} onChange={(e) => setInsight(e.target.value)} placeholder="e.g. shrink window while duplicate exists" />
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button className="ghost" style={{ ...S.ghost, flex: 1 }} onClick={onClose}>Cancel</button>
          <button className="primary" style={{ ...S.primary, flex: 2, opacity: valid ? 1 : 0.4 }}
            disabled={!valid}
            onClick={() => onSave({ name: name.trim(), category, difficulty, outcome, minutes: minutes ? parseInt(minutes, 10) : null, insight: insight.trim() })}>
            Save — review in {LADDER[outcome === "cold" ? 1 : 0]} days
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Styles ----------
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
* { box-sizing: border-box; }
body { margin: 0; background: #0E1116; }
button { cursor: pointer; font-family: inherit; }
.navBtn:hover { color: #E8EAED !important; }
.primary:hover { filter: brightness(1.1); }
.ghost:hover { border-color: #4FB8A8 !important; color: #4FB8A8 !important; }
.outcomeBtn:hover { filter: brightness(1.15); }
.card { transition: border-color .15s; }
.card:hover { border-color: #333C49 !important; }
input:focus, select:focus { outline: 2px solid #4FB8A8; outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const mono = "'IBM Plex Mono', monospace";
const disp = "'Space Grotesk', sans-serif";

const S = {
  app: { minHeight: "100vh", background: "#0E1116", color: "#B8BFC9", fontFamily: mono, fontSize: 13, padding: "28px 20px 60px", maxWidth: 860, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", marginBottom: 24 },
  eyebrow: { fontSize: 10, letterSpacing: "0.2em", color: "#E8A33D", marginBottom: 6 },
  title: { fontFamily: disp, fontWeight: 700, fontSize: 34, color: "#E8EAED", margin: 0, letterSpacing: "-0.02em" },
  headerStats: { display: "flex", gap: 22 },
  statVal: { fontFamily: disp, fontSize: 22, fontWeight: 700 },
  statLabel: { fontSize: 10, letterSpacing: "0.15em", color: "#5C6572", textTransform: "uppercase" },
  nav: { display: "flex", gap: 4, alignItems: "center", borderBottom: "1px solid #1E242D", paddingBottom: 12, marginBottom: 20, flexWrap: "wrap" },
  navBtn: { background: "none", border: "none", color: "#8B93A1", fontFamily: mono, fontSize: 12, padding: "8px 12px" },
  navBtnActive: { color: "#E8A33D", borderBottom: "2px solid #E8A33D" },
  primary: { background: "#E8A33D", color: "#0E1116", border: "none", borderRadius: 6, padding: "9px 16px", fontFamily: disp, fontWeight: 700, fontSize: 13 },
  ghost: { background: "none", border: "1px solid #2A313C", borderRadius: 6, color: "#B8BFC9", padding: "8px 14px", fontFamily: mono, fontSize: 12, whiteSpace: "nowrap", alignSelf: "center" },
  hint: { fontSize: 12, color: "#5C6572", margin: "0 0 16px", lineHeight: 1.6 },
  empty: { border: "1px dashed #2A313C", borderRadius: 10, padding: "36px 28px", color: "#8B93A1", lineHeight: 1.7, textAlign: "center", maxWidth: 520, margin: "40px auto" },
  card: { display: "flex", gap: 16, background: "#151A21", border: "1px solid #1E242D", borderRadius: 10, padding: "16px 18px", marginBottom: 10, flexWrap: "wrap" },
  cardTop: { display: "flex", alignItems: "center", gap: 10, marginBottom: 5 },
  cardName: { fontFamily: disp, fontWeight: 500, fontSize: 15, color: "#E8EAED", overflow: "hidden", textOverflow: "ellipsis" },
  cardMeta: { fontSize: 11, color: "#5C6572" },
  insight: { fontSize: 12, color: "#4FB8A8", marginTop: 7, fontStyle: "italic" },
  badge: (d) => ({
    fontSize: 9, letterSpacing: "0.1em", padding: "3px 7px", borderRadius: 4, textTransform: "uppercase", flexShrink: 0,
    background: d === "Hard" ? "#3A2230" : d === "Medium" ? "#33290F" : "#16302B",
    color: d === "Hard" ? "#E88AAB" : d === "Medium" ? "#E8A33D" : "#4FB8A8",
  }),
  ladder: { display: "flex", gap: 5, marginTop: 10, alignItems: "center" },
  dot: { minWidth: 14, height: 14, borderRadius: 7, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#0E1116", fontWeight: 700, padding: "0 3px" },
  outcomeCol: { display: "flex", flexDirection: "column", gap: 6, justifyContent: "center" },
  outcome: (k) => ({
    border: "none", borderRadius: 6, padding: "8px 12px", fontFamily: mono, fontSize: 11, fontWeight: 500,
    background: k === "cold" ? "#16302B" : k === "subopt" ? "#242038" : k === "hints" ? "#33290F" : "#3A2230",
    color: k === "cold" ? "#4FB8A8" : k === "subopt" ? "#A99BE8" : k === "hints" ? "#E8A33D" : "#E88AAB",
  }),
  overdue: { fontSize: 9, letterSpacing: "0.1em", padding: "3px 7px", borderRadius: 4, textTransform: "uppercase", flexShrink: 0, background: "#3A2230", color: "#E88AAB" },
  timeTrend: { fontSize: 11, color: "#8B93A1", marginTop: 7 },
  patternRow: { display: "flex", alignItems: "center", gap: 14, padding: "11px 4px", borderBottom: "1px solid #1E242D" },
  patternName: { width: 200, fontSize: 12, color: "#B8BFC9", flexShrink: 0 },
  barTrack: { flex: 1, height: 8, background: "#1A2028", borderRadius: 4, overflow: "hidden" },
  barFill: { height: "100%", background: "linear-gradient(90deg, #4FB8A8, #E8A33D)", borderRadius: 4, transition: "width .3s" },
  patternCount: { width: 76, textAlign: "right", fontSize: 11, color: "#5C6572", flexShrink: 0 },
  overlay: { position: "fixed", inset: 0, background: "rgba(8,10,14,0.75)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 },
  modal: { background: "#151A21", border: "1px solid #2A313C", borderRadius: 12, padding: 24, width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto" },
  modalTitle: { fontFamily: disp, fontSize: 20, color: "#E8EAED", margin: "0 0 18px" },
  label: { display: "block", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "#5C6572", margin: "14px 0 6px" },
  input: { width: "100%", background: "#0E1116", border: "1px solid #2A313C", borderRadius: 6, color: "#E8EAED", padding: "10px 12px", fontFamily: mono, fontSize: 13 },
  row2: { display: "flex", gap: 12 },
};
