/* PET Station runtime shim (Streamlit component bridge)
 * The app talks to a tiny `window.claude.use(...)` runtime (db, user, assets, downloads).
 * This file implements that surface by sending requests to the Streamlit server (streamlit_app.py), which
 * reads/writes MongoDB directly. No separate API server and no browser -> API connection is needed.
 *
 * Browser -> server : setComponentValue({cid, tick, reqs:[{id, op, a}], ack:[ids]})
 * Server -> browser : streamlit:render args.reply = {ok, err, store, vers:{collection:version}, res:{id:{ok|err}}}
 * Live updates      : every reply carries the change counter of each collection; watchers refetch what changed.
 */
/* Storage fallback: if the browser blocks localStorage for this embedded page, keep the same API alive through the
 * parent page's storage (same origin), sessionStorage, a cookie (small identity keys) and memory, so the chosen profile,
 * the device id and the theme survive a refresh. Normal browsers are untouched. */
(function () {
  function ok(s) { try { var k = '__pet_t'; s.setItem(k, '1'); s.removeItem(k); return true; } catch (e) { return false; } }
  var native = null; try { native = window.localStorage; } catch (e) {}
  if (native && ok(native)) return;
  var mem = {}, small = /^(pet_me|pet_uid|pet_shim_uid|pet_signed_in_at)$/, back = [];
  try { var pl = window.parent.localStorage; if (pl && ok(pl)) back.push(pl); } catch (e) {}
  try { if (window.sessionStorage && ok(window.sessionStorage)) back.push(window.sessionStorage); } catch (e) {}
  function ck(k) { try { var m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; } }
  function ckSet(k, v) { try { var b = k + '=' + encodeURIComponent(v) + ';path=/;max-age=31536000'; document.cookie = b + ';SameSite=None;Secure'; if (ck(k) !== v) document.cookie = b; } catch (e) {} }
  var S = {
    getItem: function (k) { k = String(k); if (Object.prototype.hasOwnProperty.call(mem, k)) return mem[k]; for (var i = 0; i < back.length; i++) { try { var v = back[i].getItem(k); if (v !== null) { mem[k] = v; return v; } } catch (e) {} } if (small.test(k)) { var c = ck(k); if (c !== null) { mem[k] = c; return c; } } return null; },
    setItem: function (k, v) { k = String(k); v = String(v); mem[k] = v; back.forEach(function (b) { try { b.setItem(k, v); } catch (e) {} }); if (small.test(k)) ckSet(k, v); },
    removeItem: function (k) { k = String(k); delete mem[k]; back.forEach(function (b) { try { b.removeItem(k); } catch (e) {} }); if (small.test(k)) { try { document.cookie = k + '=;path=/;max-age=0'; } catch (e) {} } },
    key: function (i) { return Object.keys(mem)[i] || null; },
    clear: function () { Object.keys(mem).forEach(function (k) { S.removeItem(k); }); }
  };
  Object.defineProperty(S, 'length', { get: function () { return Object.keys(mem).length; }, configurable: true });
  var P = new Proxy(S, { ownKeys: function () { return Object.keys(mem); }, getOwnPropertyDescriptor: function (tg, k) { return Object.prototype.hasOwnProperty.call(mem, k) ? { enumerable: true, configurable: true, value: mem[k] } : Object.getOwnPropertyDescriptor(tg, k); } });
  try { Object.defineProperty(window, 'localStorage', { value: P, configurable: true }); } catch (e) {}
})();
/* END STORAGE FALLBACK */
(function () {
  var POLL = 1000, HOLD = 4000, TIMEOUT = 25000, MAX_ASSET = 10 * 1024 * 1024;
  /* Connection resilience: a save is never dropped because the database or the connection hiccups. It is kept (also in
   * this browser's storage, so even a page reload does not lose it) and sent again with a short back-off until it is saved. */
  var WRITE_OPS = { put: 1, patch: 1, delete: 1, asset_put: 1, asset_del: 1 }, WRITE_MAX = 15 * 60000, OUTBOX = 'pet_outbox', DOWN = false;
  var CID = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var SEQ = 0, TICK = 0, PEND = {}, ACK = [], SYNC = false, VERS = {}, STORE = '', ERR = '', lastOk = 0, kickT = null, AWAIT = 0;
  var BOOT = {}, BOOT_OK = false, readyRes, READY = new Promise(function (r) { readyRes = r; });   // BOOT: everything saved so far, delivered with the very first render
  /* Nov 18: the last data this browser saw is kept in its storage. When the page reloads (Streamlit reconnecting, a
   * refresh), it is shown straight away instead of zeros, and replaced as soon as the server's copy arrives.
   * While only this copy is shown (window.__petCacheOnly), the app moves no cases on its own. */
  /* Nov 19: the kept copy lives in IndexedDB (was localStorage). localStorage holds about 5 MB as text, so with many cases
   * the copy was too big and dropped, and after a reload the dashboard showed only the tiles and no cases until the
   * server answered. IndexedDB has room for it and stores it without turning it into text (no stutter). */
  var BCACHE = 'pet_boot_cache' /* old text copy: only removed */, CACHED = false, cacheT = null, cacheSig = '', IDBN = 'pet_cache', IDBS = 'kv';
  function idb() { return new Promise(function (res, rej) { try { var r = indexedDB.open(IDBN, 1); r.onupgradeneeded = function () { r.result.createObjectStore(IDBS); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; } catch (e) { rej(e); } }); }
  function idbGet(k) { return idb().then(function (d) { return new Promise(function (res) { try { var q = d.transaction(IDBS, 'readonly').objectStore(IDBS).get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { res(null); }; } catch (e) { res(null); } }); }).catch(function () { return null; }); }
  function idbPut(k, v) { return idb().then(function (d) { return new Promise(function (res) { try { var t = d.transaction(IDBS, 'readwrite'); t.objectStore(IDBS).put(v, k); t.oncomplete = function () { res(true); }; t.onerror = function () { res(false); }; } catch (e) { res(false); } }); }).catch(function () { return false; }); }
  window.__petCacheClear = function () { try { localStorage.removeItem(BCACHE); } catch (e) {} return idb().then(function (d) { return new Promise(function (res) { try { var t = d.transaction(IDBS, 'readwrite'); t.objectStore(IDBS).clear(); t.oncomplete = function () { res(true); }; t.onerror = function () { res(false); }; } catch (e) { res(false); } }); }).catch(function () { return false; }); };
  function cacheSave() {
    if (!BOOT_OK || CACHED) return;
    try {
      var sig = JSON.stringify(VERS); if (sig === cacheSig) return; cacheSig = sig;   // only when something changed
      var keep = {};
      Object.keys(BOOT).forEach(function (c) { var b = BOOT[c]; if (b && !b.partial && b.docs && c.charAt(0) !== '_' && !/^assets/.test(c)) keep[c] = b; });
      idbPut('boot', { at: Date.now(), vers: VERS, boot: keep });
    } catch (e) {}
  }
  function cacheSoon() { if (cacheT) return; cacheT = setTimeout(function () { cacheT = null; cacheSave(); }, 20000); }
  function cacheUse(bc) { if (!BOOT_OK && bc && bc.boot && bc.vers && Date.now() - (bc.at || 0) < 12 * 3600000) { BOOT = bc.boot; BOOT_OK = true; CACHED = true; VERS = bc.vers; window.__petCacheOnly = true; return true; } return false; }
  try { localStorage.removeItem(BCACHE); } catch (e) {}   // frees the space the old text copy took
  var CACHE_P = idbGet('boot').then(function (bc) { try { return cacheUse(bc); } catch (e) { return false; } });
  try { document.addEventListener('visibilitychange', function () { if (document.hidden) cacheSave(); }); window.addEventListener('pagehide', cacheSave); } catch (e) {}

  function send(type, extra) { try { window.parent.postMessage(Object.assign({ isStreamlitMessage: true, type: type }, extra || {}), '*'); } catch (e) {} }
  function mkErr(msg, code) { var e = new Error(msg); e.code = code; return e; }

  /* ---------- request / response over the component value ---------- */
  function flush() {
    if (!SYNC) return;
    var now = Date.now(), reqs = [];
    /* one message at a time: while the server is still answering the last one, wait (the answer triggers the next send).
       A second message sent too early can cut the first one off on a slow connection. After HOLD ms we send anyway. */
    if (AWAIT && now - AWAIT < HOLD) return;
    /* Nov 18 (16:00): saves go first and every message stays small. Before, all waiting requests went in one message;
     * a report reading a whole month made one very large answer that held up the saves behind it (the delay) and
     * could choke the page (the white screen). Now: every save, then at most 4 list reads and 25 single reads; the
     * rest follow in the next messages. */
    var ws = [], ls = [], gs = [];
    Object.keys(PEND).forEach(function (k) {
      var p = PEND[k];
      if (p.after && now < p.after) return;                                       // waiting before trying again
      if (!p.sent || now - p.sent > 10000) (p.w ? ws : p.op === 'list' ? ls : gs).push(p);
    });
    /* a message with saves carries only the saves, so its answer comes straight back (no waiting behind reads) */
    (ws.length ? ws : ls.slice(0, 4).concat(gs.slice(0, 25))).forEach(function (p) { p.sent = now; reqs.push({ id: p.id, op: p.op, a: p.a }); });
    AWAIT = now;
    send('streamlit:setComponentValue', { value: { cid: CID, tick: ++TICK, reqs: reqs, ack: ACK.splice(0), have: haveVers() }, dataType: 'json' });
  }
  /* the version of each collection this page already holds: the server sends back only what is newer */
  function haveVers() { var h = {}; try { W.forEach(function (w) { if (w.v != null && (h[w.coll] === undefined || w.v < h[w.coll])) h[w.coll] = w.v; }); Object.keys(BOOT).forEach(function (c) { var b = BOOT[c]; if (b && !b.partial && b.version > 0) h[c] = b.version; }); } catch (e) {} return h; }   // the local copy's version: the server then sends only the documents changed since
  function kick() { if (kickT) return; kickT = setTimeout(function () { kickT = null; flush(); }, 40); }
  function localRead(op, a) {
    if (!BOOT_OK) return undefined;
    if (op === 'versions') return VERS;
    if (op !== 'get' && op !== 'list') return undefined;
    var b = BOOT[a.c];
    if (b && (VERS[a.c] || 0) !== b.version) return undefined;                  // the local copy is behind: ask the server (the copy is kept, changes are applied to it)
    if (!b) { if (VERS[a.c]) return undefined; b = { version: 0, docs: {} }; }
    if (b.partial) return undefined;
    if (a.w) return undefined;                                                   // filtered reads (one case's history, a date range) go to the server
    /* a copy of only the newest N (first load of the big, growing collections) answers only "newest first, up to N" */
    if (b.top && (op === 'get' ? b.docs[a.id] === undefined : !(a.ob === b.top.ob && a.dir === 'desc' && a.lim && a.lim <= b.top.n))) return undefined;
    if (op === 'get') { var d = b.docs[a.id]; return { version: b.version, id: a.id, exists: d !== undefined, data: d === undefined ? null : JSON.parse(JSON.stringify(d)) }; }
    var items = Object.keys(b.docs).map(function (id) { return { id: id, data: JSON.parse(JSON.stringify(b.docs[id])) }; });
    if (a.ob) {
      var f = a.ob, sg = a.dir === 'desc' ? -1 : 1;
      items.sort(function (x, y) { var u = x.data[f], v = y.data[f]; if (u === v) return 0; if (u === undefined || u === null) return -sg; if (v === undefined || v === null) return sg; return (u < v ? -1 : 1) * sg; });
    }
    var lim = a.lim || 1000; if (items.length > lim) items = items.slice(0, lim);
    return { version: b.version, count: items.length, items: items };
  }
  /* outbox: unsaved changes survive a reload / a dropped connection and are sent again when the page is back */
  /* the server's clock, for things several screens must agree on (who runs the hand-over, the order of schedule saves) */
  var SKEW = null; window.__petNow = function () { return Math.round(Date.now() + (SKEW || 0)); };
  function obRead() { try { return JSON.parse(localStorage.getItem(OUTBOX) || '{}') || {}; } catch (e) { return {}; } }
  function obWrite(o) { try { if (Object.keys(o).length) localStorage.setItem(OUTBOX, JSON.stringify(o)); else localStorage.removeItem(OUTBOX); } catch (e) {} }
  /* Nov 27 (18:45): this page's unsaved changes are kept in memory and written to browser storage together (20 ms after a
   * change is queued, a little later after a save is confirmed, and at once when the page is hidden or closed). Before,
   * every save and every confirmation re-read and re-wrote the whole stored list: after many saves at once (hundreds of
   * cases and their history lines) that used so much memory that the page could crash. Entries of other open pages are
   * left as they are. */
  var OBM = {}, obT = null, obDue = 0;
  function obFlush() {
    if (obT) { clearTimeout(obT); obT = null; } obDue = 0;
    try { var o = obRead(), pre = CID + ':'; Object.keys(o).forEach(function (k) { if (k.indexOf(pre) === 0) delete o[k]; }); Object.keys(OBM).forEach(function (k) { o[k] = OBM[k]; }); obWrite(o); } catch (e) {}
  }
  function obSoon(ms) { var due = Date.now() + ms; if (obT && obDue <= due) return; if (obT) clearTimeout(obT); obDue = due; obT = setTimeout(obFlush, ms); }
  window.__petObFlush = obFlush;
  try { document.addEventListener('visibilitychange', function () { if (document.hidden) obFlush(); }); window.addEventListener('pagehide', obFlush); window.addEventListener('beforeunload', obFlush); } catch (e) {}
  function obAdd(p) { if (p.op === 'asset_put' || p.op === 'asset_del') return; OBM[p.ob] = { op: p.op, a: p.a, t: Date.now() }; obSoon(20); }
  function obDel(p) { if (!p.ob || !OBM[p.ob]) return; delete OBM[p.ob]; obSoon(250); }
  function rpc(op, a, timeout) {
    var loc = localRead(op, a);                                                  // (our own writes come back as a small change, see 'delta')
    if (loc !== undefined) return Promise.resolve(loc);
    return new Promise(function (resolve, reject) {
      var id = ++SEQ, w = !!WRITE_OPS[op];
      var p = PEND[id] = { id: id, op: op, a: a, resolve: resolve, reject: reject, sent: 0, w: w, due: Date.now() + Math.max(timeout || TIMEOUT, w ? WRITE_MAX : 0) };
      if (w) { p.ob = CID + ':' + id; obAdd(p); }
      kick();
    });
  }
  /* a request the server could not complete because the database was briefly unreachable: send it again (new id) */
  function retryLater(p) {
    var now = Date.now(); if (now > p.due) return false;
    p.tries = (p.tries || 0) + 1; if (!p.firstFail) p.firstFail = now;
    var id = ++SEQ; p.id = id; p.sent = 0; p.after = now + Math.min(500 * Math.pow(2, p.tries - 1), 8000);
    PEND[id] = p; return true;
  }
  /* changes left unsaved by a previous page (closed or reloaded while the connection was down) are sent once now */
  /* Nov 18 (11:45): case history lines (act) and attendance records (att) are never dropped. Each is its own record, so
   * sending one late cannot overwrite anything newer; before, they were thrown away after 15 minutes without a
   * connection (or 2 minutes after a reload), and those actions were missing from productivity and the scorecard. */
  var KEEP = { act: 1, att: 1 }, KEEP_MAX = 7 * 864e5;
  function keepIt(a) { return !!(a && KEEP[a.c]); }
  function replayOutbox(mine) {
    obFlush();
    var live = {}; Object.keys(PEND).forEach(function (k) { if (PEND[k].ob) live[PEND[k].ob] = 1; });
    var o = obRead(), now = Date.now(), keys = Object.keys(o).filter(function (k) { return mine ? (!live[k] && keepIt(o[k] && o[k].a)) : k.indexOf(CID + ':') !== 0; });
    keys.sort(function (x, y) { return (o[x].t || 0) - (o[y].t || 0); });
    if (!keys.length) return;
    var cur = obRead(); keys.forEach(function (k) { delete cur[k]; }); obWrite(cur);   // each one is re-added under this page while it is sent
    keys.forEach(function (k) {
      var e = o[k];
      if (!e || !e.op || !WRITE_OPS[e.op] || (now - (e.t || 0) > 2 * 60000 && !(keepIt(e.a) && now - (e.t || 0) < KEEP_MAX))) return;    // too old: newer data may exist (case history and attendance are always sent: each entry is its own record)
      if (e.a && (e.a.c === 'config' || e.a.c === 'seat' || e.a.c === 'avail')) return;   // settings (the shift schedule, ...) are never replayed: a newer copy may have been saved since (Nov 17)
      rpc(e.op, e.a).then(function () { try { bump(e.a.c); } catch (x) {} }, function () {});
    });
  }
  function beat() {
    var now = Date.now();
    Object.keys(PEND).forEach(function (k) {
      var p = PEND[k];
      if (now > p.due) { delete PEND[k]; if (!keepIt(p.a)) obDel(p); p.reject(mkErr('Cannot reach the database', 'unavailable')); }   // case history / attendance stay in the outbox and are sent later
    });
    flush();
  }
  setInterval(beat, POLL);
  setInterval(function () { if (SYNC && !DOWN) try { replayOutbox(true); } catch (e) {} }, 60000);   // history/attendance left over from a long outage
  /* coming back to the tab (browsers slow timers down in background tabs): ask for the latest at once */
  function wake() { if (!SYNC) return; AWAIT = 0; flush(); }
  try { document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); }); window.addEventListener('focus', wake); window.addEventListener('online', wake); } catch (e) {}   // idle heartbeat: one quiet rerun every few seconds; saves go out immediately (kick)

  /* Faster opening (Nov 24): the data sent with the first answer comes compressed (about 8 times smaller, so it arrives much
     sooner). It is unpacked here before the answer is used; answers are always used in the order they came. A browser that
     cannot unpack it simply reads the data from the server the normal way. */
  var RQ = Promise.resolve();
  function unz(b64) {
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    var st = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(st).text().then(function (t) { return JSON.parse(t); });
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.type !== 'streamlit:render') return;
    var r0 = (d.args || {}).reply || {};
    RQ = RQ.then(function () {
      if (!r0.bootz) return;
      var z = r0.bootz; delete r0.bootz;
      if (r0.boot || typeof DecompressionStream === 'undefined') return;
      return unz(z).then(function (b) { r0.boot = b; }, function () {});
    }).then(function () { onRender(d); }, function () { onRender(d); });
  });
  /* Nov 25: a page left open keeps running the code it was opened with. When the server hands out a newer version (after an
     update), a large red message across the top of the screen asks the user to refresh. Nothing reloads by itself any more
     (the automatic reload interrupted people), and work is never lost: unsaved changes are sent when the page is refreshed. */
  var NEWBUILD = '';
  function buildBanner() {
    if (!NEWBUILD || !document.body || document.getElementById('pet-update')) return;
    var d = document.createElement('div');
    d.id = 'pet-update';
    d.setAttribute('role', 'alert');
    d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483000;background:#d40032;color:#fff;padding:14px 18px;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;font:800 17px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);text-align:center;border-bottom:4px solid #8f0022';
    d.innerHTML = '<span style="font-size:24px">⚠️</span><span>PAT has been updated. Please refresh the page now to keep everything working correctly.<span style="display:block;font:600 12.5px system-ui,sans-serif;opacity:.92;margin-top:2px">Your work is kept. If this message comes back after refreshing, press Ctrl+Shift+R (Cmd+Shift+R on a Mac).</span></span>' +
      '<button type="button" id="pet-update-go" style="background:#fff;color:#d40032;border:0;border-radius:999px;padding:9px 18px;font:900 15px system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 0 rgba(0,0,0,.25)">⟳ Refresh now</button>';
    document.body.appendChild(d);
    var b = document.getElementById('pet-update-go');
    if (b) b.onclick = function () { try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {} setTimeout(function () { try { location.reload(); } catch (e) {} }, 150); };
  }
  setInterval(buildBanner, 3000);
  function onRender(d) {
    var r = (d.args || {}).reply || {};
    if (r.build && window.__PET_BUILD && r.build !== window.__PET_BUILD && !NEWBUILD) { NEWBUILD = r.build; setTimeout(buildBanner, 0); }
    var first = !SYNC;
    if (typeof r.now === 'number') { var sk = r.now - Date.now(); SKEW = SKEW == null ? sk : SKEW * 0.8 + sk * 0.2; }   // the server's clock (Nov 17)
    if (r.boot && (!BOOT_OK || CACHED)) { BOOT = r.boot; BOOT_OK = true; CACHED = false; window.__petCacheOnly = false; }
    else if (CACHED && r.vers) { BOOT = {}; CACHED = false; window.__petCacheOnly = false; }   // no copy came with the answer: the stored one is dropped and everything is read from the server
    SYNC = true; AWAIT = 0; readyRes();
    STORE = r.store || STORE;
    DOWN = !!r.down;
    ERR = r.ok === false && !DOWN ? (r.err || 'storage error') : '';
    if (first) setTimeout(replayOutbox, 0);
    var res = r.res || {};
    Object.keys(res).forEach(function (id) {
      var p = PEND[id]; if (!p) { if (ACK.indexOf(+id) < 0) ACK.push(+id); return; }   // already received: tell the server again so it stops re-sending it
      delete PEND[id]; ACK.push(+id);
      var x = res[id] || {};
      if (x.err && x.err.code === 'unavailable' && (p.w || x.err.retry) && retryLater(p)) return;   // kept: sent again shortly
      lastOk = Date.now(); obDel(p);
      if (x.err) p.reject(mkErr(x.err.message || 'Request failed', x.err.code || 'unavailable')); else p.resolve(x.ok === undefined ? null : x.ok);
    });
    if (r.fresh && BOOT_OK) Object.keys(r.fresh).forEach(function (c) { var f = r.fresh[c]; if (f && f.docs && (!BOOT[c] || BOOT[c].version !== f.version)) BOOT[c] = f; });   // changed data that came with the answer: watchers read it from here
    /* only the documents that changed since this page's copy: applied in place (fast, small) */
    if (r.delta && BOOT_OK) Object.keys(r.delta).forEach(function (c) {
      var dl = r.delta[c], b = BOOT[c];
      if (!dl || !dl.docs || !b || b.partial || b.version !== dl.from) return;    // not the version it was made for: the whole collection is fetched instead
      Object.keys(dl.docs).forEach(function (id) { var d = dl.docs[id]; if (d === null) delete b.docs[id]; else b.docs[id] = d; });
      b.version = dl.version;
    });
    if (r.vers) { VERS = r.vers; onVers(); cacheSoon(); }
    if (Object.keys(PEND).some(function (k) { return !PEND[k].sent; })) kick();
  }

  var SEG = /^[A-Za-z0-9_\-]+$/, DOCID = /^[A-Za-z0-9_.\-~:@+]{1,200}$/;
  function parts(p) { return String(p).split('/').filter(Boolean); }
  function coll(a) { a.forEach(function (s) { if (!SEG.test(s)) throw mkErr('Invalid path', 'invalid_argument'); }); return a.join('__'); }
  function parseDoc(p) { var a = parts(p); if (a.length < 2 || a.length % 2) throw mkErr('Invalid document path', 'invalid_argument'); var id = a[a.length - 1]; if (!DOCID.test(id)) throw mkErr('Invalid document id', 'invalid_argument'); return { coll: coll(a.slice(0, -1)), id: id }; }
  function parseCol(p) { var a = parts(p); if (!a.length || a.length % 2 === 0) throw mkErr('Invalid collection path', 'invalid_argument'); return coll(a); }
  function autoId() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  /* ---------- assets (shared alert audio, stored in MongoDB) ---------- */
  var ASSET_CACHE = {}, ASSET_LOADING = {};
  function prefetch(id) {
    if (!id || ASSET_CACHE[id] || ASSET_LOADING[id]) return;
    ASSET_LOADING[id] = true;
    rpc('asset_get', { id: id }, 60000).then(function (r) { if (r && r.data) ASSET_CACHE[id] = r.data; }, function () {}).then(function () { delete ASSET_LOADING[id]; });
  }
  window.__assetUrl = function (id) {
    if (ASSET_CACHE[id]) return ASSET_CACHE[id];
    prefetch(id);
    return '';                                  // the app plays its built-in tone until the shared sound has loaded
  };

  /* real account names live only on the server (Streamlit secrets); they are fetched when a report is extracted */
  window.__petRealNames = function (names) { return rpc('real_names', { names: names }, 30000); };
  /* the shift schedule template is the file in the repo (templates/), read by the server on every download */
  window.__petTemplate = function (name) { return rpc('template', { name: name }, 30000); };
  /* IM•LOGIC bridge: the recorded message thread with IM•LOGIC (pet_bridge/apply_to_pet.py) */
  window.__bridge = function (op, args) { return rpc(op, args || {}, 20000); };

  /* ---------- live updates ---------- */
  var W = [];
  async function refresh(w, force) {
    if (w.busy) { w.again = true; return; }
    w.busy = true;
    var res;
    try { res = await w.fetch(); }
    catch (e) { w.busy = false; var n = Date.now(); if (w.err && n - (w.le || 0) > 10000) { w.le = n; w.err(e); } return; }
    w.busy = false; w.v = res.version;
    var sig = JSON.stringify(res.sig);
    if (force || sig !== w.sig) { w.sig = sig; try { w.cb(res.snap()); } catch (e) { if (window.console) console.error(e); } }
    if (w.again) { w.again = false; if ((VERS[w.coll] || 0) !== w.v) refresh(w); }
  }
  function onVers() { W.slice().forEach(function (w) { if ((VERS[w.coll] || 0) !== w.v) refresh(w); }); }
  function sub(w) { W.push(w); refresh(w, true); return function () { var i = W.indexOf(w); if (i >= 0) W.splice(i, 1); }; }
  function bump(c) { W.forEach(function (w) { if (w.coll === c) refresh(w); }); }

  function docSnap(r, id) {
    var data = r && r.exists ? clone(r.data) : undefined;
    if (data && typeof data.sndId === 'string' && data.sndId) prefetch(data.sndId);
    if (data && data.sounds && typeof data.sounds === 'object') Object.keys(data.sounds).forEach(function (k) { var s = data.sounds[k]; if (s && s.id) prefetch(s.id); });
    return { id: id, exists: !!(r && r.exists), data: function () { return clone(data); }, metadata: { hasPendingWrites: false, fromCache: false } };
  }
  function querySnap(items) {
    var docs = items.map(function (it) { var d = clone(it.data); return { id: it.id, exists: true, data: function () { return clone(d); }, metadata: { hasPendingWrites: false } }; });
    return { docs: docs, size: docs.length, empty: !docs.length, metadata: { hasPendingWrites: false }, forEach: function (f) { docs.forEach(f); } };
  }

  /* ---------- db ---------- */
  function docRef(path) {
    var p = parseDoc(path), a = { c: p.coll, id: p.id };
    return {
      id: p.id, path: path,
      get: async function () { return docSnap(await rpc('get', a), p.id); },
      set: async function (data) { await rpc('put', { c: p.coll, id: p.id, data: data }); bump(p.coll); },
      update: async function (patch) { await rpc('patch', { c: p.coll, id: p.id, data: patch }); bump(p.coll); },
      delete: async function () { await rpc('delete', a); bump(p.coll); },
      onSnapshot: function (cb, err) {
        return sub({ coll: p.coll, cb: cb, err: err, fetch: async function () { var r = await rpc('get', a); return { version: r.version, sig: r.exists ? r.data : null, snap: function () { return docSnap(r, p.id); } }; } });
      }
    };
  }
  function colRef(path, q) {
    q = q || {}; var c = parseCol(path);
    function args() { var r = { c: c, ob: q.ob || null, dir: q.dir || 'asc', lim: q.lim || 0 }; if (q.w && q.w.length) r.w = q.w; return r; }
    return {
      path: path,
      doc: function (id) { return docRef(path + '/' + (id || autoId())); },
      orderBy: function (f, d) { return colRef(path, { ob: f, dir: d || 'asc', lim: q.lim, w: q.w }); },
      limit: function (n) { return colRef(path, { ob: q.ob, dir: q.dir, lim: n, w: q.w }); },
      where: function (f, op, v) { return colRef(path, { ob: q.ob, dir: q.dir, lim: q.lim, w: (q.w || []).concat([[f, op, v]]) }); },
      get: async function () { return querySnap((await rpc('list', args())).items); },
      add: async function (data) { var r = docRef(path + '/' + autoId()); await r.set(data); return r; },
      onSnapshot: function (cb, err) {
        return sub({ coll: c, cb: cb, err: err, fetch: async function () {
          var r = await rpc('list', args());
          /* a complete collection read from the server becomes the local copy again, so later changes arrive as small deltas */
          try { if (BOOT_OK && !q.w && r && r.items && (!BOOT[c] || BOOT[c].version < r.version) && (!q.lim || r.items.length < q.lim) && r.version) { var docs = {}; r.items.forEach(function (it) { docs[it.id] = it.data; }); BOOT[c] = { version: r.version, docs: docs }; } } catch (e) {}
          return { version: r.version, sig: r.items, snap: function () { return querySnap(r.items); } };
        } });
      }
    };
  }
  var DB = { collection: colRef, doc: docRef };

  /* ---------- user ---------- */
  function uid() { try { var k = localStorage.getItem('pet_shim_uid'); if (!k) { k = 'u' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('pet_shim_uid', k); } return k; } catch (e) { return 'u' + Math.random().toString(36).slice(2); } }
  var USER = {
    id: async function () { return uid(); }, me: async function () { return { id: uid(), name: '', guest: false }; },
    isOwner: function () { return false; }, canEdit: function () { return false; }, can: function () { return null; },
    profiles: async function (ids) { var o = {}; (ids || []).forEach(function (i) { o[i] = { id: i, name: '' }; }); return o; }
  };

  /* ---------- assets API ---------- */
  function readDataUrl(blob) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(mkErr('Could not read the file', 'invalid_argument')); }; fr.readAsDataURL(blob); }); }
  var ASSETS = {
    upload: async function (blob) {
      if (blob && blob.size > MAX_ASSET) throw mkErr('File is larger than ' + (MAX_ASSET / 1048576) + ' MB', 'too_large');
      var data = await readDataUrl(blob);
      var r = await rpc('asset_put', { name: blob.name || 'upload', type: blob.type || 'application/octet-stream', data: data }, 90000);
      ASSET_CACHE[r.id] = data; r.url = data; return r;
    },
    list: async function () { return rpc('asset_list', {}); },
    delete: async function (id) { delete ASSET_CACHE[id]; await rpc('asset_del', { id: id }); }
  };

  /* ---------- downloads (browser save) ---------- */
  var DOWNLOADS = {
    save: async function (o) {
      var b = (o.data instanceof Blob) ? o.data : new Blob([o.data]); var a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = o.filename || 'download'; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); return { saved: true };
    }
  };

  /* ---------- claude.use ---------- */
  var probe = null;
  window.claude = {
    use: async function (name) {
      if (name === 'db') {
        if (window.parent === window) return null;                       // opened outside Streamlit: local mode
        if (!probe) probe = CACHED ? Promise.resolve(true) : Promise.race([READY.then(function () { return true; }), CACHE_P.then(function (ok) { return ok ? true : READY.then(function () { return true; }); })]);   // Nov 18: with a kept copy the page starts at once      // never fall back to local mode just because the first connection is slow (the status badge says when it is not connected)
        return (await probe) ? DB : null;
      }
      if (name === 'user') return USER;
      if (name === 'assets') return ASSETS;
      if (name === 'downloads') return DOWNLOADS;
      return null;
    }
  };

  /* ---------- Streamlit frame + status badge ---------- */
  var lastH = 0;
  function height(force) { var h = 700; try { var top = 0; try { top = Math.max(0, window.frameElement.getBoundingClientRect().top + (window.parent.scrollY || window.parent.pageYOffset || 0)); } catch (e) {}   /* position on the page, not on the screen: scrolling must not change the height (Nov 17) */ h = Math.max(420, (window.parent.innerHeight || 800) - top - 8); } catch (e) {} if (force === true || Math.abs(h - lastH) > 2) { lastH = h; send('streamlit:setFrameHeight', { height: h }); } }
  try { window.addEventListener('resize', height); } catch (e) {}
  send('streamlit:componentReady', { apiVersion: 1 }); height(true);
  /* the page around the app can change (a message above it, the sidebar): keep the frame filling the window, and resend
     it now and then in case Streamlit redrew the frame at another size (an almost empty screen) */
  /* the height is worked out at start and when the window is resized (never while scrolling: that moved the page);
     the same height is sent again now and then in case Streamlit redrew the frame at another size */
  setInterval(function () { if (lastH) send('streamlit:setFrameHeight', { height: lastH }); }, 30000);
  try { document.addEventListener('visibilitychange', function () { if (!document.hidden && lastH) send('streamlit:setFrameHeight', { height: lastH }); }); } catch (e) {}

  /* Status badge: silent while everything works (like the rest of the page, saves just happen).
   * It appears only when something needs attention, and its text never changes while it is shown. */
  try {
    var pill = null, shown = '', t0 = Date.now(), pend = '', pendAt = 0;
    setInterval(function () {
      var t = '', bg = '#b45309';
      var now = Date.now(), waiting = Object.keys(PEND).some(function (k) { var p = PEND[k]; return p.w && ((p.firstFail && now - p.firstFail > 8000) || (p.sent && now - p.sent > 20000)); });
      if (!SYNC) { if (now - t0 > 10000) t = '⚠ Not connected — changes are NOT saved'; }
      else if (DOWN || waiting) t = '⏳ Reconnecting to the database — your changes are kept and will save automatically';
      else if (ERR) { t = '❌ Storage error — changes may not be saved'; bg = '#b91c1c'; }
      else if (STORE === 'memory') t = '⚠ MongoDB not connected — data is NOT saved';
      /* Nov 18: connection trouble is handled quietly in the background; a notice appears only if it lasts more than a minute */
      if (t && t !== shown) { if (t !== pend) { pend = t; pendAt = now; } if (now - pendAt < (t.indexOf('MongoDB not connected') >= 0 ? 6000 : 60000)) return; } else pend = '';   // reconnecting happens quietly in the background; it is shown only if it lasts
      if (t === shown) return;
      shown = t;
      if (!t) { if (pill) pill.style.display = 'none'; return; }
      if (!pill && document.body) {
        pill = document.createElement('div');
        pill.style.cssText = 'position:fixed;left:12px;bottom:10px;z-index:99999;font:600 11px system-ui,sans-serif;padding:4px 10px;border-radius:999px;color:#fff;opacity:.92;pointer-events:none';
        document.body.appendChild(pill);
      }
      if (pill) { pill.textContent = t; pill.style.background = bg; pill.style.display = ''; }
    }, 1500);
  } catch (e) {}
})();
