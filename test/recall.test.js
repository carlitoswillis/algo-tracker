// The recall rules in lib/recall.js, pinned: what is due, what retires, what
// a same-day change of mind does, and the shape of the history rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RECALL_EMPTY, dueItems, carryForward, recordResult, history, isValidRecall,
} from "../lib/recall.js";

const item = (id, side = "python") => ({ id, side, prompt: `prompt ${id}`, answer: `answer ${id}` });

const fixture = (log = []) => ({
  version: 1,
  items: [item("py-01"), item("py-02"), item("node-01", "node")],
  log,
});

const ids = (rows) => rows.map((r) => r.id);

test("never-attempted items are due, on their own side only", () => {
  const data = fixture();
  assert.deepEqual(ids(dueItems(data, "2026-10-03", "python")), ["py-01", "py-02"]);
  assert.deepEqual(ids(dueItems(data, "2026-10-03", "node")), ["node-01"]);
  const [first] = dueItems(data, "2026-10-03", "python");
  assert.equal(first.attemptedToday, false);
  assert.equal(first.todayResult, null);
});

test("one clean keeps an item due", () => {
  const data = fixture([{ date: "2026-10-01", id: "py-01", result: "clean" }]);
  assert.deepEqual(ids(dueItems(data, "2026-10-03", "python")), ["py-01", "py-02"]);
});

test("two consecutive cleans retire an item", () => {
  const data = fixture([
    { date: "2026-10-01", id: "py-01", result: "clean" },
    { date: "2026-10-02", id: "py-01", result: "clean" },
  ]);
  assert.deepEqual(ids(dueItems(data, "2026-10-03", "python")), ["py-02"]);
});

test("retirement follows date order, not file order", () => {
  const data = fixture([
    { date: "2026-10-02", id: "py-01", result: "clean" },
    { date: "2026-10-01", id: "py-01", result: "clean" },
    { date: "2026-09-30", id: "py-01", result: "miss" },
  ]);
  assert.deepEqual(ids(dueItems(data, "2026-10-03", "python")), ["py-02"]);
});

test("clean, miss, clean is still due", () => {
  const data = fixture([
    { date: "2026-10-01", id: "py-01", result: "clean" },
    { date: "2026-10-02", id: "py-01", result: "miss" },
    { date: "2026-10-03", id: "py-01", result: "clean" },
  ]);
  const due = dueItems(data, "2026-10-03", "python");
  assert.deepEqual(ids(due), ["py-01", "py-02"]);
  assert.equal(due[0].attemptedToday, true);
  assert.equal(due[0].todayResult, "clean");
  assert.equal(due[1].attemptedToday, false);
});

test("recordResult appends, replaces a same-day entry, and does not mutate its input", () => {
  const data = fixture([{ date: "2026-10-02", id: "py-02", result: "miss" }]);
  const before = JSON.stringify(data);

  const once = recordResult(data, { date: "2026-10-03", id: "py-01", result: "miss" });
  assert.equal(once.log.length, 2);
  assert.deepEqual(once.log[1], { date: "2026-10-03", id: "py-01", result: "miss" });

  const twice = recordResult(once, { date: "2026-10-03", id: "py-01", result: "clean" });
  assert.equal(twice.log.length, 2, "same date + id replaces rather than appends");
  assert.deepEqual(twice.log[1], { date: "2026-10-03", id: "py-01", result: "clean" });
  assert.equal(twice.log[0], once.log[0], "untouched entries are the same objects");

  assert.equal(JSON.stringify(data), before, "input untouched");
  assert.notEqual(once, data);
  assert.notEqual(once.log, data.log);
});

test("recordResult validates its entry", () => {
  const data = fixture();
  assert.throws(() => recordResult(data, { date: "2026-10-03", id: "py-01", result: "ok" }), /result/);
  assert.throws(() => recordResult(data, { date: "10/3", id: "py-01", result: "clean" }), /date/);
  assert.throws(() => recordResult(data, { date: "2026-10-03", id: "py-99", result: "clean" }), /no item/);
});

test("carryForward returns only items whose latest result is a miss, with the date", () => {
  const data = fixture([
    { date: "2026-10-01", id: "py-01", result: "miss" },
    { date: "2026-10-02", id: "py-01", result: "clean" },   // recovered: not carried
    { date: "2026-10-01", id: "py-02", result: "clean" },
    { date: "2026-10-02", id: "py-02", result: "miss" },    // latest is a miss: carried
    { date: "2026-10-02", id: "node-01", result: "miss" },  // other side
  ]);
  const rows = carryForward(data, "python");
  assert.deepEqual(rows.map((r) => [r.id, r.missedOn]), [["py-02", "2026-10-02"]]);
  assert.deepEqual(ids(carryForward(data, "node")), ["node-01"]);
  assert.deepEqual(carryForward(fixture(), "python"), []);
});

