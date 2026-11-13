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

  function send(type, extra) { try { window.parent.postMessage(Object.assign({ isStreamlitMessage: true, type: type }, extra || {}), '*'); } catch (e) {} }
  function mkErr(msg, code) { var e = new Error(msg); e.code = code; return e; }

  /* ---------- request / response over the component value ---------- */
  function flush() {
    if (!SYNC) return;
    var now = Date.now(), reqs = [];
    /* one message at a time: while the server is still answering the last one, wait (the answer triggers the next send).
       A second message sent too early can cut the first one off on a slow connection. After HOLD ms we send anyway. */
    if (AWAIT && now - AWAIT < HOLD) return;
    Object.keys(PEND).forEach(function (k) {
      var p = PEND[k];
      if (p.after && now < p.after) return;                                       // waiting before trying again
      if (!p.sent || now - p.sent > 10000) { p.sent = now; reqs.push({ id: p.id, op: p.op, a: p.a }); }
    });
    AWAIT = now;
    send('streamlit:setComponentValue', { value: { cid: CID, tick: ++TICK, reqs: reqs, ack: ACK.splice(0), have: haveVers() }, dataType: 'json' });
  }
  /* the version of each collection this page already holds: the server sends back only what is newer */
  function haveVers() { var h = {}; try { W.forEach(function (w) { if (w.v != null && (h[w.coll] === undefined || w.v < h[w.coll])) h[w.coll] = w.v; }); } catch (e) {} return h; }
  function kick() { if (kickT) return; kickT = setTimeout(function () { kickT = null; flush(); }, 40); }
  function localRead(op, a) {
    if (!BOOT_OK) return undefined;
    if (op === 'versions') return VERS;
    if (op !== 'get' && op !== 'list') return undefined;
    var b = BOOT[a.c];
    if (b && (VERS[a.c] || 0) !== b.version) { delete BOOT[a.c]; b = null; }
    if (!b) { if (VERS[a.c]) return undefined; b = { version: 0, docs: {} }; }
    if (b.partial) return undefined;
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
  function obRead() { try { return JSON.parse(localStorage.getItem(OUTBOX) || '{}') || {}; } catch (e) { return {}; } }
  function obWrite(o) { try { if (Object.keys(o).length) localStorage.setItem(OUTBOX, JSON.stringify(o)); else localStorage.removeItem(OUTBOX); } catch (e) {} }
  function obAdd(p) { if (p.op === 'asset_put' || p.op === 'asset_del') return; var o = obRead(); o[p.ob] = { op: p.op, a: p.a, t: Date.now() }; obWrite(o); }
  function obDel(p) { if (!p.ob) return; var o = obRead(); if (o[p.ob]) { delete o[p.ob]; obWrite(o); } }
  function rpc(op, a, timeout) {
    if (op === 'put' || op === 'patch' || op === 'delete') delete BOOT[a.c];     // our own write: the first-load copy is stale now
    var loc = localRead(op, a);
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
  function replayOutbox() {
    var o = obRead(), now = Date.now(), keys = Object.keys(o).filter(function (k) { return k.indexOf(CID + ':') !== 0; });
    keys.sort(function (x, y) { return (o[x].t || 0) - (o[y].t || 0); });
    if (!keys.length) return;
    var cur = obRead(); keys.forEach(function (k) { delete cur[k]; }); obWrite(cur);   // each one is re-added under this page while it is sent
    keys.forEach(function (k) {
      var e = o[k];
      if (!e || !e.op || !WRITE_OPS[e.op] || now - (e.t || 0) > 10 * 60000) return;   // too old: newer data may exist
      rpc(e.op, e.a).then(function () { try { bump(e.a.c); } catch (x) {} }, function () {});
    });
  }
  function beat() {
    var now = Date.now();
    Object.keys(PEND).forEach(function (k) {
      var p = PEND[k];
      if (now > p.due) { delete PEND[k]; obDel(p); p.reject(mkErr('Cannot reach the database', 'unavailable')); }
    });
    flush();
  }
  setInterval(beat, POLL);   // idle heartbeat: one quiet rerun every few seconds; saves go out immediately (kick)

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.type !== 'streamlit:render') return;
    var r = (d.args || {}).reply || {};
    var first = !SYNC;
    if (r.boot && !BOOT_OK) { BOOT = r.boot; BOOT_OK = true; }
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
    if (r.vers) { VERS = r.vers; onVers(); }
    if (Object.keys(PEND).some(function (k) { return !PEND[k].sent; })) kick();
  });

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
    function args() { return { c: c, ob: q.ob || null, dir: q.dir || 'asc', lim: q.lim || 0 }; }
    return {
      path: path,
      doc: function (id) { return docRef(path + '/' + (id || autoId())); },
      orderBy: function (f, d) { return colRef(path, { ob: f, dir: d || 'asc', lim: q.lim }); },
      limit: function (n) { return colRef(path, { ob: q.ob, dir: q.dir, lim: n }); },
      get: async function () { return querySnap((await rpc('list', args())).items); },
      add: async function (data) { var r = docRef(path + '/' + autoId()); await r.set(data); return r; },
      onSnapshot: function (cb, err) {
        return sub({ coll: c, cb: cb, err: err, fetch: async function () { var r = await rpc('list', args()); return { version: r.version, sig: r.items, snap: function () { return querySnap(r.items); } }; } });
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
        if (!probe) probe = READY.then(function () { return true; });      // never fall back to local mode just because the first connection is slow (the status badge says when it is not connected)
        return (await probe) ? DB : null;
      }
      if (name === 'user') return USER;
      if (name === 'assets') return ASSETS;
      if (name === 'downloads') return DOWNLOADS;
      return null;
    }
  };

  /* ---------- Streamlit frame + status badge ---------- */
  function height() { var h = 700; try { var top = 0; try { top = Math.max(0, window.frameElement.getBoundingClientRect().top); } catch (e) {} h = Math.max(420, (window.parent.innerHeight || 800) - top - 8); } catch (e) {} send('streamlit:setFrameHeight', { height: h }); }
  try { window.addEventListener('resize', height); } catch (e) {}
  send('streamlit:componentReady', { apiVersion: 1 }); height();

  /* Status badge: silent while everything works (like the rest of the page, saves just happen).
   * It appears only when something needs attention, and its text never changes while it is shown. */
  try {
    var pill = null, shown = '', t0 = Date.now();
    setInterval(function () {
      var t = '', bg = '#b45309';
      var now = Date.now(), waiting = Object.keys(PEND).some(function (k) { var p = PEND[k]; return p.w && ((p.firstFail && now - p.firstFail > 3000) || (p.sent && now - p.sent > 8000)); });
      if (!SYNC) { if (now - t0 > 10000) t = '⚠ Not connected — changes are NOT saved'; }
      else if (DOWN || waiting) t = '⏳ Reconnecting to the database — your changes are kept and will save automatically';
      else if (ERR) { t = '❌ Storage error — changes may not be saved'; bg = '#b91c1c'; }
      else if (STORE === 'memory') t = '⚠ MongoDB not connected — data is NOT saved';
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
