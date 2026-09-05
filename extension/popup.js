// Logs the question you're on straight into your tracker.
//
// The rules are NOT reimplemented here — lib/schedule.js, lib/problems.js, and
// lib/techniques.js are copies of the app's own modules, synced by
// `npm run ext:sync`. A solve is just an attempt appended to the log; the
// technique it exercises picks it up the next time the table is derived, so
// the popup can say exactly what the solve did to that technique's tier.
//
// Extension pages with host permission are exempt from CORS, so this talks to
// /api/state directly. Basic auth is sent only if a password was configured
// in options — most trackers run unauthenticated on a private network.

import {
  CATEGORIES, OUTCOMES, TIERS_SERVED, CLIMB_STREAK,
  parseProblemUrl, findExisting, newProblem, logAttempt, migrate,
} from "./lib/schedule.js";
import { techniqueOf, lookupEntry, deriveTechniques, buildPlan, TECHNIQUE_LABELS } from "./lib/techniques.js";

// A site that doesn't publish problems at …/questions/<slug> usually still
// names the problem in the tab title ("Practice: <name> | Tasks | Somewhere").
// Take the first title segment, drop a leading label, and keep the page's own
// URL as the permanent link. Only for the host set in options, so opening the
// popup anywhere else never offers to log a page that isn't a problem.
function parseTitledProblem(url, title, host) {
  if (!host) return null;
  let u;
  try { u = new URL(url || ""); } catch { return null; }
  if (u.hostname !== host.replace(/^www\./, "") && u.hostname !== `www.${host}`) return null;
  const name = (title || "").split("|")[0].replace(/^[^:]{1,32}:\s*/, "").trim();
  if (!name || name.length > 120) return null;
  return { url: u.origin + u.pathname.replace(/\/$/, ""), name };
}

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);

const status = (msg, cls = "") => { $("status").className = cls; $("status").textContent = msg; };

let ctx = null; // { settings, rev, problems, parsed, existing, catalogEntry }

const api = (settings, path, init = {}) =>
  fetch(`${settings.baseUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      // Only sent when a password is stored — most trackers run on a
      // private network with none set.
      ...(settings.password ? { Authorization: "Basic " + btoa(":" + settings.password) } : {}),
    },
  });

async function loadSettings() {
  const { baseUrl, password, problemHost } = await chrome.storage.local.get(["baseUrl", "password", "problemHost"]);
  if (!baseUrl) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), password: password || "", problemHost: problemHost || "" };
}

// Reading the log is the only way to know whether this problem is already
// tracked. If the read fails we refuse to write — the same rule the web app
// follows, and for the same reason: a blind POST would clobber a real log.
//
// The revision we read is echoed back on write. If the log moved on in between —
// a web tab saved, another popup saved — the server rejects us rather than let
// this popup overwrite work it never saw.
async function fetchState(settings) {
  const res = await api(settings, "/api/state");
  if (res.status === 401) throw new Error("Wrong password — check your settings.");
  if (!res.ok) throw new Error(`Tracker returned HTTP ${res.status}.`);
  const state = await res.json();
  return { rev: state?.rev ?? 0, problems: (state?.problems ?? []).map(migrate) };
}

// The technique this problem exercises, with its current mastery — the thing
// an outcome here will actually move.
function techFor(problems, pseudo) {
  const t = techniqueOf(pseudo);
  return deriveTechniques(problems).find((row) => row.key === t.key) ?? null;
}

function describe(existing, tech, label, cataloged) {
  const el = $("state");
  show("state", true);
  el.className = "state";

  const solved = existing
    ? `Solved before (${existing.history.map((h) => OUTCOMES[h].short).join(" → ")}). Logging adds another attempt.`
    : "Never attempted — exactly what the technique wants.";
  const what = cataloged ? `Exercises <b>${label}</b>` : "Not in the catalog — <b>stands on its own</b>";

  if (tech?.leech) {
    el.className = "state leech";
    el.innerHTML = `<b>“${label}” is a leech</b> — it keeps failing.
      Study a worked solution and rewrite it from memory; log that honestly as “needed hints”.<br />${solved}`;
    return;
  }
  if (!tech || !tech.started) {
    el.innerHTML = `${what} — first time with this move. Read a worked solution, then rewrite it
      from a blank file and log that as “needed hints”; it doesn't count against you.`;
    return;
  }
  // Nothing here is due: the tier says how hard a disguise this technique has
  // earned, and the gap says how much it wants a rep.
  const gap = tech.staleDays === 0 ? "exercised today"
    : `${tech.staleDays} day${tech.staleDays === 1 ? "" : "s"} since you exercised it`;
  el.className = tech.streak ? "state bonus" : "state";
  el.innerHTML = `${what} · tier <b>${TIERS_SERVED[tech.tier]}</b> ·
    ${tech.streak}/${CLIMB_STREAK} clean days toward the next · ${gap}.<br />${solved}`;
}

function renderOutcomes() {
  const wrap = $("outcomes");
  wrap.textContent = "";
  for (const [key, o] of Object.entries(OUTCOMES)) {
    const b = document.createElement("button");
    b.className = `o-${key}`;
    b.textContent = o.label;
    b.addEventListener("click", () => save(key));
    wrap.appendChild(b);
  }
}

