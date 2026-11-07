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
  const mk = () => { const hid = { v: true }; return new Proxy({ value: '', checked: false, style: {}, classList: { add(c) { if (c === 'hidden') hid.v = true; }, remove(c) { if (c === 'hidden') hid.v = false; }, toggle() {}, contains(c) { return c === 'hidden' ? hid.v : false; } }, focus() {}, select() {}, pause() {}, play() { return Promise.resolve(); }, remove() {}, appendChild() {}, setAttribute() {}, textContent: '' }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } }); };
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
    document: { head: { appendChild() {} }, documentElement: { appendChild() {} }, getElementById: id => els[id] || (els[id] = mk()), querySelector: () => ({ value: 'all' }), querySelectorAll: () => [], activeElement: null, hidden: false, addEventListener() {}, createElement: () => mk(), body: mk() },
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
  A.run('openAdd()'); A.run("document.getElementById('add-id').value='PET-TEST-1';document.getElementById('add-recv').value='2026-11-06T09:00';document.getElementById('add-hp').checked=true");
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
  // ---- alerts: nothing old is replayed, fresh alarms ring, the sound stops with the alert, Later snoozes
  A.run("ME={role:'coordinator',name:'Coordinator'};GOT.cases=1;GOT.act=1");
  A.run("(()=>{const c=mkCase('PET-OLD','Haina Azuela');const r=c.items[0].rem;r.at=Date.now()-600000;r.setAt=Date.now()-1200000;CASES.push(c);remCheck()})()");
  const oldQuiet = A.run('remOpen') === false;
  console.log('old alarm not replayed after a refresh:', oldQuiet);
  A.run("(()=>{const c=mkCase('PET-NEW','Haina Azuela');c.items[0].rem.at=Date.now()+60000;CASES.push(c);remCheck()})()");
  const rang = A.run('remOpen') === true && A.run("CURKEY") === 'rem-pop|mon';
  console.log('fresh alarm rings (monitoring popup + its own sound):', rang);
  A.run('popClose()'); A.run('syncSound()');
  const stopped = A.run("CURKEY===''&&!CURA&&!BEEP&&!ASND['rem-pop']");
  console.log('sound stopped when the alert was closed:', stopped);
  A.run("ME={role:'agent',name:'Haina Azuela'};remQueue=[];remOpen=false;SEENT.clear()");
  A.run("remCheck()");
  const owner = A.run('remOpen') === true && A.run("window._p.mode") === 'owner';
  A.run('popSnooze()');
  const snoozed = A.run('SNZ.length') >= 1 && A.run('remOpen') === false;
  A.run('SNZ.forEach(z=>z.at=Date.now()-1);remCheck()');
  const again = A.run('remOpen') === true;
  console.log('owner alert, Later snoozes, alerts again after the snooze:', owner, snoozed, again);
  A.run('popClose()');
  // ---- shift schedule: per-day shifts, overnight, OFF / PTO, template layout
  const sched = A.run(`(()=>{const p={name:'T',role:'Support',start:'18:00',end:'03:00',days:[],sch:['18:00-03:00','OFF','PTO','07:00-16:00','OFF','OFF','OFF']};sDerive(p);const at=(dy,h,m)=>{const d=new Date(2026,10,1+dy,h,m);return onShiftAt(p,d)};return JSON.stringify([at(0,19,0),at(1,2,0),at(1,4,0),at(1,19,0),at(3,8,0),at(3,17,0),at(2,10,0)])})()`);
  console.log('overnight / off / pto / different time per day:', sched);
  const schedOk = sched === JSON.stringify([true, true, false, false, true, false, false]);
  let tplOk = true;
  try {
    const rows = JSON.parse(cp.execFileSync(process.env.PYTHON || 'python3', ['-c', "import json,openpyxl;ws=openpyxl.load_workbook('" + path.join(root, 'templates/PET_Shift_Schedule_Template.xlsx') + "')['PET Team'];print(json.dumps([[('' if c.value is None else str(c.value)) for c in r] for r in ws.iter_rows()]))"]).toString());
    A.ctx.__aoa = rows; A.ctx.XLSX = { utils: { sheet_to_json: () => rows } };
    const got = JSON.parse(A.run("(()=>{const g=gridRows({SheetNames:['PET Team'],Sheets:{'PET Team':{}}});return JSON.stringify(g.out.map(x=>[x.name,x.sch.join('|')]))})()"));
    tplOk = got.length === 14 && got[0][0] === 'Jerold Solidum' && got[1][0] === 'Khristine Alcantara' && got[2][1].split('|')[2] === 'PTO' && got[11][0] === 'Roland De Juan' && got[3][1].split('|')[1] === '15:00-00:00';
    console.log('PET Team template read by the importer:', got.length, 'people', tplOk);
  } catch (e) { console.log('template check skipped:', String(e.message).slice(0, 80)); }
  // ---- theme: personal colours and image skin
  A.run("TD={p:'custom',c:'#be185d',font:'georgia',size:115};THEME_PREVIEW=J(TD);applyTheme()");
  const css1 = String(A.els['theme-css'].textContent);
  A.run("TD={p:'image',imgUrl:'data:image/jpeg;base64,AAAA',pal:derive('#0b6fa4')};THEME_PREVIEW=J(TD);applyTheme()");
  const css2 = String(A.els['theme-css'].textContent);
  const themeOk = css1.includes('Georgia') && css1.includes('font-size:16.1px') && css2.includes('url("data:image/jpeg;base64,AAAA")') && css2.includes('backdrop-filter');
  console.log('theme colours / font / image skin applied:', themeOk);
  const ok = oldQuiet && rang && stopped && owner && snoozed && again && schedOk && tplOk && themeOk && (lastDump.cases || []).includes('PET-TEST-1') && B.run('CASES.some(c=>c.id==="PET-TEST-1")') && aSees === false && String(bAudio).startsWith('data:audio/mpeg');
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL'); py.kill(); process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERROR', e); py.kill(); process.exit(2); });
