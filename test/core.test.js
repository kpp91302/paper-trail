const assert = require("assert");
const C = require("../core.js");
// applyOps: ratings, downloads, toggles, notes, overrides
let u = C.applyOps(null, [
  { op: "rate", id: "a", value: 8, at: "t1" },
  { op: "download", id: "a", at: "t2" },
  { op: "download", id: "a", at: "t3" },
  { op: "save", id: "b", value: true, at: "t4" },
  { op: "skip", id: "c", value: true, at: "t5" },
  { op: "note", id: "a", value: "  good proof  ", at: "t6" },
  { op: "override", list: "boost", action: "add", term: "Edge of stability" },
  { op: "override", list: "boost", action: "add", term: "edge of stability" },
  { op: "override", list: "block", action: "add", term: "benchmarks" },
]);
assert.strictEqual(u.papers.a.rating, 8);
assert.strictEqual(u.papers.a.downloads, 2);
assert.strictEqual(u.papers.a.firstDownload, "t2");
assert.strictEqual(u.papers.a.lastDownload, "t3");
assert.strictEqual(u.papers.b.saved, true);
assert.strictEqual(u.papers.c.skipped, true);
assert.deepStrictEqual(u.profileOverrides.boost, ["Edge of stability"]);
assert.deepStrictEqual(u.profileOverrides.block, ["benchmarks"]);
// clearing
u = C.applyOps(u, [{ op: "rate", id: "a", value: 0 }, { op: "save", id: "b", value: false }, { op: "note", id: "a", value: "" }, { op: "override", list: "block", action: "remove", term: "BENCHMARKS" }]);
assert.strictEqual(u.papers.a.rating, undefined);
assert.strictEqual(u.papers.b.saved, false);
assert.strictEqual(u.papers.a.note, undefined);
assert.deepStrictEqual(u.profileOverrides.block, []);
// does not mutate input
const before = JSON.stringify(u); C.applyOps(u, [{ op: "rate", id: "z", value: 3 }]); assert.strictEqual(JSON.stringify(u), before);
// parseRunPath
assert.deepStrictEqual(C.parseRunPath("papers/2026-11-18-eos.json"), { date: "2026-11-18", feed: "eos", seq: 1 });
assert.deepStrictEqual(C.parseRunPath("papers/2026-11-18-daily-2.json"), { date: "2026-11-18", feed: "daily", seq: 2 });
const bf = C.mergeRuns([{ feed: "weekly", date: "2026-11-18", seq: 1, papers: [{ id: "q", title: "Q", summary: "", needsSummary: true }] }, { feed: "weekly", date: "2026-11-25", seq: 1, papers: [{ id: "q", title: "Q", summary: "Full.", needsSummary: false, worth: { score: 6 } }] }]);
assert.strictEqual(bf.get("q").needsSummary, false); assert.strictEqual(bf.get("q").summary, "Full.");
assert.strictEqual(C.parseRunPath("papers/notes.json"), null);
// mergeRuns
const m = C.mergeRuns([
  { feed: "weekly", date: "2026-11-11", papers: [{ id: "x", title: "X", rank: 1, worth: { score: 7 } }] },
  { feed: "eos", date: "2026-11-11", papers: [{ id: "x", title: "X", rank: 2, worth: { score: 9 }, topPick: true }, { id: "y", title: "Y", rank: 1 }] },
]);
assert.strictEqual(m.size, 2);
assert.deepStrictEqual(m.get("x").feeds.sort(), ["eos", "weekly"]);
assert.strictEqual(m.get("x").appearances.length, 2);
assert.strictEqual(m.get("x").worth.score, 7); // weekly sorts after eos alphabetically on same date
assert.strictEqual(m.get("x").topPick, true);
// calibration
const cal = C.calibration(m, { papers: { x: { rating: 9 } } });
assert.strictEqual(cal.pts.length, 1); assert.strictEqual(cal.mae, 2);
assert.ok(Math.abs(C.pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);
console.log("core tests passed");
