// web/shim.js: saves go first and messages stay small (no long delay behind big report reads, no choking the page) (Nov 18).
const vm = require('vm'), fs = require('fs'), path = require('path');
const shim = fs.readFileSync(path.join(__dirname, '..', 'web/shim.js'), 'utf8');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function browser(ls, server, delay) {
  const handlers = [];
  const render = reply => setTimeout(() => handlers.forEach(h => h({ data: { type: 'streamlit:render', args: { reply } } })), delay);
  const ctx = vm.createContext({
    console, Promise, Date, JSON, Math, Object, Array, String, Number, RegExp, Blob, URL, setTimeout, setInterval, clearTimeout, clearInterval,
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
  const msgs = [];
  const server = msg => {
    const base = { ok: true, down: false, store: 'mongodb', vers: { act: 1, cases: 1 } };
    if (!msg) return Object.assign(base, { synced: false, res: {}, boot: { cases: { version: 1, docs: {} } } });
    msgs.push(msg); const res = {};
    (msg.reqs || []).forEach(r => { res[r.id] = { ok: r.op === 'list' ? { version: 1, items: [] } : r.op === 'get' ? { version: 1, id: r.a.id, exists: false, data: null } : null }; });
    return Object.assign(base, { synced: true, res });
  };
  const A = browser({}, server, 30);
  const db = await vm.runInContext("claude.use('db')", A);
  await sleep(300);
  const reads = [];
  for (let i = 0; i < 10; i++) reads.push(db.collection('act').where('ts', '>=', i).get());
  for (let i = 0; i < 60; i++) reads.push(db.doc('cases/OLD-' + i).get());
  const save = db.doc('cases/PET-1').set({ store: '1234' });
  await save; await Promise.all(reads);
  const first = msgs.find(m => (m.reqs || []).length);
  const ops = first.reqs.map(r => r.op);
  ok(ops[0] === 'put' && ops.every(o => o === 'put'), 'the save goes out in its own message, ahead of the reads (' + ops.join(',') + ')');
  ok(msgs.every(m => (m.reqs || []).filter(r => r.op === 'list').length <= 4 && (m.reqs || []).filter(r => r.op === 'get').length <= 25), 'every message carries at most 4 list reads and 25 single reads');
  ok(msgs.filter(m => (m.reqs || []).length).length >= 3, 'the rest follow in the next messages (all ' + reads.length + ' reads answered)');
  console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
