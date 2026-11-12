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
// authors
assert.strictEqual(C.authorKey("László A. Végh"), "laszlo a vegh");
assert.strictEqual(C.authorKey("Laszlo A Vegh"), "laszlo a vegh");
assert.deepStrictEqual(C.authorWeights(3), [1, 1, 1]);
assert.deepStrictEqual(C.authorWeights(6), [1, 0.5, 0.5, 0.5, 0.5, 1]);
const ap = new Map([
  ["p1", { id: "p1", title: "P1", feeds: ["eos"], lastSeen: "2026-11-11", authorList: ["Sinho Chewi", "Eric Regis"] }],
  ["p2", { id: "p2", title: "P2", feeds: ["weekly"], lastSeen: "2026-11-12", authorList: ["Sinho Chewi"] }],
  ["p3", { id: "p3", title: "P3", feeds: ["assigned"], lastSeen: "2026-11-12", authorList: ["Sinho Chewi"] }],
  ["p4", { id: "p4", title: "P4", feeds: ["daily"], lastSeen: "2026-11-12", authors: "No List" }],
]);
const au = { papers: { p1: { rating: 9 }, p2: { rating: 7 }, p3: { rating: 2 } } };
let st = C.authorStats(ap, au);
let chewi = st.byKey.get("sinho chewi");
assert.strictEqual(chewi.rated, 3); assert.strictEqual(chewi.papers.length, 3);
assert.ok(Math.abs(chewi.avg - 6) < 1e-9);
assert.strictEqual(st.byKey.get("eric regis").avg, null); // only 1 rating
st = C.authorStats(ap, au, { forRecs: true });           // assigned p3 excluded without teach
chewi = st.byKey.get("sinho chewi"); assert.strictEqual(chewi.rated, 2); assert.ok(Math.abs(chewi.avg - 8) < 1e-9);
assert.ok(Math.abs(chewi.adjusted - 8) < 1e-9); // overall mean is also 8, so no pull
{ const s2 = C.authorStats(ap, { papers: { p1: { rating: 10 }, p2: { rating: 10 }, p4x: {} } }); }
{ const m2 = new Map([...ap, ["p5", { id: "p5", title: "P5", feeds: ["daily"], lastSeen: "2026-11-12", authorList: ["Low Author"] }], ["p6", { id: "p6", title: "P6", feeds: ["daily"], lastSeen: "2026-11-12", authorList: ["Low Author"] }]]);
  const s3 = C.authorStats(m2, { papers: { p1: { rating: 10 }, p2: { rating: 10 }, p5: { rating: 2 }, p6: { rating: 2 } } });
  const hi = s3.byKey.get("sinho chewi"), lo = s3.byKey.get("low author");
  assert.ok(hi.adjusted < hi.avg && lo.adjusted > lo.avg); }
st = C.authorStats(ap, { papers: { ...au.papers, p3: { rating: 2, teach: true } } }, { forRecs: true });
assert.strictEqual(st.byKey.get("sinho chewi").rated, 3);
assert.strictEqual(st.authors.length, 2); // p4 has no full list, so it is not counted
// meta + archive
const mp = new Map([["p4", { id: "p4", authors: "No List" }]]);
C.applyMeta(mp, [{ id: "p4", authorList: ["A B", "C D"], authors: "A B, C D", summary: "ignored" }, { id: "zz", authorList: ["x"] }]);
assert.deepStrictEqual(mp.get("p4").authorList, ["A B", "C D"]); assert.strictEqual(mp.get("p4").summary, undefined);
const ar = C.runsFromArchive({ month: "2026-08", runs: [{ feed: "daily", date: "2026-08-01", papers: [{ id: "k", title: "K" }] }], hidden: [{ id: "h" }] });
assert.strictEqual(ar.length, 1); assert.strictEqual(ar[0].archived, true);
console.log("core tests passed");
