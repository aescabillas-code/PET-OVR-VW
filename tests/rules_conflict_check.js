// Hand-over / balancing rule conflict check: random shifts, statuses, EOS, new cases, closures and catch-ups run through the
// real app code; every assignment is checked against the rules (I1 never managers, I2 nothing left off shift or in the queue
// while someone is online, I3 only online agents receive, I4 an EOS batch is split equally (total ÷ available agents) / round
// robin for new, I5 a giver never ends below the receiver, I6 running again moves nothing, I7 new cases never moved by balancing).
// Original header: End-to-end check of web/shim.js + the real Python Bridge (tests/bridge_server.py, in-memory store, no MongoDB/Streamlit needed).
// Two simulated browsers run the real app script. Verifies: a case created on one screen is saved and appears on the other,
// edits propagate back, and an uploaded shared audio file can be loaded by the second screen.
const vm = require('vm'), fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/pet_station.html'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'web/shim.js'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
new (require('vm').Script)(scripts[scripts.length - 1]);   // the whole page script, boot line included, must parse
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
  // the app always opens on the profile page and does not restore a saved profile; the test signs in as `me` directly
  vm.runInContext('ME=' + JSON.stringify(me) + ';applyMe();', ctx);
  return { ctx, run: c => vm.runInContext(c, ctx), els };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let FAILS = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + (extra || ''))); if (!ok) FAILS++; };