test("history returns N days oldest first with zeros for empty days", () => {
  const data = fixture([
    { date: "2026-10-01", id: "py-01", result: "clean" },
    { date: "2026-10-01", id: "py-02", result: "miss" },
    { date: "2026-10-01", id: "node-01", result: "miss" },
    { date: "2026-10-03", id: "py-01", result: "clean" },
    { date: "2026-09-20", id: "py-01", result: "miss" },   // outside the window
  ]);
  assert.deepEqual(history(data, 4, "2026-10-03"), [
    { date: "2026-09-30", clean: 0, miss: 0 },
    { date: "2026-10-01", clean: 1, miss: 2 },
    { date: "2026-10-02", clean: 0, miss: 0 },
    { date: "2026-10-03", clean: 1, miss: 0 },
  ]);
  assert.deepEqual(history(fixture(), 0, "2026-10-03"), []);
});

test("history steps across a month boundary", () => {
  assert.deepEqual(history(fixture(), 3, "2026-03-01").map((r) => r.date),
    ["2026-02-27", "2026-02-28", "2026-03-01"]);
});

test("isValidRecall accepts the empty file and refuses bad shapes", () => {
  assert.equal(isValidRecall(RECALL_EMPTY), true);
  assert.equal(isValidRecall(fixture([{ date: "2026-10-01", id: "py-01", result: "clean" }])), true);
  assert.equal(isValidRecall(null), false);
  assert.equal(isValidRecall({ version: 1, items: "nope", log: [] }), false);
  assert.equal(isValidRecall({ version: 1, items: [item("py-01", "ruby")], log: [] }), false);
  assert.equal(isValidRecall({ version: 1, items: [item("py-01"), item("py-01")], log: [] }), false);
  assert.equal(isValidRecall({ version: 1, items: [item("py-01")], log: [{ date: "2026-10-01", id: "py-09", result: "clean" }] }), false);
  assert.equal(isValidRecall({ version: 1, items: [item("py-01")], log: [{ date: "2026-10-01", id: "py-01", result: "meh" }] }), false);
});

// ---------- What the Recall tab leans on ----------
// The tab builds its queue and its "done today" line from these two facts;
// if either moves, the screen lies.

test("the drill queue is the due lines not yet typed today; a line typed today keeps its verdict", () => {
  const data = fixture([
    { date: "2026-10-03", id: "py-01", result: "miss" },
  ]);
  const due = dueItems(data, "2026-10-03", "python");
  const queue = due.filter((i) => !i.attemptedToday);
  assert.deepEqual(ids(queue), ["py-02"]);
  const typed = due.find((i) => i.id === "py-01");
  assert.equal(typed.todayResult, "miss", "today's miss is what the redo button starts from");
  assert.deepEqual(ids(carryForward(data, "python")), ["py-01"]);

  // Redo it clean: the same day's entry is replaced, the queue is unchanged,
  // and nothing is carried forward any more.
  const redone = recordResult(data, { date: "2026-10-03", id: "py-01", result: "clean" });
  assert.equal(redone.log.length, 1);
  assert.equal(dueItems(redone, "2026-10-03", "python").find((i) => i.id === "py-01").todayResult, "clean");
  assert.deepEqual(ids(dueItems(redone, "2026-10-03", "python").filter((i) => !i.attemptedToday)), ["py-02"]);
  assert.deepEqual(carryForward(redone, "python"), []);
});

test("a second clean today retires the line out of dueItems, so done-today must be read off the log", () => {
  const data = fixture([
    { date: "2026-10-02", id: "py-01", result: "clean" },
    { date: "2026-10-03", id: "py-01", result: "clean" },
  ]);
  const due = dueItems(data, "2026-10-03", "python");
  assert.deepEqual(ids(due), ["py-02"], "the retired line is gone from the due list");
  assert.equal(due.some((i) => i.attemptedToday), false, "so the due list alone would say nothing was typed today");
  const today = data.log.filter((e) => e.date === "2026-10-03");
  assert.deepEqual(today.map((e) => [e.id, e.result]), [["py-01", "clean"]]);
  assert.deepEqual(history(data, 1, "2026-10-03"), [{ date: "2026-10-03", clean: 1, miss: 0 }]);
});

test("an item may carry a note, and it must be text", () => {
  const base = { id: "py-01", side: "python", prompt: "p", answer: "a" };
  assert.equal(validateRecall({ version: 1, items: [{ ...base, note: "why it matters" }], log: [] }).ok, true);
  assert.equal(validateRecall({ version: 1, items: [base], log: [] }).ok, true);
  assert.equal(validateRecall({ version: 1, items: [{ ...base, note: 7 }], log: [] }).ok, false);
});
