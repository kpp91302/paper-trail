// Pure data logic for Paper Trail. No DOM, no network: shared by the site and its tests.
(function (root) {
  "use strict";

  const RUN_FILE = /^papers\/(\d{4}-\d{2}-\d{2})-(daily|weekly|eos)(?:-(\d+))?\.json$/;

  function emptyUser() {
    return { version: 1, papers: {}, profileOverrides: { boost: [], block: [] } };
  }

  function normalizeUser(u) {
    const out = u && typeof u === "object" ? JSON.parse(JSON.stringify(u)) : emptyUser();
    if (!out.papers || typeof out.papers !== "object") out.papers = {};
    if (!out.profileOverrides) out.profileOverrides = { boost: [], block: [] };
    if (!Array.isArray(out.profileOverrides.boost)) out.profileOverrides.boost = [];
    if (!Array.isArray(out.profileOverrides.block)) out.profileOverrides.block = [];
    out.version = 1;
    return out;
  }

  // Apply queued user actions to a user-state object. Each op is applied once,
  // on top of the freshest copy fetched from the repo, so two devices never
  // overwrite each other's ratings.
  function applyOps(user, ops) {
    const u = normalizeUser(user);
    for (const op of ops || []) {
      const at = op.at || new Date().toISOString();
      if (op.op === "override") {
        const list = u.profileOverrides[op.list === "block" ? "block" : "boost"];
        const term = String(op.term || "").trim();
        if (!term) continue;
        const i = list.findIndex((t) => t.toLowerCase() === term.toLowerCase());
        if (op.action === "add" && i < 0) list.push(term);
        if (op.action === "remove" && i >= 0) list.splice(i, 1);
        continue;
      }
      if (!op.id) continue;
      const p = u.papers[op.id] || (u.papers[op.id] = {});
      switch (op.op) {
        case "rate":
          if (op.value >= 1 && op.value <= 10) { p.rating = Math.round(op.value); p.ratedAt = at; }
          else { delete p.rating; delete p.ratedAt; }
          break;
        case "download":
          p.downloads = (p.downloads || 0) + 1;
          p.firstDownload = p.firstDownload || at;
          p.lastDownload = at;
          break;
        case "open":
          p.opens = (p.opens || 0) + 1;
          p.lastOpen = at;
          break;
        case "save":
          p.saved = !!op.value;
          if (p.saved) p.savedAt = at; else delete p.savedAt;
          break;
        case "skip":
          p.skipped = !!op.value;
          if (p.skipped) p.skippedAt = at; else delete p.skippedAt;
          break;
        case "note":
          if (op.value && String(op.value).trim()) p.note = String(op.value).slice(0, 4000);
          else delete p.note;
          break;
        default:
          continue;
      }
      p.updatedAt = at;
    }
    return u;
  }

  function parseRunPath(path) {
    const m = RUN_FILE.exec(path);
    return m ? { date: m[1], feed: m[2], seq: m[3] ? Number(m[3]) : 1 } : null;
  }

  // Merge run files into one record per paper. A paper sent by two digests keeps
  // one card that lists both; its latest appearance supplies summary and score.
  function mergeRuns(runs) {
    const map = new Map();
    const sorted = [...runs].sort((a, b) => a.date.localeCompare(b.date) || (a.seq || 1) - (b.seq || 1) || a.feed.localeCompare(b.feed));
    for (const run of sorted) {
      for (const raw of run.papers || []) {
        if (!raw || !raw.id || !raw.title) continue;
        const prev = map.get(raw.id);
        const appearance = { feed: run.feed, date: run.date, rank: raw.rank || 0 };
        if (!prev) {
          map.set(raw.id, { ...raw, feeds: [run.feed], appearances: [appearance], firstSeen: run.date, lastSeen: run.date });
        } else {
          const merged = { ...prev, ...raw };
          merged.feeds = [...new Set([...prev.feeds, run.feed])];
          merged.appearances = [...prev.appearances, appearance];
          merged.firstSeen = prev.firstSeen;
          merged.lastSeen = run.date;
          merged.topPick = !!(prev.topPick || raw.topPick);
          map.set(raw.id, merged);
        }
      }
    }
    return map;
  }

  function pearson(xs, ys) {
    const n = xs.length; if (n < 3) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    if (!sxx || !syy) return null;
    return sxy / Math.sqrt(sxx * syy);
  }

  function calibration(papers, user) {
    const pts = [];
    for (const [id, p] of papers) {
      const r = user.papers[id] && user.papers[id].rating;
      const s = p.worth && Number(p.worth.score);
      if (r && s) pts.push({ id, score: s, rating: r });
    }
    const mae = pts.length ? pts.reduce((a, q) => a + Math.abs(q.score - q.rating), 0) / pts.length : null;
    return { pts, mae, r: pearson(pts.map((q) => q.score), pts.map((q) => q.rating)) };
  }

  const api = { RUN_FILE, emptyUser, normalizeUser, applyOps, parseRunPath, mergeRuns, calibration, pearson };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PTCore = api;
})(typeof window !== "undefined" ? window : globalThis);
