// Stress check of web/shim.js against a SLOW server that behaves like Streamlit:
//  * only the newest message from the browser is kept (an older one that was not read yet is lost),
//  * a message that arrives while a run is still preparing the page cuts that run off (its answer is never drawn),
//  * every database request costs time.
// Verifies that every save still arrives, nothing is rejected, and a second screen sees the changes quickly.
// Usage: node tests/slow_server.js [path/to/shim.js]      (PET_EARLY=0 = older two-run server flow)
const vm = require('vm'), fs = require('fs'), path = require('path'), cp = require('child_process');
const shimPath = process.argv[2] || path.join(__dirname, '..', 'web/shim.js');
const shim = fs.readFileSync(shimPath, 'utf8');
const EARLY = process.env.PET_EARLY !== '0';
const DB = +(process.env.DB_MS || 250);          // one database round trip
const sleep = ms => new Promise(r => setTimeout(r, ms));
const py = cp.spawn(process.env.PYTHON || 'python3', [path.join(__dirname, 'slow_bridge.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '', waiters = [];
py.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim() && waiters.length) waiters.shift()(JSON.parse(l)); } });
const ask = m => new Promise(r => { waiters.push(r); py.stdin.write(JSON.stringify(m) + '\n'); });

let N = 0;
function client(cachedVersions) {
  const sid = 's' + (++N), handlers = [], st = { latest: null, seen: undefined, running: false, cut: false, runs: 0, cuts: 0, sent: 0 };
  const render = reply => handlers.forEach(h => h({ data: { type: 'streamlit:render', args: { reply } } }));
  async function loop() {
    if (st.running) return; st.running = true;
    for (;;) {
      const value = st.latest; st.seen = value; st.cut = false; st.runs++;
      const nreq = ((value && value.reqs) || []).length;
      // before the page is drawn: (new flow) the requests are handled here; the change counters are read
      const pre = await ask({ sid, op: 'pre', value });
      await sleep((EARLY ? nreq * 2 * DB : 0) + (cachedVersions ? 0 : DB) + 15);
      if (st.cut) { st.cuts++; continue; }                       // cut off before the page was drawn: answer not shown
      render(pre.reply);
      const post = await ask({ sid, op: 'post', value });
      await sleep((EARLY ? 0 : nreq * 2 * DB) + (cachedVersions ? 0 : DB) + 15);
      if (post.rerun || st.latest !== st.seen) continue;
      break;
    }
    st.running = false;
  }
  const parent = { innerHeight: 900, postMessage(m) {
    if (m.type === 'streamlit:componentReady') loop();
    else if (m.type === 'streamlit:setComponentValue') { st.sent++; st.latest = m.value; if (st.running) st.cut = true; loop(); }
  } };
  const ls = {};
  const ctx = vm.createContext({ console, Promise, Date, JSON, Math, Object, Array, String, Number, setTimeout, setInterval, clearTimeout, clearInterval, Proxy, Error,
    localStorage: { getItem: k => ls[k] ?? null, setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } },
    document: { body: null, hidden: false, createElement: () => ({ style: {} }), addEventListener() {} }, parent, addEventListener: (t, f) => { if (t === 'message') handlers.push(f); } });
  ctx.window = ctx;
  vm.runInContext(shim, ctx);
  return { ctx, st, run: s => vm.runInContext(s, ctx) };
}

(async () => {
  const cached = process.env.CACHED !== '0';
  const A = client(cached), B = client(cached);
  const dbA = await A.ctx.claude.use('db'), dbB = await B.ctx.claude.use('db');
  let seenB = [], annAt = 0, annSeen = 0, fail = 0, ok = 0;
  dbB.collection('cases').onSnapshot(s => { seenB = s.docs.map(d => d.id); });
  dbB.collection('ann').onSnapshot(s => { if (s.docs.length && !annSeen) annSeen = Date.now(); });
  await sleep(1500);
  // an agent edits quickly: 25 saves, a new one every 150 ms, while both screens keep polling
  const t0 = Date.now(), lat = [];
  const jobs = [];
  for (let i = 0; i < 25; i++) {
    const s = Date.now();
    jobs.push(dbA.doc('cases/c' + i).set({ id: 'c' + i, ts: s, owner: 'A', n: i }).then(() => { ok++; lat.push(Date.now() - s); }, () => { fail++; }));
    await sleep(150);
  }
  annAt = Date.now();
  jobs.push(dbA.doc('ann/a1').set({ id: 'a1', ts: annAt, title: 'Hello' }).then(() => { ok++; }, () => { fail++; }));
  await Promise.all(jobs);
  const saveMs = Date.now() - t0;
  for (let i = 0; i < 80 && (seenB.length < 25 || !annSeen); i++) await sleep(250);
  lat.sort((a, b) => a - b);
  const res = { shim: path.relative(process.cwd(), shimPath), flow: EARLY ? 'one run per request' : 'two runs per request', dbMs: DB, cachedVersions: cached,
    saved: ok, rejected: fail, allSavedAfterMs: saveMs, medianSaveMs: lat[lat.length >> 1], slowestSaveMs: lat[lat.length - 1],
    otherScreenSawCases: seenB.length, announcementDelayMs: annSeen ? annSeen - annAt : null, messagesSent: A.st.sent, runsCutOff: A.st.cuts + B.st.cuts };
  console.log(JSON.stringify(res));
  const pass = fail === 0 && ok === 26 && seenB.length === 25 && !!annSeen;
  console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
  py.kill(); process.exit(pass ? 0 : 1);
})();
