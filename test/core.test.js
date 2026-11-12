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
// assigned readings
assert.deepStrictEqual(C.parseRunPath("papers/2026-11-13-assigned.json"), { date: "2026-11-13", feed: "assigned", seq: 1 });
assert.strictEqual(C.parseInboxPath("inbox/up-20261112-convex-analysis-ch-3.json"), "up-20261112-convex-analysis-ch-3");
assert.strictEqual(C.parseInboxPath("inbox/../x.json"), null);
assert.strictEqual(C.idForReading("Anything", "https://arxiv.org/abs/2611.08358v2", "2026-11-12"), "ax-2611-08358");
assert.strictEqual(C.idForReading("Anything", "https://arxiv.org/pdf/2611.08358", "2026-11-12"), "ax-2611-08358");
assert.strictEqual(C.idForReading("Nesterov's Lectures: Ch. 2 (Smooth Convex Optimization)", "", "2026-11-12"), "up-20261112-nesterov-s-lectures-ch-2-smooth-convex-optimizat");
assert.ok(/^[a-z0-9-]+$/.test(C.idForReading("Über café — ünïcode!!", "", "2026-11-12")));
let t2 = C.applyOps(null, [{ op: "teach", id: "a", value: true }]); assert.strictEqual(t2.papers.a.teach, true);
t2 = C.applyOps(t2, [{ op: "teach", id: "a", value: false }]); assert.strictEqual(t2.papers.a.teach, false);
t2 = C.applyOps(t2, [{ op: "teach", id: "a", value: null }]); assert.strictEqual(t2.papers.a.teach, undefined);
assert.strictEqual(C.unwrapLink("https://nam04.safelinks.protection.outlook.com/?url=https%3A%2F%2Falready-clean.goodfire.com%2F&data=05%7Cx%40vt.edu&reserved=0"), "https://already-clean.goodfire.com/");
assert.strictEqual(C.unwrapLink("https://www.google.com/url?q=https://arxiv.org/abs/2611.13560&source=gmail"), "https://arxiv.org/abs/2611.13560");
assert.strictEqual(C.unwrapLink("https://arxiv.org/abs/2611.13560"), "https://arxiv.org/abs/2611.13560");
assert.strictEqual(C.idForReading("x", "https://arxiv.org/html/2610.15223", "2026-11-12"), "ax-2610-15223");
console.log("core tests passed");
