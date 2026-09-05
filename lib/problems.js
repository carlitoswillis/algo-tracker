// The problem catalog: the pools the technique scheduler draws from.
//
// The rows themselves live outside the source tree, in
// <ALGO_DATA_DIR>/catalog.json (see lib/data-dir.js). This module is the
// meaning laid over them — how an entry is normalised, which entries can be
// served, and how a logged problem is matched back to one. Nothing here enters
// your log until you actually attempt and log it.
//
// Each entry is filed under the tracker's broad pattern taxonomy (CATEGORIES)
// and, in `technique`, the fine-grained move it actually exercises — the unit
// the tracker schedules. The broad buckets hide real differences: "Graphs
// (BFS/DFS)" spans flood fill, Dijkstra, and union-find, and being fluent in
// one says nothing about the others. Tags are judgment calls; edit freely.
//
// Two kinds of entry:
//   curated: true   a problem you tagged yourself. Always in its technique's
//                   pool, and matched by canonical URL first, name second.
//   curated: false  a bulk-imported library. Pooled when it carries an exact
//                   technique; otherwise it is only the pattern-level reserve.
//   seen: true      already done elsewhere — mapped for logging, never served
//                   as "never attempted".
//
// Synced into extension/lib/ by `npm run ext:sync` (with schedule.js and
// techniques.js) so the popup can name the technique a logged solve advanced.

import { titleFromSlug, CATEGORIES, parseProblemUrl } from "./schedule.js";
import { CATALOG_DATA } from "./problem-data.js";

// Four tiers, easiest first. The plan builder steps a pattern up this ladder
// only as the pattern earns it.
export const TIERS = ["Easy", "Medium", "Hard", "Very Hard"];

// Where an entry with no `url` of its own is opened. `{name}` is the problem
// name, URL-encoded; `{slug}` is its kebab-case form. Set it in catalog.json,
// or override it with ALGO_LINK_TEMPLATE.
export const LINK_TEMPLATE = CATALOG_DATA.linkTemplate || null;

// A URL that names the library rather than any one problem — matching a
// logged problem against it would identify nothing, so lookups skip it.
export const LIBRARY_URL = CATALOG_DATA.libraryUrl
  || (LINK_TEMPLATE ? LINK_TEMPLATE.split(/[?#{]/)[0] : null);

const slugify = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const linkFor = (name) => (LINK_TEMPLATE && name
  ? LINK_TEMPLATE.replace(/\{name\}/g, encodeURIComponent(name)).replace(/\{slug\}/g, slugify(name))
  : null);

// The label a problem is filed under in the browsable library: whatever the
// entry declares, else the host it lives on. Nothing is hard-coded, so a
// catalog of your own reads with your own sites' names.
export const hostLabel = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
};
export const sourceOf = (e) => e?.source || hostLabel(e?.url) || "unlisted";

function normalise(raw, i) {
  const name = String(raw?.name ?? "").trim();
  const where = `catalog.json entry ${i + 1}${name ? ` (“${name}”)` : ""}`;
  if (!name) throw new Error(`${where} has no name`);
  if (!CATEGORIES.includes(raw.category)) throw new Error(`${where} has unknown pattern “${raw.category}”`);
  if (!TIERS.includes(raw.difficulty)) throw new Error(`${where} has unknown tier “${raw.difficulty}”`);
  const technique = typeof raw.technique === "string" && raw.technique.trim() ? raw.technique.trim() : null;
  if (raw.curated && !technique) throw new Error(`${where} is curated but missing its technique tag`);
  return {
    name,
    url: raw.url || linkFor(name),
    category: raw.category,
    difficulty: raw.difficulty,
    technique,
    curated: !!raw.curated,
    seen: !!raw.seen,
    source: raw.source || null,
  };
}

// A malformed entry would quietly break the plan builder's filtering, so shout
// at load time rather than mid-render.
export const ENTRIES = (CATALOG_DATA.problems ?? []).map(normalise);

// The hand-tagged pool, and the bulk-imported one behind it.
export const CATALOG = ENTRIES.filter((e) => e.curated);
export const LIBRARY = ENTRIES.filter((e) => !e.curated);

// The log stores only the broad pattern; the fine-grained technique lives here.
// To know what a tracked problem actually drills, find its own catalog entry —
// canonical URL first, then name, mirroring findExisting. Problems logged from
// outside the catalog simply have no entry, and no technique.
export const entryFor = (p) => {
  const u = parseProblemUrl(p.url)?.url;
  const n = (p.name || "").trim().toLowerCase();
  return CATALOG.find((c) => (u && c.url === u) || c.name.toLowerCase() === n) || null;
};
