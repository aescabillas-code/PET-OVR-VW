// End-to-end check of web/shim.js + the real Python Bridge (tests/bridge_server.py, in-memory store, no MongoDB/Streamlit needed).
// Two simulated browsers run the real app script. Verifies: a case created on one screen is saved and appears on the other,
// edits propagate back, and an uploaded shared audio file can be loaded by the second screen.
const vm = require('vm'), fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/pet_station.html'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'web/shim.js'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts[scripts.length - 1].replace(/renderUser\(\);render\(\);initDb\(\);setInterval[\s\S]*$/, '');

// ---- the Python side
const py = cp.spawn(process.env.PYTHON || 'python3', [path.join(__dirname, 'bridge_server.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '', waiters = [], lastDump = {};
py.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim() && waiters.length) waiters.shift()(JSON.parse(line)); } });
const askPy = (sid, value) => new Promise(r => { waiters.push(r); py.stdin.write(JSON.stringify({ sid, value }) + '\n'); });

let SID = 0;
function client(me) {
  const sid = 's' + (++SID), handlers = [];
  const els = {};
  const mk = () => new Proxy({ value: '', checked: false, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return true; } }, focus() {}, select() {}, pause() {}, play() { return Promise.resolve(); }, remove() {}, appendChild() {}, setAttribute() {}, textContent: '' }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });
  const ls = { pet_me: JSON.stringify(me) };
  const wrapT = fn => (f, ms) => fn(() => { try { f(); } catch (e) {} }, ms);
  // Streamlit's side of the postMessage protocol, backed by the Python bridge
  let chain = Promise.resolve();
  const render = reply => handlers.forEach(h => h({ data: { type: 'streamlit:render', args: { reply } } }));
  const run = value => { chain = chain.then(async () => { const r = await askPy(sid, value); lastDump = r.dump; r.renders.forEach(render); }); };
  const parent = {
    innerHeight: 900,
    postMessage(m) {
      if (m.type === 'streamlit:componentReady') run(null);
      else if (m.type === 'streamlit:setComponentValue') run(m.value);
    }
  };
  const ctx = vm.createContext({
    console, URL, FormData, Blob, Promise, Date, JSON, Math, Set, Map, Object, Array, String, Number, RegExp, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, TextEncoder, Uint8Array,
    setTimeout: wrapT(setTimeout), setInterval: wrapT(setInterval), clearTimeout, clearInterval,
    localStorage: { getItem: k => ls[k] ?? null, setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } },
    Audio: function () { return mk(); }, XLSX: undefined,
    FileReader: function () { this.readAsDataURL = function (b) { setTimeout(() => { this.result = 'data:' + (b.type || 'x') + ';base64,QUJD'; this.onload(); }, 0); }; },
    document: { getElementById: id => els[id] || (els[id] = mk()), querySelector: () => ({ value: 'all' }), querySelectorAll: () => [], activeElement: null, hidden: false, addEventListener() {}, createElement: () => mk(), body: mk() },
    crypto: require('crypto').webcrypto, parent, addEventListener: (t, f) => { if (t === 'message') handlers.push(f); }, removeEventListener() {}
  });
  ctx.window = ctx;
  vm.runInContext(shim, ctx);
  vm.runInContext(app, ctx);
  return { ctx, run: c => vm.runInContext(c, ctx), els };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const A = client({ role: 'coordinator', name: 'Coordinator' });
  await A.run('initDb()'); await sleep(2500);
  console.log('A connected to the database:', A.run('DBON'));
  A.run('openAdd()'); A.run("document.getElementById('add-id').value='PET-TEST-1';document.getElementById('add-hp').checked=true");
  A.run('addCase()'); await sleep(2500);
  console.log('collections stored:', Object.keys(lastDump).join(', '), '| cases:', (lastDump.cases || []).join(','));
  const B = client({ role: 'manager', name: 'Jeff Bote' });
  await B.run('initDb()'); await sleep(2500);
  console.log('B (second screen) sees cases:', B.run('CASES.map(c=>c.id).join(",")'));
  B.run("(()=>{const c=getCase('PET-TEST-1');c.hp=false;queueSave(c)})()"); await sleep(3500);
  const aSees = A.run("getCase('PET-TEST-1').hp");
  console.log('A sees priority change from B (expect false):', aSees);
  // shared alert audio: A uploads, B loads it from the database
  const up = await A.run("claude.use('assets').then(as=>as.upload(Object.assign(new Blob(['abc'],{type:'audio/mpeg'}),{name:'ding.mp3'})))");
  B.run('window.__assetUrl(' + JSON.stringify(up.id) + ')'); await sleep(2500);
  const bAudio = B.run('window.__assetUrl(' + JSON.stringify(up.id) + ')');
  console.log('B loads the shared audio:', String(bAudio).slice(0, 30));
  const ok = (lastDump.cases || []).includes('PET-TEST-1') && B.run('CASES.some(c=>c.id==="PET-TEST-1")') && aSees === false && String(bAudio).startsWith('data:audio/mpeg');
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL'); py.kill(); process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERROR', e); py.kill(); process.exit(2); });
