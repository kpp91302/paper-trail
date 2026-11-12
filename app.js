// Paper Trail: reads digest runs from the private data repo, records what you
// download, save, skip and rate, and writes that back so the digests can learn.
(function () {
  "use strict";
  const CFG = window.PT_CONFIG;
  const Core = window.PTCore;
  const API = "https://api.github.com";
  const FEEDS = { daily: "Daily", weekly: "Weekly ML", eos: "Edge of Stability", assigned: "Assigned" };
  const KINDS = { paper: "Paper", hf: "Hugging Face", github: "GitHub", blog: "Blog" };
  const VIEWS = ["new", "assigned", "daily", "weekly", "eos", "to-rate", "saved", "profile", "settings"];
  const MAX_UPLOAD_MB = 50;
  const NEW_DAYS = 21;
  const EMBED_TARGET = 40, EMBED_LOW = 10;

  // ---------- storage on this device ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  const S = {
    token: LS.get("pt.token", ""),
    tree: [],                 // run files known in the repo, newest first: {path, sha, date, feed}
    runsLoaded: 0,
    runs: [],                 // loaded run files
    papers: new Map(),
    remoteUser: Core.emptyUser(),
    userSha: null,
    profile: null,
    pending: LS.get("pt.pending", []),
    loaded: false,
    loading: false,
    error: "",
    sync: "idle",
    openNotes: new Set(),
    inbox: new Map(),          // id -> reading added on the site, waiting for its summary
    showAdd: false,
    uploading: "",
  };
  const ui = { view: "new", q: "", sort: "date", hideDone: false };

  // ---------- small DOM helper ----------
  const $ = (id) => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  function fmtDay(iso) {
    const d = new Date(iso + "T12:00:00");
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  function fmtShort(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function daysAgo(iso) { return (Date.now() - new Date(iso + "T12:00:00").getTime()) / 86400000; }

  // ---------- GitHub API ----------
  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function gh(path, opts = {}) {
    const res = await fetch(API + path, {
      method: opts.method || "GET",
      cache: "no-store",
      headers: {
        Accept: opts.accept || "application/vnd.github+json",
        Authorization: "Bearer " + S.token,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const err = new Error("GitHub " + res.status); err.status = res.status;
      try { err.detail = (await res.json()).message; } catch (e) {}
      throw err;
    }
    return opts.accept === "application/vnd.github.raw+json" ? res.text() : res.json();
  }
  const repoPath = () => "/repos/" + CFG.owner + "/" + CFG.dataRepo;
  function explain(e) {
    if (!navigator.onLine) return "You're offline. Changes are kept on this device and will save when you reconnect.";
    if (e.status === 401) return "GitHub rejected the token. It may have expired; create a new one and paste it in Settings.";
    if (e.status === 403) return "GitHub refused the request. If this persists, check that the token has Contents read and write access to " + CFG.dataRepo + ".";
    if (e.status === 404) return "Can't find " + CFG.owner + "/" + CFG.dataRepo + ". Check that the token was given access to that repository.";
    return "Couldn't reach GitHub (" + (e.status || e.message) + "). Try again in a moment.";
  }

  async function readJsonFile(path) {
    try {
      const f = await gh(repoPath() + "/contents/" + path + "?ref=" + CFG.branch);
      return { sha: f.sha, data: JSON.parse(b64decode(f.content)) };
    } catch (e) {
      if (e.status === 404) return { sha: null, data: null };
      throw e;
    }
  }
  async function readBlob(sha) {
    const key = "pt.blob." + sha;
    const cached = LS.get(key, null);
    if (cached) return cached;
    const text = await gh(repoPath() + "/git/blobs/" + sha, { accept: "application/vnd.github.raw+json" });
    const data = JSON.parse(text);
    LS.set(key, data);
    return data;
  }
  function pruneBlobCache(keep) {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith("pt.blob.") && !keep.has(k.slice(8))) localStorage.removeItem(k);
      }
    } catch (e) {}
  }
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }

  // ---------- loading ----------
  async function loadAll() {
    if (!S.token) { S.loaded = false; render(); return; }
    S.loading = true; S.error = ""; render();
    try {
      const [tree, user, profile] = await Promise.all([
        gh(repoPath() + "/git/trees/" + CFG.branch + "?recursive=1"),
        readJsonFile("state/user.json"),
        readJsonFile("profile.json"),
      ]);
      S.tree = (tree.tree || []).map((t) => ({ ...t, run: t.type === "blob" ? Core.parseRunPath(t.path) : null }))
        .filter((t) => t.run).map((t) => ({ path: t.path, sha: t.sha, date: t.run.date, feed: t.run.feed, seq: t.run.seq }))
        .sort((a, b) => b.date.localeCompare(a.date) || a.feed.localeCompare(b.feed));
      const inboxFiles = (tree.tree || []).filter((t) => t.type === "blob" && Core.parseInboxPath(t.path));
      const inbox = await mapLimit(inboxFiles, 6, async (t) => { try { return await readBlob(t.sha); } catch (e) { return null; } });
      S.inbox = new Map(inbox.filter((x) => x && x.id).map((x) => [x.id, x]));
      S.inboxShas = inboxFiles.map((t) => t.sha);
      S.remoteUser = Core.normalizeUser(user.data); S.userSha = user.sha;
      S.profile = profile.data;
      S.runs = []; S.runsLoaded = 0;
      await loadMoreRuns(CFG.initialRuns || 90, false);
      pruneBlobCache(new Set([...S.runs.map((r) => r.sha), ...(S.inboxShas || [])]));
      S.loaded = true;
    } catch (e) {
      S.error = explain(e);
    }
    S.loading = false;
    render();
    flush();
  }
  async function loadMoreRuns(n, rerender = true) {
    const next = S.tree.slice(S.runsLoaded, S.runsLoaded + n);
    const files = await mapLimit(next, 6, async (t) => {
      try { const d = await readBlob(t.sha); return { ...t, papers: Array.isArray(d.papers) ? d.papers : [], overview: d.overview || "" }; }
      catch (e) { return { ...t, papers: [], failed: true }; }
    });
    S.runs.push(...files); S.runsLoaded += next.length;
    S.papers = Core.mergeRuns(S.runs);
    if (rerender) render();
  }

  // ---------- writing your actions ----------
  const user = () => Core.applyOps(S.remoteUser, S.pending);
  let flushTimer = null, flushing = false;
  function act(op) {
    op.at = new Date().toISOString();
    S.pending.push(op); LS.set("pt.pending", S.pending);
    render();
    clearTimeout(flushTimer); flushTimer = setTimeout(flush, 1200);
  }
  async function flush() {
    if (flushing || !S.pending.length || !S.token) { setSync(); return; }
    flushing = true; setSync("saving");
    const batch = S.pending.slice();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await readJsonFile("state/user.json");
        const next = Core.applyOps(cur.data, batch);
        next.updatedAt = new Date().toISOString();
        try {
          const res = await gh(repoPath() + "/contents/state/user.json", { method: "PUT", body: {
            message: "Update reading log (" + batch.length + " change" + (batch.length > 1 ? "s" : "") + ")",
            content: b64encode(JSON.stringify(next, null, 1) + "\n"),
            branch: CFG.branch, ...(cur.sha ? { sha: cur.sha } : {}),
          } });
          S.remoteUser = next; S.userSha = res.content && res.content.sha;
          S.pending = S.pending.slice(batch.length); LS.set("pt.pending", S.pending);
          break;
        } catch (e) {
          if ((e.status === 409 || e.status === 422) && attempt < 2) continue; // another device saved first; re-read and reapply
          throw e;
        }
      }
      S.syncError = "";
    } catch (e) {
      S.syncError = explain(e);
    }
    flushing = false;
    setSync();
    render();
    if (S.pending.length && !S.syncError) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 800); }
  }
  function setSync(state) {
    const el = $("sync"); el.className = "sync";
    if (!S.token) { el.textContent = ""; return; }
    if (state === "saving") { el.textContent = "Saving…"; return; }
    if (S.syncError) { el.className = "sync err"; el.textContent = S.pending.length + " unsaved · " + (navigator.onLine ? "retrying soon" : "offline"); el.title = S.syncError; return; }
    if (S.pending.length) { el.className = "sync warn"; el.textContent = S.pending.length + " waiting to save"; return; }
    el.textContent = S.loaded ? "All changes saved" : "";
  }
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.loaded) { flush(); } });
  setInterval(() => { if (S.pending.length && S.syncError) { S.syncError = ""; flush(); } }, 30000);

  // ---------- undo toast ----------
  let toastTimer;
  function toast(text, undoOp) {
    $("toast-text").textContent = text;
    const b = $("toast-undo"); b.hidden = !undoOp; b.onclick = () => { act(undoOp); $("toast").hidden = true; };
    $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 5000);
  }

  // ---------- views ----------
  function stateOf(id) { return user().papers[id] || {}; }
  function touched(s) { return s.rating || s.skipped || s.downloads || s.opens; }
  function haystack(p) { return [p.title, p.authors, p.source, (p.keywords || []).join(" "), p.summary].join(" ").toLowerCase(); }
  function itemsFor(view) {
    let arr = [...S.papers.values()];
    const u = user();
    const st = (p) => u.papers[p.id] || {};
    if (view === "new") arr = arr.filter((p) => !touched(st(p)) && daysAgo(p.lastSeen) <= NEW_DAYS && p.feeds.some((f) => f !== "assigned"));
    else if (FEEDS[view]) arr = arr.filter((p) => p.feeds.includes(view));
    else if (view === "to-rate") arr = arr.filter((p) => (st(p).downloads || st(p).opens) && !st(p).rating && !st(p).skipped);
    else if (view === "saved") arr = arr.filter((p) => st(p).saved);
    if (ui.hideDone && view !== "to-rate") arr = arr.filter((p) => !st(p).rating && !st(p).skipped);
    if (ui.q) arr = arr.filter((p) => haystack(p).includes(ui.q));
    const score = (p) => (p.worth && Number(p.worth.score)) || 0;
    const byDate = (a, b) => b.lastSeen.localeCompare(a.lastSeen) || score(b) - score(a);
    if (ui.sort === "worth") arr.sort((a, b) => score(b) - score(a) || byDate(a, b));
    else if (ui.sort === "mine") arr.sort((a, b) => (st(b).rating || 0) - (st(a).rating || 0) || byDate(a, b));
    else if (view === "to-rate") arr.sort((a, b) => String(st(b).lastDownload || st(b).lastOpen || "").localeCompare(String(st(a).lastDownload || st(a).lastOpen || "")));
    else if (view === "saved") arr.sort((a, b) => String(st(b).savedAt || "").localeCompare(String(st(a).savedAt || "")));
    else arr.sort(byDate);
    return arr;
  }

  function pdfOf(p) {
    if (p.pdfUrl) return p.pdfUrl;
    const m = /arxiv\.org\/abs\/([^?#\s]+)/.exec(p.url || "");
    return m ? "https://arxiv.org/pdf/" + m[1] : null;
  }

  // Uploaded PDFs live in the private repo, so they are fetched with the token
  // and opened from a local blob URL. The tab opens first, inside the tap, so
  // iPad Safari doesn't block it.
  async function openUpload(p) {
    const name = (p.uploadPath || "").split("/").pop() || "reading.pdf";
    act({ op: "download", id: p.id });
    const win = window.open("", "_blank");
    if (win) { try { win.document.title = "Opening " + name; win.document.body.textContent = "Opening " + name + "…"; } catch (e) {} }
    try {
      const res = await fetch(API + repoPath() + "/contents/" + p.uploadPath + "?ref=" + CFG.branch, {
        cache: "no-store", headers: { Accept: "application/vnd.github.raw+json", Authorization: "Bearer " + S.token } });
      if (!res.ok) throw Object.assign(new Error("GitHub " + res.status), { status: res.status });
      const url = URL.createObjectURL(new Blob([await res.blob()], { type: "application/pdf" }));
      if (win) win.location.href = url;
      else { const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove(); }
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    } catch (e) {
      if (win) win.close();
      toast("Couldn't open the PDF. " + explain(e));
    }
  }
  function assignedLine(p) {
    const a = p.assigned || {};
    const bits = [];
    if (a.by) bits.push("Assigned by " + a.by);
    if (a.due) bits.push("due " + fmtDay(a.due));
    if (!bits.length && !a.note) return null;
    return h("p", { class: "assigned" }, bits.join(" · "), a.note ? h("span", null, (bits.length ? " — " : "") + a.note) : null);
  }
  function teachToggle(p, s) {
    return h("div", { class: "teach", role: "group", "aria-label": "Use this paper for recommendations" },
      h("span", null, "Use for recommendations"),
      h("button", { type: "button", class: "btn", "aria-pressed": String(s.teach === true), onclick: () => act({ op: "teach", id: p.id, value: s.teach === true ? null : true }) }, "Yes"),
      h("button", { type: "button", class: "btn", "aria-pressed": String(s.teach === false), onclick: () => act({ op: "teach", id: p.id, value: s.teach === false ? null : false }) }, "No"),
      s.teach === undefined ? h("small", null, "Not counted until you choose Yes") : null);
  }

  function card(p) {
    const s = stateOf(p.id);
    const isAssigned = (p.feeds || []).includes("assigned");
    const w = p.worth || {};
    const pdf = pdfOf(p);
    const status = [];
    if (s.downloads) status.push("Downloaded" + (s.downloads > 1 ? " " + s.downloads + "×" : "") + " " + fmtShort(s.lastDownload));
    else if (s.opens) status.push("Opened " + fmtShort(s.lastOpen));
    if (s.rating) status.push("Rated " + s.rating + "/10");
    const scale = h("div", { class: "scale", role: "group", "aria-label": "Your rating, 1 to 10" },
      Array.from({ length: 10 }, (_, i) => i + 1).map((n) =>
        h("button", { type: "button", class: s.rating === n ? "on" : (s.rating && n < s.rating ? "in" : ""), "aria-pressed": String(s.rating === n), "aria-label": "Rate " + n + " of 10",
          onclick: () => { act({ op: "rate", id: p.id, value: s.rating === n ? 0 : n }); if (s.rating !== n) toast("Rated " + n + "/10"); } }, String(n))));
    const noteOpen = S.openNotes.has(p.id) || !!s.note;
    return h("article", { class: "card" + (s.skipped ? " dim" : ""), id: "p-" + p.id },
      h("div", { class: "body" },
        h("div", { class: "meta" },
          h("span", { class: "badge" }, KINDS[p.kind] || "Item"),
          p.topPick ? h("span", { class: "badge top" }, "Top pick") : null,
          p.exploration ? h("span", { class: "badge explore", title: "Picked to widen your range, not because it matches your profile" }, "Exploring") : null,
          h("span", null, p.feeds.map((f) => FEEDS[f] || f).join(" · ")),
          p.pubDate ? h("span", null, p.pubDate) : null,
          p.source ? h("span", null, p.source) : null),
        p.url ? h("h3", null, h("a", { href: p.url, target: "_blank", rel: "noopener", onclick: () => act({ op: "open", id: p.id }) }, p.title)) : h("h3", null, p.title),
        p.authors ? h("div", { class: "authors" }, p.authors) : null,
        isAssigned ? assignedLine(p) : null),
      w.score ? h("div", { class: "worth" + (w.score >= 8 ? " hi" : ""), title: "Claude's worth-reading score" },
        h("b", null, String(w.score), h("small", null, "/10")), h("span", null, "Worth reading")) : null,
      h("div", { class: "body" },
        w.reason ? h("p", { class: "reason" }, h("strong", null, "Why: "), w.reason,
          (w.quality || w.fit) ? " (quality " + (w.quality || "–") + ", fit " + (w.fit || "–") + ")" : "") : null,
        p.summary ? h("p", { class: "summary" }, p.summary)
          : p.pending ? h("p", { class: "reason" }, "Summary and score arrive with the next daily run (6:38am).")
          : p.needsSummary ? h("p", { class: "reason" }, isAssigned ? "Summary pending: the file or link couldn't be read. The next daily run tries again." : "Summary and score pending: the abstract couldn't be read when this was imported. The next weekly run fills them in.") : null,
        (p.keywords || []).length ? h("div", { class: "kw" }, p.keywords.map((k) => h("span", null, k))) : null),
      h("div", { class: "actions" },
        p.uploadPath ? h("button", { type: "button", class: "btn primary", onclick: () => openUpload(p) }, "Open PDF")
          : pdf ? h("a", { class: "btn primary", href: pdf, target: "_blank", rel: "noopener", onclick: () => act({ op: "download", id: p.id }) }, "Download PDF")
          : p.url ? h("a", { class: "btn primary", href: p.url, target: "_blank", rel: "noopener", onclick: () => act({ op: "download", id: p.id }) }, "Open") : null,
        (p.links || []).map((l) => h("a", { class: "btn", href: l.url, target: "_blank", rel: "noopener", onclick: () => act({ op: "open", id: p.id }) }, l.label)),
        h("button", { type: "button", class: "btn", "aria-pressed": String(!!s.saved), onclick: () => act({ op: "save", id: p.id, value: !s.saved }) }, s.saved ? "Saved" : "Save for later"),
        h("button", { type: "button", class: "btn", "aria-pressed": String(!!s.skipped), onclick: () => {
          act({ op: "skip", id: p.id, value: !s.skipped });
          if (!s.skipped) toast("Marked “not for me”", { op: "skip", id: p.id, value: false });
        } }, "Not for me"),
        h("button", { type: "button", class: "btn", "aria-expanded": String(noteOpen), onclick: () => { noteOpen ? S.openNotes.delete(p.id) : S.openNotes.add(p.id); render(); } }, s.note ? "Note ✓" : "Add note"),
        h("span", { class: "status" }, status.join(" · "))),
      h("div", { class: "rate" }, h("span", null, "Your rating"), scale),
      isAssigned ? teachToggle(p, s) : null,
      noteOpen ? h("div", { class: "note" }, h("textarea", { id: "note-" + p.id, placeholder: "What stood out, or why it missed. Notes help the profile.", "aria-label": "Note on " + p.title,
        onchange: (e) => act({ op: "note", id: p.id, value: e.target.value }) }, s.note || "")) : null);
  }

  function paperList(view) {
    const arr = itemsFor(view);
    const nodes = [];
    if (view === "new") nodes.push(h("p", { class: "intro" }, "Everything from the last three weeks you haven't touched yet. Download what you want to read; it moves to To rate."));
    if (view === "to-rate") nodes.push(h("p", { class: "intro" }, "Papers you downloaded or opened but haven't rated. Rate them once you've read them; ratings teach the digests most."));
    if (view === "saved") nodes.push(h("p", { class: "intro" }, "Your read-later list."));
    if (!arr.length) {
      const msg = { new: "You're caught up. New papers appear here after each digest run.", "to-rate": "Nothing waiting for a rating.", saved: "Nothing saved yet." }[view] || "Nothing here yet.";
      nodes.push(h("p", { class: "empty" }, ui.q ? "Nothing matches “" + ui.q + "”." : msg));
    } else if (ui.sort === "date" && (view === "new" || FEEDS[view])) {
      const groups = new Map();
      for (const p of arr) {
        const ap = FEEDS[view] ? p.appearances.filter((a) => a.feed === view).map((a) => a.date).sort().pop() : p.lastSeen;
        const key = ap || p.lastSeen;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      const keys = [...groups.keys()].sort().reverse();
      for (const k of keys) {
        const items = groups.get(k);
        if (FEEDS[view]) items.sort((a, b) => rankIn(a, view, k) - rankIn(b, view, k));
        const run = FEEDS[view] ? S.runs.find((r) => r.feed === view && r.date === k) : null;
        nodes.push(h("section", { class: "day" },
          h("h2", null, fmtDay(k), h("span", null, items.length + (items.length === 1 ? " item" : " items"))),
          run && run.overview ? h("p", { class: "intro" }, run.overview) : null,
          items.map(card)));
      }
    } else nodes.push(h("section", { class: "day" }, arr.map(card)));
    if (S.runsLoaded < S.tree.length && view !== "new") nodes.push(h("button", { type: "button", class: "btn more-runs", onclick: () => loadMoreRuns(60) }, "Load older digests"));
    return nodes;
  }
  function assignedItems() {
    const u = user();
    const items = [...S.papers.values()].filter((p) => p.feeds.includes("assigned"));
    for (const [id, r] of S.inbox) {
      if (S.papers.has(id) && S.papers.get(id).feeds.includes("assigned")) continue;
      items.push({ id, title: r.title, url: r.link || "", uploadPath: r.uploadPath, kind: "paper", feeds: ["assigned"], appearances: [], firstSeen: (r.addedAt || "").slice(0, 10), lastSeen: (r.addedAt || "").slice(0, 10),
        assigned: { by: r.assignedBy, due: r.dueDate, note: r.note, addedAt: r.addedAt }, pending: true });
    }
    let arr = items;
    if (ui.hideDone) arr = arr.filter((p) => !(u.papers[p.id] || {}).rating);
    if (ui.q) arr = arr.filter((p) => haystack(p).includes(ui.q) || String((p.assigned || {}).by || "").toLowerCase().includes(ui.q));
    const due = (p) => (p.assigned && p.assigned.due) || "9999";
    return arr.sort((a, b) => due(a).localeCompare(due(b)) || String((b.assigned || {}).addedAt || "").localeCompare(String((a.assigned || {}).addedAt || "")));
  }

  // The form is built once and reused across re-renders, so a background save
  // never wipes what you've typed or the file you picked.
  function addForm() {
    if (!S.addFormEl) S.addFormEl = buildAddForm();
    return S.addFormEl;
  }
  function closeAddForm() { S.showAdd = false; S.addFormEl = null; render(); }
  function buildAddForm() {
    const byValues = [...new Set([...S.inbox.values()].map((r) => r.assignedBy).concat([...S.papers.values()].map((p) => (p.assigned || {}).by)).filter(Boolean))];
    const f = {
      title: h("input", { type: "text", id: "ar-title", required: true, placeholder: "e.g. Nesterov, Lectures on Convex Optimization, ch. 2" }),
      file: h("input", { type: "file", id: "ar-file", accept: "application/pdf,.pdf" }),
      link: h("input", { type: "url", id: "ar-link", placeholder: "https://arxiv.org/abs/… or any link" }),
      by: h("input", { type: "text", id: "ar-by", list: "ar-by-list", placeholder: "e.g. ML Theory course, or Advisor" }),
      due: h("input", { type: "date", id: "ar-due" }),
      note: h("textarea", { id: "ar-note", placeholder: "Optional: which sections, what to focus on" }),
    };
    const msg = h("p", { class: "form-msg", role: "status" }, S.uploading);
    const submit = async (e) => {
      e.preventDefault();
      const title = f.title.value.trim(), link = Core.unwrapLink(f.link.value.trim()), file = f.file.files[0];
      if (!title) { msg.textContent = "Add a title so you can find it later."; f.title.focus(); return; }
      if (!file && !link) { msg.textContent = "Attach a PDF or paste a link."; return; }
      if (file && file.size > MAX_UPLOAD_MB * 1024 * 1024) { msg.textContent = "That PDF is over " + MAX_UPLOAD_MB + " MB. Paste a link to it instead."; return; }
      if (link && !/^https?:\/\//i.test(link)) { msg.textContent = "The link should start with https://"; return; }
      if (S.uploading) return;
      const today = new Date().toISOString().slice(0, 10);
      const base = Core.idForReading(title, link, today);
      const taken = (x) => S.inbox.has(x) || (S.papers.has(x) && S.papers.get(x).feeds.includes("assigned"));
      let id = base;
      for (let n = 2; taken(id); n++) id = base + "-" + n;
      const reading = { id, title, link: link || null, uploadPath: null, assignedBy: f.by.value.trim() || null, dueDate: f.due.value || null, note: f.note.value.trim() || null, addedAt: new Date().toISOString() };
      try {
        if (file) {
          S.uploading = "Uploading " + file.name + "…"; msg.textContent = S.uploading;
          const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
          reading.uploadPath = "uploads/" + id + ".pdf";
          await gh(repoPath() + "/contents/" + reading.uploadPath, { method: "PUT", body: { message: "Add reading PDF: " + title.slice(0, 60), content: b64, branch: CFG.branch } });
        }
        S.uploading = "Saving…"; msg.textContent = S.uploading;
        await gh(repoPath() + "/contents/inbox/" + id + ".json", { method: "PUT", body: { message: "Add assigned reading: " + title.slice(0, 60), content: b64encode(JSON.stringify(reading, null, 1) + "\n"), branch: CFG.branch } });
        S.inbox.set(id, reading); S.uploading = "";
        toast("Added. Its summary arrives with the next daily run.");
        closeAddForm();
      } catch (err) {
        S.uploading = "";
        msg.textContent = err.status === 422 ? "A reading with this name already exists. Change the title slightly and try again." : explain(err);
      }
    };
    return h("form", { class: "panel addform", onsubmit: submit },
      h("h2", null, "Add a reading"),
      h("label", { for: "ar-title" }, "Title"), f.title,
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", { for: "ar-file" }, "PDF (up to " + MAX_UPLOAD_MB + " MB)"), f.file),
        h("div", { class: "field" }, h("label", { for: "ar-link" }, "or a link"), f.link)),
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", { for: "ar-by" }, "Assigned by"), f.by, h("datalist", { id: "ar-by-list" }, byValues.map((v) => h("option", { value: v })))),
        h("div", { class: "field" }, h("label", { for: "ar-due" }, "Due date (optional)"), f.due)),
      h("label", { for: "ar-note" }, "Note"), f.note,
      h("div", { class: "row" },
        h("button", { type: "submit", class: "btn primary", id: "ar-submit" }, "Add reading"),
        h("button", { type: "button", class: "btn", onclick: closeAddForm }, "Cancel")),
      msg);
  }

  function assignedView() {
    const nodes = [h("p", { class: "intro" }, "Readings from your courses and advisor, soonest due first. Each gets a summary and worth-reading score with the next daily run. They only teach your recommendations if you choose Yes on the card.")];
    nodes.push(S.showAdd ? addForm() : h("button", { type: "button", class: "btn primary add-btn", onclick: () => { S.showAdd = true; render(); setTimeout(() => $("ar-title") && $("ar-title").focus(), 0); } }, "+ Add a reading"));
    const arr = assignedItems();
    if (!arr.length) nodes.push(h("p", { class: "empty" }, ui.q ? "Nothing matches “" + ui.q + "”." : "No assigned readings yet. Add one with a PDF or a link."));
    else nodes.push(h("section", { class: "day" }, arr.map(card)));
    return nodes;
  }

  function rankIn(p, feed, date) { const a = p.appearances.find((x) => x.feed === feed && x.date === date); return a ? a.rank || 99 : 99; }

  function termEditor(list, label, cls) {
    const u = user();
    const terms = u.profileOverrides[list];
    const input = h("input", { type: "text", id: "add-" + list, placeholder: list === "boost" ? "e.g. step-size theory" : "e.g. benchmark leaderboards", "aria-label": "Add to " + label });
    const add = () => { const v = input.value.trim(); if (v) { act({ op: "override", list, action: "add", term: v }); input.value = ""; } };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    return h("div", { class: "panel" },
      h("h2", null, label),
      h("p", { class: "intro" }, list === "boost" ? "Topics the digests should always favor, whatever your ratings say." : "Topics the digests should never pick."),
      terms.length ? h("div", { class: "terms" }, terms.map((t) => h("span", { class: "term" + cls }, t, h("button", { type: "button", "aria-label": "Remove " + t, onclick: () => act({ op: "override", list, action: "remove", term: t }) }, "×")))) : null,
      h("div", { class: "addterm" }, input, h("button", { type: "button", class: "btn", onclick: add }, "Add")));
  }

  function profileView() {
    const u = user();
    const prof = S.profile || {};
    const ratings = Object.values(u.papers).filter((s) => s.rating);
    const low = ratings.filter((s) => s.rating <= 4).length;
    const counts = { rated: ratings.length, downloaded: Object.values(u.papers).filter((s) => s.downloads).length, skipped: Object.values(u.papers).filter((s) => s.skipped).length, saved: Object.values(u.papers).filter((s) => s.saved).length };
    const cal = Core.calibration(S.papers, u);
    const nodes = [];
    nodes.push(h("div", { class: "panel" },
      h("h2", null, "What the digests have learned"),
      h("p", null, prof.summary || "Nothing yet. The daily run rewrites this each morning from your ratings, downloads and skips."),
      (prof.likes || []).length ? [h("span", { class: "label" }, "Favoring"), h("div", { class: "terms" }, prof.likes.map((t) => h("span", { class: "term", title: "weight " + t.weight }, t.term)))] : null,
      (prof.dislikes || []).length ? [h("span", { class: "label" }, "Avoiding"), h("div", { class: "terms" }, prof.dislikes.map((t) => h("span", { class: "term neg", title: "weight " + t.weight }, t.term)))] : null,
      (prof.authorsLiked || []).length ? [h("span", { class: "label" }, "Authors you engage with"), h("p", null, prof.authorsLiked.join(", "))] : null,
      prof.updatedAt ? h("span", { class: "label" }, "Updated " + new Date(prof.updatedAt).toLocaleString()) : null));
    nodes.push(h("div", { class: "panel" },
      h("h2", null, "Your activity"),
      h("div", { class: "stats" }, Object.entries(counts).map(([k, v]) => h("div", null, h("b", null, String(v)), h("span", { class: "label" }, k))))));
    nodes.push(h("div", { class: "grid2" }, termEditor("boost", "Always favor", ""), termEditor("block", "Never show", " neg")));

    const calPanel = h("div", { class: "panel" }, h("h2", null, "How well the scores predict your ratings"));
    if (cal.pts.length < 5) calPanel.append(h("p", null, "Appears after 5 ratings (" + cal.pts.length + " so far). It compares Claude's worth-reading score with your own rating for each paper."));
    else {
      const W = 300, P = 30, sc = (v) => P + ((v - 1) / 9) * (W - 2 * P), sy = (v) => W - sc(v);
      const chart = svg("svg", { class: "chart", viewBox: "0 0 " + W + " " + W, role: "img", "aria-label": "Scatter of Claude's score against your rating" },
        svg("line", { class: "axis", x1: P, y1: W - P, x2: W - P, y2: W - P }), svg("line", { class: "axis", x1: P, y1: P, x2: P, y2: W - P }),
        svg("line", { class: "diag", x1: sc(1), y1: sy(1), x2: sc(10), y2: sy(10) }),
        [1, 5, 10].map((v) => [svg("text", { x: sc(v), y: W - 10, "text-anchor": "middle" }, String(v)), svg("text", { x: 12, y: sy(v) + 4, "text-anchor": "middle" }, String(v))]),
        svg("text", { x: W / 2, y: W - 0, "text-anchor": "middle" }, "Claude's score"),
        cal.pts.map((q, i) => svg("circle", { cx: sc(q.score) + ((i * 7) % 9 - 4), cy: sy(q.rating) + ((i * 5) % 9 - 4), r: 5 })));
      calPanel.append(h("div", { class: "stats" },
        h("div", null, h("b", null, String(cal.pts.length)), h("span", { class: "label" }, "rated")),
        h("div", null, h("b", null, cal.mae.toFixed(1)), h("span", { class: "label" }, "avg gap (points)")),
        h("div", null, h("b", null, cal.r == null ? "–" : cal.r.toFixed(2)), h("span", { class: "label" }, "correlation"))), chart,
        h("p", { class: "intro" }, "Dots on the dashed line are papers where the score matched your rating. Your rating is up the side."));
    }
    nodes.push(calPanel);
    nodes.push(h("div", { class: "panel" },
      h("h2", null, "Next step: similarity matching"),
      h("p", null, "Paper embeddings get added once there are " + EMBED_TARGET + " ratings, at least " + EMBED_LOW + " of them 4 or lower, so the system has seen what you dislike too."),
      h("span", { class: "label" }, "Ratings " + Math.min(ratings.length, EMBED_TARGET) + " / " + EMBED_TARGET), h("div", { class: "meter" }, h("div", { style: "width:" + Math.min(100, (ratings.length / EMBED_TARGET) * 100) + "%" })),
      h("span", { class: "label" }, "Low ratings " + Math.min(low, EMBED_LOW) + " / " + EMBED_LOW), h("div", { class: "meter" }, h("div", { style: "width:" + Math.min(100, (low / EMBED_LOW) * 100) + "%" }))));
    return nodes;
  }

  function settingsView() {
    const input = h("input", { type: "password", id: "token", autocomplete: "off", spellcheck: "false", placeholder: "github_pat_…", "aria-label": "GitHub token" });
    const msg = h("p", { role: "status" });
    const save = async () => {
      const t = input.value.trim(); if (!t) { msg.textContent = "Paste the token first."; return; }
      S.token = t; msg.textContent = "Checking…"; msg.className = "";
      try {
        const repo = await gh(repoPath());
        if (repo.permissions && repo.permissions.push === false) throw Object.assign(new Error("read-only"), { status: 403 });
        LS.set("pt.token", t); input.value = "";
        msg.className = "ok"; msg.textContent = "Connected to " + CFG.owner + "/" + CFG.dataRepo + ". Loading your papers…";
        location.hash = "#new"; loadAll();
      } catch (e) { S.token = LS.get("pt.token", ""); msg.className = ""; msg.textContent = explain(e); }
    };
    const nodes = [h("div", { class: "panel" },
      h("h2", null, S.token ? "Connected on this device" : "Connect this device"),
      h("p", null, "Paper Trail keeps your papers and ratings in your private repository " + CFG.owner + "/" + CFG.dataRepo + ". Each device needs a GitHub token that can read and write only that repository."),
      h("ol", { class: "steps" },
        h("li", null, "Open ", h("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener" }, "GitHub → new fine-grained token"), "."),
        h("li", null, "Repository access: Only select repositories → ", h("b", null, CFG.dataRepo), "."),
        h("li", null, "Permissions → Repository → Contents: ", h("b", null, "Read and write"), "."),
        h("li", null, "Generate, copy, and paste it here.")),
      h("div", { class: "form" }, input, h("button", { type: "button", class: "btn primary", onclick: save }, S.token ? "Replace token" : "Connect")),
      msg)];
    if (S.token) nodes.push(h("div", { class: "panel" },
      h("h2", null, "This device"),
      h("p", null, S.pending.length ? S.pending.length + " changes are waiting to save." : "Everything is saved."),
      h("button", { type: "button", class: "btn", onclick: () => { LS.del("pt.token"); S.token = ""; S.loaded = false; render(); } }, "Disconnect this device")));
    return nodes;
  }

  // ---------- render ----------
  function render() {
    for (const a of $("tabs").querySelectorAll("a")) {
      if (a.dataset.view === ui.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    setSync();
    const listView = ui.view !== "profile" && ui.view !== "settings";
    $("controls").hidden = !(listView && S.loaded);
    if (S.loaded) {
      const toRate = itemsFor("to-rate").length, saved = [...S.papers.values()].filter((p) => stateOf(p.id).saved).length;
      $("c-to-rate").textContent = toRate || ""; $("c-saved").textContent = saved || "";
    }
    const nodes = [];
    if (S.syncError && S.pending.length) nodes.push(h("p", { class: "notice err" }, S.syncError));
    if (ui.view === "settings" || !S.token) nodes.push(...settingsView());
    else if (S.error) nodes.push(h("p", { class: "notice err" }, S.error), h("button", { type: "button", class: "btn", onclick: loadAll }, "Try again"));
    else if (!S.loaded) nodes.push(h("p", { class: "empty" }, "Loading your papers…"));
    else if (ui.view === "profile") nodes.push(...profileView());
    else if (!S.papers.size && ui.view !== "assigned") nodes.push(h("p", { class: "empty" }, "No digests yet. Papers appear here after the next scheduled run."));
    else if (ui.view === "assigned") nodes.push(h("div", { class: "list" }, assignedView()));
    else nodes.push(h("div", { class: "list" }, paperList(ui.view)));
    const focusId = document.activeElement && document.activeElement.id;
    $("main").replaceChildren(...nodes);
    if (focusId && $(focusId) && /^(note-|add-|token|ar-)/.test(focusId)) $(focusId).focus();
  }

  function route() {
    const v = (location.hash || "").slice(1);
    ui.view = VIEWS.includes(v) ? v : (S.token ? "new" : "settings");
    if (ui.view === "new" && ui.sort === "mine") ui.sort = "date";
    window.scrollTo(0, 0);
    render();
  }
  window.addEventListener("hashchange", route);

  $("q").addEventListener("input", (() => { let t; return (e) => { clearTimeout(t); t = setTimeout(() => { ui.q = e.target.value.trim().toLowerCase(); render(); }, 150); }; })());
  $("sort").addEventListener("change", (e) => { ui.sort = e.target.value; render(); });
  $("hide-done").addEventListener("change", (e) => { ui.hideDone = e.target.checked; render(); });

  route();
  loadAll();
})();
