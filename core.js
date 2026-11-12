// Pure data logic for Paper Trail. No DOM, no network: shared by the site and its tests.
(function (root) {
  "use strict";

  const RUN_FILE = /^papers\/(\d{4}-\d{2}-\d{2})-(daily|weekly|eos|assigned)(?:-(\d+))?\.json$/;
  const INBOX_FILE = /^inbox\/([a-z0-9-]+)\.json$/;
  const META_FILE = /^meta\/([a-z0-9-]+)\.json$/;
  const ARCHIVE_FILE = /^archive\/(\d{4}-\d{2})\.json$/;
  const AUTHOR_PRIOR = 2;      // pseudo-ratings pulling small samples toward your overall average
  const AUTHOR_MIN_RATED = 2;  // ratings needed before an author's average is shown

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
        case "teach":
          if (op.value === true || op.value === false) p.teach = op.value; else delete p.teach;
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

  // Same ID rule the scheduled runs use (SCHEMA.md), so an assigned arXiv paper
  // merges with the same paper if a digest ever sends it.
  function slug(text, max) {
    return String(text || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max || 60).replace(/-+$/g, "");
  }
  function idForReading(title, link, date) {
    const m = /arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/i.exec(link || "") || /huggingface\.co\/papers\/(\d{4}\.\d{4,5})/i.exec(link || "");
    if (m) return "ax-" + m[1].replace(".", "-");
    const s = slug(title, 48) || "reading";
    return "up-" + String(date || "").replace(/-/g, "") + "-" + s;
  }
  // Email clients wrap links in redirectors (Outlook Safe Links, Google) that
  // hide the real address and carry the recipient's email and tracking data.
  function unwrapLink(link) {
    let cur = String(link || "").trim();
    for (let i = 0; i < 3; i++) {
      let u; try { u = new URL(cur); } catch (e) { return cur; }
      const host = u.hostname.toLowerCase();
      let inner = null;
      if (host.endsWith("safelinks.protection.outlook.com")) inner = u.searchParams.get("url");
      else if ((host === "www.google.com" || host === "google.com") && u.pathname === "/url") inner = u.searchParams.get("q") || u.searchParams.get("url");
      else if (host === "urldefense.com" || host === "urldefense.proofpoint.com") inner = u.searchParams.get("u");
      if (!inner || !/^https?:\/\//i.test(inner)) return cur;
      cur = inner;
    }
    return cur;
  }
  function parseInboxPath(path) { const m = INBOX_FILE.exec(path); return m ? m[1] : null; }

  // ---------- corrections and archive ----------
  // meta/<id>.json lets a run fix or fill fields of an already-published paper
  // (today: the full author list) without editing an old run file.
  const META_FIELDS = ["authorList", "authors"];
  function applyMeta(papers, metas) {
    for (const m of metas || []) {
      const p = m && papers.get(m.id);
      if (!p) continue;
      for (const f of META_FIELDS) if (m[f] != null) p[f] = m[f];
    }
    return papers;
  }
  // archive/YYYY-MM.json keeps the papers worth keeping from run files older
  // than 90 days, in their original runs. "hidden" entries are removed papers
  // kept only as learning signal; the site never shows them.
  function runsFromArchive(doc) {
    return (doc && Array.isArray(doc.runs) ? doc.runs : [])
      .filter((r) => r && r.feed && r.date)
      .map((r) => ({ feed: r.feed, date: r.date, seq: r.seq || 1, overview: r.overview || "", papers: Array.isArray(r.papers) ? r.papers : [], archived: true }));
  }

  // ---------- authors ----------
  function authorKey(name) {
    return String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z\s-]/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
  }
  // Up to 5 authors: equal credit (theory papers are often alphabetical).
  // 6 or more: first and last full credit, everyone in between half.
  function authorWeights(n) {
    return Array.from({ length: n }, (_, i) => (n <= 5 || i === 0 || i === n - 1 ? 1 : 0.5));
  }
  function roleOf(i, n) { return n === 1 ? "sole" : i === 0 ? "first" : i === n - 1 ? "last" : "middle"; }
  function isAssignedOnly(p) { return (p.feeds || []).length > 0 && p.feeds.every((f) => f === "assigned"); }

  // forRecs: assigned-only papers count only when the reader chose "Use for recommendations: Yes".
  function authorStats(papers, user, opts) {
    const forRecs = !!(opts && opts.forRecs);
    const ups = (user && user.papers) || {};
    const counted = (p) => !forRecs || !isAssignedOnly(p) || (ups[p.id] || {}).teach === true;
    const allRatings = [];
    for (const p of papers.values()) { const r = (ups[p.id] || {}).rating; if (r && counted(p)) allRatings.push(r); }
    const mean = allRatings.length ? allRatings.reduce((a, b) => a + b, 0) / allRatings.length : 5.5;
    const map = new Map();
    for (const p of papers.values()) {
      const list = Array.isArray(p.authorList) ? p.authorList.filter((x) => authorKey(x)) : [];
      if (!list.length) continue;
      const w = authorWeights(list.length);
      const rating = (ups[p.id] || {}).rating;
      list.forEach((name, i) => {
        const key = authorKey(name);
        let a = map.get(key);
        if (!a) map.set(key, (a = { key, nameCounts: {}, papers: [], sumW: 0, sumWR: 0, rated: 0, lastSeen: "" }));
        a.nameCounts[name] = (a.nameCounts[name] || 0) + 1;
        if (a.papers.some((x) => x.id === p.id)) return;
        a.papers.push({ id: p.id, title: p.title, role: roleOf(i, list.length), weight: w[i], rating: rating || null, lastSeen: p.lastSeen || "" });
        if (p.lastSeen > a.lastSeen) a.lastSeen = p.lastSeen;
        if (rating && counted(p)) { a.sumW += w[i]; a.sumWR += w[i] * rating; a.rated++; }
      });
    }
    const out = [];
    for (const a of map.values()) {
      a.name = Object.entries(a.nameCounts).sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)[0][0];
      a.avg = a.rated >= AUTHOR_MIN_RATED ? a.sumWR / a.sumW : null;
      a.adjusted = a.rated ? (a.sumWR + AUTHOR_PRIOR * mean) / (a.sumW + AUTHOR_PRIOR) : null;
      a.papers.sort((x, y) => String(y.lastSeen).localeCompare(String(x.lastSeen)));
      delete a.nameCounts;
      out.push(a);
    }
    return { authors: out, mean, byKey: new Map(out.map((a) => [a.key, a])) };
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

  const api = { RUN_FILE, INBOX_FILE, META_FILE, ARCHIVE_FILE, AUTHOR_MIN_RATED, applyMeta, runsFromArchive, authorKey, authorWeights, authorStats, isAssignedOnly, unwrapLink, slug, idForReading, parseInboxPath, emptyUser, normalizeUser, applyOps, parseRunPath, mergeRuns, calibration, pearson };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PTCore = api;
})(typeof window !== "undefined" ? window : globalThis);
