/* PET Station runtime shim
 * The app talks to a tiny `window.claude.use(...)` runtime (db, user, assets, downloads).
 * This file implements that surface on top of the REST API so the HTML runs unchanged inside Streamlit.
 * Live updates: poll GET /api/versions (one cheap request) and refetch only the collections that changed.
 */
(function () {
  var CFG = window.__PET_CFG || {};
  var API = String(CFG.api || '/api').replace(/\/+$/, '');
  var TOK = CFG.token || '';
  var POLL = CFG.poll || 1500;

  function hdr(json) { var h = {}; if (TOK) h['X-API-Key'] = TOK; if (json) h['Content-Type'] = 'application/json'; return h; }
  function mkErr(msg, code) { var e = new Error(msg); e.code = code; return e; }
  function fromResp(r, m) {
    var d = m && m.detail;
    var code = (d && d.code) || (r.status === 404 ? 'not_found' : (r.status === 400 || r.status === 422) ? 'invalid_argument' : (r.status === 401 || r.status === 403) ? 'permission_denied' : 'unavailable');
    return mkErr((d && d.message) || (typeof d === 'string' ? d : r.statusText) || 'Request failed', code);
  }
  async function call(method, path, body, raw) {
    var o = { method: method, headers: hdr(body !== undefined && !raw) };
    if (body !== undefined) o.body = raw ? body : JSON.stringify(body);
    var r;
    try { r = await fetch(API + path, o); } catch (e) { throw mkErr('Cannot reach the API', 'unavailable'); }
    if (!r.ok) { var m = null; try { m = await r.json(); } catch (e) {} throw fromResp(r, m); }
    return r.status === 204 ? null : r.json();
  }

  var SEG = /^[A-Za-z0-9_\-]+$/, DOCID = /^[A-Za-z0-9_.\-~:@+]{1,200}$/;
  function parts(p) { return String(p).split('/').filter(Boolean); }
  function coll(a) { a.forEach(function (s) { if (!SEG.test(s)) throw mkErr('Invalid path', 'invalid_argument'); }); return a.join('__'); }
  function parseDoc(p) { var a = parts(p); if (a.length < 2 || a.length % 2) throw mkErr('Invalid document path', 'invalid_argument'); var id = a[a.length - 1]; if (!DOCID.test(id)) throw mkErr('Invalid document id', 'invalid_argument'); return { coll: coll(a.slice(0, -1)), id: id }; }
  function parseCol(p) { var a = parts(p); if (!a.length || a.length % 2 === 0) throw mkErr('Invalid collection path', 'invalid_argument'); return coll(a); }
  function autoId() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  function docSnap(r, id) { var data = r && r.exists ? clone(r.data) : undefined; return { id: id, exists: !!(r && r.exists), data: function () { return clone(data); }, metadata: { hasPendingWrites: false, fromCache: false } }; }
  function querySnap(items) {
    var docs = items.map(function (it) { var d = clone(it.data); return { id: it.id, exists: true, data: function () { return clone(d); }, metadata: { hasPendingWrites: false } }; });
    return { docs: docs, size: docs.length, empty: !docs.length, metadata: { hasPendingWrites: false }, forEach: function (f) { docs.forEach(f); } };
  }

  /* ---------- live updates (polling) ---------- */
  var W = [], timer = null, busy = false;
  async function refresh(w, force) {
    var res;
    try { res = await w.fetch(); } catch (e) { var n = Date.now(); if (w.err && n - (w.le || 0) > 10000) { w.le = n; w.err(e); } return; }
    w.v = res.version;
    var sig = JSON.stringify(res.sig);
    if (force || sig !== w.sig) { w.sig = sig; try { w.cb(res.snap()); } catch (e) { if (window.console) console.error(e); } }
  }
  async function tick() {
    if (busy || !W.length) return; busy = true;
    try { var vs = await call('GET', '/versions'); W.slice().forEach(function (w) { if ((vs[w.coll] || 0) !== w.v) refresh(w); }); } catch (e) {}
    busy = false;
  }
  function sub(w) { W.push(w); if (!timer) timer = setInterval(tick, POLL); refresh(w, true); return function () { var i = W.indexOf(w); if (i >= 0) W.splice(i, 1); }; }
  function bump(c) { W.forEach(function (w) { if (w.coll === c) refresh(w); }); }

  /* ---------- db ---------- */
  function docRef(path) {
    var p = parseDoc(path), base = '/' + p.coll + '/' + encodeURIComponent(p.id);
    return {
      id: p.id, path: path,
      get: async function () { return docSnap(await call('GET', base + '?envelope=true'), p.id); },
      set: async function (data) { await call('PUT', base, data); bump(p.coll); },
      update: async function (patch) { await call('PATCH', base, patch); bump(p.coll); },
      delete: async function () { await call('DELETE', base); bump(p.coll); },
      onSnapshot: function (cb, err) {
        return sub({ coll: p.coll, cb: cb, err: err, fetch: async function () { var r = await call('GET', base + '?envelope=true'); return { version: r.version, sig: r.exists ? r.data : null, snap: function () { return docSnap(r, p.id); } }; } });
      }
    };
  }
  function colRef(path, q) {
    q = q || {}; var c = parseCol(path);
    function qs() { var a = ['envelope=true']; if (q.ob) a.push('orderBy=' + encodeURIComponent(q.ob), 'direction=' + (q.dir || 'asc')); if (q.lim) a.push('limit=' + q.lim); return '?' + a.join('&'); }
    return {
      path: path,
      doc: function (id) { return docRef(path + '/' + (id || autoId())); },
      orderBy: function (f, d) { return colRef(path, { ob: f, dir: d || 'asc', lim: q.lim }); },
      limit: function (n) { return colRef(path, { ob: q.ob, dir: q.dir, lim: n }); },
      get: async function () { return querySnap((await call('GET', '/' + c + qs())).items); },
      add: async function (data) { var r = docRef(path + '/' + autoId()); await r.set(data); return r; },
      onSnapshot: function (cb, err) {
        return sub({ coll: c, cb: cb, err: err, fetch: async function () { var r = await call('GET', '/' + c + qs()); return { version: r.version, sig: r.items, snap: function () { return querySnap(r.items); } }; } });
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

  /* ---------- assets (stored in MongoDB GridFS) ---------- */
  window.__assetUrl = function (id) { return API + '/assets/' + encodeURIComponent(id) + (TOK ? '?key=' + encodeURIComponent(TOK) : ''); };
  var ASSETS = {
    upload: async function (blob) { var fd = new FormData(); fd.append('file', blob, blob.name || 'upload'); var r = await call('POST', '/assets', fd, true); r.url = window.__assetUrl(r.id); return r; },
    list: async function () { return call('GET', '/assets'); },
    delete: async function (id) { await call('DELETE', '/assets/' + encodeURIComponent(id)); }
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
      if (name === 'db') { if (!probe) probe = call('GET', '/versions').then(function () { return true; }, function () { return false; }); return (await probe) ? DB : null; }
      if (name === 'user') return USER;
      if (name === 'assets') return ASSETS;
      if (name === 'downloads') return DOWNLOADS;
      return null;
    }
  };
})();
