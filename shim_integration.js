// Runs the real app script + web/shim.js in two simulated browsers against an in-memory copy of the REST contract.
// Verifies: data written by one screen is saved through the API and appears on the other screen.
const vm = require('vm'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/pet_station.html'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'web/shim.js'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts[scripts.length - 1].replace(/renderUser\(\);render\(\);initDb\(\);setInterval[\s\S]*$/, '');

// ---- in-memory server implementing the same contract as api/main.py
const store = {}, ver = {};
const bump = c => (ver[c] = (ver[c] || 0) + 1);
async function fetchMock(url, o = {}) {
  const u = new URL(url, 'http://api.test'), p = u.pathname.replace(/^\/api/, '').split('/').filter(Boolean), m = (o.method || 'GET').toUpperCase();
  const json = (b, s = 200) => ({ ok: s < 400, status: s, statusText: '', json: async () => JSON.parse(JSON.stringify(b)) });
  if (p[0] === 'versions') return json(ver);
  const c = p[0], id = p[1] && decodeURIComponent(p[1]); store[c] = store[c] || {};
  const body = o.body && typeof o.body === 'string' ? JSON.parse(o.body) : null;
  if (!id && m === 'GET') {
    let items = Object.entries(store[c]).map(([i, d]) => ({ id: i, data: d, updated: 0 }));
    const ob = u.searchParams.get('orderBy'), dir = u.searchParams.get('direction');
    if (ob) items.sort((a, b) => ((a.data[ob] ?? 0) - (b.data[ob] ?? 0)) * (dir === 'desc' ? -1 : 1));
    const lim = +u.searchParams.get('limit') || 1000; return json({ version: ver[c] || 0, count: items.length, items: items.slice(0, lim) });
  }
  if (id && m === 'GET') { const d = store[c][id]; return json(d ? { version: ver[c] || 0, id, exists: true, data: d } : { version: ver[c] || 0, id, exists: false, data: null }); }
  if (id && m === 'PUT') { store[c][id] = body; bump(c); return json({ id }); }
  if (id && m === 'PATCH') { if (!store[c][id]) return json({ detail: { code: 'not_found', message: 'nf' } }, 404); Object.assign(store[c][id], body); bump(c); return json({ id }); }
  if (id && m === 'DELETE') { delete store[c][id]; bump(c); return { ok: true, status: 204, json: async () => null }; }
  return json({ detail: 'bad' }, 400);
}

function client(me) {
  const els = {};
  const mk = () => new Proxy({ value: '', checked: false, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return true; } }, focus() {}, select() {}, pause() {}, play() { return Promise.resolve(); }, remove() {}, appendChild() {}, setAttribute() {}, textContent: '' }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });
  const ls = { pet_me: JSON.stringify(me) };
  const wrapT = fn => (f, ms) => fn(() => { try { f(); } catch (e) {} }, ms);
  const ctx = vm.createContext({
    console, fetch: fetchMock, URL, FormData, Blob, Promise, Date, JSON, Math, Set, Map, Object, Array, String, Number, RegExp, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, TextEncoder, Uint8Array,
    setTimeout: wrapT(setTimeout), setInterval: wrapT(setInterval), clearTimeout, clearInterval,
    localStorage: { getItem: k => ls[k] ?? null, setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } },
    Audio: function () { return mk(); }, XLSX: undefined,
    document: { getElementById: id => els[id] || (els[id] = mk()), querySelector: () => ({ value: 'all' }), querySelectorAll: () => [], activeElement: null, hidden: false, addEventListener() {}, createElement: () => mk(), body: mk() },
    crypto: require('crypto').webcrypto
  });
  ctx.window = ctx; ctx.__PET_CFG = { api: '/api', poll: 300 };
  vm.runInContext(shim, ctx);
  vm.runInContext(app, ctx);
  return { ctx, run: c => vm.runInContext(c, ctx), els };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const A = client({ role: 'coordinator', name: 'Coordinator' });
  await A.run('initDb()'); await sleep(1500);
  console.log('A connected to API:', A.run('DBON'));
  A.run('openAdd()'); A.run("document.getElementById('add-id').value='PET-TEST-1';document.getElementById('add-hp').checked=true");
  A.run('addCase()'); await sleep(1500);
  console.log('cases stored in "database":', Object.keys(store.cases || {}));
  console.log('activity rows stored:', Object.keys(store.act || {}).length, '| config docs:', Object.keys(store.config || {}));
  const B = client({ role: 'manager', name: 'Jeff Bote' });
  await B.run('initDb()'); await sleep(1500);
  console.log('B (second screen) sees cases:', B.run('CASES.map(c=>c.id).join(",")'));
  // B changes the case; A must receive it
  B.run("(()=>{const c=getCase('PET-TEST-1');c.hp=false;queueSave(c)})()"); await sleep(1500);
  console.log('A sees priority change from B:', A.run("getCase('PET-TEST-1').hp"));
  const ok = Object.keys(store.cases || {}).includes('PET-TEST-1') && B.run('CASES.some(c=>c.id==="PET-TEST-1")') && A.run("getCase('PET-TEST-1').hp") === false;
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL'); process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
