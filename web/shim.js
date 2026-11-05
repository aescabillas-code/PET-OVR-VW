/* PET Station runtime shim (Streamlit component bridge)
 * The app talks to a tiny `window.claude.use(...)` runtime (db, user, assets, downloads).
 * This file implements that surface by sending requests to the Streamlit server (streamlit_app.py), which
 * reads/writes MongoDB directly. No separate API server and no browser -> API connection is needed.
 *
 * Browser -> server : setComponentValue({cid, tick, reqs:[{id, op, a}], ack:[ids]})
 * Server -> browser : streamlit:render args.reply = {ok, err, store, vers:{collection:version}, res:{id:{ok|err}}}
 * Live updates      : every reply carries the change counter of each collection; watchers refetch what changed.
 */
(function () {
  var POLL = 1200, TIMEOUT = 25000, MAX_ASSET = 10 * 1024 * 1024;
  var CID = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var SEQ = 0, TICK = 0, PEND = {}, ACK = [], SYNC = false, VERS = {}, STORE = '', ERR = '', lastOk = 0, kickT = null;

  function send(type, extra) { try { window.parent.postMessage(Object.assign({ isStreamlitMessage: true, type: type }, extra || {}), '*'); } catch (e) {} }
  function mkErr(msg, code) { var e = new Error(msg); e.code = code; return e; }

  /* ---------- request / response over the component value ---------- */
  function flush() {
    if (!SYNC) return;
    var now = Date.now(), reqs = [];
    Object.keys(PEND).forEach(function (k) {
      var p = PEND[k];
      if (!p.sent || now - p.sent > 10000) { p.sent = now; reqs.push({ id: p.id, op: p.op, a: p.a }); }
    });
    send('streamlit:setComponentValue', { value: { cid: CID, tick: ++TICK, reqs: reqs, ack: ACK.splice(0) }, dataType: 'json' });
  }
  function kick() { if (kickT) return; kickT = setTimeout(function () { kickT = null; flush(); }, 40); }
  function rpc(op, a, timeout) {
    return new Promise(function (resolve, reject) {
      var id = ++SEQ;
      PEND[id] = { id: id, op: op, a: a, resolve: resolve, reject: reject, sent: 0, due: Date.now() + (timeout || TIMEOUT) };
      kick();
    });
  }
  function beat() {
    var now = Date.now();
    Object.keys(PEND).forEach(function (k) {
      var p = PEND[k];
      if (now > p.due) { delete PEND[k]; p.reject(mkErr('Cannot reach the database', 'unavailable')); }
    });
    flush();
  }
  setInterval(beat, POLL);

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.type !== 'streamlit:render') return;
    SYNC = true;
    var r = (d.args || {}).reply || {};
    STORE = r.store || STORE;
    ERR = r.ok === false ? (r.err || 'storage error') : '';
    var res = r.res || {};
    Object.keys(res).forEach(function (id) {
      var p = PEND[id]; if (!p) return;
      delete PEND[id]; ACK.push(+id); lastOk = Date.now();
      var x = res[id] || {};
      if (x.err) p.reject(mkErr(x.err.message || 'Request failed', x.err.code || 'unavailable')); else p.resolve(x.ok === undefined ? null : x.ok);
    });
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
    try { return typeof SND_SRC !== 'undefined' ? SND_SRC : ''; } catch (e) { return ''; }   // default sound until the shared one has loaded
  };

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
      if (name === 'db') { if (!probe) probe = rpc('versions', {}, 15000).then(function () { return true; }, function () { return false; }); return (await probe) ? DB : null; }
      if (name === 'user') return USER;
      if (name === 'assets') return ASSETS;
      if (name === 'downloads') return DOWNLOADS;
      return null;
    }
  };

  /* ---------- Streamlit frame + status badge ---------- */
  function height() { var h = 900; try { h = Math.max(720, (window.parent.innerHeight || 900) - 24); } catch (e) {} send('streamlit:setFrameHeight', { height: h }); }
  try { window.addEventListener('resize', height); } catch (e) {}
  send('streamlit:componentReady', { apiVersion: 1 }); height();

  try {
    var pill = null;
    var mkPill = function () {
      if (pill || !document.body) return;
      pill = document.createElement('div');
      pill.style.cssText = 'position:fixed;left:12px;bottom:10px;z-index:99999;font:600 11px system-ui,sans-serif;padding:4px 10px;border-radius:999px;color:#fff;opacity:.9;pointer-events:none';
      document.body.appendChild(pill);
    };
    setInterval(function () {
      mkPill(); if (!pill) return;
      var t, bg = '#0A1C2E', pending = Object.keys(PEND).length;
      if (!SYNC) { t = '⚠ Not connected — changes are NOT saved'; bg = '#b45309'; }
      else if (ERR) { t = '❌ Storage error: ' + ERR; bg = '#b91c1c'; }
      else if (STORE === 'memory') { t = '⚠ MongoDB not connected — data is NOT saved'; bg = '#b45309'; }
      else if (pending > 0) t = '⏳ Saving…';
      else t = '💾 Saved to MongoDB' + (lastOk ? ' · ' + new Date(lastOk).toLocaleTimeString() : '');
      pill.textContent = t; pill.style.background = bg;
    }, 1000);
  } catch (e) {}
})();