async function save(outcome) {
  const { settings, rev, problems, parsed, existing, catalogEntry } = ctx;
  document.querySelectorAll("#outcomes button").forEach((b) => (b.disabled = true));
  status("Saving…");

  const insight = $("insight").value.trim();
  const raw = existing ? $("minutes").value : $("minutesNew").value;
  const minutes = raw.trim() ? parseInt(raw, 10) : null;
  // The two blind-rep fields: which move was reached for, and when it was
  // clear. Optional here as everywhere — an empty field is stored as null.
  const guess = $("guess").value.trim() || null;
  const knewRaw = $("knew").value.trim();
  const knew = knewRaw ? parseInt(knewRaw, 10) : null;

  const updated = existing
    ? { ...logAttempt(existing, outcome, minutes, { guess, knew }), insight: insight || existing.insight }
    : newProblem({
        name: parsed.name, url: parsed.url, insight,
        category: $("category").value, difficulty: $("difficulty").value,
        outcome, minutes, guess, knew,
      });

  const next = existing
    ? problems.map((p) => (p.id === existing.id ? updated : p))
    : [updated, ...problems];

  try {
    const res = await api(settings, "/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rev, problems: next }),
    });
    if (res.status === 409) {
      status("Your log changed somewhere else since this popup opened. Nothing was saved — close and reopen to try again.", "err");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Re-derive the technique with the new attempt in it, so the confirmation
    // describes what the solve actually did — including the name of the move,
    // which the blind rep was hiding until now.
    const tech = techFor(next, updated);
    if (tech?.started) {
      const label = catalogEntry ? `“${tech.label}”` : "Uncataloged — stands on its own";
      const climb = tech.streak ? `${tech.streak}/${CLIMB_STREAK} clean days toward the next` : "streak reset";
      status(`Logged. ${label}: tier ${TIERS_SERVED[tech.tier]}, ${climb}.`, "ok");
    } else {
      status("Logged.", "ok");
    }
    show("form", false);
    show("state", false);
  } catch (e) {
    status(`Save failed: ${e.message}. Nothing was changed.`, "err");
    document.querySelectorAll("#outcomes button").forEach((b) => (b.disabled = false));
  }
}

async function init() {
  const settings = await loadSettings();
  if (!settings) {
    show("setup");
    $("setupMsg").textContent = "Point the extension at your tracker (password only if it has one).";
    return;
  }

  // Host permission is requested in options, but the user may have revoked it.
  const origin = new URL(settings.baseUrl).origin + "/*";
  if (!(await chrome.permissions.contains({ origins: [origin] }))) {
    show("setup");
    $("setupMsg").textContent = `This extension isn't allowed to talk to ${settings.baseUrl} yet.`;
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const parsed = parseProblemUrl(tab?.url || "")
    ?? parseTitledProblem(tab?.url, tab?.title, settings.problemHost);

  status("Reading your log…");
  const { rev, problems } = await fetchState(settings);

  // Not on a problem page: show the ranked session instead.
  if (!parsed) { status(""); return renderQueue(problems); }

  const existing = findExisting(problems, parsed);
  const catalogEntry = lookupEntry(parsed);
  ctx = { settings, rev, problems, parsed, existing, catalogEntry };

  $("name").textContent = existing?.name || parsed.name;
  $("url").textContent = parsed.url;
  $("insight").value = existing?.insight || "";
  $("guess").value = "";
  $("knew").value = "";
  const list = $("technique-labels");
  if (!list.children.length) {
    for (const label of TECHNIQUE_LABELS) {
      const o = document.createElement("option");
      o.value = label;
      list.appendChild(o);
    }
  }

  const pseudo = existing ?? { ...parsed, category: catalogEntry?.category ?? CATEGORIES[0] };
  const tech = techFor(problems, pseudo);
  const ownEntry = catalogEntry ?? (existing && lookupEntry(existing)) ?? null;
  describe(existing, tech, ownEntry?.technique ?? pseudo.name, !!ownEntry);

  if (existing) {
    show("reviewFields");
  } else {
    const sel = $("category");
    CATEGORIES.forEach((c) => sel.add(new Option(c, c)));
    // The catalog already knows where this problem files — prefill it.
    if (catalogEntry) {
      sel.value = catalogEntry.category;
      $("difficulty").value = catalogEntry.difficulty;
    }
    show("newFields");
  }

  renderOutcomes();
  show("form");
  status("");
}

// The session: the top of the ranking, each row linking the problem it
// serves. The rep is BLIND, so a row names the PROBLEM, never the technique —
// seeing "monotonic stack" here would hand you the answer before you opened
// the tab. Intro and study rows are the exception: their whole point is to
// read the move, so they say which one.
// Skips (device-local to the web app) aren't visible here, so a technique the
// app shows as skipped still lists — the safe direction.
const QUEUE_MIN = 300; // not sizing a session, just taking the top of the list
const QUEUE_ROWS = 10;

function renderQueue(problems) {
  const items = buildPlan(deriveTechniques(problems), QUEUE_MIN, {}).items;
  const wrap = $("queueList");
  wrap.textContent = "";
  $("queueTitle").textContent = items.length
    ? `Up next: ${items.length} problem${items.length === 1 ? "" : "s"}`
    : "Nothing ranked yet — log a solve to start";
  for (const { tech, serve, est } of items.slice(0, QUEUE_ROWS)) {
    const row = document.createElement("div");
    row.className = "qrow";
    const label = document.createElement("div");
    label.className = "qtech";
    label.textContent = serve.mode === "intro" ? `new — ${tech.label}`
      : serve.mode === "study" ? `study — ${tech.label}`
      : `${est}m`;
    const a = document.createElement("a");
    a.href = serve.problem.url || "#";
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `${serve.problem.name} (${serve.problem.difficulty ?? "?"})`;
    row.append(label, a);
    wrap.appendChild(row);
  }
  if (items.length > QUEUE_ROWS) {
    const more = document.createElement("div");
    more.className = "qtech";
    more.textContent = `…and ${items.length - QUEUE_ROWS} more in the tracker`;
    wrap.appendChild(more);
  }
  show("queue");
}

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

init().catch((e) => {
  show("form", false);
  status(`${e.message}`, "err");
});
