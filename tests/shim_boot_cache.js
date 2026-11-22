// web/shim.js: after a reload the last data seen is shown at once (not zeros), then replaced by the server's copy (Nov 18).
const vm = require('vm'), fs = require('fs'), path = require('path');
const shim = fs.readFileSync(path.join(__dirname, '..', 'web/shim.js'), 'utf8');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fakeIDB(store) {   // a tiny in-memory stand-in for IndexedDB (the kept copy lives there since Nov 19)
  const req = (res) => { const r = {}; setTimeout(() => { r.result = res; r.onsuccess && r.onsuccess(); }, 0); return r; };
  const os = { get: k => req(store[k]), put(v, k) { store[k] = v; }, clear() { Object.keys(store).forEach(k => delete store[k]); } };
  const db = { createObjectStore() {}, transaction() { const t = { objectStore: () => os }; setTimeout(() => t.oncomplete && t.oncomplete(), 0); return t; } };
  return { open() { return req(db); } };
}
function browser(ls, server, delay, store) {
  const handlers = [];
  const render = reply => setTimeout(() => handlers.forEach(h => h({ data: { type: 'streamlit:render', args: { reply } } })), delay);
  const ctx = vm.createContext({
    console, Promise, Date, JSON, Math, Object, Array, String, Number, RegExp, Blob, URL, setTimeout, setInterval, clearTimeout, clearInterval,
    indexedDB: fakeIDB(store || {}),
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } },
    document: { body: null, createElement: () => ({ style: {} }), cookie: '', addEventListener() {} },
    addEventListener: (t, f) => { if (t === 'message') handlers.push(f); },
    parent: { innerHeight: 800, postMessage(m) { if (m.type === 'streamlit:componentReady') render(server(null)); else if (m.type === 'streamlit:setComponentValue') render(server(m.value)); } }
  });
  ctx.window = ctx; ctx.window.parent = ctx.parent;
  vm.runInContext(shim, ctx);
  return ctx;
}
(async () => {
  const ls = { pet_boot_cache: 'old text copy' };
  const store = { boot: { at: Date.now() - 60000, vers: { cases: 5 }, boot: { cases: { version: 5, docs: { A: { owner: 'Old' }, B: { owner: 'Bee' } } } } } };
  const server = msg => {
    const base = { ok: true, down: false, store: 'mongodb', vers: { cases: 6 } };
    if (!msg) return Object.assign(base, { synced: false, res: {}, boot: { cases: { version: 6, docs: { A: { owner: 'New' }, B: { owner: 'Bee' }, C: { owner: 'Cee' } } } } });
    return Object.assign(base, { synced: true, res: {} });
  };
  const A = browser(ls, server, 1500, store);              // a slow first answer (Streamlit reconnecting)
  const db = await vm.runInContext("claude.use('db')", A);
  const seen = [];
  db.collection('cases').onSnapshot(s => seen.push(s.docs.map(d => d.id + ':' + d.data().owner).sort().join()));
  await sleep(200);
  ok(seen[0] === 'A:Old,B:Bee', 'the kept copy is shown straight away instead of zeros (' + seen[0] + ')');
  ok(A.__petCacheOnly === true, 'the app knows it is only the kept copy (moves no cases on its own)');
  await sleep(2500);
  ok(seen[seen.length - 1] === 'A:New,B:Bee,C:Cee', 'the server\'s copy replaces it as soon as it arrives (' + seen[seen.length - 1] + ')');
  ok(A.__petCacheOnly === false, 'live again');
  ok(!seen.some(x => x === ''), 'never an empty list in between');
  ok(!('pet_boot_cache' in ls), 'the old text copy is removed from the browser storage');
  console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