const J = s => JSON.parse(s);
let A; const setv = (id, v) => { A.ctx.document.getElementById(id).value = v; };
(async () => {
  A = client({ role: 'manager', name: 'Jeff Bote' });
  await A.run('initDb()'); await sleep(2500);
  A.run(`window.note=()=>{};SIMON=false;window.__V=[];window.__PH='other';window.__moves=0;
  const __ra=reassign;
  reassign=function(c,to,why,by){const fr=c.owner,now=simNow(),on=onlineAgents(now,fr),ph=__PH;
    if(to!==QUEUE){const p=pers(to);if(!p||isMgr(p))__V.push('I1 case '+c.id+' given to manager/unknown '+to);
      if(!on.some(x=>x.name===to)&&!(ph.startsWith('bal:')&&ph.slice(4)===to))__V.push('I3 '+c.id+' given to agent not online: '+to+' ('+ph+')');}
    if(ph==='eos'&&fr!==QUEUE&&to!==QUEUE){window.__batch=window.__batch||{};__batch[to]=(__batch[to]||0)+1;window.__batchOn=on.map(x=>x.name)}
    if(ph==='eos'&&fr===QUEUE){const mn=Math.min(...on.map(x=>lastNewAt(x.name)));if(lastNewAt(to)>mn)__V.push('I4b queued new case '+c.id+' skipped the round robin turn')}
    const isho=isHo(c),man=!!(c.credit&&c.credit.manTo===c.owner);
    __ra(c,to,why,by);
    if(c.owner===to&&fr!==to)__moves++;
    if(ph.startsWith('bal:')&&c.owner===to){if(!isho)__V.push('I7 a new case '+c.id+' was moved by balancing');if(man)__V.push('I5b a hand-by-hand case '+c.id+' was moved');if(hoLoad(fr)<hoLoad(to))__V.push('I5 giver '+fr+' left below receiver '+to+' ('+hoLoad(fr)+'<'+hoLoad(to)+')')}
  };`);
  const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const nowM = A.run('minOf(simNow())');
  let seed = 7; const R = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
  let scen = 0, steps = 0, totalMoves = 0;
  for (scen = 0; scen < 60; scen++) {
    const n = 3 + R(4), staff = {};
    for (let i = 0; i < n; i++) { const nm = 'A' + i; const lateStart = R(5) === 0; staff[nm] = ag(nm, lateStart ? 60 + R(120) : -(30 + R(300)), 200 + R(300), R(4) === 0 ? 'unavailable' : 'available'); }
    const lv = ['L0', 'L1']; lv.forEach(l => { staff[l] = ag(l, -400, 200 + R(200)); });
    staff['Near'] = ag('Near', -400, 10 + R(15));
    const push = () => A.run('STAFF=' + JSON.stringify(Object.values(staff)) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    push();
    A.run(`CASES.length=0;__PH='other';`);
    // cases held by leaving agents and some hand-over cases already with agents
    lv.concat(['Near']).forEach(l => A.run(`for(let i=0;i<${R(35)};i++)CASES.push(mkCase('${l}-${scen}-'+i,'${l}',{}))`));
    Object.keys(staff).filter(k => k[0] === 'A').forEach(k => A.run(`for(let i=0;i<${R(8)};i++){const c=mkCase('${k}-${scen}-h'+i,'${k}',{});c.credit={n:'Old',at:Date.now()-36e5};c.xfer={from:'Old',to:'${k}',at:Date.now()-6e4};if(${R(6) === 0})c.credit.manTo='${k}',c.credit.manAt=Date.now();CASES.push(c)}for(let i=0;i<${R(3)};i++)CASES.push(mkCase('${k}-${scen}-n'+i,'${k}',{}))`));
    for (let s = 0; s < 8; s++) {
      steps++;
      const act = R(6), agents = Object.keys(staff).filter(k => k[0] === 'A');
      if (act === 0) { const k = agents[R(agents.length)]; staff[k].status = staff[k].status === 'unavailable' ? 'available' : 'unavailable'; push(); }
      else if (act === 1) { A.run(`__PH='new';for(let i=0;i<${1 + R(4)};i++){const o=coverFor(simNow(),null,undefined,true)||(hasAgents()?QUEUE:'');const c=mkCase('N-${scen}-${s}-'+i,o||QUEUE,{nw:1});rrMark(c,o);CASES.unshift(c)}`); }
      else if (act === 2) { const l = lv[R(2)]; staff[l].end = T(nowM - 2); staff[l].start = T(nowM - 500); push(); }
      else if (act === 3) { const k = agents[R(agents.length)]; A.run(`CASES.filter(c=>c.owner==='${k}'&&!c.closed).slice(0,${R(5)}).forEach(c=>c.closed=true)`); }
      else if (act === 4) { const k = agents.filter(x => staff[x].start > T(nowM))[0]; if (k) { staff[k].start = T(nowM - 3); push(); } }
      // automatic EOS check (as the leader screen does every second)
      A.run(`__batch={};__PH='eos';eosCheck();__PH='other';{const ks=(window.__batchOn||[]);if(Object.keys(__batch).length){const v=ks.map(k=>__batch[k]||0);if(Math.max(...v)-Math.min(...v)>1)__V.push('I4 an EOS batch was not split equally: '+JSON.stringify(__batch))}}`);
      // every agent's own catch-up check
      agents.forEach(k => A.run(`__PH='bal:${k}';ME={role:'agent',name:'${k}'};BAL_LAST_ST=(pers('${k}')||{}).status==='unavailable'?'':'unavailable';try{localStorage.setItem('pet_signed_in_at',String(Date.now()-60000));localStorage.removeItem('pat_bal_ok')}catch(e){}balanceCatchUp(true);__PH='other'`));
      // invariants after the step
      const bad = J(A.run(`JSON.stringify((()=>{const v=[],now=simNow(),on=onlineAgents(now);
        if(on.length){CASES.forEach(c=>{if(c.closed)return;if(c.owner===QUEUE)v.push('I2 queue case '+c.id+' left while agents are online');const p=pers(c.owner);if(p&&!isMgr(p)&&!onShiftAt(p,now)&&!(c.credit&&c.credit.manTo===c.owner))v.push('I2 '+c.id+' left with off-shift '+c.owner)})}
        CASES.forEach(c=>{if(!c.closed&&isMgr(pers(c.owner)))v.push('I1 '+c.id+' with manager')});return v})())`));
      bad.forEach(b => A.run(`__V.push(${JSON.stringify(b)})`));
      // stability: doing it again moves nothing
      const m0 = A.run('__moves'); A.run(`__PH='eos';eosCheck();__PH='other'`);
      agents.forEach(k => A.run(`__PH='bal:${k}';ME={role:'agent',name:'${k}'};BAL_LAST_ST='';try{localStorage.removeItem('pat_bal_ok')}catch(e){}balanceCatchUp(true);__PH='other'`));
      if (A.run('__moves') !== m0) A.run(`__V.push('I6 a second run moved '+(__moves-${m0})+' more case(s) in scenario ${scen} step ${s}')`);
    }
    totalMoves = A.run('__moves');
  }
  const V = J(A.run('JSON.stringify(__V)'));
  const groups = {}; V.forEach(v => { const k = v.split(' ')[0]; (groups[k] = groups[k] || []).push(v); });
  console.log(JSON.stringify({ scenarios: scen, steps, moves: totalMoves, violations: V.length, byRule: Object.fromEntries(Object.entries(groups).map(([k, l]) => [k, { n: l.length, ex: l.slice(0, 3) }])) }, null, 1));
  console.log('RESULT: ' + (V.length ? 'FAIL' : 'PASS'));
  py.kill(); process.exit(V.length ? 1 : 0);
})();
