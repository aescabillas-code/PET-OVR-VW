// web/shim.js against a fake Streamlit server whose database drops out: saves must survive and arrive once it is back.
const vm = require('vm'), fs = require('fs'), path = require('path');
const shim = fs.readFileSync(path.join(__dirname, '..', 'web/shim.js'), 'utf8');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function browser(ls, server) {
  const handlers = [];
  const render = reply => setTimeout(() => handlers.forEach(h => h({ data: { type: 'streamlit:render', args: { reply } } })), 5);
  const ctx = vm.createContext({
    console, Promise, Date, JSON, Math, Object, Array, String, Number, RegExp, Blob, URL, setTimeout, setInterval, clearTimeout, clearInterval,
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } },
    document: { body: null, createElement: () => ({ style: {} }), cookie: '' },
    addEventListener: (t, f) => { if (t === 'message') handlers.push(f); },
    parent: { innerHeight: 800, postMessage(m) { if (m.type === 'streamlit:componentReady') render(server(null)); else if (m.type === 'streamlit:setComponentValue') render(server(m.value)); } }
  });
  ctx.window = ctx; ctx.window.parent = ctx.parent;
  vm.runInContext(shim, ctx);
  return ctx;
}

function makeServer() {
  const S = { down: true, docs: {}, seen: {}, ver: 1, puts: 0 };
  S.fn = msg => {
    const base = { ok: !S.down, down: S.down, store: 'mongodb', vers: { cases: S.ver } };
    if (!msg) return Object.assign(base, { synced: false, res: {}, boot: { cases: { version: S.ver, docs: {} } } });
    const res = {};
    (msg.reqs || []).forEach(r => {
      if (S.down) { res[r.id] = { err: { code: 'unavailable', message: 'Database unavailable', retry: true } }; return; }
      if (r.op === 'put') { S.docs[r.a.id] = r.a.data; S.ver++; S.puts++; res[r.id] = { ok: null }; }
      else res[r.id] = { ok: { version: S.ver, items: [] } };
    });
    return Object.assign(base, { synced: true, res, vers: { cases: S.ver } });
  };
  return S;
}

(async () => {
  const ls = {};
  const S = makeServer();
  const A = browser(ls, m => S.fn(m));
  const db = await vm.runInContext("claude.use('db')", A);
  let settled = null;
  db.doc('cases/PET-1').set({ x: 1 }).then(() => { settled = 'saved'; }, e => { settled = 'failed:' + e.code; });
  await sleep(2500);
  ok(settled === null, 'a save during an outage is kept waiting, not failed (' + settled + ')');
  ok(/PET-1/.test(ls.pet_outbox || ''), 'the unsaved change is kept in browser storage too');
  S.down = false;
  await sleep(9000);
  ok(settled === 'saved', 'the save arrives by itself once the database is back (' + settled + ')');
  ok(S.docs['PET-1'] && S.docs['PET-1'].x === 1 && S.puts === 1, 'saved exactly once');
  ok(!ls.pet_outbox, 'outbox emptied after saving');

  // a page closed while a save was still waiting: the next page sends it
  ls.pet_outbox = JSON.stringify({ 'cOLD:7': { op: 'put', a: { c: 'cases', id: 'PET-2', data: { y: 2 } }, t: Date.now() - 1000 },
                                   'cOLD:8': { op: 'put', a: { c: 'cases', id: 'PET-OLD', data: { y: 0 } }, t: Date.now() - 3600000 } });
  const S2 = makeServer(); S2.down = false; S2.docs = S.docs; S2.ver = S.ver;
  browser(ls, m => S2.fn(m));
  await sleep(2500);
  ok(S2.docs['PET-2'] && S2.docs['PET-2'].y === 2, 'a change left unsaved by a closed page is saved by the next page');
  ok(!S2.docs['PET-OLD'], 'very old leftovers are not replayed (newer data may exist)');
  ok(!ls.pet_outbox, 'outbox emptied after replay');
  // realtime: a change made elsewhere arrives as a small delta and shows without a refresh (no full re-read)
  {
    const S3 = { ver: 5, docs: { a: { owner: 'A', ts: 1 }, b: { owner: 'B', ts: 2 } }, lists: 0, pending: null };
    const fn = msg => {
      const base = { ok: true, store: 'mongodb', vers: { cases: S3.ver } };
      if (!msg) return Object.assign(base, { synced: false, res: {}, boot: { cases: { version: 5, docs: JSON.parse(JSON.stringify(S3.docs)) } } });
      const res = {}; (msg.reqs || []).forEach(r => { if (r.op === 'list') { S3.lists++; res[r.id] = { ok: { version: S3.ver, items: Object.keys(S3.docs).map(id => ({ id, data: S3.docs[id] })) } }; } else res[r.id] = { ok: null }; });
      const out = Object.assign(base, { synced: true, res });
      if (S3.pending && msg.have && msg.have.cases === S3.pending.from) out.delta = { cases: S3.pending };
      return out;
    };
    const ls3 = {}, C = browser(ls3, m => fn(m));
    const db3 = await vm.runInContext("claude.use('db')", C);
    let seen = null;
    db3.collection('cases').orderBy('ts', 'desc').limit(1000).onSnapshot(q => { seen = q.docs.map(d => d.id + ':' + d.data().owner).join(','); });
    await sleep(1500);
    ok(seen === 'b:B,a:A' && S3.lists === 0, 'first view comes from the copy delivered with the page (' + seen + ', reads ' + S3.lists + ')');
    S3.docs.a.owner = 'Z'; S3.ver = 6; S3.pending = { from: 5, version: 6, docs: { a: { owner: 'Z', ts: 1 } } };
    await sleep(2500);
    ok(seen === 'b:B,a:Z' && S3.lists === 0, "another person's change shows on its own, sent as one changed document (" + seen + ', reads ' + S3.lists + ')');
  }
  console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
  process.exit(fails ? 1 : 0);
})();
