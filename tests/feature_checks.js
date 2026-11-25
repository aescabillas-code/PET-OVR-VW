// End-to-end check of web/shim.js + the real Python Bridge (tests/bridge_server.py, in-memory store, no MongoDB/Streamlit needed).
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
// Nov 24: the old hand-over split and agent-to-agent balancing were replaced by the hand-over queue (5 per available agent every
// hour). Their checks are kept here by name and reported as RETIRED; the queue has its own checks (search 'Hand-over queue').
const RETIRED = new Set([
"if nobody is on shift yet the cases wait for the first agent to start",
"a manual hand-over is shared evenly between the agents on shift, never to someone off shift",
"a manual hand-over to an agent who has not started yet stays put",
"manual hand-overs are marked so they are never taken back",
"the second click hands all open cases to the agent on shift",
"a new agent in mid-shift is given cases until the workload is even",
"the newest untouched cases moved first (BL-5 down to BL-2)",
"balanced cases are marked so they are never balanced again",
"no alarm or acknowledge window for a balanced case",
"every hand-over case of the busy agents was worked on, yet the signed-in agent is filled up evenly",
"her 6 new cases are on top of the hand-over share (not counted, not moved)",
"hand-over is not limited by who held the case before",
"nobody available at EOS: the cases stay with the leaving agent",
"sign-in balancing fills the new agent up evenly (4/4/4 hand-over cases)",
"cases that were hers before go back to her first",
"once available with no hand-over since sign-in, she gets an equal share from the agents who have cases (4/4/4)",
"it happens once per sign-in (no balancing every time)",
"an agent below the round limit is filled up evenly even after one hand-over (4/4/4)",
"an agent tagged as coordinator also gets hand-over cases after signing in (4/4/4)",
"100 cases ÷ 4 available agents = 25 each",
"new cases are on top, not part of the share",
"the case history has a plain hand-over line (no math)",
"one more available agent: 100 ÷ 5 = 20 each (she gets 5 from each)",
"her new cases stayed with Amy (5 new + 20 hand-over)",
"a late agent gets the share of the open hand-over cases: 80 ÷ 6 = 13 (a giver with none open is skipped)",
"the next check (30 s later) gives her the share once cases can move",
"when an agent's shift starts she gets her share at once, without her own browser open (30 ÷ 4 = 7)",
"the agent ending in 3 hours gives first (down to the share), then the busiest",
"new cases still stay with the agent who received them",
"the move is logged as a plain line in Case History",
"back from Unavailable: balanced again straight away",
"signing in on shift counts as becoming available too",
"a late end-of-shift hand-over says when the shift ended and that nobody was available then"
]);
const check = (name, ok, extra) => { if (RETIRED.has(name)) { console.log('RETIRED ' + name); return; } console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + (extra || ''))); if (!ok) FAILS++; };
const J = s => JSON.parse(s);
let A; const setv = (id, v) => { A.ctx.document.getElementById(id).value = v; };

(async () => {
  A = client({ role: 'manager', name: 'Jeff Bote' });
  await A.run('initDb()'); await sleep(2500);
  // the test database starts empty: put a shift schedule in it (the page itself no longer saves its built-in sample list, Nov 20)
  A.run("STAFF=J(DEMO_STAFF).map(p=>{delete p.demo;return p});ensureMgrs(STAFF);STAFFLOADED=true;saveStaff(true,true)"); await sleep(1500);
  // test helper: make the cases in the list hand-over cases (they came from an agent whose shift ended a minute ago)
  A.run("window.asHo=f=>CASES.forEach(c=>{if(!c.closed&&c.owner&&c.owner!=='Queue'&&credOf(c).n===c.owner&&!c.xfer){f=f||'Prev Shift';c.credit={n:f,at:Date.now()-36e5};c.xfer={from:f,to:c.owner,at:Date.now()-6e4}}})");

  // ---------- shift schedule: person + info saved to the database, even with fast edits ----------
  A.run('setTabTo("shift")');
  A.run('sAdd()');
  const newName = A.run('STAFF[STAFF.length-1].name');
  for (let i = 0; i < 7; i++) {                       // rapid edits, spaced so earlier saves echo back in between
    await sleep(i % 2 ? 140 : 520);
    if (i === 0) A.run(`sRename(STAFF.length-1,'Zed Tester')`);
    else A.run(`sSet(STAFF.length-1,${i - 1},'0${i}:00-1${i}:00')`);
  }
  A.run(`sSet(STAFF.length-1,6,'PTO')`);
  await sleep(3000);
  const exp = J(A.run('JSON.stringify(STAFF[STAFF.length-1].sch)'));
  check('A keeps all its own schedule edits', A.run('STAFF[STAFF.length-1].name') === 'Zed Tester' && exp[6] === 'PTO' && exp[5] === '06:00-16:00', JSON.stringify(exp));
  const B0 = client({ role: 'manager', name: 'Jeff Bote' });
  await B0.run('initDb()'); await sleep(2500);
  const stored = J(B0.run('JSON.stringify(STAFF.map(p=>[p.name,p.sch]))')).find(x => x[0] === 'Zed Tester');
  check('new person + name + every day saved in the database (read by another screen)', !!stored && JSON.stringify(stored[1]) === JSON.stringify(exp), JSON.stringify(stored));
  check('the placeholder name was not left behind in the database', !J(B0.run('JSON.stringify(STAFF.map(p=>p.name))')).includes(newName));
  A.run('sDel(STAFF.length-1)'); await sleep(4500);
  check('deleting a person is saved too', !J(B0.run('JSON.stringify(STAFF.map(p=>p.name))')).includes('Zed Tester'));
  check('Inactive profiles section is gone', (A.run('PROFILE_REGISTRY={zz:{active:false,name:"Old Person"}};shiftTab()')).indexOf('Inactive profiles') < 0);

  // ---------- profile passwords saved in the database ----------
  A.run("LP={v:'setpw',name:'Karen Sabile'}"); setv('lp-pw', 'secret1'); setv('lp-pw2', 'secret1');
  await A.run('lpSavePw()'); await sleep(2000);
  A.run("ME={role:'manager',name:'Jeff Bote'};applyMe()");
  const C = client({ role: null, name: '' });
  await C.run('initDb()'); await sleep(2500);
  check('a password set on one screen is known on a brand-new screen', String(C.run("PROFILE_HASHES['karensabile']||''")).includes(':'));

  // ---------- Export current: monthly layout, template colours ----------
  const cells = {}; let blobName = '';
  const mkCell = key => cells[key] || (cells[key] = {});
  A.ctx.ExcelJS = { Workbook: function () { this.addWorksheet = () => ({ getColumn: () => ({}), getCell: (r, c) => mkCell(r + ':' + c), getRow: r => ({ getCell: c => mkCell(r + ':' + c), set height(v) {} }) }); this.xlsx = { writeBuffer: async () => new Uint8Array([1]) }; } };
  A.ctx.saveBlob = (b, n) => { blobName = n; };
  A.run('STAFF=[{name:"Q One",role:"Support",days:[1,1,1,1,1,0,0],sch:["OFF","09:00-17:00","09:00-17:00","09:00-17:00","09:00-17:00","09:00-17:00","OFF"],msch:{"2026-12-01":"12:00-21:00","2026-12-02":"18:00-03:00","2026-12-03":"OFF","2026-12-04":"PTO","2026-12-05":"Absent"}}];SCH_M="2026-12"');
  await A.run('sExport()');
  const col = (r, c) => (cells[r + ':' + c] && cells[r + ':' + c].fill && cells[r + ':' + c].fill.fgColor.argb);
  check('export: monthly — dates of the month across the top, weekday row, dark header with yellow dates', cells['3:2'].value === '2026-12-01' && cells['3:32'].value === '2026-12-31' && cells['4:2'].value === 'Tue' && col(3, 2) === 'FF404040' && cells['3:2'].font.color.argb === 'FFFFFF00' && String(cells['1:2'].value).includes('2026-12'));
  check('export: orange / green shifts by day of the month', cells['5:2'].value === '12:00-21:00' && col(5, 2) === 'FFFFC000' && col(5, 3) === 'FFB7E1A1');
  check('export: pink OFF, dark-green PTO, Absent in dark red', col(5, 4) === 'FFFFC7CE' && cells['5:4'].font.color.argb === 'FFC00000' && col(5, 5) === 'FF1E6B34' && cells['5:6'].value === 'Absent' && col(5, 6) === 'FF7A1F3D');
  check('export: a day with no monthly value uses the weekly pattern', cells['5:7'].value === 'OFF' && cells['5:8'].value === '09:00-17:00');
  check('export: file name', blobName === 'PET_Shift_Schedule_2026-12.xlsx');

  // ---------- cases: checklist, acknowledge, reminders, maintenance window ----------
  A.run("GOT.cases=1;GOT.act=1;STAFF=" + A.run('JSON.stringify(STAFF)').replace(/^/, ''));
  A.run('STAFF=[{name:"Haina Azuela",role:"Support",shift:"",start:"00:00",end:"23:59",days:[1,1,1,1,1,1,1],sch:["00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59"],status:"available"},{name:"Karen Sabile",role:"Support",start:"00:00",end:"23:59",days:[1,1,1,1,1,1,1],sch:["00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59"],status:"available"}]');
  A.run('openAdd()'); A.run("(()=>{document.getElementById('add-id').value='PET-FEAT-1';document.getElementById('add-recv').value='2026-11-06T09:00'})()");
  A.run('addCase()'); await sleep(300);
  const cid = 'PET-FEAT-1';
  const body = () => String(A.els['case-body'].innerHTML);
  check('required item shows a working Acknowledge button', /openAck\('PET-FEAT-1','[^']+'\)/.test(body()) && !body().includes('${c.id}'));
  const reqId = A.run(`getCase('${cid}').items.find(i=>i.req).id`);
  A.run(`openAck('${cid}','${reqId}')`);
  const pop = String(A.els['rem-pop-card'].innerHTML);
  check('Acknowledge opens the alarm form with the documentation box', pop.includes('id="doc"') && pop.includes('Acknowledge &amp; Document') === false && pop.includes('Acknowledge & Document'));
  A.run('popComplete()');
  check('acknowledging without documentation is refused', A.run(`getCase('${cid}').items.find(i=>i.req).done`) === false);
  setv('doc', 'Called the site, engineer dispatched');
  A.run('popComplete()');
  check('documented acknowledgement completes the required item', A.run(`getCase('${cid}').items.find(i=>i.req).done`) === true && A.run(`getCase('${cid}').items.find(i=>i.req).rem.done.text`).startsWith('Called the site') && A.run('remOpen') === false);

  setv('new-in', 'Call the store');
  A.run(`addItem('${cid}')`);
  check('add-item field is cleared after adding', A.els['new-in'].value === '');
  const itId = A.run(`getCase('${cid}').items[getCase('${cid}').items.length-1].id`);
  check('item without a reminder shows the reminder button, not Acknowledge', body().includes(`openRem('${cid}','${itId}')`) && !body().includes(`openAck('${cid}','${itId}')`));
  A.run(`openRem('${cid}','${itId}')`);
  A.run('remQuick(60)'); A.run('remQuick(60)');
  const R = J(A.run('JSON.stringify(R)'));
  const exp2 = A.run(`toLI(${R.qb}+120*60000)`);
  check('+1 hr twice adds up to +2 hours', R.qk === 120 && A.els['rm-dt'].value === exp2, A.els['rm-dt'].value + ' vs ' + exp2);
  A.run('remQuick(15)'); A.run('remQuick(15)'); A.run('remQuick(5)');
  check('minutes keep adding too', A.run('R.qk') === 155);
  A.run('remManual()');
  check('editing the time by hand restarts the count', A.run('R.qk') === 0);
  check('the reminder uses a calendar date and time field, not Today/Tomorrow', !String(A.els['rem-set-card'].innerHTML).includes('Tomorrow') && String(A.els['rem-set-card'].innerHTML).includes('data-dtp="rm-dt"'));
  setv('rm-dt', A.run("toLI(Date.now()+10*86400000)")); A.run('remManual()');
  check('a reminder can be set on a date 10 days ahead', Math.round((A.run('remTarget().getTime()') - A.run('simNow().getTime()')) / 86400000) === 10);
  A.run('remQuick(60)'); A.run('remQuick(60)');
  setv('rm-dt', A.run("toLI(Date.now()+7*86400000+3600000)"));
  setv('rm-text', 'Confirm the switch replacement');
  A.run('remSave()');
  check('after a reminder is set the button becomes Acknowledge', body().includes(`openAck('${cid}','${itId}')`) && !body().includes(`openRem('${cid}','${itId}')`));
  A.run(`openAck('${cid}','${itId}')`);
  const pop2 = String(A.els['rem-pop-card'].innerHTML);
  check('acknowledgement modal for the reminder shows the reminder text and a way to change it', pop2.includes('Confirm the switch replacement') && pop2.includes('Change reminder'));
  A.run('popClose()');

  setv('mw-s', '2026-11-07T10:00'); setv('mw-e', '');
  A.run(`mwSave('${cid}')`);
  check('maintenance window accepts a start only', A.run(`getCase('${cid}').mw.e`) === null && A.run(`getCase('${cid}').mw.s`) > 0);
  check('case cannot be closed until the end is added', J(A.run(`JSON.stringify(missingFields(getCase('${cid}')))`)).includes('Maintenance Window end time'));
  check('end-time box is offered', body().includes('id="mw-end"'));
  setv('mw-end', '2026-11-07T09:00'); A.run(`mwEnd('${cid}')`);
  check('end before start is rejected', A.run(`getCase('${cid}').mw.e`) === null);
  setv('mw-end', '2026-11-07T12:00'); A.run(`mwEnd('${cid}')`);
  check('end can be set later', A.run(`getCase('${cid}').mw.e`) > A.run(`getCase('${cid}').mw.s`) && !J(A.run(`JSON.stringify(missingFields(getCase('${cid}')))`)).includes('Maintenance Window end time'));

  A.run('render()');
  const rows = String(A.els['rows'].innerHTML);
  check('case table row is laid out on one line', rows.includes('class="sl"') && !rows.includes('flex-col') && !rows.includes('mt-1 overflow-hidden'));

  // ---------- account names: dropdown in the case entry form, list uploaded under Timezone and Data ----------
  A.run('setTabTo("tz")');
  check('the Timezone tab is now called Timezone and Data', String(A.els['set-tabs'].innerHTML).includes('Timezone and Data') && String(A.els['set-body'].innerHTML).includes('Timezone and Data'));
  check('Timezone and Data has the account list upload', String(A.els['set-body'].innerHTML).includes('id="acct-file"') && String(A.els['set-body'].innerHTML).includes('No accounts uploaded yet'));
  A.run("openAdd()");
  check('the case entry form has an Account name dropdown (nothing to pick before an upload)', String(A.els['add-card'].innerHTML).includes('id="add-acct"') && !String(A.els['add-card'].innerHTML).includes('Acme Corp'));
  A.ctx.XLSX = { utils: { sheet_to_json: () => [['Account Name'], ['Acme Corp'], ['  Globex   Inc '], [''], ['acme corp'], ['Initech']] } };
  const acctList = J(A.run("JSON.stringify(acctParse({SheetNames:['S'],Sheets:{S:{}}}))"));
  check('the uploaded list skips the header, blanks and duplicates and trims names', JSON.stringify(acctList) === JSON.stringify(['Acme Corp', 'Globex Inc', 'Initech']), JSON.stringify(acctList));
  A.run("acctSet(acctParse({SheetNames:['S'],Sheets:{S:{}}}),'accounts.xlsx',true)");
  A.run("openAdd()");
  check('the uploaded names appear in the dropdown', ['Acme Corp', 'Globex Inc', 'Initech'].every(n => String(A.els['add-card'].innerHTML).includes('<option value="' + n + '"')));
  check('the Timezone and Data tab shows how many accounts are loaded', (A.run('setTabTo("tz")'), String(A.els['set-body'].innerHTML).includes('3 accounts')));
  A.run("openAdd()");
  A.run("(()=>{document.getElementById('add-id').value='PET-ACCT-1';document.getElementById('add-recv').value='2026-11-06T09:00';document.getElementById('add-acct').value='Globex Inc'})()");
  A.run('addCase()'); await sleep(2500);
  check('the chosen account is saved on the new case', A.run("getCase('PET-ACCT-1').account") === 'Globex Inc');
  A.run("openCaseModal('PET-ACCT-1')");
  check('the case modal shows the account name dropdown with the saved value', String(A.els['case-body'].innerHTML).includes('id="cd-acct"') && String(A.els['case-body'].innerHTML).includes('<option value="Globex Inc" selected>'));
  A.run("cdSet('PET-ACCT-1','account','Initech')");
  await sleep(2500);
  check('the account can be changed later and is logged', A.run("getCase('PET-ACCT-1').account") === 'Initech' && A.run("getCase('PET-ACCT-1').log.some(l=>l.action==='Account name updated')") === true);
  // autosave: every edit is written to the database on its own and shows on the other screen, also while the screen repaints
  A.run("cdSet('PET-ACCT-1','account','Acme Corp')"); await sleep(1800);
  check('autosave: the edit reached the database without any save button', (()=>{try{return JSON.stringify(A.run("REALRAW['PET-ACCT-1'].account"))==='"Acme Corp"'}catch(e){return false}})() || A.run("getCase('PET-ACCT-1').account")==='Acme Corp');
  check('autosave: the other screen sees the edit', B0.run("(getCase('PET-ACCT-1')||{}).account") === 'Acme Corp', String(B0.run("(getCase('PET-ACCT-1')||{}).account")));
  A.run("acctSet(['Only One'],'x.xlsx',true)");
  check('an account already on a case stays selectable after the list is replaced', String(A.run("acctOpts('Initech')")).includes('<option value="Initech" selected>'));
  A.run("acctSet([],'',true)");
  A.run("closeCase()");

  // ---------- checklist documentation keeps its formatting ----------
  {
    A.run("openCaseModal('PET-ACCT-1')");
    const iid = A.run("getCase('PET-ACCT-1').items[0].id");
    A.run("window._p={cid:'PET-ACCT-1',iid:'" + iid + "',phase:'due',mode:'owner'}");
    A.run("document.getElementById('doc').value='  Called the FE.  \\r\\nETA confirmed for 3 PM.\\n\\n\\n\\nSecond paragraph:\\n- part delivered\\n- site contact informed   '");
    A.run('popComplete()'); await sleep(2500);
    const want = 'Called the FE.\nETA confirmed for 3 PM.\n\nSecond paragraph:\n- part delivered\n- site contact informed';
    const got = A.run("getCase('PET-ACCT-1').items.find(x=>x.id==='" + iid + "').rem.done.text");
    check('documentation is saved with its lines and paragraph spacing', got === want, JSON.stringify(got));
    const gotB = B0.run("((getCase('PET-ACCT-1')||{items:[]}).items.find(x=>x.id==='" + iid + "')||{rem:{done:{}}}).rem.done.text");
    check('the other screen receives the same formatted documentation', gotB === want, JSON.stringify(gotB));
    A.run("openCaseModal('PET-ACCT-1')");
    const body = String(A.els['case-body'].innerHTML);
    check('the saved documentation is shown with line breaks kept', /whitespace-pre-wrap[^>]*>Called the FE\.\nETA confirmed for 3 PM\.\n\nSecond paragraph:/.test(body), body.slice(body.indexOf('Called the FE') - 120, body.indexOf('Called the FE') + 80));
    check('the case history shows the documentation on its own lines', A.run("getCase('PET-ACCT-1').log.some(l=>/Documentation:\\nCalled the FE\\.\\nETA/.test(l.details||''))") === true);
    check('a one-line documentation is logged on one line as before', A.run("docFmt('  done  ')") === 'done');
    A.run("closeCase()");
  }
  // ---------- announcements ----------
  A.run('setTabTo("ann")');
  setv('an-msg', 'Hello @kar');
  A.run('annInput()');
  check('typing @ lists names from the shift schedule', A.run('AN.mn&&AN.mn.list[0].name') === 'Karen Sabile');
  A.run('annPick(0)');
  check('picking a name inserts it', A.els['an-msg'].value === 'Hello @Karen Sabile ');
  setv('an-msg', A.els['an-msg'].value + 'please review this case 😀');
  setv('an-case', 'PET-FEAT-1'); A.run('annTagCase()');
  check('case can be tagged', A.run('AN.cases.length') === 1 && A.run('AN.cases[0].id') === cid);
  check('GIF link is accepted', A.run("annAddUrl('https://media.giphy.com/media/abc123/giphy.gif')") === true);
  check('Giphy page link is converted to the GIF file', (A.run("annAddUrl('https://giphy.com/gifs/funny-cat-XyZ789')"), A.run('AN.imgs[1].url')) === 'https://media.giphy.com/media/XyZ789/giphy.gif');
  A.run("AN.imgs.push({url:'data:image/jpeg;base64,QUJD',name:'pasted.jpg',blob:new Blob(['abc'],{type:'image/jpeg'})})");
  A.ctx.document.querySelector = () => ({ value: 'sel' });
  setv('an-from', 'Coordinator'); setv('an-title', 'Queue update');
  await A.run('publishAnn()'); await sleep(2500);
  const ann = J(A.run('JSON.stringify(ANN.find(a=>a.title==="Queue update"))'));
  check('announcement keeps mention, tagged case, emoji and attachments', ann && ann.mentions[0] === 'Karen Sabile' && ann.cases[0].id === cid && ann.msg.includes('😀') && ann.imgs.length === 3 && !!ann.imgs[2].id, JSON.stringify(ann).slice(0, 300));
  check('a mentioned person is added to an announcement', ann && Array.isArray(ann.to) && ann.to.includes('Karen Sabile'));
  check('no Send-to options are shown any more', !String(A.run('annTab()')).includes('an-aud') && !String(A.run('annTab()')).includes('Specific people'));
  check('@everyone is offered in the @ menu', (setv('an-msg', '@eve'), A.run('annInput()'), A.run('AN.mn&&AN.mn.list[0].name')) === 'everyone');
  setv('an-msg', 'Heads up @everyone, queue is busy'); setv('an-from', 'Coordinator'); setv('an-title', 'Team broadcast');
  A.run('AN.imgs=[];AN.cases=[]');
  await A.run('publishAnn()'); await sleep(2500);
  const ann2 = J(A.run('JSON.stringify(ANN.find(a=>a.title===\"Team broadcast\"))'));
  check('@everyone sends the announcement to everyone', ann2 && ann2.to === 'all');
  setv('an-msg', 'no mention here'); setv('an-title', 'Nobody tagged');
  await A.run('publishAnn()'); await sleep(500);
  check('an announcement with no @everyone or name is not published', A.run('ANN.some(a=>a.title===\"Nobody tagged\")') === false);
  const B = client({ role: 'agent', name: 'Karen Sabile' });
  await B.run('initDb()'); await sleep(2500);
  check('the mentioned person sees the announcement from the database', B.run('ANN.some(a=>a.title==="Queue update")') === true);
  check('mention is highlighted for that person', B.run('annMsgHtml(ANN.find(a=>a.title==="Queue update"))').includes('class="mention me"'));
  check('images are stored as shared assets and cases show as chips', B.run('annMedia(ANN.find(a=>a.title==="Queue update"),false)').includes('data-aid=') && B.run('annMedia(ANN.find(a=>a.title==="Queue update"),false)').includes('PET-FEAT-1'));
  check('script tags in a message stay inert', A.run(`annMsgHtml({msg:'<img src=x onerror=1> @Karen Sabile',mentions:['Karen Sabile']})`).indexOf('<img') < 0);

  // ---------- a new sign-in must not get old alerts ----------
  A.run("ME={role:'manager',name:'Jeff Bote'}");
  A.run("sendAgentNotice('Haina Azuela','Standard case assigned','Case PET-FEAT-1 has been assigned to you.','PET-FEAT-1')");
  await sleep(2500);
  A.run("remQueue.push({cid:'PET-FEAT-1',iid:'x',mode:'owner',phase:'pre'});SNZ.push({cid:'PET-FEAT-1',iid:'x',phase:'pre',at:Date.now()-1});remOpen=true;show('rem-pop')");
  A.run("pickAgent(STAFF.findIndex(p=>p.name==='Haina Azuela'))");
  A.run('mentionInboxCheck()');
  check('old notice for the new account does not pop up', A.run('NOTICE_OPEN') === false);
  check('queued / snoozed / open alerts of the previous account are dropped', A.run('remQueue.length') === 0 && A.run('SNZ.length') === 0 && A.run('remOpen') === false);
  A.run("sendAgentNotice('Haina Azuela','New','Fresh one','PET-FEAT-1')"); await sleep(2500);
  A.run('mentionInboxCheck()');
  check('a notice that arrives after sign-in still pops up', A.run('NOTICE_OPEN') === true);


  // ---------- dashboard: sorting, history removed, theme sharing ----------
  A.run("ME={role:'manager',name:'Jeff Bote'}");
  A.run("(()=>{const mk=(id,min)=>{const c=mkCase(id,'Haina Azuela',{});c.items=[{id:'a'+id,text:'t',done:false,rem:min!=null?{at:Date.now()+min*60000,text:'t',fired:false,by:'x',setAt:Date.now()}:null}];CASES.push(c)};CASES.length=0;mk('SORT-NONE',null);mk('SORT-LATE',90);mk('SORT-SOON',10);mk('SORT-OVERDUE',-5)})()");
  A.run('TAB="active";FS="all";FO="all";FR="all";render()');
  const rowsHtml = String(A.els['rows'].innerHTML), pos = id => rowsHtml.indexOf("openCaseModal('" + id + "')");
  check('cases are sorted by next reminder, nearest first, no-reminder cases last', pos('SORT-OVERDUE') < pos('SORT-SOON') && pos('SORT-SOON') < pos('SORT-LATE') && pos('SORT-LATE') < pos('SORT-NONE') && pos('SORT-OVERDUE') > 0, rowsHtml.length + '');
  A.run('FR="due";render()');
  check('reminder filter works', String(A.els['rows'].innerHTML).includes('SORT-OVERDUE') && !String(A.els['rows'].innerHTML).includes('SORT-LATE'));
  A.run('FR="all";render()');
  check('stat cards are drawn', ['Total Cases', 'Active Cases', 'Due Reminders', 'Completed Cases'].every(x => String(A.els['stats'].innerHTML).includes(x)));
  check('agent status panel is drawn', String(A.els['agent-sum'].innerHTML).includes('Available') && String(A.els['agent-list'].innerHTML).includes('<table'));
  check('action history is gone', A.run('typeof openHist') === 'undefined' && A.run('typeof renderHist') === 'undefined');
  check('general actions are no longer recorded (the old no-op loggers are gone)', A.run('typeof glog') === 'undefined' && A.run('typeof aglog') === 'undefined');
  const fs0 = require('fs').readFileSync(path.join(root, 'web/pet_station.html'), 'utf8');
  check('no action-history button in the page', !/openHist|Action history|hist-modal/i.test(fs0));
  check('frame scrolls inside the app (cases area has its own scroll bar)', fs0.includes('id="cases-scroll"') && fs0.includes('#cases-scroll{overflow:auto'));
  A.run("TD={p:'image',imgUrl:'data:image/jpeg;base64,AAAA',pal:derive('#0b6fa4')}");
  setv('th-all', ''); A.els['th-all'].checked = true;
  await A.run('thSave()'); await sleep(2000);
  const T = client({ role: 'agent', name: 'Karen Sabile' });
  await T.run('initDb()'); await sleep(2500);
    check('shared image skin reaches another screen inside the theme itself (no second download)', T.run("(THEME_G&&THEME_G.imgUrl)||''") === 'data:image/jpeg;base64,AAAA' && String(T.els['theme-css'].textContent).includes('url("data:image/jpeg;base64,AAAA")'));

  // ---------- tiles act as case filters ----------
  A.run("(()=>{const c=mkCase('TILE-CLOSED','Haina Azuela',{});c.closed=true;CASES.push(c)})()");
  const ids = () => (String(A.els['rows'].innerHTML).match(/openCaseModal\('([^']+)'/g) || []).map(x => x.slice(15, -1));
  A.run("setDash('all')"); check('Total tile shows every case', ids().includes('TILE-CLOSED') && ids().includes('SORT-LATE'));
  A.run("setDash('closed')"); check('Completed tile shows only closed cases', ids().join() === 'TILE-CLOSED');
  A.run("setDash('active')"); check('Active tile shows only open cases', !ids().includes('TILE-CLOSED') && ids().length >= 4);
  A.run("ackTile()"); check('Due tile filters to cases with due reminders', ids().join() === 'SORT-OVERDUE' && String(A.els['stats'].innerHTML).includes('stat-sel'));
  A.run("ackTile()"); check('clicking the Due tile again clears the filter', ids().length >= 4);
  check('tiles are clickable', (String(A.els['stats'].innerHTML).match(/onclick=/g) || []).length === 4);

  // ---------- the profile stays until another profile is selected ----------
  A.run("ME={role:'manager',name:'Jeff Bote'};checkMe()");
  check('profile is not switched by another screen', A.run('ME.role') === 'manager' && A.run('ME.name') === 'Jeff Bote');
  A.run("pickAgent(0)"); const nm = A.run('ME.name');
  check('selected profile is saved on the device', JSON.parse(A.ctx.localStorage.getItem('pet_me')).name === nm);

  // ---------- profile page first, header shows the profile in use (no dropdown) ----------
  const htmlSrc = html;
  const chipAt = htmlSrc.lastIndexOf('<', htmlSrc.indexOf('id="me-btn"')), chipHtml = htmlSrc.slice(chipAt, htmlSrc.indexOf('</header>'));
  check('header profile chip is a plain display (not a button) with no dropdown arrow', chipHtml.startsWith('<div') && !chipHtml.slice(0, chipHtml.indexOf('</div>')).includes('onclick') && !chipHtml.slice(0, chipHtml.indexOf('</div>')).includes('m6 9 6 6 6-6'));
  check('a saved profile is restored on refresh; the profile page shows only when none is saved', /hydrateImgs\(\)\},300\);\s*if\(!SAVED_PENDING\)lpShow\(\);\s*<\/script>/.test(htmlSrc) && /function bootMe\(\)/.test(htmlSrc));
  A.run("ME={role:null,name:''};SAVED_PENDING=false;localStorage.setItem('pet_me',JSON.stringify({role:'agent',name:'"+nm+"',coord:false}));bootMe();settleSavedMe()");
  check('after a refresh the saved profile stays signed in', A.run('ME.role')!==null && A.run('ME.name')===nm);
  A.run("ME={role:null,name:''};SAVED_PENDING=false;localStorage.setItem('pet_me',JSON.stringify({role:'agent',name:'Nobody Here'}));bootMe();settleSavedMe()");
  check('a saved profile no longer on the schedule falls back to the login page', A.run('ME.role')===null);
  A.run("pickAgent(0)");

  // ---------- account in report, bulk upload, case counts ----------
  check('weekly report starts with Account Name', A.run("WEEKLY[0]")==='account');
  check('bulk parser reads a row and rejects a bad one', (()=>{A.run("ACCOUNTS=['Account A'];var __r=bkParse([['Case Type *','Case Number *','Account Name *','Received on PET Queue (yyyy-mm-dd hh:mm) *'],['Aruba','AR-77','account a','2026-11-10 09:30'],['Foo','','Zed','x']]);");return A.run("__r.rows.length")===2&&A.run("__r.rows[0].errs.length")===0&&A.run("__r.rows[0].acct")==='Account A'&&A.run("__r.rows[1].errs.length")>=3})());
  check('closing needs the account name', A.run("missingFields({caseType:'att',attNo:'1',sfdc:[],items:[],sev:'Sev 1',cstatus:'FE Name',recv:1,model:'x',mw:{s:1,e:2},mwUp:[],pOrd:1,pDel:1,ceArr:1,account:''})").includes('Account Name'));
  A.run("SIMON=true;SIM_ST0=[];CASES=[];ACCOUNTS=['Account A'];NOTICEN=0;var __sn=sendAgentNotice;sendAgentNotice=function(){NOTICEN++};var __hdr=['Case Type','Case Number','Account Name','Received on PET Queue'];var __rows=[__hdr];for(var q=0;q<6;q++)__rows.push(['Aruba','AR-90'+q,'Account A','2026-11-10 09:30']);BK=bkParse(__rows);bkCommit();sendAgentNotice=__sn;");
  check('bulk upload adds every valid case', A.run("CASES.length")===6);
  check('bulk upload creates exactly one reminder alarm', A.run("CASES.reduce((n,c)=>n+c.items.filter(i=>i.rem).length,0)")===1);
  check('bulk upload sends no assignment notification', A.run("NOTICEN")===0);
  check('bulk cases carry the account and case type', A.run("CASES.every(c=>c.account==='Account A'&&c.caseType==='aruba')"));
  check('bulk cases are old cases: given to the agent like hand-over cases, never tagged or counted as New', A.run("CASES.every(c=>credOf(c).n===BULK&&credsOf(c).some(x=>x.n===c.owner)&&!c.nw&&!isNew(c))"));
  A.run("var __c=mkCase('TR-1',pool()[0].name,{nw:1});CASES.unshift(__c);var __o=__c.owner,__t=pool().find(p=>p.name!==__o).name;reassign(__c,__t,'test');");
  check('a transferred case stays in the first agent\'s daily count', A.run("credOf(CASES[0]).n")===A.run("__o")&&A.run("dayN(__o,simNow())")>=1);

  // ---------- statuses, same-case-number merge, daily trend ----------
  check('case statuses are FE Name, Tracking Number, Service Window, Scheduled, TR2, Resolved, Canceled', JSON.stringify(A.run("CSTAT"))===JSON.stringify(['FE Name','Tracking Number','Service Window','Scheduled','TR2','Resolved','Canceled']));
  check('a legacy "Scheduled TR2" status is read as Scheduled', A.run("cx({cstatus:'Scheduled TR2'}).cstatus")==='Scheduled');
  A.run("ACCOUNTS=['Account A','Account Z'];BKM=bkParse([['Case Type','Case Number','Account Name','Received on PET Queue','SFDC Case ID(s)','Model Number'],['Aruba','AR-5000','Account A','2026-11-10 09:30','5001','' ],['Aruba','AR-5000','Account A','2026-11-10 09:30','5002','AP-635'],['Aruba','AR-5000','Account A','2026-11-10 09:30','5001,5003',''],['Aruba','AR-5001','Account A','2026-11-10 10:00','6001',''],['Aruba','AR-5000','Account Z','2026-11-10 09:30','5009','']]);");
  check('rows with the same Aruba case number are combined into one case', A.run("BKM.rows.filter(r=>!r.errs.length).length")===2 && A.run("BKM.merged")===2);
  check('the combined case holds every SFDC number once and fills blanks', JSON.stringify(A.run("BKM.rows[0].sfdc"))===JSON.stringify(['5001','5002','5003']) && A.run("BKM.rows[0].model")==='AP-635');
  check('a same-number row with a different account is rejected', A.run("BKM.rows.some(r=>r.errs.some(e=>/different account/.test(e)))"));
  A.run("SIMON=true;CASES=[];ACCOUNTS=['Account A'];BK=bkParse([['Case Type','Case Number','Account Name','Received on PET Queue','SFDC Case ID(s)','RITM Number'],['Aruba','CS0163982','Account A','2026-11-10 09:30','5406391731','RITM1'],['Aruba','CS0163982','Account A','2026-11-10 09:30','5406391732 / 5406391733','']]);bkCommit();openId='CS0163982';");
  check('a merged case stores every SFDC ID', JSON.stringify(A.run("getCase('CS0163982').sfdc"))===JSON.stringify(['5406391731','5406391732','5406391733']) && A.run("CASES.length")===1);
  check('the case screen lists every SFDC ID in Case Information', (()=>{A.run("renderCase(true)");const h=String(A.els['case-body']?A.els['case-body'].innerHTML:'')||'';return A.run("getCase('CS0163982').sfdc.length")===3&&(h.match(/id="cd-sf\d"/g)||[]).length===3})());
  A.run("BK=bkParse([['Case Type','Case Number','Account Name','Received on PET Queue','SFDC Case ID(s)'],['Aruba','CS0163982','Account A','2026-11-10 09:30','5406391731'],['Aruba','CS0163982','Account A','2026-11-10 09:30','5406399999']]);");
  check('a re-upload adds the new SFDC ID to the existing case, not a duplicate', A.run("BK.rows.filter(r=>!r.errs.length&&r.addTo).length")===1 && A.run("BK.rows.length")===1);
  A.run("bkCommit();");
  check('the existing case now holds the extra SFDC ID', A.run("getCase('CS0163982').sfdc.length")===4 && A.run("CASES.length")===1);
  A.run("SIMON=true;CASES=[];var __n=Date.now(),__D=86400000;var __a=mkCase('T-1',pool()[0].name,{caseType:'att',account:'Account A',recv:__n-2*__D});__a.cstatus='FE Name';__a.sh=[{s:'FE Name',ts:__n-2*__D+36e5},{s:'Tracking Number',ts:__n-__D}];__a.cstatus='Tracking Number';var __b=mkCase('T-2',pool()[0].name,{caseType:'att',account:'Account A',recv:__n-2*__D});__b.closed=true;__b.closedAt=__n-__D;CASES.unshift(__a,__b);rptDays(3,true);RPT.view='daily';DM=dailyModel();");
  check('daily model counts created, closed and pending per day', A.run("DM.rows.length")===3 && A.run("DM.tot.created")===2 && A.run("DM.tot.closed")===1 && A.run("DM.open.length")===1 && A.run("DM.rows[2].pending")===1);
  check('time in each bucket is tracked from the status history', A.run("Math.round(DM.tl.find(x=>x.c.id==='T-1').du['FE Name']/3600000)")>=22);
  check('the daily report renders with graph and tables', (()=>{const h=A.run("dailyHtml()");return /<svg/.test(h)&&/Created vs closed/.test(h)&&/Time each case stayed/.test(h)})());

  check('reports get one row per SFDC ID for a case with several IDs', (()=>{A.run("var __m=mkCase('M-1',pool()[0].name,{caseType:'aruba',account:'Account A',recv:Date.now()});__m.sfdc=['111','222','333'];var __s=mkCase('S-1',pool()[0].name,{caseType:'aruba',account:'Account A',recv:Date.now()});__s.sfdc=['444'];RR=rptRows([__m,__s],WEEKLY);RRn=rptRows([__m,__s],['arubaNo']);");return A.run("RR.length")===4&&JSON.stringify(A.run("RR.map(r=>rv(r,'sfdc'))"))===JSON.stringify(['111','222','333','444'])&&A.run("RRn.length")===2&&A.run("RR.filter(r=>r.c.id==='M-1').every(r=>r.gi===RR[0].gi)")})());
  A.run("CASES.unshift(__m,__s);DM=dailyModel();");
  check('daily model counts SFDC IDs separately from cases and bands pending cases by age', A.run("DM.tot.sfdc")>=4 && A.run("DM.bands.reduce((a,b)=>a+b.n,0)")===A.run("DM.open.length") && A.run("DM.avgClose")!==undefined);
  check('daily report no longer has the redundant open-by-bucket bar', !/Open cases by status bucket now/.test(A.run("dailyHtml()")) && /Pending cases by age/.test(A.run("dailyHtml()")));
  check('weekly report has the AT&T case number right after the account name', JSON.stringify(A.run("WEEKLY.slice(0,3)"))===JSON.stringify(['account','attNo','arubaNo']));
  check('settings tabs stay on one line in a wider modal', /id="settings"[\s\S]{0,200}max-w-\[1680px\]/.test(html) && /id="set-tabs" class="flex flex-nowrap/.test(html));
  check('case table has Account Name before Case Number', /<th[^>]*>Account Name<\/th><th[^>]*>Case Number<\/th>/.test(html));
  check('case table shows no revisit reason', !/Revisit · /.test(html));
  A.run("CASES.unshift(mkCase('R-1',pool()[0].name,{caseType:'att',account:'Account A',recv:Date.now()}));CASES[0].revisit={reason:'x',tid:'T1'};render();");
  check('case table row has the account name before the case number', (()=>{const h=String(A.els['rows']?A.els['rows'].innerHTML:'');const i=h.indexOf('Account A'),j=h.indexOf('R-1');return i>=0&&j>i&&!/Revisit ·/.test(h)})());
  A.run("SIMON=true;CASES=[];var __os=onShiftAt;onShiftAt=function(){return true};var __p=pool(),__a=__p[0].name,__b=__p[1].name;__p.forEach(function(p){p.status='available'});for(var q=0;q<6;q++){var hc=mkCase('H-'+q,__b,{caseType:'att',account:'Account A',recv:Date.now()});hc.eos={from:__a,at:Date.now()};CASES.push(hc)}var __k=mkCase('K-1',__b,{caseType:'att',account:'Account A',recv:Date.now()});CASES.push(__k);rebalanceEos(simNow());");
  A.run("eosCheck();eosCheck();rebalanceEos(simNow());eosCheck()");
  check('cases handed over at EOS are NOT shared back later (no bouncing between agents)', A.run("loadOf(__a)")===0 && A.run("loadOf(__b)")===7);
  check('their owner and credit are untouched by repeated checks', A.run("CASES.every(c=>c.owner===__b)") && A.run("CASES.filter(c=>c.eos).length")===6);
  A.run("SIMON=true;var __os2=onShiftAt;onShiftAt=function(){return true};STAFF.push({name:'EOD Support',role:'EOD Support',shift:'Night',start:'00:00',end:'23:59',days:{},status:'available'});render();");
  check('EOD support does not appear in the agent status panel or its counts', !/EOD Support/.test(String(A.els['agent-list']?A.els['agent-list'].innerHTML:'')) && A.run("isEod(STAFF[STAFF.length-1])") && !A.run("isEod(STAFF[0])"));
  A.run("STAFF.pop();onShiftAt=__os2;SIMON=false");
  A.run("SIMON=true;CASES=[];var __o3=onShiftAt,__sl=STAFF.length;onShiftAt=function(){return true};while(STAFF.filter(function(p){return !isMgr(p)&&!isEod(p)}).length<3)STAFF.push({name:'Test Agent '+STAFF.length,role:'Support',shift:'Morning',start:'06:00',end:'14:00',days:WK([0,1,2,3,4,5,6]),status:'available'});var __q=STAFF.filter(function(p){return !isMgr(p)&&!isEod(p)}),__x=__q[0].name,__y=__q[1].name,__z=__q[2].name;__q.forEach(function(p){p.status='available'});function mkN(o,cn,n,t){for(var i=0;i<n;i++){var c=mkCase(t+i,o,{caseType:'att',account:'Account A',recv:Date.now()});c.credit={n:cn,at:Date.now()};CASES.push(c)}}mkN(__x,__x,29,'X');mkN(__y,__y,29,'Y');mkN(__z,__z,29,'Z');mkN(__x,'Gone Agent',11,'G');var __bef=loadOf(__x);toggleAvailability_test=null;rebalanceEos(simNow());");
  A.run("eosCheck();rebalanceEos(simNow());eosCheck()");
  check('a pile built up by hand-overs is not moved around automatically', A.run("loadOf(__x)")===A.run("__bef") && A.run("loadOf(__y)")===29 && A.run("loadOf(__z)")===29);
  check('an agent\'s own cases stay where they are', A.run("CASES.filter(c=>/^X\\d/.test(c.id)).every(c=>c.owner===__x)")&&A.run("CASES.filter(c=>/^Y\\d/.test(c.id)).every(c=>c.owner===__y)"));
  A.run("onShiftAt=function(p){return p.name!==__z};render();");
  check('an agent past end of shift (EOS) is not listed in the agent status section', !A.run("String(document.getElementById('agent-list').innerHTML).includes(__z)") && A.run("String(document.getElementById('agent-list').innerHTML).includes(__x)"));
  A.run("onShiftAt=__o3;CASES=[];STAFF.length=__sl;SIMON=false");
  A.run("onShiftAt=__os;SIMON=false");
  // ---------- the Template button downloads the repo file ----------
  {let got=null;const __sb=A.ctx.saveBlob;if(!A.ctx.Blob)A.ctx.Blob=Blob;if(!A.ctx.atob)A.ctx.atob=atob;A.ctx.saveBlob=(b,n)=>{got={b,n}};
   const repoB64=require('fs').readFileSync(path.join(root,'templates/PET_Shift_Schedule_Template.xlsx')).toString('base64');
   A.ctx.__petTemplate=()=>Promise.resolve({name:'PET_Shift_Schedule_Template.xlsx',b64:repoB64});
   {const __x=A.ctx.ExcelJS;A.ctx.ExcelJS={Workbook:function(){this.addWorksheet=()=>({getColumn:()=>({}),getCell:()=>({}),getRow:()=>({getCell:()=>({}),set height(v){}})});this.xlsx={writeBuffer:async()=>new Uint8Array([1,2])}}};A.run("SCH_M='2026-12'");await A.ctx.sTemplate();check('the Template button builds the monthly template for the month shown (names and the dates of the month)', !!got&&got.n==='PET_Shift_Schedule_Template_2026-12.xlsx');got=null;A.ctx.ExcelJS=undefined;
   await A.ctx.sTemplate();check('without the Excel library it downloads the file kept in the repo (templates/)', !!got&&got.n==='PET_Shift_Schedule_Template.xlsx'&&got.b.size===Buffer.from(repoB64,'base64').length);
   got=null;A.ctx.__petTemplate=()=>Promise.reject(new Error('offline'));await A.ctx.sTemplate();check('it falls back to the built-in copy when the repo file cannot be reached', !!got&&got.b.size>1000);
   A.ctx.__petTemplate=undefined;A.ctx.saveBlob=__sb;A.ctx.ExcelJS=__x}}
  A.run("RPT.view='weekly'");
  A.run("SIMON=false;CASES=REAL.cases");
  A.run("ME={role:'manager',name:'Jeff Bote'};saveMe()");
  A.run("ME={role:null,name:''};loadMe()");
  check('a profile saved on the device is not restored when the app opens', A.run('ME.role') === null);
  A.run("pickAgent(0)");
  check('the header shows the profile that was selected', A.run('meLabel()').includes(A.run('ME.name')) && !!A.run('ME.name'));
  A.run("ME={role:null,name:''};DBON=true;GOT={};MEASKED=false;LP_T0=Date.now()");
  check('faces cannot be used before the profile data is loaded', A.run('lpReady()') === false);
  A.run("GOT={staff:1,profileHashes:1,seats:1,acct:1,coords:1,landing:1}");
  check('faces work once the profile data is loaded', A.run('lpReady()') === true);
  A.run("DBON=false;ME={role:'manager',name:'Jeff Bote'}");

  // ---------- Foundation case type: SFDC Case ID only, no RITM ----------
  A.run("ADDT='aruba';openAdd()");
  const af = String(A.els['add-card'].innerHTML);
  check('Add Case offers Aruba, AT&T and Foundation', af.includes("addType('aruba')") && af.includes("addType('att')") && af.includes("addType('foundation')") && af.includes('>Foundation<'));
  A.run("addType('foundation')");
  const af2 = String(A.els['add-card'].innerHTML);
  check('Foundation asks for the SFDC Case ID', af2.includes('SFDC Case ID <span class="text-red-600">*</span>') && af2.includes('Enter the SFDC Case ID') && !af2.includes('Foundation Case Number'));
  A.run("(()=>{document.getElementById('add-id').value='';document.getElementById('add-recv').value='2026-11-06T09:00'})()");
  A.run('addCase()');
  check('Foundation case needs the SFDC Case ID', A.run("CASES.some(c=>c.caseType==='foundation')") === false);
  A.run("(()=>{document.getElementById('add-id').value='5009988776';document.getElementById('add-recv').value='2026-11-06T09:00'})()");
  A.run('addCase()'); await sleep(300);
  const fid = '5009988776';
  check('Foundation case is created with the SFDC Case ID as its case ID', A.run(`getCase('${fid}').caseType`) === 'foundation' && JSON.stringify(J(A.run(`JSON.stringify(getCase('${fid}').sfdc)`))) === JSON.stringify([fid]) && A.run(`getCase('${fid}').arubaNo`) === '' && A.run(`dispNo(getCase('${fid}'))`) === fid);
  check('Foundation label', A.run("tlabel('foundation')") === 'Foundation');
  const fb = String(A.els['case-body'].innerHTML);
  check('Foundation case detail has the SFDC Case ID and no RITM', fb.includes('SFDC Case ID') && fb.includes('id="cd-sf0"') && !fb.includes('id="cd-ritm"') && !fb.includes('RITM Number'));
  check('Foundation SFDC Case ID is required, RITM is not', J(A.run(`JSON.stringify(missingFields(getCase('${fid}')))`)).includes('SFDC Case ID') === false && !J(A.run(`JSON.stringify(missingFields(getCase('${fid}')))`)).includes('RITM Number'));
  A.run(`getCase('${fid}').sfdc=['']`);
  check('closing a Foundation case needs an SFDC Case ID but never a RITM', J(A.run(`JSON.stringify(missingFields(getCase('${fid}')))`)).includes('SFDC Case ID') && !J(A.run(`JSON.stringify(missingFields(getCase('${fid}')))`)).includes('RITM Number'));
  A.run(`getCase('${fid}').sfdc=['${fid}']`);
  check('Aruba still asks for SFDC Case ID and RITM; AT&T asks for neither', (() => { const m = J(A.run("JSON.stringify(missingFields({caseType:'aruba',sfdc:[],items:[],mwUp:[]}))")), n = J(A.run("JSON.stringify(missingFields({caseType:'att',sfdc:[],items:[],mwUp:[]}))")); return m.includes('SFDC Case ID') && m.includes('RITM Number') && !n.includes('SFDC Case ID') && !n.includes('RITM Number'); })());
  check('report filter has Foundation', htmlSrc.includes("['foundation','Foundation']"));
  A.run(`closeCase()`);

  // ---------- maintenance window: edit start and end, no "update window" ----------
  A.run("CASES.length=0;CASES.push(mkCase('MWE-1','Haina Azuela',{}));openCaseModal('MWE-1')");
  const mb0 = String(A.els['case-body'].innerHTML);
  check('no maintenance window yet: Start / End and Set window are offered, no Edit', mb0.includes('Set window') && mb0.includes('data-dtp="mw-s"') && !mb0.includes('Edit maintenance window'));
  setv('mw-s', '2026-11-07T10:00'); setv('mw-e', '2026-11-07T12:00'); A.run("mwSave('MWE-1')");
  const mb1 = String(A.els['case-body'].innerHTML);
  check('once set there is an Edit option and no update-window form', mb1.includes('Edit maintenance window') && !mb1.includes('Update window') && !mb1.includes('Or record a new window') && !mb1.includes('data-dtp="mw-s"'));
  A.run("mwEdit('MWE-1')");
  const mb2 = String(A.els['case-body'].innerHTML);
  check('Edit shows the start and end filled with the current values', mb2.includes('data-dtp="mw-es"') && mb2.includes('data-dtp="mw-ee"') && mb2.includes('value="2026-11-07T10:00"') && mb2.includes('value="2026-11-07T12:00"'));
  setv('mw-es', '2026-11-07T11:00'); setv('mw-ee', '2026-11-07T13:30'); A.run("mwEditSave('MWE-1')");
  const w = J(A.run("JSON.stringify(getCase('MWE-1').mw)"));
  check('saving the edit changes the start and the end', w.s === A.run("fromLI('2026-11-07T11:00')") && w.e === A.run("fromLI('2026-11-07T13:30')") && !!w.editTs);
  check('the edit is recorded in the case history and is not an update entry', A.run("getCase('MWE-1').mwUp.length") === 0 && A.run("getCase('MWE-1').log.some(l=>l.action==='Maintenance window edited')") === true);

  // ---------- maintenance window: update button keeps the original ----------
  const mbU = String(A.els['case-body'].innerHTML);
  check('an Update maintenance window button sits beside Edit', mbU.includes('Update maintenance window') && mbU.includes('Edit maintenance window'));
  A.run("mwUpd('MWE-1')");
  check('Update opens a start / end form', String(A.els['case-body'].innerHTML).includes('data-dtp="mw-us"') && String(A.els['case-body'].innerHTML).includes('data-dtp="mw-ue"'));
  const orig = J(A.run("JSON.stringify(getCase('MWE-1').mw)"));
  setv('mw-us', '2026-11-08T09:00'); setv('mw-ue', '2026-11-08T11:00'); A.run("mwUpdSave('MWE-1')");
  check('an update becomes the current window and the original is untouched', A.run("getCase('MWE-1').mwUp.length") === 1 && A.run("mwCur(getCase('MWE-1')).s") === A.run("fromLI('2026-11-08T09:00')") && A.run("getCase('MWE-1').mw.s") === orig.s && A.run("getCase('MWE-1').mw.e") === orig.e);
  A.run("mwUpd('MWE-1')"); setv('mw-us', '2026-11-08T09:00'); setv('mw-ue', '2026-11-08T11:00'); A.run("mwUpdSave('MWE-1')");
  check('an update identical to the current window is not added', A.run("getCase('MWE-1').mwUp.length") === 1);
  A.run("mwUpd('MWE-1')"); setv('mw-us', '2026-11-08T12:00'); setv('mw-ue', '2026-11-08T10:00'); A.run("mwUpdSave('MWE-1')");
  check('update: end before the start is refused', A.run("getCase('MWE-1').mwUp.length") === 1);
  for (const [a, b] of [['2026-11-09T09:00', '2026-11-09T10:00'], ['2026-11-10T09:00', '']]) { A.run("mwUpd('MWE-1')"); setv('mw-us', a); setv('mw-ue', b); A.run("mwUpdSave('MWE-1')"); }
  check('there is no limit on updates and the last one is current', A.run("getCase('MWE-1').mwUp.length") === 3 && A.run("mwCur(getCase('MWE-1')).s") === A.run("fromLI('2026-11-10T09:00')") && A.run("mwCur(getCase('MWE-1')).e") === null);
  check('every update is recorded in the case history', A.run("getCase('MWE-1').log.filter(l=>l.action==='Maintenance window updated').length") === 3);
  const mbU2 = String(A.els['case-body'].innerHTML);
  check('the case shows Original, earlier updates and the Current one', mbU2.includes('Original') && mbU2.includes('Update 1') && mbU2.includes('Update 2') && mbU2.includes('Current'));
  check('the weekly report shows only the current maintenance window (no Original / Update tags)', (() => { const t = String(A.run("mwX(getCase('MWE-1'))")), m = A.run("JSON.stringify(mwCur(getCase('MWE-1')))"), cur = JSON.parse(m); return !t.includes('Original') && !t.includes('Update') && !t.includes('\n') && t.startsWith(A.run("xdt(" + cur.s + ")")); })());
  check('closing needs an end time on the current window', J(A.run("JSON.stringify(missingFields(getCase('MWE-1')))")).includes('Maintenance Window end time'));
  // restore the state the next tests expect
  A.run("getCase('MWE-1').mwUp.length=0");
  A.run("mwEdit('MWE-1')"); setv('mw-es', '2026-11-07T11:00'); setv('mw-ee', '2026-11-07T10:00'); A.run("mwEditSave('MWE-1')");
  check('editing: end before the start is refused', A.run("getCase('MWE-1').mw.e") === w.e);
  setv('mw-es', ''); setv('mw-ee', '2026-11-07T10:00'); A.run("mwEditSave('MWE-1')");
  check('editing: the start cannot be blank', A.run("getCase('MWE-1').mw.s") === w.s);
  setv('mw-es', '2026-11-07T11:00'); setv('mw-ee', ''); A.run("mwEditSave('MWE-1')");
  check('editing: the end can be cleared (then it is required to close)', A.run("getCase('MWE-1').mw.e") === null && J(A.run("JSON.stringify(missingFields(getCase('MWE-1')))")).includes('Maintenance Window end time'));
  A.run("mwEditCancel('MWE-1')");
  check('cancel leaves edit mode', !String(A.els['case-body'].innerHTML).includes('data-dtp="mw-es"'));
  // add new maintenance window (no limit)
  A.run("mwAdd('MWE-1')");
  check('the add form opens', String(A.els['case-body'].innerHTML).includes('Add new maintenance window') && String(A.els['case-body'].innerHTML).includes('data-dtp="mw-as"'));
  setv('mw-as', '2026-11-12T09:00'); setv('mw-ae', '2026-11-12T08:00'); A.run("mwAddSave('MWE-1')");
  check('add: end before the start is refused', A.run("getCase('MWE-1').mwUp.length") === 0);
  setv('mw-as', ''); setv('mw-ae', ''); A.run("mwAddSave('MWE-1')");
  check('add: the start cannot be blank', A.run("getCase('MWE-1').mwUp.length") === 0);
  for (const [a, b] of [['2026-11-12T09:00', '2026-11-12T10:00'], ['2026-11-13T09:00', '2026-11-13T10:00'], ['2026-11-14T09:00', '']]) { A.run("mwAdd('MWE-1')"); setv('mw-as', a); setv('mw-ae', b); A.run("mwAddSave('MWE-1')"); }
  check('any number of new windows can be added and the newest is current', A.run("getCase('MWE-1').mwUp.length") === 3 && A.run("mwCur(getCase('MWE-1')).s") === A.run("fromLI('2026-11-14T09:00')") && A.run("getCase('MWE-1').mwUp.every(m=>m.add)"));
  check('adding keeps the first window untouched', A.run("getCase('MWE-1').mw.s") === w.s);
  check('every added window is recorded in the history', A.run("getCase('MWE-1').log.filter(l=>l.action==='Maintenance window added').length") === 3);
  { const t = String(A.els['case-body'].innerHTML), r = String(A.run("mwX(getCase('MWE-1'))")); check('the case lists the added windows; the report shows only the current one', t.includes('Window 2') && t.includes('Window 4') && !r.includes('Window') && !r.includes('\n')); }
  check('the add button is offered next to Update and Edit', String(A.els['case-body'].innerHTML).includes("mwAdd('MWE-1')"));
  A.run("getCase('MWE-1').mwUp.length=0");
  A.run("closeCase()");

  // ---------- case modal layout, closing rule, availability toggle, simulation ----------
  A.run("ME={role:'manager',name:'Jeff Bote'};CASES.length=0;(()=>{const c=mkCase('MODAL-1','Haina Azuela',{hp:true});c.items.forEach(i=>{i.done=true});c.sev='Sev 3';c.cstatus=CSTAT[0];c.model='AP-1';c.sfdc=['5001'];c.ritm='RITM1';c.pOrd=1;c.pDel=2;c.ceArr=3;c.mw={s:Date.now()-36e5,e:null,by:'x',ts:Date.now()};CASES.push(c)})()");
  A.run("openCaseModal('MODAL-1')");
  const mb = String(A.els['case-body'].innerHTML);
  check('case modal uses the new sections', ['High priority account', 'Case ID', 'Owner', 'Case Information', 'Transfer Details', 'Case Details', 'Work / Part Orders', 'Revisit', 'Checklists', 'Case History', 'Close Case'].every(x => mb.includes(x)));
  A.ctx.document.getElementById('close-err').scrollIntoView = () => {};
  A.run("closeCaseAct('MODAL-1')");
  check('maintenance window end is required to close the case', A.run("getCase('MODAL-1').closed") === false && String(A.els['close-err'].innerHTML).includes('Maintenance Window end time') && A.run("typeof SLA!=='undefined'&&SLA&&SLA.cid==='MODAL-1'") !== true);
  setv('mw-end', '2099-01-01T10:00'); A.run("mwEnd('MODAL-1')");
  check('closing is allowed once the end is set', !J(A.run("JSON.stringify(missingFields(getCase('MODAL-1')))")).includes('Maintenance Window end time'));
  A.run("startSim()");
  check('simulation shows a case with a maintenance window start but no end', A.run('CASES[1].mw&&CASES[1].mw.e') === null);
  check('simulation announcement carries a mention and a case tag', A.run("ANN.some(a=>a.simulation&&a.mentions&&a.mentions.length&&a.cases&&a.cases.length)") === true);
  const ag = A.run("pool()[0].name"); A.run(`setUser(${JSON.stringify(ag)})`);
  check('availability toggle is available while simulating an agent', A.run("!!availP()") === true);
  const st0 = A.run("availP().status"); A.run('toggleAvailability()');
  check('going unavailable first asks for a reason (nothing changes yet)', A.run("availP().status") === st0);
  A.run("document.getElementById('aux-reason').value='Break'");A.run('auxConfirm()');
  check('toggle changes the simulated agent only', A.run("availP().status") !== st0);
  A.run('stopSim()');
  check('stopping the simulation restores the real availability', A.run(`pers(${JSON.stringify(ag)}).status`) === st0);
  check('toggle text is dark green', fs0.includes("color:#0b4f2a !important") && fs0.includes('header button:not(#agent-availability)'));

  // ---------- date/time picker, same-time maintenance window, required item alerts ----------
  check('time typed as text is understood', [A.run("dtpParse('9:23 am',0)"), A.run("dtpParse('930',0)"), A.run("dtpParse('930',800)"), A.run("dtpParse('21:15',0)"), A.run("dtpParse('12 am',0)"), A.run("dtpParse('12pm',0)"), A.run("dtpParse('nonsense',0)")].join() === '563,570,1290,1275,0,720,');
  check('time list shows 12-hour times', A.run("t12m(0)") === '12:00 AM' && A.run("t12m(785)") === '1:05 PM' && A.run("dtpFmt('2026-11-07T09:23','datetime')") === 'Nov 7, 2026, 9:23 AM' && A.run("dtpFmt('14:05','time')") === '2:05 PM');
  A.run("CASES.length=0;CASES.push(mkCase('PICK-1','Haina Azuela',{}));openCaseModal('PICK-1')");
  const pb = String(A.els['case-body'].innerHTML);
  check('case form uses the new picker instead of the native one', pb.includes('data-dtp="cd-pOrd"') && pb.includes('data-dtp="mw-s"') && !pb.includes('datetime-local'));
  setv('mw-s', ''); A.run("dtpOpen('mw-s')");
  A.run("dtpMonth(1);dtpDay(15);dtpSearch('9:3')");
  check('searching narrows the time list', String(A.els['dtp-list'].innerHTML).includes('9:30 AM') && !String(A.els['dtp-list'].innerHTML).includes('10:00 AM'));
  A.run("dtpTime(570)");
  const before = A.els['mw-s'].value; A.run('dtpOk()');
  check('OK stores the chosen date and time', before === '' && /^\d{4}-\d{2}-15T09:30$/.test(A.els['mw-s'].value) && A.run('DTP') === null, A.els['mw-s'].value);
  setv('mw-s', '2026-11-07T10:00'); setv('mw-e', '2026-11-07T10:00'); A.run("mwSave('PICK-1')");
  check('maintenance window start and end can be the same date and time', A.run("getCase('PICK-1').mw&&getCase('PICK-1').mw.e===getCase('PICK-1').mw.s") === true);
  setv('mw-e', '2026-11-07T09:59'); A.run("mwSave('PICK-1')");
  check('a second "set window" no longer adds an update', A.run("getCase('PICK-1').mwUp.length") === 0);
  A.run("mwEdit('PICK-1')"); setv('mw-es', '2026-11-07T10:00'); setv('mw-ee', '2026-11-07T09:59'); A.run("mwEditSave('PICK-1')");
  check('end before the start is still refused when editing', A.run("getCase('PICK-1').mw.e===getCase('PICK-1').mw.s&&getCase('PICK-1').mwUp.length===0") === true);
  A.run("mwEditCancel('PICK-1')");
  A.run("REQUIRED_ITEMS=[{text:'Ack the case',min:20},{text:'Call the customer',min:45},{text:'No alert item',min:0}];CASES.push(mkCase('REQ-1','Haina Azuela',{}))");
  const ri = J(A.run("JSON.stringify(getCase('REQ-1').items.map(i=>[i.text,i.reqMin,!!i.rem,i.rem?Math.round((i.rem.at-i.rem.setAt)/60000):0]))"));
  check('each required item gets its own alarm time on a new case', JSON.stringify(ri) === JSON.stringify([['Ack the case', 20, true, 20], ['Call the customer', 45, true, 45], ['No alert item', 0, false, 0]]), JSON.stringify(ri));
  A.run("REQUIRED_ITEMS=['Legacy text item']");
  check('older required items (plain text) still get the default alert', A.run("getCase('REQ-1')&&mkCase('LEG-1','x',{}).items[0].rem!==null") === true);
  A.run("REQUIRED_ITEMS=[{text:'A',min:20},{text:'B',min:0}];setTabTo('required')");
  const rt = String(A.els['set-body'].innerHTML);
  check('settings show an alarm time with quick buttons for every required item', rt.includes('id="req-min-0"') && rt.includes('id="req-min-1"') && rt.includes('id="req-min-new"') && rt.includes('+1 hr'));
  setv('req-min-1', '10'); A.run("reqQuick('1',60,false)");
  check('+ buttons add up in the required item alarm', A.els['req-min-1'].value === '70');
  setv('req-1', 'B'); A.run("saveRequired(1)");
  check('required item saves its text and alarm time', JSON.stringify(J(A.run("JSON.stringify(REQUIRED_ITEMS[1])"))) === JSON.stringify({ text: 'B', min: 70 }));
  setv('req-0', 'A'); setv('req-min-0', '0'); A.run("saveRequired(0)");
  check('the first required item must keep an alert time', A.run("reqNorm(REQUIRED_ITEMS[0],0).min") === 20);
  setv('req-new', 'Third'); setv('req-min-new', '15'); A.run("addRequired()");
  check('a new required item can be added with an alarm time', JSON.stringify(J(A.run("JSON.stringify(REQUIRED_ITEMS[2])"))) === JSON.stringify({ text: 'Third', min: 15 }));
  check('green line beside Operations Overview is gone', !fs0.includes('background:#17a863"></span><div><h2'));

  // ---------- theme reaches the pop-up modals ----------
  const css = () => String(A.els['theme-css'].textContent);
  A.run("applyTheme({p:'default'})");
  check('default theme keeps the original pop-up overlays and announcement colour', !css().includes('#case-modal,#add-modal') && !css().includes('.bg-violet-600') && css().includes('--ann:#7c3aed') && css().includes('.cch{'));
  A.run("applyTheme({p:'custom',c:'#c2410c'})");
  check('a colour theme tints pop-up overlays and recolours announcements', css().includes('#case-modal,#add-modal') && css().includes('.bg-violet-600{background-color:var(--ann)') && !css().includes('--ann:#7c3aed') && css().includes('.bg-\\[\\#0a5bd6\\]{background-color:var(--ac)'));
  A.run("applyTheme({p:'image',imgUrl:'data:image/jpeg;base64,AAAA',pal:derive('#0b6fa4')})");
  check('image skin shows on pop-up backgrounds, cards and headers', css().includes('#ann-pop{background-image:linear-gradient(') && css().includes('url("data:image/jpeg;base64,AAAA")') && css().includes('#dtp-card{background-color:rgba(255,255,255,.93)') && css().includes('.modal-hdr{background-image:'));
  check('case modal and settings headers take part in the theme', (fs0.match(/class="modal-hdr /g) || []).length === 2);
  A.run("applyTheme({p:'default'})");

  // ---------- login page: faces, profiles, passwords, sign-up, coordinators ----------
  const sv = (c, id, v) => { c.ctx.document.getElementById(id).value = v; };
  const P = client({ role: null, name: '' });
  await P.run('initDb()'); await sleep(2500);
  check('the login page opens when nobody is signed in', P.run('MEASKED') === true);
  check('the two front-row managers are always in the schedule', P.run("STAFF.some(p=>p.name==='Joerolyn Franquelli'&&p.role==='Manager')&&STAFF.some(p=>p.name==='Jose Teves'&&p.role==='Manager')") === true);
  check('front-row faces belong to the managers', P.run("seatName('m1')") === 'Joerolyn Franquelli' && P.run("seatName('m2')") === 'Jose Teves');
  check('every other face starts without a name or profile', P.run("SEAT_IDS.filter(i=>!MGR_SEATS[i]).every(i=>!seatName(i))") === true);
  check('16 team faces + 2 managers + 3 Vendor Management Team faces + the Director, 21 clickable on the mobile picture', P.run('SEAT_IDS.length') === 22 && P.run('SEAT_IDS.filter(i=>SEAT_GEO[i].length>4).length') === 21);
  check('June John Cruz (Vendor Management Team - Auditor) keeps his face and manager access', P.run("seatName('j1')") === 'June John Cruz' && P.run("STAFF.some(p=>p.name==='June John Cruz'&&p.role==='Vendor Management Team - Auditor'&&isMgr(p))") === true);
  check('Jeff Bote (Vendor Management Team - Manager) is the man in the middle with manager access', P.run("seatName('j2')") === 'Jeff Bote' && P.run("STAFF.some(p=>p.name==='Jeff Bote'&&p.role==='Vendor Management Team - Manager'&&isMgr(p))") === true);
  check('Arianne Escabillas (Vendor Management Team - Developer) is the standing woman on the right with full access', P.run("seatName('a1')") === 'Arianne Escabillas' && P.run("STAFF.some(p=>p.name==='Arianne Escabillas'&&p.role==='Vendor Management Team - Developer'&&isMgr(p))") === true);
  check('the earlier face ids are kept, so faces already claimed stay claimed', ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11','s12','s13','s14','s15','s16','m1','m2'].every(i => P.run('SEAT_IDS').includes(i)));
  P.run("viewAssign('s3')");
  check('an unclaimed face lists names from the shift schedule (not the managers)', P.run("LP.list.includes('Karen Sabile')") === true && P.run("LP.list.includes('Jose Teves')") === false);
  P.run("claimSeat('s3','Karen Sabile')"); await sleep(1500);
  check('claiming a face only asks for the name and signs in (no password step yet)', P.run("seatName('s3')") === 'Karen Sabile' && P.run('ME.name') === 'Karen Sabile' && P.run('LP.v') === 'assign');
  P.run("ME={role:null,name:''}"); P.run("claimSeat('s5','Jonathan Gaspar')"); await sleep(800);
  check('a first claim signs in straight away, without asking for a password', P.run("seatName('s5')") === 'Jonathan Gaspar' && P.run('ME.name') === 'Jonathan Gaspar');
  P.run("ME={role:null,name:''}"); P.run("lpSeat('s5')");
  check('the next time that face is clicked it asks to add a password', P.run('LP.v') === 'offer' && P.run('ME.role') === null);
  P.run("lpEnter(LP.name)"); P.run("ME={role:null,name:''}"); P.run("lpSeat('s5')");
  check('Not now still asks again on the following login', P.run('LP.v') === 'offer');
  const P2 = client({ role: null, name: '' });
  await P2.run('initDb()'); await sleep(2500);
  check('a claimed face is known on another screen', P2.run("seatName('s3')") === 'Karen Sabile');
  P.run("claimSeat('s4','Karen Sabile')");
  check('a name cannot be claimed on two faces', P.run("seatName('s4')") === '');
  P.run("LP={v:'setpw',name:'Karen Sabile'}"); sv(P, 'lp-pw', 'pw1234'); sv(P, 'lp-pw2', 'pw1234');
  await P.run('lpSavePw()'); await sleep(1500);
  check('after setting a password the profile opens', P.run('ME.name') === 'Karen Sabile' && P.run('ME.role') === 'agent');
  P.run("ME={role:null,name:''}"); P.run("lpSeat('s3')");
  check('a profile with a password asks for it before opening', P.run('LP.v') === 'verify' && P.run('ME.role') === null);
  sv(P, 'lp-pw', 'wrong'); await P.run('lpVerify()');
  check('a wrong password does not open the profile', P.run('ME.role') === null);
  sv(P, 'lp-pw', 'pw1234'); await P.run('lpVerify()');
  check('the right password opens it', P.run('ME.name') === 'Karen Sabile');
  P.run("ME={role:null,name:''}"); P.run("lpSeat('m2')");
  check('a face without a password asks if you want to set one', P.run('LP.v') === 'offer' && P.run('LP.name') === 'Jose Teves');
  P.run("lpEnter('Jose Teves')");
  check('a front-row manager signs in as a manager', P.run('ME.role') === 'manager' && P.run('ME.name') === 'Jose Teves');
  P.run("ME={role:null,name:''}"); P.run('viewSignUp()');
  sv(P, 'lp-nm', 'Karen Sabile'); sv(P, 'lp-em', 'k@hpe.com'); sv(P, 'lp-pw', 'secret12'); sv(P, 'lp-pw2', 'secret12'); await P.run('lpSignUp()');
  check('a name on the shift schedule cannot sign up', String(P.els['lp-err'].textContent).includes('shift schedule') && P.run('ACCTS.length') === 0);
  sv(P, 'lp-nm', 'Maria Santos'); sv(P, 'lp-em', 'maria.santos@hpe.com'); sv(P, 'lp-pw', 'secret12'); sv(P, 'lp-pw2', 'secret12'); await P.run('lpSignUp()'); await sleep(1500);
  check('sign-up creates an account', P.run("ACCTS.some(a=>a.email==='maria.santos@hpe.com')") === true);
  sv(P, 'lp-nm', 'Other'); sv(P, 'lp-em', 'x@gmail.com'); await P.run('lpSignUp()');
  check('only HPE emails can sign up', String(P.els['lp-err'].textContent).includes('HPE'));
  P.run('viewEmail()'); sv(P, 'lp-em', 'maria.santos@hpe.com'); sv(P, 'lp-pw', 'nope'); await P.run('lpEmail()');
  check('a wrong password does not sign in with email', P.run('ME.role') === null);
  sv(P, 'lp-pw', 'secret12'); await P.run('lpEmail()');
  check('signing in with the HPE email opens the new profile', P.run('ME.role') === 'member' && P.run('ME.name') === 'Maria Santos');
  const P3 = client({ role: null, name: '' });
  await P3.run('initDb()'); await sleep(2500);
  check('accounts are shared between screens', P3.run("ACCTS.some(a=>a.name==='Maria Santos')") === true);
  // coordinators
  P.run("ME={role:'agent',name:'Karen Sabile'}"); P.run("toggleCoord('Karen Sabile',true)");
  check('only a manager can assign coordinators', P.run('COORDS.length') === 0);
  P.run("ME={role:'manager',name:'Jose Teves'}");
  P.run("toggleCoord('Haina Azuela',true)");
  check('a coordinator needs a profile that already exists', P.run("isCoordName('Haina Azuela')") === false);
  P.run("toggleCoord('Karen Sabile',true)"); P.run("toggleCoord('Maria Santos',true)"); await sleep(1500);
  check('a manager can assign more than one coordinator', P.run('COORDS.length') === 2);
  check('the Profiles tab lists profiles with coordinator boxes', String(P.run('profTab()')).includes('Release face') && String(P.run('profTab()')).includes('toggleCoord'));
  const Q = client({ role: 'agent', name: 'Karen Sabile', coord: false });
  await Q.run('initDb()'); await sleep(2500);
  check('a signed-in profile becomes coordinator when a manager assigns it', Q.run('ME.coord') === true && Q.run('isLead()') === true && Q.run('meKey()') === Q.run('ME.name'));
  P.run("ME={role:null,name:''}"); P.run("lpEnter('Karen Sabile')");
  check('signing in as an assigned coordinator gives the coordinator role', P.run('ME.coord') === true && String(P.run('meLabel()')).startsWith('Coordinator'));
  P.run("ME={role:'manager',name:'Jose Teves'}"); P.run("toggleCoord('Karen Sabile',false)"); await sleep(3000);
  check('removing the coordinator role takes effect on the signed-in screen', Q.run('ME.coord') === false && Q.run('isLead()') === false);
  P.run("ME={role:'manager',name:'Jose Teves'}"); P.run("relSeat('Karen Sabile')"); await sleep(1500);
  check('a manager can release a face so it can be claimed again', P.run("seatName('s3')") === '');
  P.run("ME={role:'manager',name:'Jose Teves'}"); P.run("sDel(STAFF.findIndex(p=>p.name==='Jose Teves'))");
  check('the front-row managers cannot be removed from the schedule', P.run("STAFF.some(p=>p.name==='Jose Teves')") === true);
  check('login page has the web and mobile pictures with 18 faces', (fs0.match(/id="landing-img"/g) || []).length === 1 && (fs0.match(/id="landing-img-m"/g) || []).length === 1);
  check('login page has no close button', !fs0.includes('id="l-close"'));

  // ---------- cases stay with the owner when unavailable; only EOS transfers them ----------
  const ALL = '["00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59","00:00-23:59"]';
  A.run(`STAFF=[{name:"Haina Azuela",role:"Support",start:"00:00",end:"23:59",days:[1,1,1,1,1,1,1],sch:${ALL},status:"available"},{name:"Karen Sabile",role:"Support",start:"00:00",end:"23:59",days:[1,1,1,1,1,1,1],sch:${ALL},status:"available"}]`);
  A.run("ME={role:'agent',name:'Karen Sabile'};applyMe();CASES.length=0;CASES.push(mkCase('RET-1','Karen Sabile',{}),mkCase('RET-2','Karen Sabile',{}))");
  A.run('toggleAvailability()');
  check('asking for a reason: the agent is still available until one is chosen', A.run("pers('Karen Sabile').status") === 'available');
  A.run("document.getElementById('aux-reason').value=''");A.run('auxConfirm()');
  check('confirming without a reason is refused', A.run("pers('Karen Sabile').status") === 'available');
  A.run("document.getElementById('aux-reason').value='Lunch'");A.run('auxConfirm()');
  check('the agent is now unavailable', A.run("pers('Karen Sabile').status") === 'unavailable');
  check('the chosen reason is kept and shown in Agent Status', A.run("pers('Karen Sabile').reason") === 'Lunch' && A.run("auxLabel(pers('Karen Sabile'))") === 'Lunch');
  check('open cases stay with the owner after marking unavailable', A.run("CASES.every(c=>c.owner==='Karen Sabile')") === true);
  check('an unavailable agent is excluded from new assignments', A.run("pool().some(p=>p.name==='Karen Sabile')") === false);
  A.run('eosCheck()');
  check('still on shift: eosCheck leaves the cases with the unavailable owner', A.run("CASES.every(c=>c.owner==='Karen Sabile')") === true);
  A.run("(()=>{const k=pers('Karen Sabile');k.days=[0,0,0,0,0,0,0];k.sch=['OFF','OFF','OFF','OFF','OFF','OFF','OFF']})()");
  A.run('eosCheck()');
  check("at the owner's end of shift the cases are transferred automatically", A.run("CASES.every(c=>c.owner==='Haina Azuela')") === true);
  A.run("ME={role:'manager',name:'Jeff Bote'};applyMe()");
  // ---------- unavailable reason, 30 minutes before end of shift, automatic sign-out, 100 cases per page ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, startOff, endOff) => ({ name, role: 'Support', start: T(nowM + startOff), end: T(nowM + endOff), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    const setStaff = list => A.run('STAFF=' + JSON.stringify(list) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    // -- Agent Status shows the reason
    setStaff([ag('Haina Azuela', -240, 240), ag('Karen Sabile', -240, 240)]);
    A.run("ME={role:'agent',name:'Karen Sabile'};applyMe();CASES.length=0;LOCAL_NOTICES.length=0");
    A.run('toggleAvailability()'); A.run("document.getElementById('aux-reason').value='Lunch'"); A.run('auxConfirm()'); A.run('render()');
    const al = String(A.els['agent-list'].innerHTML);
    check('Agent Status shows the chosen reason next to Unavailable', /Unavailable · <span[^>]*>Lunch</.test(al), al.slice(0, 300));
    check('the reason dropdown offers Break, Lunch, Coaching, Admin and Other', ['Break', 'Lunch', 'Coaching', 'Admin', 'Other'].every(r => A.run('AUX_REASONS').includes(r)) && A.run('AUX_REASONS.length') === 5);
    A.run('toggleAvailability()');
    check('becoming available again clears the reason', A.run("pers('Karen Sabile').status") === 'available' && A.run("pers('Karen Sabile').reason") === '');
    A.run('toggleAvailability()'); A.run("document.getElementById('aux-reason').value='Other'"); A.run("document.getElementById('aux-note').value='  System issue  '"); A.run('auxConfirm()'); A.run('render()');
    check('Other can carry a short detail that is shown too', /Unavailable · <span[^>]*>Other: System issue</.test(String(A.els['agent-list'].innerHTML)));
    A.run('toggleAvailability()');
    // -- no new cases in the last 30 minutes of a shift
    setStaff([ag('Late Larry', -450, 25), ag('Edge Eddie', -450, 35), ag('Long Lena', -240, 300)]);
    check('minutes to end of shift are worked out', [24, 25].includes(A.run("minsToEos(pers('Late Larry'),simNow())")) && [299, 300].includes(A.run("minsToEos(pers('Long Lena'),simNow())")));
    check('25 minutes before EOS is "near", 35 minutes is not', A.run("nearEos(pers('Late Larry'),simNow())") === true && A.run("nearEos(pers('Edge Eddie'),simNow())") === false);
    A.run("CASES.length=0;for(let i=0;i<3;i++)CASES.push(mkCase('NE-'+i,'Long Lena',{}))");
    const picks = [0, 1, 2, 3].map(() => A.run('coverFor(simNow(),null,undefined,true)'));
    check('a case is never assigned to someone 30 minutes from EOS (even though they have the fewest cases)', picks.every(n => n !== 'Late Larry'), JSON.stringify(picks));
    check('the agent with a later EOS and the fewest cases gets it instead', picks[0] === 'Edge Eddie', JSON.stringify(picks));
    check('"prefer" cannot override the 30-minute rule', A.run("coverFor(simNow(),'Late Larry',undefined,false)") !== 'Late Larry');
    setStaff([ag('Late Larry', -450, 25), { ...ag('Night Nina', 600, 1000), days: [1, 1, 1, 1, 1, 1, 1] }]);
    check('nobody on shift and nobody starting soon: no off-shift agent is picked (the case waits in the queue)', A.run("coverFor(simNow(),null,undefined,true)") === '');
    setStaff([ag('Late Larry', -450, 25), ag('Soon Sal', 40, 500), ag('Night Nina', 600, 1000)]);
    check('a new case is not given to an agent who has not started yet (it waits for the first available agent)', A.run("coverFor(simNow(),null,undefined,true)") === '');
    // -- hand-over only at the start of the receiving agent's shift, shared evenly, never bounced back
    {
      const ho = (list) => { setStaff(list); };
      ho([ag('Gone Gary', -540, -10), ag('Early Ed', -300, 240), ag('Later Lou', -300, 240)]);
      A.run("CASES.length=0;for(let i=0;i<6;i++)CASES.push(mkCase('HO-'+i,'Gone Gary',{}))");
      A.run('eosCheck()');
      { const o0 = J(A.run("JSON.stringify(CASES.map(c=>c.owner))")); check('at EOS the cases are handed over at once to the agents on shift, evenly', !o0.includes('Gone Gary') && o0.filter(o => o === 'Early Ed').length === 3 && o0.filter(o => o === 'Later Lou').length === 3, o0); }
      ho([ag('Gone Gary', -540, -10), ag('Night Nina', 300, 800)]);
      A.run("CASES.length=0;for(let i=0;i<4;i++)CASES.push(mkCase('HO-'+i,'Gone Gary',{}))");
      A.run('eosCheck()');
      check('if nobody is on shift yet the cases wait for the first agent to start', A.run("CASES.every(c=>c.owner==='Gone Gary')") === true);
      ho([ag('Gone Gary', -540, -10), ag('Starter Sam', -5, 480), ag('Starter Sue', -3, 480), ag('Early Ed', -300, 240)]);
      A.run("CASES.length=0;for(let i=0;i<6;i++)CASES.push(mkCase('HO-'+i,'Gone Gary',{}))");
      A.run('eosCheck()');
      const own = J(A.run("JSON.stringify(CASES.map(c=>c.owner))"));
      check('the cases are shared evenly between everyone on shift', ['Starter Sam', 'Starter Sue', 'Early Ed'].every(n => own.filter(o => o === n).length === 2) && !own.includes('Gone Gary'), own);
      A.run('eosCheck();eosCheck();rebalanceEos(simNow())');
      check('a later check moves nothing back', J(A.run("JSON.stringify(CASES.map(c=>c.owner))")).join() === own.join());
      ho([ag('Gone Gary', -540, -10), ag('Starter Sam', -5, 25), ag('Starter Sue', -3, 480)]);
      A.run("CASES.length=0;for(let i=0;i<4;i++)CASES.push(mkCase('HO-'+i,'Gone Gary',{}))");
      A.run('eosCheck()');
      check('someone near EOS does not receive hand-overs', A.run("CASES.every(c=>c.owner==='Starter Sue')") === true);
      // manual hand-over before EOS: shared evenly, waits for the receivers, never bounced
      ho([ag('Ending Eva', -480, 40), ag('Mid Max', -200, 300), ag('Mid Mia', -200, 300), ag('Later Lia', 30, 540)]);
      A.run("CASES.length=0;for(let i=0;i<8;i++)CASES.push(mkCase('MH-'+i,'Ending Eva',{}));ME={role:'agent',name:'Ending Eva'};applyMe();render()");
      check('the banner lists only the agents on shift now', /Mid Max/.test(String(A.els['eos-xfer'].innerHTML)) && /Mid Mia/.test(String(A.els['eos-xfer'].innerHTML)) && !/Later Lia/.test(String(A.els['eos-xfer'].innerHTML)));
      A.run('xferAll();xferAll()');
      const mo = J(A.run("JSON.stringify(CASES.map(c=>c.owner))")), cnt = n => mo.filter(o => o === n).length;
      check('a manual hand-over is shared evenly between the agents on shift, never to someone off shift', mo.length === 8 && !mo.includes('Ending Eva') && cnt('Later Lia') === 0 && cnt('Mid Max') === 4 && cnt('Mid Mia') === 4, mo);
      A.run('eosCheck();eosCheck();rebalanceEos(simNow())');
      check('a manual hand-over to an agent who has not started yet stays put', J(A.run("JSON.stringify(CASES.map(c=>c.owner))")).join() === mo.join());
      check('manual hand-overs are marked so they are never taken back', A.run("CASES.every(c=>c.credit&&c.credit.man===true&&c.credit.manTo===c.owner)") === true);
    }
    // -- automatic sign-out 20 minutes after end of shift
    const agOut = (name, passed) => ag(name, -480 - passed, -passed);
    setStaff([agOut('Gone Gina', 25), agOut('Just Jill', 10), ag('Here Hana', -240, 240)]);
    const asIn = (name, signedAgo, extra) => A.run("ME=Object.assign({role:'agent',name:'" + name + "'}," + JSON.stringify(extra || {}) + ");SIGNED_IN_AT=Date.now()-" + signedAgo + ";SAVED_PENDING=false;localStorage.setItem('pet_me','x');autoSignOutCheck()");
    check('forgot to sign out and EOS passed 25 minutes ago: signed out automatically', asIn('Gone Gina', 3600000) === true && A.run('ME.role') === null && A.run("localStorage.getItem('pet_me')") === null);
    check('EOS passed only 10 minutes ago: still signed in', asIn('Just Jill', 3600000) === false && A.run('ME.role') === 'agent');
    check('still on shift: not signed out', asIn('Here Hana', 3600000) === false);
    check('signed in after the 20-minute mark (picked the profile up later): not signed out', asIn('Gone Gina', 1000) === false);
    check('coordinators are never signed out automatically', asIn('Gone Gina', 3600000, { coord: true }) === false);
    check('managers are never signed out automatically', (A.run("ME={role:'manager',name:'Gone Gina'};SIGNED_IN_AT=Date.now()-3600000;autoSignOutCheck()")) === false);
    // -- the case table shows 100 cases per page, the search still reaches all of them
    setStaff([ag('Long Lena', -240, 300)]);
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();CASES.length=0;for(let i=0;i<230;i++){const c=mkCase('PG-'+i,'Long Lena',{});c.ts=Date.now()-i;CASES.push(c)}");
    setv('q', ''); A.ctx.document.getElementById('mine').checked = false; A.run("TAB='active';CPAGE=0;CSIG='';render()");
    const nRows = () => (String(A.els['rows'].innerHTML).match(/<tr onclick/g) || []).length;
    check('page 1 shows 100 cases', nRows() === 100, String(nRows()));
    check('a pager tells where you are', String(A.els['pager'].innerHTML).includes('Page 1 of 3') && String(A.els['pager'].innerHTML).includes('1–100 of 230'));
    A.run('cPage(1)'); check('page 2 shows the next 100', nRows() === 100 && String(A.els['pager'].innerHTML).includes('Page 2 of 3'));
    A.run('cPage(1)'); check('page 3 shows the last 30', nRows() === 30 && String(A.els['pager'].innerHTML).includes('Page 3 of 3'));
    A.run('cPage(1)'); check('"Next" on the last page stays there', nRows() === 30);
    setv('q', 'pg-229'); A.run('render()');
    check('the search finds a case that is on another page', nRows() === 1 && String(A.els['rows'].innerHTML).includes('PG-229'));
    check('searching goes back to page 1 and hides the pager', A.run('CPAGE') === 0 && !String(A.els['pager'].innerHTML).includes('Page'));
    setv('q', ''); A.run('render()'); check('clearing the search shows page 1 again', nRows() === 100);
    A.run("CASES.length=0;render()");
    setStaff([ag('Haina Azuela', -240, 240), ag('Karen Sabile', -240, 240)]);
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();SIGNED_IN_AT=Date.now()");
  }
  // ---------- welcome page after sign-in ----------
  {
    A.run("lpHide();CASES.length=0;ANN.length=0;ACKS.length=0;LOCAL_NOTICES.length=0;MENTIONS.length=0");
    const me = 'Haina Azuela', now = Date.now();
    A.run("SEATS={s5:{name:'" + me + "'}}");
    A.run("ANN.push({id:'wa1',title:'Unread queue update',msg:'Please read this',to:'all',by:'Jose Teves',byKey:'Jose_Teves',ts:" + (now - 3600000) + ",mentions:[],cases:[],imgs:[]})");
    A.run("ANN.push({id:'wa2',title:'Already read news',msg:'old',to:'all',by:'Jose Teves',byKey:'Jose_Teves',ts:" + (now - 7200000) + ",mentions:[],cases:[],imgs:[]})");
    A.run("ACKS.push({ann:'wa2',key:akey('" + me + "'),ts:" + now + "})");
    A.run("LOCAL_NOTICES.push({id:'wm1',kind:'mention',caseId:'W-1',owner:'" + me + "',from:'Jose Teves',message:'Please review W-1 now',ts:" + (now - 600000) + ",ack:false})");
    A.run("LOCAL_NOTICES.push({id:'wm2',kind:'mention',caseId:'W-1',owner:'" + me + "',from:'Old Mention',message:'seen already',ts:" + (now - 900000) + ",ack:true})");
    A.run("LOCAL_NOTICES.push({id:'wm3',kind:'mention',caseId:'W-9',owner:'Someone Else',from:'Jose Teves',message:'not for this person',ts:" + (now - 900000) + ",ack:false})");
    A.run("(()=>{const c=mkCase('W-1','" + me + "',{caseType:'att',account:'Account A',recv:Date.now()-3600000});c.hp=true;c.ts=" + (now - 1800000) + ";c.items=[{id:'wi1',text:'Call the customer back',done:false,rem:{at:Date.now()-60000,text:'Call back',fired:true,by:'Jose Teves',setAt:Date.now()-3600000}}];CASES.push(c)})()");
    A.run("localStorage.setItem('pat_seen_'+akey(profileKey('" + me + "')),'" + (now - 4 * 3600000) + "')");
    A.run("document.getElementById('landing-img').src='data:image/webp;base64,QUJD';WEL.url=''");
    A.run("ME={role:null,name:''};WEL.open=false");
    A.run("pickAgent(STAFF.findIndex(p=>p.name==='" + me + "'))");
    check('signing in opens the welcome page', A.run('WEL.open') === true);
    const h = String(A.els['welcome'].innerHTML);
    check('it greets the owner of the profile by first name', /Good (morning|afternoon|evening), Haina!/.test(h), h.slice(0, 200));
    check('the profile picture is the selected face cropped from the team picture', /class="wl-av"[^>]*background-position:calc\(var\(--d\)\*-?[\d.]+\) calc\(var\(--d\)\*-?[\d.]+\)/.test(h) && /background-image:url\(/.test(h));
    check('a person without a selected face gets initials instead', (A.run("SEATS={}"), A.run("welAvatar('Haina Azuela')").includes('>HA<')) && (A.run("SEATS={s5:{name:'" + me + "'}}"), true));
    check('unread mention is listed', h.includes('Please review W-1 now'));
    check('an acknowledged mention is not listed', !h.includes('seen already'));
    check("another person's mention is not listed", !h.includes('not for this person'));
    check('unread announcement is listed', h.includes('Unread queue update'));
    check('an announcement already acknowledged is not listed', !h.includes('Already read news'));
    check('things that arrived while away are marked NEW', (h.match(/wl-new/g) || []).length >= 3, String((h.match(/wl-new/g) || []).length));
    check('the away time and summary line are shown', /You were away for 4 hours/.test(h) && h.includes('While you were away:'));
    check('a due reminder and the high-priority case are shown', h.includes('Reminder due') && h.includes('Call the customer back') && h.includes('High priority'));
    check('the page takes its colours from the shared theme', String(A.els['welcome'].style.cssText || '').includes('--wa:'));
    A.run("welAck('wm1')");
    check('"Got it" removes the mention from the page', !String(A.els['welcome'].innerHTML).includes('Please review W-1 now'));
    check('and it stays acknowledged', A.run("LOCAL_NOTICES.find(x=>x.id==='wm1').ack") === true);
    A.run("LOCAL_NOTICES.push({id:'wm4',kind:'notice',caseId:'W-1',owner:'" + me + "',from:'Standard case assigned',message:'live arrival',ts:Date.now(),ack:false});welcomeRefresh()");
    check('something that arrives while the page is open appears at once', String(A.els['welcome'].innerHTML).includes('live arrival'));
    A.run('hideWelcome()');
    check('"Go to dashboard" closes the page and remembers when you were last here', A.run('WEL.open') === false && +A.run("localStorage.getItem('pat_seen_'+akey(profileKey('" + me + "')))") > now - 60000);
    A.run("localStorage.setItem('pet_me',JSON.stringify({role:'agent',name:'" + me + "'}));");
    A.run("ME={role:null,name:''};bootMe()");
    check('a refresh (restored session) goes straight to the dashboard, no welcome page', A.run('WEL.open') === false && A.run('SAVED_PENDING') === true);
    A.run("SAVED_PENDING=false");
    A.run("CASES.length=0;ANN.length=0;ACKS.length=0;LOCAL_NOTICES.length=0;localStorage.removeItem('pat_seen_'+akey(profileKey('" + me + "')));ME={role:'agent',name:'" + me + "'};showWelcome()");
    const e = String(A.els['welcome'].innerHTML);
    check('with nothing missed it says so, and a first visit is explained', e.includes("all caught up") && e.includes('first visit') && !e.includes('wl-new'));
    A.run('hideWelcome(true)');
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe()");
  }
  // ---------- welcome page: cases handed over / assigned back, cases with a reminder highlighted ----------
  {
    const me = 'Haina Azuela', now = Date.now();
    A.run("CASES.length=0;ANN.length=0;ACKS.length=0;LOCAL_NOTICES.length=0;SEATS={s5:{name:'" + me + "'}}");
    const mk = (id, owner, log, rem) => A.run("(()=>{const c=mkCase('" + id + "','" + owner + "',{account:'Account A'});c.ts=" + (now - 86400000) + ";c.log=" + JSON.stringify(log) + ";c.items=[{id:'i" + id + "',text:'Check in with FE',done:false,rem:" + rem + "}];CASES.push(c)})()");
    mk('HO-IN', me, [{ ts: now - 1800000, action: 'Ownership transferred', by: 'System', details: 'Karen Sabile reached end of shift (EOS). Karen Sabile → ' + me + '.' }], "{at:Date.now()-120000,text:'Call FE',fired:true,by:'x',setAt:Date.now()-3600000}");
    mk('HO-BACK', me, [{ ts: now - 900000, action: 'Ownership transferred', by: 'System', details: me + ' is back on shift: cases handed over at EOS are shared back to even out the workload. Karen Sabile → ' + me + '.' }], "{at:Date.now()+3600000,text:'Later',fired:false,by:'x',setAt:Date.now()}");
    mk('HO-OUT', 'Karen Sabile', [{ ts: now - 7200000, action: 'Ownership transferred', by: 'System', details: me + ' reached end of shift (EOS). ' + me + ' → Karen Sabile.' }], 'null');
    mk('HO-OLD', me, [{ ts: now - 5 * 86400000, action: 'Ownership transferred', by: 'System', details: 'Karen Sabile reached end of shift (EOS). Karen Sabile → ' + me + '.' }], 'null');
    A.run("localStorage.setItem('pat_seen_'+akey(profileKey('" + me + "')),'" + (now - 4 * 3600000) + "')");
    A.run("ME={role:'agent',name:'" + me + "'};showWelcome()");
    const h = String(A.els['welcome'].innerHTML);
    check('a case handed over to you at someone\'s EOS is announced', h.includes('Handed over to you') && h.includes('HO-IN') && h.includes('from Karen Sabile at their end of shift'));
    check('a case assigned back to you is announced', h.includes('Assigned back to you') && h.includes('HO-BACK') && h.includes('shared back from Karen Sabile'));
    check('your own case that was handed over to someone else is announced', h.includes('Handed over from you') && h.includes('HO-OUT') && h.includes('moved to Karen Sabile at your end of shift'));
    check('a hand-over from before your last visit is not announced again', !h.includes('HO-OLD'));
    check('the hand-over card counts them in the summary line', h.includes('3 case hand-overs'));
    check('a case with a due reminder is highlighted in red', /wl-r clk hl due[^>]*>(?:(?!wl-r clk)[\s\S])*?HO-IN/.test(h) && h.includes('wl-rem due'));
    check('a case with an upcoming reminder is highlighted in amber with its time', /wl-r clk hl"[^>]*>(?:(?!wl-r clk)[\s\S])*?HO-BACK/.test(h) && /wl-rem">⏰ Reminder \d/.test(h));
    check('a case without a reminder is not highlighted', /wl-r clk"[^>]*>(?:(?!wl-r clk)[\s\S])*?HO-OUT/.test(h));
    A.run("getCase('HO-IN').owner='Karen Sabile';welcomeRefresh()");
    check('a case that has since moved on is no longer listed as handed to you', !String(A.els['welcome'].innerHTML).includes('Handed over to you'));
    A.run('hideWelcome(true)');
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe()");
  }
  // ---------- manual hand-over near the end of shift; alerts are not shown twice ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Haina Azuela', -480, 45), ag('Karen Sabile', -10, 540), ag('Kenjie Locsin', -200, 20)]) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    A.run("ME={role:'agent',name:'Haina Azuela'};applyMe();CASES.length=0;LOCAL_NOTICES.length=0;for(let i=0;i<3;i++)CASES.push(mkCase('XF-'+i,'Haina Azuela',{}));CASES.push(mkCase('XF-9','Kenjie Locsin',{}))");
    A.run('render()');
    check('45 minutes before EOS the agent is offered a hand-over to the next agent', /Hand over my 3 open cases/.test(String(A.els['eos-xfer'].innerHTML)) && String(A.els['eos-xfer'].innerHTML).includes('Karen Sabile'));
    A.run('xferAll()');
    check('the first click only asks to confirm', A.run("CASES.filter(c=>c.owner==='Haina Azuela').length") === 3 && String(A.els['eos-xfer'].innerHTML).includes('Click again to confirm'));
    A.run('xferAll()');
    check('the second click hands all open cases to the agent on shift', A.run("CASES.filter(c=>/^XF-[0-2]$/.test(c.id)).every(c=>c.owner==='Karen Sabile')") === true && A.run("getCase('XF-9').owner") === 'Kenjie Locsin');
    check('the hand-over is logged with the actor and stays manual', A.run("getCase('XF-0').log.some(l=>l.action==='Ownership transferred'&&l.by==='Haina Azuela')") === true && A.run("getCase('XF-0').credit.man") === true);
    check('a hand-over does not pop up a new-case assignment', A.run("LOCAL_NOTICES.filter(n=>n.owner==='Karen Sabile').length") === 0);
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();doTransfer('XF-9','Karen Sabile')");
    check('a manual transfer does not pop up a new-case assignment either', A.run("getCase('XF-9').owner") === 'Karen Sabile' && A.run("LOCAL_NOTICES.filter(n=>n.owner==='Karen Sabile').length") === 0);
    A.run("ME={role:'agent',name:'Haina Azuela'};applyMe()");
    A.run('render()');
    check('nothing left to hand over: the offer disappears', !String(A.els['eos-xfer'].innerHTML).includes('Hand over my'));
    A.run("ME={role:'agent',name:'Karen Sabile'};applyMe();CASES.push(mkCase('XF-7','Karen Sabile',{}));render()");
    check('an agent far from EOS is not offered the hand-over', !String(A.els['eos-xfer'].innerHTML).includes('Hand over my'));
    // alerts shown or acknowledged are remembered on the device
    A.run("disAdd('men|zzz')");
    check('a dismissed alert is remembered', A.run("disHas('men|zzz')") === true && A.run("disHas('men|other')") === false);
    A.run("ME={role:'agent',name:'Karen Sabile'};applyMe();NOTICE_OPEN=false;MENTIONS=[];LOCAL_NOTICES.length=0;LOCAL_NOTICES.push({id:'zzz',kind:'notice',caseId:'XF-7',owner:'Karen Sabile',from:'t',message:'m',ts:Date.now()+5000,ack:false});mentionInboxCheck()");
    check('an alert that was already acknowledged is not shown again', A.run('NOTICE_OPEN') === false);
    A.run("LOCAL_NOTICES[0].id='fresh1';mentionInboxCheck()");
    check('a new alert is still shown', A.run('NOTICE_OPEN') === true);
    A.run('ackMention()');
    check('acknowledging remembers it', A.run("disHas('men|fresh1')") === true && A.run('NOTICE_OPEN') === false);
  }
  // ---------- log out button; assignment pop-up only for newly added cases ----------
  {
    check('the header has a Log out button', fs0.includes('id="logout-btn"') && fs0.includes('onclick="signOut()"'));
    check('only adding a case sends the new-case assignment pop-up', (fs0.match(/sendAgentNotice\(/g) || []).length === 3 && !/function reassign\([^]*?sendAgentNotice/.test(fs0.slice(fs0.indexOf('function reassign('), fs0.indexOf('lag-free hand-over'))));
    A.run("ME={role:'agent',name:'Haina Azuela'};applyMe();SIGNED_IN_AT=Date.now();try{localStorage.setItem('pet_me',JSON.stringify(ME))}catch(e){}");
    A.run('signOut()');
    check('Log out signs the person out and shows the login page', A.run('ME.role') === null, A.run('JSON.stringify(ME)')); check('and the login page is shown', A.run('Date.now()-LP_T0') < 5000);
    check('Log out forgets the saved session on this device', A.run("localStorage.getItem('pet_me')") === null);
  }
  // ---------- EOS transfer toast: only for the agents involved, once, and grouped ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    const mk = () => { A.run('STAFF=' + JSON.stringify([ag('Juan Gone', -540, -30), ag('Kenjie Locsin', -10, 300), ag('Karen Sabile', -5, 400)]) + ';ensureMgrs(STAFF);STAFFLOADED=true'); A.run("CASES.length=0;for(let i=0;i<5;i++)CASES.push(mkCase('TN-'+i,'Juan Gone',{}))"); };
    A.run("window.__N=[];window.__note0=window.note;window.note=m=>{__N.push(String(m))}");
    mk(); A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();NOTED.clear();__N.length=0");
    A.run('eosCheck()');
    check('someone not involved in the EOS transfer gets no toast', A.run('__N.filter(m=>/EOS/.test(m)).length') === 0);
    check('but the cases did move', A.run("CASES.every(c=>c.owner!=='Juan Gone')") === true);
    mk(); A.run("ME={role:'agent',name:'Kenjie Locsin'};applyMe();NOTED.clear();__N.length=0");
    A.run('eosCheck()');
    const toasts = J(A.run("JSON.stringify(__N.filter(m=>/EOS/.test(m)))"));
    check('the receiving agent gets no pop-up for automatic hand-overs (removed by the checklist)', toasts.length === 0, toasts);
    A.run("CASES.forEach(c=>{if(c.owner==='Kenjie Locsin')c.owner='Juan Gone'});__N.length=0");
    A.run('eosCheck()');
    check('the same move is not announced again if it is redone', A.run('__N.filter(m=>/EOS/.test(m)).length') === 0);
    A.run("window.note=window.__note0");
  }
  // ---------- an agent who signs in mid-shift gets cases from the others ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Haina Azuela', -240, 300), ag('Karen Sabile', -240, 300), ag('Kenjie Locsin', -120, 300), ag('Edge Eddie', -240, 20)]) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    A.run("CASES.length=0;for(let i=0;i<8;i++)CASES.push(mkCase('SB-'+i,i<5?'Haina Azuela':'Karen Sabile',{}));CASES.push(mkCase('SB-9','Haina Azuela',{}));getCase('SB-9').credit={n:'Karen Sabile',at:Date.now(),man:true,manTo:'Haina Azuela',manAt:Date.now()};asHo()");
    const L = n => A.run(`loadOf('${n}')`);
    A.run("ME={role:'agent',name:'Kenjie Locsin'};applyMe()");
    const moved = A.run("balanceOnSignIn('Kenjie Locsin')");
    check('a new agent in mid-shift is given cases until the workload is even', moved >= 2 && Math.abs(L('Kenjie Locsin') - L('Haina Azuela')) <= 1 && Math.abs(L('Kenjie Locsin') - L('Karen Sabile')) <= 1, [L('Haina Azuela'), L('Karen Sabile'), L('Kenjie Locsin')]);
    check('a case handed over by hand is not taken away', A.run("getCase('SB-9').owner") === 'Haina Azuela');
    check('the move is logged as a balance, not as an EOS hand-over', A.run("CASES.filter(c=>c.owner==='Kenjie Locsin').every(c=>c.log.some(l=>/became available/.test(l.details)))") === true);
    const before = [L('Haina Azuela'), L('Karen Sabile'), L('Kenjie Locsin')].join();
    A.run("balanceOnSignIn('Kenjie Locsin')");
    check('doing it again moves nothing more (no bouncing)', [L('Haina Azuela'), L('Karen Sabile'), L('Kenjie Locsin')].join() === before);
    check('an agent near the end of shift is not given cases', A.run("balanceOnSignIn('Edge Eddie')") === 0);
    A.run("eosCheck()");
    check('the automatic EOS check never moves them back', [L('Haina Azuela'), L('Karen Sabile'), L('Kenjie Locsin')].join() === before);
  }
  // ---------- balancing takes the newest untouched cases, leaves worked ones, and never alarms the new owner ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Haina Azuela', -240, 300), ag('Kenjie Locsin', -60, 300)]) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    A.run("CASES.length=0;for(let i=0;i<8;i++){const c=mkCase('BL-'+i,'Haina Azuela',{});c.ts=Date.now()-(8-i)*3600000;CASES.push(c)}asHo()");
    // BL-7 is the newest but was already worked on (an agent update), BL-6 has a done checklist item
    A.run("logc(getCase('BL-7'),'Case details updated','Haina Azuela','Model number set');getCase('BL-6').items[0].done=true");
    A.run("ME={role:'agent',name:'Kenjie Locsin'};applyMe()");
    const mv = A.run("balanceOnSignIn('Kenjie Locsin')");
    const own = J(A.run("JSON.stringify(CASES.map(c=>c.id+':'+c.owner[0]))"));
    check('the worked-on cases stay with the previous agent', own.includes('BL-7:H') && own.includes('BL-6:H'), own);
    check('the newest untouched cases moved first (BL-5 down to BL-2)', mv === 4 && ['BL-5', 'BL-4', 'BL-3', 'BL-2'].every(i => own.includes(i + ':K')) && ['BL-0', 'BL-1'].every(i => own.includes(i + ':H')), own);
    check('balanced cases are marked so they are never balanced again', A.run("getCase('BL-5').bal&&getCase('BL-5').bal.to==='Kenjie Locsin'") === true);
    // alarms: a required reminder that comes due for the new owner does not pop up for a balanced case, but does for a normal one
    A.run("ME={role:'agent',name:'Kenjie Locsin'};applyMe();GOT.cases=1;GOT.act=1;remQueue=[];remOpen=false;SEENT.clear();for(const k in DIS)delete DIS[k]");
    A.run("CASES.forEach(c=>{c.items.forEach(it=>{if(it.rem){it.rem.at=Date.now()+60000;it.rem.setAt=Date.now()-1000}})});getCase('BL-5').owner='Kenjie Locsin';getCase('BL-8')||CASES.push(mkCase('BL-8','Kenjie Locsin',{}));getCase('BL-8').items[0].rem.at=Date.now()+60000;remCheck()");
    const q = J(A.run("JSON.stringify(remQueue.map(x=>x.cid).concat(remOpen&&window._p?[window._p.cid]:[]))"));
    check('no alarm or acknowledge window for a balanced case', !q.includes('BL-5') && !q.includes('BL-4'), q);
    check('a normal case of the same agent still alerts', q.includes('BL-8'), q);
    // a balanced case can still be handed over at EOS; the marker is cleared and the new owner is alerted normally
    A.run("(()=>{const k=pers('Kenjie Locsin');const T=m=>{m=((m%1440)+1440)%1440;return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')};const nm=minOf(simNow());k.start=T(nm-300);k.end=T(nm-40);k.sch=undefined;k.sch=mkSch(k);const h=pers('Haina Azuela');h.start=T(nm-20);h.end=T(nm+400);h.sch=undefined;h.sch=mkSch(h);STAFFLOADED=true})()");
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();eosCheck()");
    check('a balanced case is still handed over at the owner\'s EOS', A.run("getCase('BL-5').owner") === 'Haina Azuela' && A.run("getCase('BL-5').bal") === null, A.run("getCase('BL-5').owner"));
    // a held-back case copy is released when its save finishes, and a failed save never leaves a case stuck on old data
    A.run("PEND.add('Q-1');IGNC.add('Q-1');pendDone('Q-1')");
    check('when a save finishes the case is no longer held back', A.run("PEND.has('Q-1')") === false && A.run("IGNC.has('Q-1')") === false);
    // alarms only for truly new cases: EOS and manual hand-overs are silent for the new owner too, own new reminders still ring
    A.run("ME={role:'agent',name:'Haina Azuela'};applyMe();GOT.cases=1;GOT.act=1;remQueue=[];remOpen=false;SEENT.clear();for(const k in DIS)delete DIS[k];hide('rem-pop')");
    A.run("CASES.length=0;['HO-1','HO-2','HO-3'].forEach(id=>CASES.push(mkCase(id,'Kenjie Locsin',{})));CASES.forEach(c=>c.items[0].rem.at=Date.now()+60000)");
    A.run("reassign(getCase('HO-1'),'Haina Azuela','Kenjie Locsin reached end of shift (EOS)');doTransfer('HO-2','Haina Azuela')");
    A.run("getCase('HO-3').owner='Haina Azuela';getCase('HO-3').items[0].rem.at=Date.now()+60000;remCheck()");
    const q2 = J(A.run("JSON.stringify(remQueue.map(x=>x.cid).concat(remOpen&&window._p?[window._p.cid]:[]))"));
    check('no alarm or acknowledge window for an EOS hand-over or a manual transfer', !q2.includes('HO-1') && !q2.includes('HO-2'), q2);
    check('a case that was not handed over (new case) still alerts', q2.includes('HO-3'), q2);
    A.run("hide('rem-pop');remOpen=false;remQueue=[];SEENT.clear();for(const k in DIS)delete DIS[k]");
    A.run("(()=>{const c=getCase('HO-1'),it=c.items[0];it.rem={at:Date.now()+60000,text:'Call back',fired:false,by:'Haina Azuela',setAt:Date.now()+1000}})()");
    A.run("remCheck()");
    check('a reminder the new owner sets after the hand-over still rings', J(A.run("JSON.stringify(remQueue.map(x=>x.cid).concat(remOpen&&window._p?[window._p.cid]:[]))")).includes('HO-1'));
    check('a failed first save also releases the case', fs0.includes(".then(()=>pendDone(cur.id),e=>{SVN[cur.id]=Math.max(0,(SVN[cur.id]||1)-1);PEND.delete(cur.id);throw e})"));
  }
  // ---------- opening another case never shows the first case's typed values (SFDC Case ID, model, ...) ----------
  {
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();CASES.length=0;const a=mkCase('OP-1','Haina Azuela',{caseType:'foundation'});a.sfdc=['SF-AAA'];a.model='MODEL-A';const b=mkCase('OP-2','Haina Azuela',{caseType:'foundation'});b.sfdc=['SF-BBB'];b.model='MODEL-B';CASES.push(a,b)");
    A.run("openCaseModal('OP-1')");
    check('the first case shows its own SFDC Case ID', String(A.els['case-body'].innerHTML).includes('value="SF-AAA"'));
    A.run("document.getElementById('cd-sf0').value='SF-AAA-edited-not-saved'");
    A.run("openCaseModal('OP-2')");
    const h2 = String(A.els['case-body'].innerHTML);
    check('another case shows its own SFDC Case ID, not the first one', h2.includes('value="SF-BBB"') && !h2.includes('SF-AAA'));
    check('and its own model number', h2.includes('value="MODEL-B"') && !h2.includes('MODEL-A'));
    A.run("closeCase();getCase('OP-2').sfdc=['SF-BBB-changed-elsewhere'];openCaseModal('OP-2')");
    check('reopening a case shows its current saved value', String(A.els['case-body'].innerHTML).includes('value="SF-BBB-changed-elsewhere"'));
    A.run("closeCase()");
  }
  // ---------- for cabling: no part dates needed ----------
  {
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();CASES.length=0;const c=mkCase('CB-1','Haina Azuela',{caseType:'foundation'});c.sfdc=['SF-1'];c.sev='Sev 2';c.account='Account A';c.cstatus='FE Name';c.model='AP-1';c.mw={s:Date.now(),e:Date.now()+3600000};c.ceArr=Date.now();c.recv=Date.now()-1000;CASES.push(c)");
    const miss = () => J(A.run("JSON.stringify(missingFields(getCase('CB-1')))"));
    check('without the cabling tick, part ordered and delivered are required', miss().includes('Part Ordered Time') && miss().includes('Part Delivered Time'), miss());
    A.run("openCaseModal('CB-1')");
    check('the case has a For cabling tick box beside Lift', String(A.els['case-body'].innerHTML).includes('id="cd-cable"') && String(A.els['case-body'].innerHTML).includes('Lift required'));
    check('part dates are open while it is not for cabling', !/data-dtp="cd-pOrd"[^>]*disabled|disabled[^>]*data-dtp="cd-pOrd"/.test(String(A.els['case-body'].innerHTML)));
    A.run("cdCable('CB-1',true)");
    check('ticking For cabling saves on the case', A.run("getCase('CB-1').cable") === true && A.run("getCase('CB-1').log.some(l=>l.action==='Cabling requirement updated')") === true);
    const h = String(A.els['case-body'].innerHTML);
    check('part ordered and delivered are greyed out and say they are not needed', /disabled[^>]*data-dtp="cd-pOrd"|data-dtp="cd-pOrd"[^>]*disabled/.test(h) && /disabled[^>]*data-dtp="cd-pDel"|data-dtp="cd-pDel"[^>]*disabled/.test(h) && h.includes('not needed for Cabling/HOD') && h.includes('> Cabling/HOD <'));
    check('CE arrival stays editable', !/disabled[^>]*data-dtp="cd-ceArr"|data-dtp="cd-ceArr"[^>]*disabled/.test(h));
    check('the store number is required to close a case', miss().includes('Store Number'));
    A.run("cdSet('CB-1','store','4521')");
    check('a cabling case can be closed without part ordered and delivered dates', !miss().includes('Part Ordered Time') && !miss().includes('Part Delivered Time') && miss().length === 0, miss());
    A.run("cdCable('CB-1',false)");
    check('unticking brings the part dates back as required', miss().includes('Part Ordered Time') && miss().includes('Part Delivered Time'));
    A.run("closeCase()");
  }
  // ---------- balancing: 50 + 50 + 6 ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Haina Azuela', -300, 300), ag('Kenjie Locsin', -300, 300), ag('Karen Sabile', -200, 300)]) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    A.run("CASES.length=0;let n=0;for(const o of ['Haina Azuela','Kenjie Locsin']){for(let i=0;i<50;i++){const c=mkCase('BB-'+(n++),o,{});c.ts=Date.now()-(100-n)*60000;c.ceArr=Date.now();c.model='AP-'+n;CASES.push(c)}}asHo();for(let i=0;i<6;i++){const c=mkCase('BK-'+i,'Karen Sabile',{});CASES.push(c)}");
    A.run("batchR(()=>balanceOnSignIn('Karen Sabile'))");
    const ld = n => A.run(`loadOf('${n}')`);
    const ho = n => A.run(`hoLoad('${n}')`);
    check('every hand-over case of the busy agents was worked on, yet the signed-in agent is filled up evenly', Math.abs(ho('Haina Azuela') - ho('Kenjie Locsin')) <= 1 && Math.abs(ho('Karen Sabile') - ho('Haina Azuela')) <= 1 && ld('Haina Azuela') + ld('Kenjie Locsin') + ld('Karen Sabile') === 106, [ho('Haina Azuela'), ho('Kenjie Locsin'), ho('Karen Sabile')].join('/'));
    check('her 6 new cases are on top of the hand-over share (not counted, not moved)', ho('Karen Sabile') >= 33 && ho('Karen Sabile') <= 34 && ld('Karen Sabile') === ho('Karen Sabile') + 6);
    // someone who later finishes cases is not topped up again: balancing only happens at sign-in
    A.run("CASES.filter(c=>c.owner==='Haina Azuela').slice(0,20).forEach(c=>c.closed=true)");
    const before = ld('Haina Azuela') + '/' + ld('Kenjie Locsin') + '/' + ld('Karen Sabile');
    A.run('eosCheck()');
    check('no repeated balancing after cases are completed', !fs0.includes('balanceTick') && before === ld('Haina Azuela') + '/' + ld('Kenjie Locsin') + '/' + ld('Karen Sabile'));
    // a new case then goes to whoever has the fewest, not by hand-picking
    A.run("CASES.length=0;for(let i=0;i<3;i++)CASES.push(mkCase('RL-'+i,'Haina Azuela',{}))");
  }
  // ---------- queue, off-shift agents never receive, Canceled ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    const st = l => A.run('STAFF=' + JSON.stringify(l) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    st([ag('Ending Eva', -480, 40), ag('Off Otto', 200, 700), ag('Near Ned', -300, 20)]);
    A.run("CASES.length=0;for(let i=0;i<4;i++)CASES.push(mkCase('QQ-'+i,'Ending Eva',{}));ME={role:'agent',name:'Ending Eva'};applyMe();XFER_ARM=0;render()");
    check('with nobody else online the banner says the cases stay with the agent until someone is online', String(A.els['eos-xfer'].innerHTML).includes('your cases stay with you'));
    A.run('xferAll();xferAll()');
    check('a hand-over by hand with nobody online keeps the cases with the owner, marked to go out', A.run("CASES.every(c=>c.owner==='Ending Eva'&&c.hop==='Ending Eva')") === true && A.run("loadOf('Off Otto')") === 0);
    A.run('eosCheck();eosCheck()');
    check('they are not given to off-shift or near-EOS agents (Nov 24: they wait in the hand-over queue)', A.run("CASES.every(c=>c.owner===HOQ)") === true);
    A.run('render()');
    st([ag('Ending Eva', -480, 40), ag('Off Otto', 200, 700), ag('Fresh Fay', -5, 500), ag('Fresh Finn', -5, 500)]);
    A.run('eosCheck()');
    const qo = J(A.run("JSON.stringify(CASES.map(c=>c.owner))"));
    check('the queue goes to the next available agents on shift, evenly', qo.filter(o => o === 'Fresh Fay').length === 2 && qo.filter(o => o === 'Fresh Finn').length === 2, qo);
    check('productivity credit stays with the agent who first had the case', A.run("credOf(CASES[0]).n") === 'Ending Eva');
    A.run("CASES.push(mkCase('QV-1','Queue',{}));openId='QV-1';renderCase();render()");
    check('a queued case opens and shows Queue as the owner', String(A.els['case-body'].innerHTML).includes('Queue'));
    A.run("CASES.pop();openId=null");
    // EOS hand-over and balancing never pick an off-shift agent
    st([ag('Gone Gary', -540, -10), ag('Off Otto', 200, 700), ag('On Olga', -100, 400)]);
    A.run("CASES.length=0;for(let i=0;i<5;i++)CASES.push(mkCase('OF-'+i,'Gone Gary',{}))");
    A.run('eosCheck()');
    check('EOS hand-over goes only to the agent on shift', A.run("CASES.every(c=>c.owner==='On Olga')") === true);
    check('an off-shift agent who signs in is not balanced any cases', A.run("batchR(()=>balanceOnSignIn('Off Otto'))") === 0 && A.run("loadOf('Off Otto')") === 0);
    // a case can go back to an agent who held it before
    st([ag('Bal Ben', -100, 400), ag('Bal Bea', -100, 400)]);
    A.run("CASES.length=0;for(let i=0;i<6;i++){const c=mkCase('BN-'+i,'Bal Ben',{});c.bal={from:'Bal Bea',to:'Bal Ben',at:Date.now()};CASES.push(c)}asHo()");
    A.run("batchR(()=>balanceOnSignIn('Bal Bea'))");
    check('hand-over is not limited by who held the case before', A.run("loadOf('Bal Bea')") === 3);
    // new case with nobody on shift
    st([ag('Off Otto', 200, 700)]);
    check('a new case with nobody on shift goes to the queue', A.run("coverFor(simNow(),null,undefined,true)||(hasAgents()?QUEUE:'')") === 'Queue');
    // Canceled
    st([ag('On Olga', -100, 400)]);
    A.run("CASES.length=0;CASES.push(mkCase('CN-1','On Olga',{}));ME={role:'agent',name:'On Olga'};applyMe();openId='CN-1';renderCase()");
    check('before Canceled the three times are required', ['Part Ordered Time', 'Part Delivered Time', 'CE Arrival Time'].every(x => A.run("missingFields(getCase('CN-1'))").includes(x)));
    A.run("cdSet('CN-1','cstatus','Canceled')");
    const mf = A.run("missingFields(getCase('CN-1'))"), hc = String(A.els['case-body'].innerHTML);
    check('Canceled: part ordered, part delivered and CE arrival are not required', !['Part Ordered Time', 'Part Delivered Time', 'CE Arrival Time'].some(x => mf.includes(x)));
    check('Canceled: the three time fields are greyed out', ['pOrd', 'pDel', 'ceArr'].every(k => new RegExp('disabled[^>]*data-dtp="cd-' + k + '"|data-dtp="cd-' + k + '"[^>]*disabled').test(hc)) && hc.includes('not needed (canceled)'));
    A.run("cdSet('CN-1','cstatus','Scheduled')");
    check('changing the status back makes them required again', A.run("missingFields(getCase('CN-1'))").includes('CE Arrival Time') && !String(A.els['case-body'].innerHTML).includes('not needed (canceled)'));
  }
  // ---------- new case entries: bold, blinking New, on top ----------
  {
    A.run("ME={role:'agent',name:'On Olga'};applyMe();TAB='open';FO='all';FS='all';FR='all';DUEF=false;CASES.length=0;(()=>{const a=mkCase('NW-OLD','On Olga',{});a.items[0].rem.at=Date.now()+60000;const b=mkCase('NW-LATE','On Olga',{});b.items[0].rem.at=Date.now()+9e6;const n1=mkCase('NW-NEW1','On Olga',{nw:1});n1.ts-=5000;n1.items[0].rem.at=Date.now()+9e7;const n2=mkCase('NW-NEW2','Queue',{nw:1});CASES.push(b,a,n1,n2)})();render()");
    const rows = () => String(A.els['rows'].innerHTML), pos = id => rows().indexOf(id);
    check('new cases are at the top (newest first), then the closest reminder', pos('NW-NEW2') < pos('NW-NEW1') && pos('NW-NEW1') < pos('NW-OLD') && pos('NW-OLD') < pos('NW-LATE'), [pos('NW-NEW2'), pos('NW-NEW1'), pos('NW-OLD'), pos('NW-LATE')].join());
    check('a new case row is bold with a blinking red New', (rows().match(/nw-row/g) || []).length === 2 && (rows().match(/class="newtag">New</g) || []).length === 2 && htmlSrc.includes('.newtag{color:#e3003f') && htmlSrc.includes('animation:newblink'));
    A.run("openCaseModal('NW-NEW1')");
    check('once the owner clicks it the row is regular and no longer New', A.run("getCase('NW-NEW1').nw") === false && (rows().match(/nw-row/g) || []).length === 1);
    A.run("openCaseModal('NW-NEW2')");
    check('someone else opening a case does not clear New for its owner', A.run("getCase('NW-NEW2').nw") === true);
    check('the New flag is saved with the case', A.run("CX.includes('nw')") === true && A.run("cx({}).nw") === false);
    A.run("hide('case-modal');openId=null");
  }
  // ---------- login page DIY, seasonal design, 8-hour sign-out ----------
  {
    A.run("ME={role:'manager',name:'Jose Teves'};applyMe();LAND=null;LAND_SIG='';applyLanding()");
    check('the built-in picture is used when no DIY picture is saved', A.run('SEAT_IDS.length') === 22 && A.run("seatName('j1')") === 'June John Cruz');
    A.run("SEATS={s3:{name:'Haina Azuela'}};landSnap({web:{url:'data:image/png;base64,AAAA',w:1000,h:500},mob:null,faces:[{id:'s3',g:[100,100,40,50],m:null,name:''},{id:'f1',g:[300,200,40,50],m:null,name:'Jose Teves'},{id:'f2',g:[500,200,40,50],m:null,name:''}],ts:1})");
    check('a saved DIY picture replaces the faces on the login page', A.run('SEAT_IDS.join()') === 's3,f1,f2' && A.run('LPD.w') === 1000);
    check('a face kept from the old picture keeps its claim', A.run("seatName('s3')") === 'Haina Azuela' && A.run("seatOf('Haina Azuela')") === 's3');
    check('a face fixed to a profile in the editor belongs to that person', A.run("seatName('f1')") === 'Jose Teves' && A.run("!!MGR_SEATS.f1") === true);
    check('without a mobile picture phones use the web picture and its boxes', A.run("SEAT_GEO.f2.length") === 8 && A.run("SEAT_GEO.f2.slice(4).join()") === '500,200,40,50');
    check('the managers stay managers whatever the picture', A.run("isMgrName('June John Cruz')") === true);
    A.run("landSnap(null)");
    check('removing the DIY picture brings back the built-in team picture', A.run('SEAT_IDS.length') === 22);
    A.run("LD=null;setTabTo('theme')");
    check('Theme settings has a Login page (DIY) section for managers', String(A.els['set-body'].innerHTML).includes('Login page (DIY)'));
    A.run("ldStart()");
    check('editing starts from the current picture with the same faces', A.run('LD.faces.length') === 22 && A.run("LD.faces.find(f=>f.id==='j1').name") === 'June John Cruz');
    A.run("ldCancel()");
    // seasons
    check('a season window wraps over the new year', A.run("inWin('01-03','12-31','01-07')") === true && A.run("inWin('02-01','12-31','01-07')") === false);
    A.run("SSN={kind:'christmas',from:'11-01',to:'12-31',snow:true,sleigh:true,tree:true,santa:true}");
    const at = d => A.run(`!!seasonNow(new Date('${d}T12:00:00').getTime())`);
    check('Christmas shows inside its dates', at('2026-11-12') === true && at('2026-12-25') === true);
    check('and is gone on its own once the season is over (after New Year, which follows Christmas)', at('2027-01-08') === false && at('2026-10-15') === false && A.run("seasonNow(new Date('2027-01-02T12:00:00').getTime()).kind") === 'newyear');
    A.run("SSN={kind:'none'}");
    check('the season can be switched off', at('2026-12-25') === false);
    A.run("SSN={kind:'christmas',from:'01-01',to:'12-31',snow:true,sleigh:true,tree:true,santa:true};STAFF=STAFF.filter(p=>!/Gift/.test(p.name));STAFF.push({name:'Gift Gina',role:'Support',start:'08:00',end:'17:00',days:[1,1,1,1,1,1,1],status:'available'})");
    const xc = A.run('xmasCard()');
    check('the Christmas corner shows a tree with the agents on the gifts and a countdown', xc.includes('xm-tree') && xc.includes('>Gift<') && xc.includes('id="xm-cd"') && !xc.includes('>Joerolyn<'));
    check('Santa joins the announcements', A.run('santaOn()') === true && A.run('SANTA_SVG').includes('s-arm'));
    A.run("localStorage.setItem('pat_fx_off','1');FXOFF=null");
    check('anyone can hide the effects on their own screen', A.run('xmasCard()') === '' && A.run('santaOn()') === false);
    A.run("localStorage.removeItem('pat_fx_off');FXOFF=null;SSN={kind:'christmas',from:'02-01',to:'02-02'}");
    check('outside the season nothing seasonal is drawn', A.run('xmasCard()') === '' && A.run('santaOn()') === false);
    check('the sleigh runs every 10 minutes over the cases table', htmlSrc.includes('SLEIGH_EVERY=10*60000') && htmlSrc.includes("$('cases-scroll')"));
    A.run("SSN=null");
    // 8 hours idle
    A.run("localStorage.setItem('pet_me',JSON.stringify({role:'agent',name:'Haina Azuela'}));localStorage.setItem('pat_last_act',String(Date.now()-9*3600000));ME={role:null,name:''}");
    check('after more than 8 hours without activity the saved sign-in is not restored', A.run('bootMe()') === false && A.run("localStorage.getItem('pet_me')") === null);
    A.run("localStorage.setItem('pat_last_act',String(Date.now()-2*3600000));localStorage.setItem('pet_me',JSON.stringify({role:'agent',name:'Haina Azuela'}));ME={role:null,name:''}");
    check('a recent session is restored as before', A.run('bootMe()') === true);
    A.run("SAVED_PENDING=false;ME={role:'agent',name:'Haina Azuela'};localStorage.setItem('pat_last_act',String(Date.now()-8.5*3600000))");
    check('an open app left idle for 8 hours signs out', A.run('idleCheck()') === true && A.run('ME.role') === null);
    A.run("ME={role:'agent',name:'Haina Azuela'};localStorage.setItem('pat_last_act',String(Date.now()-60000))");
    check('an active user stays signed in', A.run('idleCheck()') === false && A.run('ME.role') === 'agent');
  }
  // ---------- managers only: login page and seasonal design; no switch-profile button ----------
  {
    check('the switch profile button is gone (Log out does the same)', !htmlSrc.includes('id="me-switch"') && !htmlSrc.includes('title="Switch profile"'));
    A.run("ME={role:'agent',name:'Haina Azuela',coord:true};applyMe();LD=null;SSN_DRAFT=null;setTabTo('theme')");
    const hc = String(A.els['set-body'].innerHTML);
    check('a coordinator does not get the Login page (DIY) section', !hc.includes('Login page (DIY)'));
    check('a coordinator sees the seasonal design read-only', hc.includes('Seasonal theme') && !hc.includes('ssnSave()') && hc.includes('Only a manager can change the seasonal design'));
    A.run("ldStart()");
    check('a coordinator cannot start editing the login page', A.run('LD') === null);
    A.run("ME={role:'agent',name:'Haina Azuela',coord:true};applyMe();setTabTo('theme')");
    check('an agent (even a coordinator) cannot change them either', !String(A.els['set-body'].innerHTML).includes('Login page (DIY)') && !String(A.els['set-body'].innerHTML).includes('ssnSave()'));
    A.run("ME={role:'manager',name:'June John Cruz'};applyMe();setTabTo('theme')");
    const hm = String(A.els['set-body'].innerHTML);
    check('a manager (including June John Cruz) can change the login page and seasonal design', hm.includes('Login page (DIY)') && hm.includes('ssnSave()'));
  }
  // ---------- seasonal login picture, fairy lights, naughty-list Santa ----------
  {
    A.run("ME={role:'manager',name:'Jose Teves'};applyMe();localStorage.removeItem('pat_fx_off');FXOFF=null;SSN={kind:'christmas',from:'01-01',to:'12-31'}");
    A.run("landSnap(null,{kind:'christmas',web:{url:'data:image/png;base64,BBBB',w:800,h:400},mob:null,faces:[{id:'s1',g:[100,100,40,50],m:null,name:''},{id:'m1',g:[300,100,40,50],m:null,name:'Joerolyn Franquelli'}],ts:2})");
    check('during the season the seasonal login picture is shown', A.run('SEAT_IDS.join()') === 's1,m1' && A.run('LPD.w') === 800);
    A.run("SSN={kind:'christmas',from:'02-01',to:'02-02'};applyLanding()");
    check('when the season is over the everyday login picture comes back by itself', A.run('SEAT_IDS.length') === 22 && A.run('LPD.w') === 1672);
    A.run("SSN={kind:'christmas',from:'01-01',to:'12-31'};applyLanding();localStorage.setItem('pat_fx_off','1');FXOFF=null;applyLanding()");
    check('hiding seasonal effects also shows the everyday login picture', A.run('SEAT_IDS.length') === 22);
    A.run("localStorage.removeItem('pat_fx_off');FXOFF=null;SSN_DRAFT=null;LD=null;setTabTo('theme')");
    const st = String(A.els['set-body'].innerHTML);
    check('the seasonal design has a seasonal login picture, fairy lights and naughty-list Santa', st.includes('Seasonal login picture') && st.includes('fairy lights') && st.includes('Naughty-list Santa'));
    A.run("ldStart('season')");
    check('the seasonal picture is edited with the same editor, starting from its faces', A.run('LDT') === 'season' && A.run('LD.faces.length') === 2);
    A.run("ldCancel();landSnap(null,null);applyLanding()");
    const fh = A.run('fairyHtml(20,2)');
    check('fairy lights are blinking bulbs on a wire', (fh.match(/<i /g) || []).length === 20 && fh.includes('ssn-fairy') && htmlSrc.includes('@keyframes fairyTw'));
    A.run("SSN={kind:'christmas',from:'01-01',to:'12-31',tree:true}");
    check('the welcome Christmas card has fairy lights too', A.run('xmasCard()').includes('ssn-fairy'));
    A.run("SSN={kind:'christmas',from:'01-01',to:'12-31',tree:true,lights:false}");
    check('fairy lights can be switched off', !A.run('xmasCard()').includes('ssn-fairy'));
    check('naughty-list Santa pushes the blinking Due tile, waves and says you are being naughty', htmlSrc.includes("document.querySelector('#stats .due-tile')") && A.run('NAUGHTY_MSG[0]').includes('naughty') && htmlSrc.includes('@keyframes tileBump') && htmlSrc.includes("tt.classList.add('ssn-bump')") && A.run('SANTA_SVG').includes('s-arm'));
    A.run("SSN=null");
  }
  check('Santa and the reindeer are drawn with shading (3D look) and the lead reindeer has a glowing nose', A.run('SANTA_SVG').includes('url(#ssg-red)') && A.run('SLEIGH_SVG').includes('sl-deer') && A.run('SLEIGH_SVG').includes('rn-glow') && A.run('SSN_DEFS').includes('radialGradient'));
  check('naughty-list Santa pops up above the Due tile, then the bubble appears', htmlSrc.includes('@keyframes nsUp') && htmlSrc.includes('y=r.top-hr.top-H+8'));
  check('the bubble mentions the naughty list and that they are being naughty', A.run('NAUGHTY_MSG').every(m => /naughty list/i.test(m) && /being naughty/i.test(m)));
  check('the spinning Santa is gone; the tree, gifts and countdown sit below Agent Status instead of the welcome page', !htmlSrc.includes('dzSpin') && htmlSrc.includes("function xmasPanel(on)") && htmlSrc.includes("document.querySelector('main aside')") && !/\$\{xmasCard\(\)\}<div class="wl-sum">/.test(htmlSrc));
  {
    A.run("ME={role:'agent',name:'Haina Azuela'};applyMe();FXOFF=null;SSN={kind:'christmas',from:'01-01',to:'12-31'};NAUGHTY_ST='naughty';NL=new Set();NAUGHTY_SEEN=0;WEL.open=false");
    A.run("window.__said=[];window.__nice=[];naughtySay=(t,n)=>__said.push([t,!!n]);naughtyPlace=()=>{};runNaughty=()=>{NAUGHTY_ST='naughty';__said.push(['RUN '+[...NL.keys()].join('|'),false])};naughtyNice=w=>{__nice.push(w);NAUGHTY_ST='nice'}");
    A.run("localStorage.removeItem('pat_nl_cleared');NAUGHTY_ST='';window.__dueOwn=new Map([['Kenjie Locsin',3]]);NAUGHTY_SEEN=Date.now()-2000;naughtyTick()");
    check('Santa pops up when cases reach due, naming the owner once', A.run("__said[0][0]") === 'RUN Kenjie Locsin' && A.run("NL.get('Kenjie Locsin')") === 3);
    A.run("window.__dueOwn=new Map([['Kenjie Locsin',3],['Karen Sabile',1]]);naughtyTick()");
    check('a new owner reaching due is listed with the count beside the name', /Karen Sabile 1x, you have been listed on my Naughty List/.test(A.run("__said[__said.length-1][0]")) && !/Kenjie/.test(A.run("__said[__said.length-1][0]")));
    A.run("window.__dueOwn=new Map([['Kenjie Locsin',4],['Karen Sabile',1]]);naughtyTick()");
    check('another due case for the same owner only adds to the count (name listed once)', /Kenjie Locsin 4x — another due case added to your count/.test(A.run("__said[__said.length-1][0]")) && A.run("nlList()").split('Kenjie').length === 2 && /Kenjie Locsin 4x/.test(A.run("nlList()")));
    A.run("window.__dueOwn=new Map([['Karen Sabile',1]]);naughtyTick()");
    check('when an owner clears their due reminders he says they are off the Naughty List, and stays for the rest', /Kenjie Locsin is off the Naughty List/.test(A.run("__said[__said.length-1][0]")) && A.run("__said[__said.length-1][1]") === true && A.run('NAUGHTY_ST') === 'naughty');
    A.run("TRIG=TILE_ACK");
    check('clicking the tile (blinking stops) does not send him away while due remains', (A.run("naughtyTick();NAUGHTY_ST")) === 'naughty');
    A.run("window.__dueOwn=new Map([['Karen Sabile',1],['Kenjie Locsin',1]]);naughtyTick()");
    check('the same owner coming back later: someone enjoys the Naughty List', /someone who enjoys the Naughty List — Kenjie Locsin 1x is back on it/.test(A.run("__said[__said.length-1][0]")));
    A.run("window.__dueOwn=new Map();naughtyTick()");
    check('when every due reminder is cleared he puts everyone on the Nice List and leaves', A.run('NAUGHTY_ST') === 'nice' && A.run("JSON.stringify(__nice[0].slice().sort())") === JSON.stringify(['Karen Sabile', 'Kenjie Locsin']));
    check('the bubble finds a spot that covers nothing important (beside, level with his feet or above Santa)', htmlSrc.includes('function nbFit(') && htmlSrc.includes('function nbObstacles('));
    check('several owners are named together', A.run("nlNames(['B b','A a','C c'],new Map([['A a',10]]))") === 'A a 10x, B b and C c' && A.run("nlNames(['1','2','3','4','5','6'])") === '1, 2, 3 and 3 more');
    check('the Nice List lines talk about being back on the Nice List', A.run('NICE_MSG').every(m => /nice list/i.test(m)));
    A.run("NAUGHTY_ST='';SSN=null;NL=new Map()");
  }
  check('announcements open like a gift with Santa springing out like a jack-in-the-box', htmlSrc.includes('function annGift()') && htmlSrc.includes('@keyframes jbJack') && htmlSrc.includes('@keyframes jbLid') && htmlSrc.includes('try{annGift()}catch(e){}'));
  check('the effects stay light: lights blink with opacity only, the sleigh moves with transform, settings are not re-read from storage every second', /@keyframes fairyTw\{0%,100%\{opacity:1\}50%\{opacity:\.22\}\}/.test(htmlSrc) && /@keyframes ssnBulb\{0%,100%\{opacity:1\}50%\{opacity:\.3\}\}/.test(htmlSrc) && !/@keyframes slRun\{[^}]*left:/.test(htmlSrc) && htmlSrc.includes('let FXOFF=null'));
  check('the case window has Christmas elves: one sitting on the header, one writing at Case Details, one dragging gift sacks', htmlSrc.includes('function caseDeco()') && htmlSrc.includes("elfSvg('sit')") && htmlSrc.includes("elfSvg('write')") && htmlSrc.includes("elfSvg('pull')") && htmlSrc.includes('try{caseDeco()}catch(e){}'));
  check('alert pop-ups get lights and elves placed only in empty space around the card', htmlSrc.includes('function alertDeco()') && htmlSrc.includes(".ad-deco.side .ad-write{display:block}") && htmlSrc.includes(".ad-deco.below .ad-drag{display:block}") && htmlSrc.includes('.ad-deco{position:fixed;pointer-events:none'));
  check('decorations never cover text: lights get their own space in headers and the header text makes room for the elf', htmlSrc.includes('body.ssn-lights .modal-hdr{padding-bottom:24px!important}') && htmlSrc.includes('body.ssn-lights #case-body .cch{padding-top:24px}') && htmlSrc.includes('#case-modal .modal-hdr>div.flex{padding-right:70px}'));
  check('more lights: along the tiles row and on the welcome cards', htmlSrc.includes("r.className='ssn-row'") && htmlSrc.includes("${lightsOn()?fairyHtml(22,2):''}"));
  check('the countdown greets from the Partner Engagement Team and Vendor Management Team', htmlSrc.includes('Merry Christmas from the Partner Engagement Team and Vendor Management Team!'));
  check('the login picture is extended to fill any screen without cropping (all four sides)', ['lx-t','lx-b','lx-l','lx-r'].every(k => htmlSrc.includes('class="lx ' + k + '"')) && htmlSrc.includes('function lpExtend()') && htmlSrc.includes('function lpGaps()'));
  check('at Christmas the login page edges get vines and poinsettias', htmlSrc.includes('function lpXmas(on)') && A.run('BOUQ').includes('url(#pr)') && A.run('VINE_H').includes('<path d="M0 30 C40 8'));
  {
    A.run("ME={role:'manager',name:'Jose Teves'};applyMe();setTabTo('shift')");
    const sh = String(A.els['set-body'].innerHTML);
    check('the Vendor Management Team is not in the shift schedule table', !sh.includes('value="June John Cruz"') && !sh.includes('value="Jeff Bote"') && !sh.includes('value="Arianne Escabillas"') && sh.includes('value="Jose Teves"'));
    check('everyone else stays in the schedule and profiles', A.run("STAFF.some(p=>p.name==='Jose Teves')&&STAFF.some(p=>p.name==='Joerolyn Franquelli')") === true);
    A.run("ME={role:'agent',name:'Haina Azuela'};applyMe();CASES.length=0;CASES.push(mkCase('NW-X1','Haina Azuela',{nw:1}),mkCase('NW-X2','Kenjie Locsin',{nw:1}));localStorage.removeItem(nwKey());NWSEEN=null");
    check('a new case shows as New for its owner before the click', A.run("isNew(getCase('NW-X1'))") === true);
    A.run("openCaseModal('NW-X1');hide('case-modal');openId=null");
    A.run("getCase('NW-X1').nw=true");
    check('once the owner clicks it, New is gone and stays gone even if an older copy comes back from the database', A.run("isNew(getCase('NW-X1'))") === false);
    A.run("queueSave(getCase('NW-X1'))");
    check('and the regular format is saved again for everyone', A.run("getCase('NW-X1').nw") === false);
    A.run("openCaseModal('NW-X2');hide('case-modal');openId=null");
    check('someone who is not the owner does not clear New', A.run("isNew(getCase('NW-X2'))") === true);
    check('on wide screens the cases table is as tall as Agent Status and the Christmas corner', htmlSrc.includes('#ops-grid>section{contain:size;display:flex;flex-direction:column;min-height:560px}') && htmlSrc.includes('id="ops-grid"'));
  }
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Arianne May Escabillas', -100, 300), ag('On Olga', -100, 300)]) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    check('Arianne May Escabillas and Arianne Escabillas are one profile (Vendor Management Team - Developer)', A.run("STAFF.filter(p=>/Arianne/.test(p.name)).map(p=>p.name+'|'+p.role).join()") === 'Arianne Escabillas|Vendor Management Team - Developer');
    A.run('STAFF=' + JSON.stringify([ag('Arianne May Escabillas', -100, 300), { name: 'Arianne Escabillas', role: 'Vendor Management Team - Developer' }, ag('On Olga', -100, 300)]) + ';ensureMgrs(STAFF)');
    check('when both names were saved, only the merged profile is kept', A.run("STAFF.filter(p=>/Arianne/.test(p.name)).length") === 1);
    A.run("ME={role:'agent',name:'Arianne May Escabillas'};CASES.length=0;CASES.push(mkCase('AR-1','Arianne May Escabillas',{}),mkCase('AR-2','Arianne May Escabillas',{}));PROFILE_HASHES[profileKey('Arianne May Escabillas')]='h1';aliasFix()");
    check('signed in under the old name: now signed in as Arianne Escabillas with manager access', A.run('ME.name') === 'Arianne Escabillas' && A.run("ME.role") === 'manager');
    check('her password moves to the merged profile', A.run("PROFILE_HASHES[profileKey('Arianne Escabillas')]") === 'h1' && !A.run("PROFILE_HASHES[profileKey('Arianne May Escabillas')]"));
    check('her open cases go to the agents on shift (the Vendor Management Team is not on the schedule)', A.run("CASES.every(c=>c.owner==='On Olga')") === true);
    check('the default team list uses the merged name', !htmlSrc.includes("{name:'Arianne May Escabillas'"));
  }
  // ---------- rules checklist applied ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
    const st = l => A.run('STAFF=' + JSON.stringify(l) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    const L = n => A.run(`loadOf('${n}')`);
    // EOS: divided equally, whatever the current load
    st([ag('Gone Gail', -540, -5), ag('Busy Ben', -100, 300), ag('Free Fran', -100, 300), ag('Away Al', -100, 300, 'unavailable')]);
    A.run("CASES.length=0;for(let i=0;i<10;i++)CASES.push(mkCase('EQ-B'+i,'Busy Ben',{}));for(let i=0;i<6;i++)CASES.push(mkCase('EQ-G'+i,'Gone Gail',{}))");
    A.run('eosCheck()');
    check('at EOS the cases are divided equally between the agents online (3 and 3), not by who has fewest', L('Gone Gail') === 0 && L('Busy Ben') === 13 && L('Free Fran') === 3 && L('Away Al') === 0);
    // credit: every handler counts
    A.run("window.__cr=credsOf(getCase('EQ-G0')).map(x=>x.n).join()");
    check('productivity: the new-case owner always counts; the hand-over receiver only after updating the case', A.run('__cr').split(',').includes('Gone Gail') && A.run('__cr').split(',').length === 2 && A.run("dayN('Gone Gail',simNow())") === 6 && A.run("prodCredsOf(getCase('EQ-G0')).length") === 1);
    A.run("{const c=getCase('EQ-G0');window.__o=c.owner;ME={role:'agent',name:c.owner};applyMe();cdSet('EQ-G0','model','HPE DL380')}");
    check('adding information is written to the case history', A.run("getCase('EQ-G0').log.some(l=>l.action==='Model number updated'&&l.by===__o&&/DL380/.test(l.details))") === true);
    check('after updating it, the hand-over case counts in the receiver\'s productivity', A.run("prodCredsOf(getCase('EQ-G0')).some(x=>x.n===__o)") === true);
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe()");
    // nobody online at EOS: stays, then moves to the first available
    st([ag('Gone Gail', -540, -5), ag('Away Al', -100, 300, 'unavailable')]);
    A.run("CASES.length=0;for(let i=0;i<4;i++)CASES.push(mkCase('EQ-W'+i,'Gone Gail',{}))");
    A.run('eosCheck()');
    check('nobody available at EOS: the cases stay with the leaving agent', L('Gone Gail') === 4);
    A.run("STAFF.find(p=>p.name==='Away Al').status='available';eosCheck()");
    check('they move as soon as someone becomes available', L('Away Al') === 4);
    // new case with nobody online waits, then goes out
    st([ag('Later Liz', 100, 500)]);
    check('a new case with nobody online waits instead of going to someone off shift', A.run("coverFor(simNow(),null,undefined,true)||(hasAgents()?QUEUE:'')") === 'Queue');
    // sign-in balancing: equal share, own cases first, due reminders can move
    st([ag('Haina Azuela', -300, 300), ag('Kenjie Locsin', -300, 300), ag('Karen Sabile', -200, 300)]);
    A.run("CASES.length=0;for(let i=0;i<12;i++){const c=mkCase('BS-'+i,i<6?'Haina Azuela':'Kenjie Locsin',{});c.ts=Date.now()-i*60000;c.items[0].rem.at=Date.now()-60000;CASES.push(c)}getCase('BS-11').eos={from:'Karen Sabile',at:Date.now()};getCase('BS-11').ts=0;asHo()");
    A.run("batchR(()=>balanceOnSignIn('Karen Sabile'))");
    check('sign-in balancing fills the new agent up evenly (4/4/4 hand-over cases)', L('Haina Azuela') === 4 && L('Kenjie Locsin') === 4 && L('Karen Sabile') === 4);
    check('cases that were hers before go back to her first', A.run("getCase('BS-11').owner") === 'Karen Sabile');
    check('cases with a reminder due can be balanced too', A.run("CASES.filter(c=>c.owner==='Karen Sabile').every(c=>dueList(c).length>0)") === true);
    check('the rules are written down in the code', htmlSrc.includes('Hand-over and balancing rules (from the rules checklist)'));
  }
  // ---------- round robin for new cases + handover/new counts ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Rr Ana', -100, 300), ag('Rr Ben', -100, 300), ag('Rr Cy', -100, 300), ag('Rr Off', 200, 600), ag('Rr Away', -100, 300, 'unavailable')]) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    A.run("CASES.length=0;for(let i=0;i<5;i++)CASES.push(mkCase('RR-H'+i,'Rr Ana',{}));CASES.forEach(c=>{c.credit={n:'Rr Ana',at:simNow().getTime()-864e5*3};c.rr=null})");
    A.run("window.__rr=[];for(let i=0;i<7;i++){const o=coverFor(simNow(),null,undefined,true);const c=mkCase('RR-N'+i,o,{nw:1});rrMark(c,o);CASES.unshift(c);__rr.push(o)}");
    const seq = A.run('__rr.join()').split(',');
    check('new cases go round robin: everyone on shift takes a turn before anyone gets a second one', new Set(seq.slice(0, 3)).size === 3 && seq[3] === seq[0] && seq[4] === seq[1] && seq[5] === seq[2] && seq[6] === seq[0], seq.join());
    check('round robin ignores how many cases someone already holds (Ana holds 5 old cases but still gets her turn)', seq.includes('Rr Ana'));
    check('off-shift and unavailable agents are skipped', !seq.includes('Rr Off') && !seq.includes('Rr Away'));
    A.run("reassign(CASES.find(c=>c.owner==='Rr Ben'),'Rr Cy','test hand-over');window.__hc=CASES.find(c=>c.owner==='Rr Cy'&&c.xfer&&c.xfer.to==='Rr Cy')");
    check('a hand-over case the agent did not update yet is not counted', A.run("dayParts('Rr Cy',simNow()).ho") === 0);
    A.run("ME={role:'agent',name:'Rr Cy'};applyMe();openId=__hc.id;document.getElementById('new-in').value='Call the CE';addItem(__hc.id);openId=null;ME={role:'manager',name:'Jeff Bote'};applyMe()");
    const q = A.run("JSON.stringify(dayParts('Rr Cy',simNow()))");
    check('cases today are split into handover and new', q === JSON.stringify({ ho: 1, nw: seq.filter(x => x === 'Rr Cy').length }), q);
    A.run("setDash('active');render()");
    const al = String(A.els['agent-list'].innerHTML);
    check('Agent Status shows the handover count first, then the new cases', /↪ 1 handover<\/span> <span[^>]*>\d+ new/.test(al));
    A.run("STAFF.forEach(p=>{if(!isMgr(p))p.status='unavailable'});CASES.unshift(mkCase('RR-Q','Queue',{nw:1}));STAFF.find(p=>p.name==='Rr Ben').status='available';eosCheck()");
    check('a new case waiting in the queue goes to the next agent and counts as new for them', A.run("getCase('RR-Q').owner") === 'Rr Ben' && A.run("credOf(getCase('RR-Q')).n") === 'Rr Ben');
  }
  // ---------- catch-up balancing ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
    const L = n => A.run(`loadOf('${n}')`);
    const setup = st => { A.run('STAFF=' + JSON.stringify([ag('Cu Ann', -300, 300), ag('Cu Bob', -300, 300), ag('Cu Kim', -200, 300, st)]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false');
      A.run("CASES.length=0;for(let i=0;i<12;i++){const c=mkCase('CU-'+i,i<6?'Cu Ann':'Cu Bob',{});c.ts=Date.now()-i*60000;CASES.push(c)}asHo();ME={role:'agent',name:'Cu Kim'};localStorage.setItem('pet_signed_in_at',String(Date.now()-60000));localStorage.removeItem('pat_bal_ok')"); };
    setup('unavailable');
    A.run("batchR(()=>balanceOnSignIn('Cu Kim'))");
    check('signed in while Unavailable: nothing is handed over yet', L('Cu Kim') === 0);
    check('catch-up waits while still Unavailable', A.run('balanceCatchUp(true)') === 0 && L('Cu Kim') === 0);
    A.run("pers('Cu Kim').status='available'");
    A.run('balanceCatchUp(true)');
    check('once available with no hand-over since sign-in, she gets an equal share from the agents who have cases (4/4/4)', L('Cu Kim') === 4 && L('Cu Ann') === 4 && L('Cu Bob') === 4);
    A.run("CASES.push(...Array.from({length:6},(_,i)=>mkCase('CU-X'+i,'Cu Ann',{})))");
    check('it happens once per sign-in (no balancing every time)', A.run('balanceCatchUp(true)') === 0 && L('Cu Kim') === 4);
    setup('available');
    A.run("reassign(getCase('CU-0'),'Cu Kim','end of shift hand-over')");
    A.run('balanceCatchUp(true)');
    check('an agent below the round limit is filled up evenly even after one hand-over (4/4/4)', L('Cu Kim') === 4 && L('Cu Ann') === 4 && L('Cu Bob') === 4, [L('Cu Ann'), L('Cu Bob'), L('Cu Kim')]);
  }
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    const L = n => A.run(`loadOf('${n}')`);
    A.run('STAFF=' + JSON.stringify([ag('Co Ann', -300, 300), ag('Co Bob', -300, 300), ag('Co Cora', -200, 300)]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false');
    A.run("CASES.length=0;for(let i=0;i<12;i++){const c=mkCase('CO-'+i,i<6?'Co Ann':'Co Bob',{});c.ts=Date.now()-i*60000;CASES.push(c)}asHo();ME={role:'agent',name:'Co Cora',coord:true};localStorage.setItem('pet_signed_in_at',String(Date.now()-60000));localStorage.removeItem('pat_bal_ok')");
    A.run('balanceCatchUp(true)');
    check('an agent tagged as coordinator also gets hand-over cases after signing in (4/4/4)', L('Co Cora') === 4 && L('Co Ann') === 4 && L('Co Bob') === 4);
    check('managers are never balanced', A.run("ME={role:'manager',name:'Jeff Bote'};balWho()") === '');
    check('there is no shared Coordinator sign-in: a coordinator acts under their own name and is a lead', A.run("ME={role:'agent',name:'Co Cora',coord:true};applyMe();SIM_USER+'|'+meKey()+'|'+isLead()") === 'Co Cora|Co Cora|true');
    check('a coordinator still receives new cases (round robin) and is in the hand-over pool', A.run("COORDS=['Co Cora'];onlineAgents(simNow()).some(p=>p.name==='Co Cora')") === true && ['Co Ann','Co Bob','Co Cora'].every(n => A.run(`(()=>{const r=[];for(let i=0;i<3;i++){const o=coverFor(simNow(),null,undefined,true);const c=mkCase('CO-N'+i+Math.random(),o,{nw:1});rrMark(c,o);CASES.unshift(c);r.push(o)}return r})().length`) === 3) && A.run("CASES.some(c=>c.nw&&c.owner==='Co Cora')") === true);
  }
  {
    const agN = A.run("STAFF.find(p=>!isMgr(p)).name");
    A.run(`ME={role:'agent',name:'Haina Azuela',coord:true};applyMe();PROFILE_HASHES[profileKey(${JSON.stringify(agN)})]='h';PROFILE_HASHES[profileKey('Jeff Bote')]='h2';setTabTo('prof')`);
    const pb = String(A.els['set-body'].innerHTML);
    check('a coordinator does not get Release face / Clear password / Delete in Profiles', !pb.includes('clrPw(') && !pb.includes('relSeat(') && !pb.includes('delAcct('));
    A.run(`clrPw(${JSON.stringify(agN)});clrPw('Jeff Bote')`);
    check('a coordinator cannot clear passwords', A.run(`PROFILE_HASHES[profileKey(${JSON.stringify(agN)})]`) === 'h' && A.run("PROFILE_HASHES[profileKey('Jeff Bote')]") === 'h2');
    A.run(`ME={role:'manager',name:'June John Cruz'};applyMe();setTabTo('prof')`);
    check('managers and the Vendor Management Team keep these tools', String(A.els['set-body'].innerHTML).includes(`clrPw('${agN}')`));
    A.run(`clrPw(${JSON.stringify(agN)});ME={role:'agent',name:'Haina Azuela',coord:true};applyMe()`);
    check('a manager can clear a password', !A.run(`PROFILE_HASHES[profileKey(${JSON.stringify(agN)})]`));
    A.run(`toggleCoord(${JSON.stringify(agN)},true)`);
    const ssnBefore = A.run('JSON.stringify(SSN)');
    A.run("SSN_DRAFT={kind:'none'};ssnSave();LD=null;ldStart('main')");
    check('a coordinator still cannot change roles, the seasonal theme or the login page', A.run(`isCoordName(${JSON.stringify(agN)})`) === false && A.run('JSON.stringify(SSN)') === ssnBefore && A.run('LD') === null);
    check('a coordinator has the other manager/coordinator settings (Profiles, Reports, Required checklist)', A.run("isLead()") === true);
  }
  // ---------- hand-over formula: total ÷ available agents, re-divided when another agent becomes available ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
    const H = n => A.run(`hoOpen('${n}')`), L = n => A.run(`loadOf('${n}')`);
    A.run('STAFF=' + JSON.stringify([ag('Rl Gone', -540, -2), ag('Rl Amy', -200, 300), ag('Rl Ben', -200, 300), ag('Rl Cat', -200, 300), ag('Rl Dee', -200, 300), ag('Rl Eve', -200, 300, 'unavailable')]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false');
    A.run("CASES.length=0;for(let i=0;i<100;i++)CASES.push(mkCase('RL-'+String(i).padStart(3,'0'),'Rl Gone',{}));for(let i=0;i<5;i++)CASES.push(mkCase('RN-'+i,'Rl Amy',{}))");
    A.run('eosCheck()');
    check('100 cases ÷ 4 available agents = 25 each', ['Rl Amy', 'Rl Ben', 'Rl Cat', 'Rl Dee'].every(n => H(n) === 25), ['Rl Amy', 'Rl Ben', 'Rl Cat', 'Rl Dee'].map(H));
    check('new cases are on top, not part of the share', L('Rl Amy') === 30);
    check('an Unavailable agent gets nothing while away', L('Rl Eve') === 0);
    check('the case history has a plain hand-over line (no math)', A.run("getCase('RL-000').log.some(l=>/reached end of shift \\(EOS\\): case handed over to/.test(l.details))") === true && A.run("getCase('RL-000').log.every(l=>!/÷/.test(l.details))") === true);
    A.run("STAFF.find(p=>p.name==='Rl Eve').status='available';ME={role:'agent',name:'Rl Eve'};localStorage.setItem('pet_signed_in_at',String(Date.now()-60000));localStorage.removeItem('pat_bal_ok')");
    A.run('balanceCatchUp(true)');
    check('one more available agent: 100 ÷ 5 = 20 each (she gets 5 from each)', ['Rl Amy', 'Rl Ben', 'Rl Cat', 'Rl Dee', 'Rl Eve'].every(n => H(n) === 20), ['Rl Amy', 'Rl Ben', 'Rl Cat', 'Rl Dee', 'Rl Eve'].map(H));
    check('her new cases stayed with Amy (5 new + 20 hand-over)', L('Rl Amy') === 25);
    A.run("render()");
    const alh = String(A.els['agent-list'].innerHTML);
    check('Agent Status shows only the counts (handover worked + new), no share computation', !/÷|Hand-over share/.test(alh) && /handover<\/span> <span[^>]*>\d+ new/.test(alh));
    A.run("CASES.filter(c=>c.owner==='Rl Amy'&&isHo(c)).forEach(c=>c.closed=true);STAFF.push(" + JSON.stringify(ag('Rl Dan', -5, 400)) + ");ME={role:'agent',name:'Rl Dan'};localStorage.setItem('pet_signed_in_at',String(Date.now()));localStorage.removeItem('pat_bal_ok')");
    A.run('balanceCatchUp(true)');
    check('a late agent gets the share of the open hand-over cases: 80 ÷ 6 = 13 (a giver with none open is skipped)', H('Rl Dan') === 13 && H('Rl Amy') === 0, ['Rl Amy', 'Rl Ben', 'Rl Cat', 'Rl Dee', 'Rl Eve', 'Rl Dan'].map(H));
    check('checklist items show who added and who completed them', (() => { A.run("ME={role:'agent',name:'Rl Ben'};applyMe();window.__bc=CASES.find(c=>c.owner==='Rl Ben'&&isHo(c));openId=__bc.id;document.getElementById('new-in').value='Confirm part ETA';addItem(__bc.id);ME={role:'agent',name:'Rl Cat'};applyMe();toggleItem(__bc.id,__bc.items.length-1);renderCase()"); const h = String(A.els['case-body'] ? A.els['case-body'].innerHTML : ''); const it = J(A.run("JSON.stringify(__bc.items[__bc.items.length-1])")); A.run("openId=null;ME={role:'manager',name:'Jeff Bote'};applyMe()"); return it.by === 'Rl Ben' && it.doneBy === 'Rl Cat' && (!h || (/Added by <b[^>]*>Rl Ben/.test(h) && /Completed by <b[^>]*>Rl Cat/.test(h))); })());
  }
  // ---------- checklist Nov 13 (evening): catch-up not limited to once; no pop-up for automatic moves ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
    const H = n => A.run(`hoOpen('${n}')`);
    A.run('STAFF=' + JSON.stringify([ag('Ck Gone', -540, -2), ag('Ck Ann', -200, 300), ag('Ck Bo', -200, 300), ag('Ck Kim', -10, 300)]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false');
    // Ann and Bo hold hand-over cases that were transferred to them by hand: they cannot move
    A.run("CASES.length=0;for(let i=0;i<6;i++){const c=mkCase('CK-A'+i,'Old',{});reassign(c,'Ck Ann','by hand','Jeff Bote');CASES.push(c)}for(let i=0;i<6;i++){const c=mkCase('CK-B'+i,'Old',{});reassign(c,'Ck Bo','by hand','Jeff Bote');CASES.push(c)}");
    A.run("ME={role:'agent',name:'Ck Kim'};applyMe();localStorage.setItem('pet_signed_in_at',String(Date.now()-60000));localStorage.removeItem('pat_bal_ok');BAL_LAST_ST='';balanceCatchUp(true)");
    check('first check finds nothing that can move, and is not counted as done', H('Ck Kim') === 0 && !A.run("localStorage.getItem('pat_bal_ok')"));
    A.run("window.__notes=[];window.__on=note;note=m=>__notes.push(m)");
    A.run("for(let i=0;i<12;i++)CASES.push(mkCase('CK-G'+i,'Ck Gone',{}));ME={role:'agent',name:'Ck Ann'};applyMe();eosCheck()");
    check('automatic hand-overs show no pop-up to the agents involved', A.run('__notes.length') === 0 && H('Ck Ann') === 10, A.run('JSON.stringify(__notes)'));
    A.run("note=__on");
    A.run("ME={role:'agent',name:'Ck Kim'};applyMe();balanceCatchUp(true)");
    check('the next check (30 s later) gives her the share once cases can move', H('Ck Kim') >= 5 && Math.abs(H('Ck Kim') - H('Ck Ann')) <= 2, ['Ck Ann', 'Ck Bo', 'Ck Kim'].map(H));
    check('once she holds her share the check rests (closing cases later does not pull in more)', (() => { A.run("CASES.filter(c=>c.owner==='Ck Kim'&&isHo(c)).forEach(c=>c.closed=true);balanceCatchUp(true)"); return H('Ck Kim') === 0; })());
  }
  // ---------- Nov 15: balancing happens at once on the hand-over screen, near-EOS agents give first ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
    const H = n => A.run(`hoOpen('${n}')`), L = n => A.run(`loadOf('${n}')`);
    A.run('STAFF=' + JSON.stringify([ag('Nb Soon', -300, 180), ag('Nb Ann', -200, 400), ag('Nb Bo', -200, 400), ag('Nb Kim', 30, 500)]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false;BALDONE={};AVAILIN={}');
    A.run("CASES.length=0;['Nb Soon','Nb Ann','Nb Bo'].forEach(n=>{for(let i=0;i<10;i++){const c=mkCase('NB-'+n.slice(3)+i,'Old',{});reassign(c,n,'end of shift hand-over');CASES.push(c)}});for(let i=0;i<8;i++)CASES.push(mkCase('NB-NEW'+i,'Nb Soon',{nw:1}))");
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();balanceJoiners(true)");
    check('agents already sharing equally are left alone by the hand-over screen', H('Nb Soon') === 10 && H('Nb Ann') === 10 && H('Nb Bo') === 10 && L('Nb Kim') === 0);
    A.run(`pers('Nb Kim').start=${JSON.stringify(T(nowM - 1))}`);
    const mv = A.run('balanceJoiners(true)');
    check('when an agent\'s shift starts she gets her share at once, without her own browser open (30 ÷ 4 = 7)', mv === 7 && H('Nb Kim') === 7, ['Nb Soon', 'Nb Ann', 'Nb Bo', 'Nb Kim'].map(H));
    check('the agent ending in 3 hours gives first (down to the share), then the busiest', H('Nb Soon') === 7 && H('Nb Ann') === 8 && H('Nb Bo') === 8, ['Nb Soon', 'Nb Ann', 'Nb Bo'].map(H));
    check('new cases still stay with the agent who received them', L('Nb Soon') === 15 && A.run("CASES.filter(c=>c.nw&&c.owner==='Nb Soon').length") === 8);
    check('the move is logged as a plain line in Case History', A.run("CASES.some(c=>c.owner==='Nb Kim'&&(c.log||[]).some(l=>/Nb Kim became available: hand-over case moved from Nb Soon/.test(l.details||'')))") === true);
    A.run("CASES.filter(c=>c.owner==='Nb Kim'&&isHo(c)).forEach(c=>c.closed=true)");
    check('once she has her share the check rests (closing cases does not pull in more)', A.run('balanceJoiners(true)') === 0 && H('Nb Kim') === 0);
    A.run("pers('Nb Kim').availAt=Date.now()+5");
    A.run('balanceJoiners(true)');
    check('back from Unavailable: balanced again straight away', H('Nb Kim') >= 4, ['Nb Soon', 'Nb Ann', 'Nb Bo', 'Nb Kim'].map(H));
    A.run("AVAILIN['Nb Kim']=Date.now()+10;CASES.filter(c=>c.owner==='Nb Kim'&&isHo(c)).forEach(c=>c.closed=true)");
    A.run('balanceJoiners(true)');
    check('signing in on shift counts as becoming available too', H('Nb Kim') >= 4, ['Nb Soon', 'Nb Ann', 'Nb Bo', 'Nb Kim'].map(H));
    check('an agent who stays signed in into her next shift is balanced again (new shift = new check)', A.run("(()=>{const p=pers('Nb Ann'),k=availKey(p,+simNow());return k!==availKey(p,+simNow()+86400000)})()") === true);
    check('an agent near EOS (30 min) is never given cases by the hand-over screen', (() => { A.run(`STAFF.push(${JSON.stringify(ag('Nb Late', -400, 20))});BALDONE={}`); A.run('balanceJoiners(true)'); return L('Nb Late') === 0; })());
    // the agent's own browser leaves it to the hand-over screen when another screen runs it (no double moves)
    A.run("ME={role:'agent',name:'Nb Kim'};applyMe();localStorage.removeItem('pat_bal_ok');window.__db0=DBON;window.__g0=[GOT.cases,GOT.staff];DBON=true;GOT.cases=1;GOT.staff=1;LEASE={id:'other-screen',until:Date.now()+15000}");
    const own = A.run('balanceCatchUp(true)');
    A.run("DBON=__db0;GOT.cases=__g0[0];GOT.staff=__g0[1];LEASE={id:'',until:0};ME={role:'manager',name:'Jeff Bote'};applyMe()");
    check('the agent\'s own browser does not move cases while another screen is balancing', own === 0);
  }
  // ---------- idle sign-out rules + agent productivity & due-miss report ----------
  {
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();localStorage.setItem('pat_last_act',String(Date.now()-9*3600000))");
    check('managers / Vendor Management are not signed out after 8 hours idle', A.run('idleCheck()') === false && A.run('ME.role') === 'manager');
    const ag0 = A.run("STAFF.find(p=>!isMgr(p)).name");
    A.run(`ME={role:'agent',name:${JSON.stringify(ag0)}};applyMe();pers(${JSON.stringify(ag0)}).status='unavailable';localStorage.setItem('pat_last_act',String(Date.now()-9*3600000))`);
    check('an agent is still signed out after 8 hours idle', A.run('idleCheck()') === true && !A.run('ME.role'));
    A.run(`ME={role:'agent',name:${JSON.stringify(ag0)}};afterSignIn()`);
    check('after an idle sign-out the agent comes back as Available', A.run(`pers(${JSON.stringify(ag0)}).status`) === 'available' && !A.run("localStorage.getItem('pat_idle_out')"));
    A.run(`ME={role:'agent',name:${JSON.stringify(ag0)}};applyMe();pers(${JSON.stringify(ag0)}).status='unavailable';pers(${JSON.stringify(ag0)}).reason='Lunch';localStorage.setItem('pat_last_act',String(Date.now()-65*60000))`);
    check('an agent on a lunch break (signed in, under 8 hours) is not signed out', A.run('idleCheck()') === false && A.run('ME.role') === 'agent');
    A.run(`afterSignIn()`);
    check('...and keeps their break status (only an 8-hour idle sign-out resets to Available)', A.run(`pers(${JSON.stringify(ag0)}).status`) === 'unavailable');
    A.run(`signOut();ME={role:'agent',name:${JSON.stringify(ag0)}};afterSignIn()`);
    check('signing out and in by hand does not change the status either', A.run(`pers(${JSON.stringify(ag0)}).status`) === 'unavailable');
    A.run(`pers(${JSON.stringify(ag0)}).status='available';pers(${JSON.stringify(ag0)}).reason=''`);
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe()");
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name) => ({ name, role: 'Support', start: T(nowM - 300), end: T(nowM + 300), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Pf Amy'), ag('Pf Ben')]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false;rptWeek(0);RPT.account="all";RPT.type="all"');
    A.run(`CASES.length=0;(()=>{const H=36e5,n=Date.now();
      const a=mkCase('PF-1','Pf Amy',{});a.ts=n-5*H;a.items[0].rem={at:n-3*H,text:'Call the CE',fired:true,by:'Pf Amy',setAt:n-4*H};CASES.push(a);
      reassign(a,'Pf Ben','test hand-over');a.ownh[a.ownh.length-1].at=n-2*H;
      a.items[0].rem.done={text:'done',by:'Pf Ben',at:n-2.5*H};a.items[0].done=true;
      const b=mkCase('PF-2','Pf Ben',{});b.ts=n-H;b.log.unshift({ts:n-H/2,action:'Model number updated',by:'Pf Ben',details:'x'});CASES.push(b);
      const c=mkCase('PF-3','Pf Amy',{});c.ts=n-H;c.items[0].rem={at:n-H/2,text:'Order part',fired:true,by:'Pf Amy',setAt:n-H};CASES.push(c)})()`);
    const D = J(A.run("JSON.stringify((()=>{const D=perfData();return{rows:D.rows.map(r=>({n:r.n,nw:r.nw,nwU:r.nwU,ho:r.ho,hoU:r.hoU,miss:r.miss,open:r.open,ack:r.ackN?Math.round(r.ackMs/r.ackN/6e4):null})),ev:D.ev.map(e=>({id:e.c.id,own:e.own,later:e.later,ack:!!e.ack,open:e.open}))}})())"));
    const amy = D.rows.find(r => r.n === 'Pf Amy') || {}, ben = D.rows.find(r => r.n === 'Pf Ben') || {};
    check('due miss counted for the owner at due time (Amy), with the time until acknowledged (30 min)', amy.miss === 2 && amy.ack === 30 && ben.miss === 0, JSON.stringify(D.rows));
    check('a due reminder still open when the case moved is not the next agent\'s fault', D.ev.some(e => e.id === 'PF-1' && e.own === 'Pf Amy'));
    check('still unacknowledged reminders are shown as open', amy.open === 1);
    check('received cases split into new and hand-over, with how many were updated', amy.nw === 2 && ben.nw === 1 && ben.nwU === 1 && ben.ho === 1, JSON.stringify(D.rows));
    check('older cases without the new ownership history are back-tracked from Case History', A.run("(()=>{const c=getCase('PF-1'),o=c.ownh;c.ownh=null;const tl=ownTimeline(c);c.ownh=o;return tl.map(x=>x.n).join('>')})()") === 'Pf Amy>Pf Ben');
    const sc = r0 => { const r = { ...r0, upN: r0.upN != null ? r0.upN : r0.nwU, upO: r0.upO != null ? r0.upO : r0.hoU }; return A.run(`perfScore(${JSON.stringify(r)}).st`); };
    const base = { n: 'X', nw: 6, nwU: 5, ho: 4, hoU: 4, closed: 0, miss: 0, ackMs: 0, ackN: 0, maxMs: 0, open: 0 };
    const base8 = { n: 'X', nw: 6, nwU: 5, ho: 4, hoU: 4, closed: 0, miss: 0, ackMs: 0, ackN: 0, maxMs: 0, open: 0 };
    check('dashboard: a normal agent is not highlighted (even at 70% updated with a miss)', sc(base8) === 'ok' && sc({ ...base8, nwU: 3, miss: 1, ackN: 1, ackMs: 3600000 }) === 'ok');
    check('dashboard: Needs attention only when clearly not performing — under 40% updated', sc({ ...base8, nwU: 1, hoU: 2 }) === 'attn');
    check('dashboard: Needs attention — 3+ due misses at 0.3+ per case, or 3+ left open, or over 4 h to acknowledge', sc({ ...base8, miss: 3, ackN: 3, ackMs: 3 * 600000 }) === 'attn' && sc({ ...base8, open: 3, miss: 3 }) === 'attn' && sc({ ...base8, miss: 3, ackN: 3, ackMs: 3 * 5 * 3600000 }) === 'attn' && sc({ ...base8, miss: 2, ackN: 2, ackMs: 2 * 600000 }) === 'ok');
    check('dashboard: fewer than 8 cases is not judged', sc({ ...base8, nw: 3, nwU: 0, ho: 2, hoU: 0 }) === 'na');
    A.run("RPT.view='perf';setTabTo('reports')");
    const rb = String(A.els['set-body'].innerHTML);
    check('Reports has the Agent productivity & due misses view with an Excel download', /Agent productivity &amp; due misses|Agent productivity & due misses/.test(rb) && rb.includes('exportPerf()') && !rb.includes('perfCsv()') && rb.includes('Counted for'));
    check('the view opens with the Performance dashboard, grouped by region, with charts and a 4-week trend', rb.includes('Performance dashboard') && /🌏 (APJ|EMEA|AMS|Unassigned)/.test(rb) && rb.includes('<svg') && rb.includes('last 4 weeks'));
    A.run("RPT.view='weekly'");
  }
  // ---------- Nov 17: every update counts for productivity; numbers instead of bars; charts; Variance ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name) => ({ name, role: 'Support', start: T(nowM - 300), end: T(nowM + 300), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Pw Amy'), ag('Pw Ben'), ag('Pw Cy')]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false;rptWeek(0);RPT.account="all";RPT.type="all"');
    // three cases received earlier (a week ago) by Amy: today Ben fills a field, Cy adds a checklist item, Ben sets a maintenance window on another
    A.run(`CASES.length=0;(()=>{const W=8*864e5,n=Date.now();['PW-1','PW-2','PW-3'].forEach(id=>{const c=mkCase(id,'Pw Amy',{});c.ts=n-W;c.credit={n:'Pw Amy',at:n-W};CASES.push(c)})})();
      ME={role:'agent',name:'Pw Ben'};applyMe();cdSet('PW-1','model','DL380');
      ME={role:'agent',name:'Pw Cy'};applyMe();openId='PW-2';document.getElementById('new-in').value='Check the cable';addItem('PW-2');openId=null;
      ME={role:'agent',name:'Pw Ben'};applyMe();(()=>{const c=getCase('PW-3'),t=Date.now()+36e5;c.mw={s:t,e:null,by:'Pw Ben',ts:Date.now()};logc(c,'Maintenance window set','Pw Ben','x')})();
      ME={role:'manager',name:'Jeff Bote'};applyMe()`);
    check('each update marks the case with the agent and day (kept on the case, not only in the history)', A.run("JSON.stringify(Object.keys(getCase('PW-1').wk||{}))") === '["Pw Ben"]' && A.run("Object.keys(getCase('PW-2').wk||{}).join()") === 'Pw Cy');
    A.run("CASES.forEach(c=>{c.log=[]})");   // even if the history is not loaded
    const P = J(A.run("JSON.stringify(perfData().rows.map(r=>({n:r.n,oth:r.upO,p:prodOf(r)})))"));
    const pr = n => P.find(r => r.n === n) || {};
    check('a value added to a field, a checklist item and a maintenance window all count for productivity', pr('Pw Ben').oth === 2 && pr('Pw Ben').p === 2 && pr('Pw Cy').oth === 1 && pr('Pw Cy').p === 1, JSON.stringify(P));
    check('the same case updated twice on a day counts once', (() => { A.run("ME={role:'agent',name:'Pw Ben'};applyMe();cdSet('PW-1','ritm','R1');ME={role:'manager',name:'Jeff Bote'};applyMe()"); return J(A.run("JSON.stringify(perfData().rows.find(r=>r.n==='Pw Ben').upO)")) === 2; })());
    check('several fields and a checklist item on one case the same day still count as 1', (() => { A.run("ME={role:'agent',name:'Pw Cy'};applyMe();cdSet('PW-2','model','X1');cdSet('PW-2','ritm','R9');openId='PW-2';document.getElementById('new-in').value='Second item';addItem('PW-2');openId=null;ME={role:'manager',name:'Jeff Bote'};applyMe()"); return J(A.run("JSON.stringify(prodOf(perfData().rows.find(r=>r.n==='Pw Cy')))")) === 1 && A.run("dayParts('Pw Cy',simNow()).ho") === 1; })());
    check('the same case received on one day and updated on another day counts 1 for each of those days', (() => {
      A.run(`(()=>{const n=Date.now(),D=864e5,c=mkCase('PW-9','Pw Amy',{});c.ts=n-2*D;c.credit={n:'Pw Amy',at:n-2*D};c.wk={'Pw Amy':[n-2*D+60000,n-D]};CASES.push(c)})()`);
      const one = d => A.run(`(()=>{const t=Date.now()-${d}*864e5,f=fromLI(ymd(wall(t))+'T00:00'),e=fromLI(ymd(wall(t))+'T23:59')+59999,r=perfData(f,e).rows.find(r=>r.n==='Pw Amy');return r?prodOf(r):0})()`);
      const tot = A.run("(()=>{const t=Date.now()-2*864e5,r=perfData(fromLI(ymd(wall(t))+'T00:00'),Date.now()).rows.find(r=>r.n==='Pw Amy');return r?prodOf(r):0})()");
      return one(2) === 1 && one(1) === 1 && tot === 2;
    })());
    check('Agent Status counts the cases they updated today too', A.run("dayParts('Pw Ben',simNow()).ho") === 2 && A.run("dayParts('Pw Cy',simNow()).ho") === 1);
    check('cases received earlier and not updated in the period do not count for the agent who received them', pr('Pw Amy').p === 0);
    A.run("RPT.view='perf';setTabTo('reports')");
    const rb = String(A.els['set-body'].innerHTML);
    check('the productivity table shows numbers (no bars), centred', !/<rect x="0" y="0" width="100" height="10"/.test(rb) && /class="py-1\.5 px-2 text-center font-bold text-sm">2</.test(rb));
    check('the full numbers table is centred: old cases and new cases (received and updated), productivity, due reminders', rb.includes('Old cases (hand-over / balanced)') && rb.includes('= Old updated + New updated') && !rb.includes('Own cases followed up') && /<td class="px-2 py-1\.5 border border-gray-200 text-center ">/.test(rb));
    check('the note says productivity is based on updated cases only', rb.includes('<b>Note:</b> Productivity is based on updated cases only: a case that was assigned but not updated does not count.'));
    check('a guide explains every column', rb.includes('Guide: what each column means') && rb.includes('Several updates on one case in a day count as 1') && htmlSrc.includes("xlSheet(wb,sub,'Guide'"));
    check('graphs: productivity and due misses per day and per agent', rb.includes('Productivity and due misses per day') && rb.includes('Productivity and due misses per agent') && rb.includes('Due misses (right scale)'));
    check('the Excel download is wired to the lazy Excel library', htmlSrc.includes("'exportDaily','exportPerf'") && htmlSrc.includes('async function exportPerf()') && /pic\(ws1,perfDaySvg/.test(htmlSrc) && /pic\(ws2,perfAgentSvg/.test(htmlSrc));
    A.run("RPT.view='daily';setTabTo('reports')");
    const db = String(A.els['set-body'].innerHTML);
    check('Daily trend shows Variance instead of Net', db.includes('>Variance</th>') && !db.includes('>Net</th>') && htmlSrc.includes("'Variance (created − closed)'"));
    A.run("RPT.view='weekly'");
  }
  // ---------- Nov 17 (b): one row per agent in the current region, breakdown, agent's own view ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    A.run(`STAFF=[{name:'Jv Mar',role:'Support',start:'06:00',end:'15:00',days:[1,1,1,1,1,1,1],status:'available'},{name:'Jv Ann',role:'Support',start:'06:00',end:'15:00',days:[1,1,1,1,1,1,1],status:'available'},{name:'Jv Bo',role:'Support',start:'${T(nowM - 300)}',end:'${T(nowM + 300)}',days:[1,1,1,1,1,1,1],status:'available'}];STAFF.forEach(p=>p.sch=mkSch(p));ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false;rptDays(7,true);RPT.account='all';RPT.type='all';
      RGH={'Jv Mar':[{at:0,rg:'APJ'},{at:Date.now()-2*864e5,rg:'EMEA'},{at:Date.now()-864e5,rg:'APJ'}]};
      CASES.length=0;(()=>{const n=Date.now(),D=864e5;
        const a=mkCase('JV-1','Jv Mar',{});a.ts=n-1.5*D;a.credit={n:'Jv Mar',at:n-1.5*D};CASES.push(a);           // new case received while EMEA
        const b=mkCase('JV-2','Jv Mar',{});b.ts=n-60000;b.credit={n:'Jv Mar',at:n-60000};CASES.push(b);              // new case received now (APJ)
        const h=mkCase('JV-3','Jv Ann',{});h.ts=n-3*D;h.credit={n:'Jv Ann',at:n-3*D};h.credits=[{n:'Jv Mar',at:n-1.2*D}];h.owner='Jv Mar';h.wk={'Jv Mar':[n-1.1*D,n-30000]};CASES.push(h);   // hand-over, updated on 2 days
        a.wk={'Jv Mar':[n-1.5*D+60000,n-20000]};                                                                     // own case followed up today
        const o=mkCase('JV-4','Jv Bo',{});o.ts=n-6*D;o.credit={n:'Jv Bo',at:n-6*D};o.wk={'Jv Mar':[n-10000]};CASES.push(o)})()`);   // helping on a colleague's case
    const R = J(A.run("JSON.stringify(perfData().rows.filter(r=>r.n==='Jv Mar').map(r=>({rg:r.rg,nw:r.nw,ho:r.ho,upN:r.upN,upO:r.upO,p:prodOf(r),segs:r.segs})))"));
    check('a schedule change does not split the agent: one row, in the current region', R.length === 1 && R[0].rg === 'APJ', JSON.stringify(R));
    check('the days worked in the earlier region are kept apart for the comparison (EMEA 1 day, APJ 1 day)', R[0] && R[0].segs.some(g => g.rg === 'EMEA' && g.act === 1 && g.p === 2) && R[0].segs.some(g => g.rg === 'APJ' && g.act === 1 && g.p === 3), JSON.stringify(R));
    check('the earlier days are compared with the earlier region\'s average (benchmark mixes the regions by days)', A.run("benchOf({segs:[{rg:'EMEA',p:4,act:2},{rg:'APJ',p:3,act:1}],rg:'APJ'},{EMEA:3,APJ:6})") === 4 && A.run("regionAvgs([{segs:[{rg:'EMEA',p:6,act:2}]},{segs:[{rg:'EMEA',p:2,act:2},{rg:'APJ',p:5,act:1}]}]).EMEA") === 2);
    check('productivity = updated cases only, in total 5: old 1 received / 3 updated, new 2 received / 2 updated (the new case not updated = 0)', R.reduce((a,r)=>a+r.p,0) === 5 && R.reduce((a,r)=>a+r.upO,0) === 3 && R.reduce((a,r)=>a+r.upN,0) === 2 && R.reduce((a,r)=>a+r.nw,0) === 2 && R.reduce((a,r)=>a+r.ho,0) === 1, JSON.stringify(R));
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();RPT.view='perf';setTabTo('reports')");
    const mb = String(A.els['set-body'].innerHTML), mt = String(A.els['set-tabs'].innerHTML);
    check('the dashboard table shows old and new cases received with how many were updated (no breakdown)', mb.includes('<b>1</b> received</span> · <span class="nw"><b class="text-[#01A982]">3</b> updated') && mb.includes('<b>2</b> received</span> · <span class="nw"><b class="text-[#01A982]">2</b> updated') && mb.includes('· earlier EMEA 1 day') && !mb.includes('follow-up</span>'));
    check('Unassigned is not shown', !mb.includes('🌏 Unassigned'));
    check('managers keep the full Reports (no "My productivity" tab)', mt.includes('📊 Reports') && !mt.includes('My productivity'));
    A.run("ME={role:'agent',name:'Jv Mar'};applyMe();setTabTo('reports')");
    const ab = String(A.els['set-body'].innerHTML), at = String(A.els['set-tabs'].innerHTML);
    check('an agent sees the report in their profile as "My productivity"', at.includes('🏅 My productivity') && !at.includes('📊 Reports') && (ab.includes('My productivity &amp; due misses') || ab.includes('My productivity & due misses')));
    check('the agent sees only their own numbers, with the team average to compare', ab.includes('Jv Mar') && !ab.includes('Jv Ann</b>') && !ab.includes('Jv Bo</b>') && ab.includes('How you compare with the APJ team') && ab.includes('Guide: what each column means'));
    check('changing the dates keeps the agent on their own view', (() => { A.run("rptDays(14)"); return A.run('setTab') === 'myperf' && A.run('PERF_ONLY') === ''; })());
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();RGH={};RPT.view='weekly'");
  }
  // ---------- Nov 17 (c): scorecard; New tag only for cases added with + Add ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Sc Gone', -540, -2), ag('Sc Amy', -200, 300), ag('Sc Ben', -200, 300)]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false;RGH={}');
    A.run("CASES.length=0;ME={role:'manager',name:'Jeff Bote'};applyMe();(()=>{const a=mkCase('NT-1','Sc Gone',{nw:1});CASES.push(a);const b=mkCase('NT-2','Sc Amy',{nw:1});CASES.push(b);const q=mkCase('NT-3','Sc Amy',{});CASES.push(q)})();eosCheck()");
    check('a case added with + Add shows as New for the agent it was added for', A.run("isNew(getCase('NT-2'))") === true);
    check('a new case handed over at end of shift does not show as New for the next agent', A.run("getCase('NT-1').owner") !== 'Sc Gone' && A.run("isNew(getCase('NT-1'))") === false && A.run("getCase('NT-1').nw") === false);
    A.run("reassign(getCase('NT-2'),'Sc Ben','balancing')");
    check('a balanced or transferred case does not show as New', A.run("isNew(getCase('NT-2'))") === false);
    check('an older moved case still flagged in the database is not shown as New either', A.run("(()=>{const c=getCase('NT-3');c.nw=true;c.owner='Sc Ben';return isNew(c)})()") === false);
    // scorecard
    const S = r => J(A.run(`JSON.stringify(scRows({rows:[${JSON.stringify(r)}]}).map(x=>({s:x.score,rt:x.rt,we:x.we,none:x.none})))`))[0];
    const base = { n: 'X', rg: 'APJ', nw: 6, nwU: 6, ho: 4, hoU: 4, upN: 6, upO: 4, closed: 0, miss: 1, ackMs: 600000, ackN: 1, maxMs: 0, open: 0, act: 5 };
    check('score table: weighted average of the ratings (follow-through 5, due misses 0.10 = 4, ack 10 min = 5, productivity at the region average = 5 (100% is the top), nothing open = 5; no attendance yet, so its 15% is shared → 4.77)', S(base).s === 4.77 && S(base).rt.mpc === 4 && S(base).rt.prod === 5 && A.run('scSt(4.5).l') === 'Exceeds', JSON.stringify(S(base)));
    check('score table: 50% follow-through is rated 2; 80% is rated 4 (follow-through = productivity ÷ cases received)', S({ ...base, upN: 3, upO: 2 }).rt.rate === 2 && S({ ...base, upN: 4, upO: 4 }).rt.rate === 4);
    check('score table: due misses, time to acknowledge and open reminders rated 1–5', S({ ...base, miss: 5 }).rt.mpc === 1 && S({ ...base, ackMs: 3 * 3600000 }).rt.ack === 2 && S({ ...base, miss: 2, open: 1 }).rt.open === 4);
    const mis = S({ ...base, miss: 0, ackN: 0, ackMs: 0 });
    check('a missing KPI (no due reminders: no time to acknowledge, nothing open) shares its weight equally with the others', mis.rt.ack === null && mis.rt.open === null && mis.we.ack === 0 && mis.we.rate === 36.7 && mis.we.mpc === 31.7 && mis.we.prod === 31.7 && mis.s === 5, JSON.stringify(mis));
    const nod = S({ ...base, nw: 0, nwU: 0, ho: 0, hoU: 0, upN: 0, upO: 0, miss: 0, ackN: 0, ackMs: 0, act: 0 });
    check('an agent with no data gets no score at all', nod.none === true && nod.s === null);
    check('fewer than 8 cases: ratings shown, no overall score', S({ ...base, nw: 3, ho: 2, nwU: 3, hoU: 2 }).s === null && S({ ...base, nw: 3, ho: 2, nwU: 3, hoU: 2 }).rt.rate === 5);
    check('status bands: 4.50+ Exceeds, 3.50 On track, 2.50 Watch, under 2.50 Below target', A.run("[scSt(4.5).l,scSt(3.5).l,scSt(2.5).l,scSt(2.49).l].join()") === 'Exceeds,On track,Watch,Below target');
    A.run("RPT.view='perf';rptView('score')");
    const sb = String(A.els['set-body'].innerHTML);
    check('Reports has a Scorecard view with cards per region, the guide and manager notes', sb.includes('🎯 Scorecard') && sb.includes('Score table and how the scorecard works') && sb.includes('5 (highest)') && sb.includes('1 (lowest)') && sb.includes('Last 4 weeks') && sb.includes('Context note for') && sb.includes(' / 5'));
    A.run("scNote('Sc Amy','On leave 3 days')");
    A.run("ME={role:'agent',name:'Sc Amy'};applyMe();setTabTo('myperf')");
    const ab = String(A.els['set-body'].innerHTML);
    check('an agent sees their own scorecard (with the manager note) in My productivity', ab.includes('My scorecard') && ab.includes('Manager note:</b> On leave 3 days') && !ab.includes('Sc Ben</div>') && !ab.includes('Context note for'));
    check('the Excel file has a Scorecard sheet and the score table', htmlSrc.includes("xlSheet(wb,sub,'Scorecard'") && htmlSrc.includes("xlSheet(wb,sub,'Score table'"));
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();STAFF.push({name:'Wency Villanueva',role:'Support',start:'06:00',end:'15:00',days:[1,1,1,1,1,1,1],status:'available'});(()=>{const c=mkCase('WV-1','Min Villanueva',{});c.wk={'Min Villanueva':[Date.now()-1000]};CASES.push(c)})();setTabTo('prof')");
    const pb = String(A.els['set-body'].innerHTML);
    check('Profiles has "Same person, two names" for managers', pb.includes('Same person, two names') && pb.includes('<option value="Min Villanueva">'));
    A.run("document.getElementById('al-from').value='Min Villanueva';document.getElementById('al-to').value='Wency Villanueva';aliasSave()");
    check('merging Min Villanueva into Wency Villanueva combines everything under Wency (saved, no code change)', A.run("canon('Min Villanueva')") === 'Wency Villanueva' && A.run("getCase('WV-1').owner") === 'Wency Villanueva' && A.run("ALIAS_DB['Min Villanueva']") === 'Wency Villanueva' && A.run("perfData().rows.some(r=>r.n==='Min Villanueva')") === false && String(A.els['set-body'].innerHTML).includes('<b>Min Villanueva</b> → Wency Villanueva'));
    A.run("ME={role:'agent',name:'Wency Villanueva',coord:true};applyMe()");
    check('a coordinator cannot merge names', (() => { A.run("ALIAS_DB={};aliasSave()"); return Object.keys(J(A.run('JSON.stringify(ALIAS_DB)'))).length === 0; })());
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe()");
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();RPT.view='weekly'");
  }
  // ---------- Nov 17 (d): bulk cases are not new; developer access; automatic EOS aux ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Ea Done', -540, -30), ag('Ea On', -200, 300), ag('Ea Back', -5, 400, 'unavailable'), ag('Ea Ot', -540, -60)]) + ";ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false;pers('Ea Back').reason='EOS';CASES.length=0;RGH={}");
    A.run("(()=>{const t0=Date.now(),c=mkCase('BK-1','Ea On',{});c.credit={n:BULK,at:t0};c.credits=[{n:'Ea On',at:t0}];CASES.push(c)})()");
    check('a bulk-uploaded case is not counted as a new case received (Agent Status and the report)', A.run("dayParts('Ea On',simNow()).nw") === 0 && A.run("perfData().rows.find(r=>r.n==='Ea On').nw") === 0 && A.run("perfData().rows.find(r=>r.n==='Ea On').ho") === 1);
    A.run("pers('Ea Ot').eosAux=lastEosAt(pers('Ea Ot'),+simNow())");   // already had EOS for this shift and went Available again (overtime)
    A.run('eosAuxCheck()');
    check('an agent whose shift ended is set to Unavailable · EOS automatically', A.run("pers('Ea Done').status") === 'unavailable' && A.run("auxLabel(pers('Ea Done'))") === 'EOS');
    check('an agent still on shift is not touched', A.run("pers('Ea On').status") === 'available');
    check('the automatic EOS is cleared back to Available when the next shift starts', A.run("pers('Ea Back').status") === 'available' && !!A.run("pers('Ea Back').availAt"));
    check('an agent who set themselves Available after EOS (overtime) is not set back for that shift', A.run("pers('Ea Ot').status") === 'available');
    check('EOS is not one of the reasons an agent picks by hand (it is automatic)', A.run("AUX_REASONS.includes('EOS')") === false);
    check('the screen that runs the hand-over applies it', htmlSrc.includes('eosCheck();try{eosAuxCheck()}catch(e){}'));
    // developer access: the Developer's password opens a password-protected profile
    const hasCrypto = A.run("typeof lpCrypto==='function'&&!!lpCrypto()");
    if (hasCrypto) {
      await A.run("(async()=>{PROFILE_HASHES[profileKey('Arianne Escabillas')]=await hashProfilePassword('dev-pass-1');PROFILE_HASHES[profileKey('Ea On')]=await hashProfilePassword('agent-pass')})()");
      A.run("ME={role:null,name:''};LP={v:'verify',name:'Ea On'};document.getElementById('lp-pw').value='dev-pass-1'");
      await A.run('lpVerify()');
      check('the Developer password opens any password-protected profile (maintenance)', A.run('ME.name') === 'Ea On');
      A.run("ME={role:null,name:''};LP={v:'verify',name:'Ea On'};document.getElementById('lp-pw').value='wrong'");
      await A.run('lpVerify()');
      check('a wrong password still does not open it', A.run('ME.name') === '');
    } else check('developer access code is present (no crypto in this test runner)', htmlSrc.includes('async function devKeyOk(v)') && htmlSrc.includes("if(await devKeyOk(v)){note('Opened with developer access')"));
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe()");
  }
  // ---------- Nov 17 (e): monthly shift schedule, attendance, Absent ----------
  {
    const attTxtCheck = () => true;
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Ms Amy', -120, 300), ag('Ms Ben', -120, 300), ag('Ms Cy', -540, -30)]) + ';STAFF.forEach(p=>p.sch=mkSch(p));ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false;CASES.length=0;RGH={}');
    const tk = A.run('dkey(wall(simNow()))');
    check('a day with no monthly value follows the weekly pattern', A.run("onShiftAt(pers('Ms Amy'),simNow())") === true);
    A.run(`pers('Ms Amy').msch={'${tk}':'OFF'}`);
    check('the monthly schedule decides the day: OFF today means not on shift', A.run("onShiftAt(pers('Ms Amy'),simNow())") === false);
    A.run(`pers('Ms Amy').msch={'${tk}':'Absent'}`);
    check('Absent is a schedule value: not on shift, gets no cases', A.run("onShiftAt(pers('Ms Amy'),simNow())") === false && A.run("parseCell('absent')") === 'Absent' && A.run("cellCls('Absent')").includes('7a1f3d'));
    A.run(`delete pers('Ms Amy').msch`);
    // monthly upload (Excel read stubbed: the sheet as rows)
    A.run(`window.__X=window.XLSX;XLSX={utils:{sheet_to_json:ws=>ws.aoa}};window.__wb={SheetNames:['PET Team'],Sheets:{'PET Team':{aoa:[['PET Team — Monthly Shift Schedule','Month: 2026-12'],['legend'],['Name',...Array.from({length:31},(_,i)=>'2026-12-'+String(i+1).padStart(2,'0'))],['',...Array.from({length:31},()=>'Mon')],['Amy, Ms',...Array.from({length:31},(_,i)=>i%7===5||i%7===4?'OFF':'14:00-23:00')],['Dee New',...Array.from({length:31},(_,i)=>i===2?'absent':'06:00-15:00')]]}}}`);
    const mr = J(A.run("JSON.stringify((()=>{const r=monthRows(__wb);return{n:r.out.length,names:r.out.map(x=>x.name),d3:r.out[1].m['2026-12-03'],k:r.keys.length}})())"));
    check('the monthly template is read: names, every date of the month, Absent', mr.n === 2 && mr.names.join() === 'Ms Amy,Dee New' && mr.d3 === 'Absent' && mr.k === 31, JSON.stringify(mr));
    A.run("applyMonth(monthRows(__wb));XLSX=__X");
    check('upload keeps each person\'s days by date and shows that month', A.run("pers('Ms Amy').msch['2026-12-01']") === '14:00-23:00' && A.run("pers('Dee New').msch['2026-12-03']") === 'Absent' && A.run('SCH_M') === '2026-12');
    check('the weekly pattern is derived from the month (fallback for days without a monthly value)', A.run("pers('Ms Amy').sch.filter(v=>v==='14:00-23:00').length") === 5);
    A.run("setTabTo('shift')");
    const sb = String(A.els['set-body'].innerHTML);
    check('the Shift Schedule shows the whole month (1–31) with month navigation', sb.includes('Shift Schedule · Monthly') && sb.includes('type="month" value="2026-12"') && sb.includes('>31<br>Thu<') && sb.includes("sSetD("));
    A.run("sSetD(STAFF.findIndex(p=>p.name==='Dee New'),'2026-12-04','pto')");
    check('editing one day of the month saves it by date', A.run("pers('Dee New').msch['2026-12-04']") === 'PTO');
    // region backtracked from the monthly schedule
    A.run("pers('Ms Amy').msch=Object.assign({},pers('Ms Amy').msch,{'2026-10-05':'14:00-23:00','2026-10-06':'14:00-23:00','2026-11-05':'06:00-15:00','2026-11-06':'06:00-15:00'})");
    check('the region of an earlier month comes from that month\'s schedule (EMEA in December/October, APJ in November)', A.run("regionAt('Ms Amy',new Date('2026-10-10T12:00:00').getTime())") === 'EMEA' && A.run("regionFor('Ms Amy',new Date('2026-11-01T00:00:00').getTime(),new Date('2026-11-30T23:00:00').getTime())") === 'APJ');
    // attendance: not logged in by the start = Absent (no cases); logging in clears it (late)
    A.run('STAFF=' + JSON.stringify([ag('At Amy', -120, 300), ag('At Ben', -120, 300), ag('At Cy', -540, -30)]) + ";STAFF.forEach(p=>p.sch=mkSch(p));ensureMgrs(STAFF);window.__db=DBON;window.__ga=GOT.att;DBON=true;GOT.att=1;ATT_SINCE=Date.now()-45*864e5;ATT={};ATT[attId('At Ben',dkey(wall(Date.now())))]={in:Date.now()-150*6e4}");
    check('an agent on shift who has not logged in to PAT is Absent and gets no cases', A.run("isAbsentNow(pers('At Amy'),simNow())") === true && A.run("onlineAgents(simNow()).map(p=>p.name).join()") === 'At Ben' && A.run("coverFor(simNow(),null,undefined,true)") === 'At Ben');
    A.run("render()");
    check('Agent Status shows Absent', String(A.els['agent-list'].innerHTML).includes('>Absent</span>'));
    A.run("ME={role:'agent',name:'At Amy'};applyMe();recordAtt()");
    check('logging in records the time and removes Absent (late after the start)', A.run("isAbsentNow(pers('At Amy'),simNow())") === false && A.run("onlineAgents(simNow()).some(p=>p.name==='At Amy')") === true && A.run("ATT[attId('At Amy',dkey(wall(Date.now())))].late") >= 119);
    // Nov 23 fix: the log-in is also recorded when the attendance list arrives after signing in, or when already signed in from before
    A.run("window.__k=attId('At Amy',dkey(wall(Date.now())));delete ATT[__k];ATTPEND.clear();delete ATT_MINE[__k];GOT.att=0;ATT_FROM=Date.now()-100*6e4;ME={role:'agent',name:'At Amy'};applyMe();SAVED_PENDING=false;window.__r=recordAtt()");
    // Nov 25: the agent's screen no longer waits for the attendance list (it checks the saved record of the shift itself)
    check('signed in before the attendance list loaded: the log-in is recorded at once (no waiting for the list)', A.run('__r') === true && !!A.run('ATT[__k]&&ATT[__k].in'));
    A.run("GOT.att=1");
    A.run("attKeep()");
    check('... with the time the agent signed in (not the time of the check)', A.run("Math.abs(ATT[__k].in-ATT_FROM)<1000") === true && A.run("ATT[__k].late") >= 19 && A.run("ATT[__k].late") <= 21 && A.run("isAbsentNow(pers('At Amy'),simNow())") === false, A.run("JSON.stringify(ATT[__k])"));
    check('the check also runs every 20 s while signed in and when the attendance list changes', htmlSrc.includes('setInterval(attKeep,20000)') && htmlSrc.includes('ATT=attMerge(m);attKeep();render()'));
    check('the live attendance copy holds only the last 3 days (small, quick on every screen); older days are read in the background', htmlSrc.includes("ATT_UNSUB=dbq.collection('att').where('ts','>=',ATT_LIVE_FROM).limit(5000).onSnapshot(") && !htmlSrc.includes("dbq.collection('att').where('ts','>=',Date.now()-100*864e5).limit(20000).onSnapshot(") && htmlSrc.includes("where('ts','<',to).limit(20000).get()"));
    A.run("window.__ah=[ATT_HIST,GOT.atth,ATT_LIVE,ATT_LIVE_FROM];ATT_HIST={'zz_old':{n:'x',in:1}};ATT_LIVE={'zz_new':{n:'y',in:2}};window.__m=attMerge(ATT_LIVE)");
    check('... both are combined (older days + live days)', A.run("!!(__m.zz_old&&__m.zz_new)") === true);
    A.run("ATT_HIST=__ah[0];GOT.atth=__ah[1];ATT_LIVE=__ah[2];ATT_LIVE_FROM=__ah[3]");
    const nh = J(A.run("JSON.stringify((()=>{const g=GOT.atth,lf=ATT_LIVE_FROM,db=DBON;GOT.atth=0;DBON=true;ATT_LIVE_FROM=Date.now();const k=attId('At Ben',dkey(new Date(wall(Date.now()).getTime()-5*864e5)));const sv=ATT[k];delete ATT[k];const a=attOf('At Ben',Date.now()-6*864e5,Date.now()-4*864e5);GOT.atth=1;const b=attOf('At Ben',Date.now()-6*864e5,Date.now()-4*864e5);GOT.atth=g;ATT_LIVE_FROM=lf;DBON=db;if(sv)ATT[k]=sv;return{a:a.abs,b:b.abs}})())"));
    check('... an older day is never counted Absent just because the older days have not been read yet', nh.a === 0 && nh.b >= 1, JSON.stringify(nh));
    // Nov 24 fix: a log-in whose save did not get through is tried again (it used to count as done until a reload)
    A.run("window.__k2=attId('At Amy',dkey(wall(Date.now())));window.__amy=ATT[__k2];window.__amyM=ATT_MINE[__k2];delete ATT[__k2];ATTPEND.clear();delete ATT_MINE[__k2];ATT_OK.delete(__k2);window.__dq=dbq;window.__sets=0;window.__fail=true;window.__wait=[];dbq={doc:id=>({get:()=>Promise.resolve({exists:false}),set:d=>{__sets++;return __fail?Promise.reject(new Error('offline')):Promise.resolve()},onSnapshot(){}}),collection:()=>__dq.collection()};ME={role:'agent',name:'At Amy'};applyMe();SAVED_PENDING=false;GOT.att=1;window.__db0=DBON;DBON=true;recordAtt()");
    await sleep(100);
    check('a log-in whose save failed is not counted as saved', A.run('__sets') >= 1 && A.run('ATT_OK.has(__k2)') === false && !!A.run('ATT[__k2]&&ATT[__k2].in'));
    const tin1 = A.run('ATT[__k2].in');
    A.run("__fail=false;attKeep()"); await sleep(100);
    check('... and is saved on the next check (every 20 s), with the same log-in time', A.run('ATT_OK.has(__k2)') === true && A.run('ATT[__k2].in') === tin1);
    const s2 = A.run('__sets');
    A.run('attKeep()'); await sleep(50);
    check('... then not written again', A.run('__sets') === s2);
    // Nov 24 (17:30): after a reload with the saved sign-in, the time the agent signed in is kept when the page was open until just now
    const fr = J(A.run(`JSON.stringify((()=>{ME={role:'agent',name:'At Amy'};const n=Date.now(),sa=n-95*6e4;localStorage.setItem('pet_signed_in_at',String(sa));localStorage.setItem('pat_seen_'+seenK(),String(n-40000));const a=attFromRestore();localStorage.setItem('pat_seen_'+seenK(),String(n-30*6e4));const b=attFromRestore();return{a:a-sa,b:Math.abs(b-n)<5000}})())`));
    check('after a reload / reopen with the saved sign-in, the log-in time is when the agent signed in (page open until just now)', fr.a === 0, JSON.stringify(fr));
    check('... and now when the page had been closed for a while (they just came back)', fr.b === true, JSON.stringify(fr));
    A.run("SEEN['Old Page']=undefined");
    check('sign-in notes from a page on the older version (no "since") count from the first note of an unbroken run', htmlSrc.includes("since:+v.since||(o&&ts-o.ts<15*6e4?o.since:ts)"));
    // second source: the sign-in notes, read on the hand-over screen
    A.run("delete ATT[__k2];ATT_OK.delete(__k2);ME={role:'manager',name:'Jeff Bote'};applyMe();SEENSUB=true;GOT.seen=1;SEEN['At Amy']={ts:Date.now()-60000,since:Date.now()-30*6e4};window.__ao2=ATT_OFF;ATT_OFF=false;attSeenCheck()"); await sleep(100);
    check('an agent on shift who is signed in (sign-in notes) but has no saved log-in gets it recorded from the notes', !!A.run('ATT[__k2]&&ATT[__k2].in') && A.run('ATT[__k2].src') === 'seen' && A.run('__sets') === s2 + 1 && A.run("isAbsentNow(pers('At Amy'),simNow())") === false);
    A.run("delete ATT[__k2];SEEN['At Amy']={ts:Date.now()-40*6e4,since:Date.now()-50*6e4};attSeenCheck()");
    check('... not when the notes stopped (signed out / page closed)', !A.run('ATT[__k2]'));
    A.run("delete SEEN['At Amy'];dbq=__dq;DBON=__db0;ATT_OFF=__ao2;SEENSUB=false;ATT[__k2]=__amy;ATT_MINE[__k2]=__amyM;ATT_OK.add(__k2)");
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();attEosCheck()");
    check('no log-in until EOS: the day is marked Absent automatically', A.run("attAutoAbsent(pers('At Cy'),dkey(wall(Date.now())))") === true);
    const at = J(A.run("JSON.stringify(['At Amy','At Ben','At Cy'].map(n=>{const a=attOf(n,fromLI(ymd(wall(Date.now()))+'T00:00'),Date.now());return{n,sch:a.sch,pres:a.pres,late:a.late,abs:a.abs}}))"));
    check('attendance is matched with the schedule: present / late / absent', at[0].pres === 1 && at[0].late === 1 && at[1].pres === 1 && at[1].late === 0 && at[2].abs === 1, JSON.stringify(at));
    // Nov 23: late lowers attendance; log-in times in 24-hour format
    const lr = J(A.run("JSON.stringify((()=>{const a=attOf('At Amy',fromLI(ymd(wall(Date.now()))+'T00:00'),Date.now()),b=attOf('At Ben',fromLI(ymd(wall(Date.now()))+'T00:00'),Date.now());return{a:attPct(a),cr:a.cr,b:attPct(b),x:a.list[0]}})())"));
    check('a late log-in lowers attendance (only the part of the shift logged in counts); on time stays 100%', lr.a < 100 && lr.a > 0 && lr.cr < 1 && lr.b === 100 && lr.x.cr === lr.cr, JSON.stringify(lr));
    // Nov 23: report builder: running SLA from the current MW start, last / next action from the checklist
    const rb = J(A.run(`JSON.stringify((()=>{const n=Date.now(),c={id:'rbx',items:[{text:'Call store',rem:{at:n-7e6,done:{at:n-6e6,by:'Ana',text:'ok'}}},{text:'Confirm CE',rem:{at:n-3e6,done:{at:n-2e6,by:'Ben',text:'ok'}}},{text:'Check part',rem:{at:n+36e5}},{text:'Other',done:true}],mw:{s:n+(2*1440+5*60+30)*6e4+30000,e:n+4*864e5},mwUp:[]};
      const later={...c,mw:{s:n-(27*60+5)*6e4-30000}},closed={...c,closed:true,closedAt:n-60*6e4};
      return{run:RF('slaRun').g(c),ns:RF('slaRun').g(later),cl:RF('slaRun').g(closed),none:RF('slaRun').g({items:[]}),last:RF('lastAct').g(c),next:RF('nextAct').g(c),nextCl:RF('nextAct').g(closed),due:RF('nextDue').g(c),dueX:xdt(n+36e5),dueCl:RF('nextDue').g(closed),
        upd:RF('slaRun').g({...c,mwUp:[{s:n+90*6e4+30000}]})}})())`));
    check('SLA column = time left from the moment the report is extracted until the current maintenance window starts (days and hours:minutes)', rb.run === '2d 05:30 left' && rb.ns === 'Started 1d 03:05 ago' && rb.none === 'No maintenance window data' && rb.upd === '0d 01:30 left', JSON.stringify(rb));
    check('... a closed case is counted at its closing time', rb.cl === '2d 06:30 left (at closing)', rb.cl);
    // Nov 24: the hand-over batch is set in Settings; the Account Name column can show the actual account name
    A.run("window.__hb=HO_BATCH;hoqSet(3)");
    check('the number of cases per agent every hour can be changed in Settings (Shift Schedule)', A.run('HO_BATCH') === 3 && A.run("hoqSetHtml(false)").includes('value="3"') && A.run("setTabTo('shift');document.getElementById('set-body').innerHTML.includes('Cases given to each available agent every hour')") === true);
    A.run("hoqSet(0);hoqSet(999)");
    check('... only 1 to 50 is accepted', A.run('HO_BATCH') === 3);
    A.run("HO_BATCH=__hb;clearTimeout(HOQ_T)");
    {
      const cells2 = {}; const mk2 = k => cells2[k] || (cells2[k] = {});
      const xl0 = A.ctx.ExcelJS, sb0 = A.ctx.saveBlob;
      A.ctx.ExcelJS = { Workbook: function () { this.addWorksheet = () => ({ getColumn: () => ({}), getCell: (r, c) => mk2(r + ':' + c), mergeCells() {}, getRow: r => ({ getCell: c => mk2(r + ':' + c), set height(v) {} }) }); this.xlsx = { writeBuffer: async () => new Uint8Array([1]) }; } };
      A.ctx.saveBlob = () => {};
      A.run("window.__rc=CASES.slice();window.__rf=[RPT.from,RPT.to,RPT.account,RPT.type,RPT.status];CASES.length=0;CASES.push(mkCase('AC-1','Haina Azuela',{account:'Acct P',recv:Date.now()-2000}),mkCase('AC-2','Haina Azuela',{account:'Acct Q',recv:Date.now()-1000}));CASES[0].store='1234';CASES[1].store='N/A';RPT.from=RPT.to=ymd(wall(Date.now()));RPT.account='all';RPT.type='all';RPT.status='all';window.__rn=window.__petRealNames;window.__petRealNames=async l=>({configured:true,map:{[acctNorm('Acct P')]:'Real P Inc',[acctNorm('Acct Q')]:'Real Q Inc'},missing:[]});RPT.cols=['account'];RPT.acctMode='store'");
      await A.run("exportXlsx('custom')");
      const st0 = [cells2['5:1'] && cells2['5:1'].value, cells2['6:1'] && cells2['6:1'].value];
      A.run("RPT.acctMode='name'"); await A.run("exportXlsx('custom')");
      const nm0 = [cells2['5:1'] && cells2['5:1'].value, cells2['6:1'] && cells2['6:1'].value];
      check('report builder: Account Name column = store number (account name if the store is N/A) by default', st0[0] === '1234' && st0[1] === 'Acct Q', JSON.stringify(st0));
      check('... or the actual account name when chosen', nm0[0] === 'Real P Inc' && nm0[1] === 'Real Q Inc', JSON.stringify(nm0));
      A.run("RPT.view='builder';setTabTo('reports')");
      check('... the choice is in the report builder and saved with a template', A.run("document.getElementById('set-body').innerHTML.includes('The actual account name')") === true && A.run("(()=>{const l=TPL.length;document.getElementById('tpl-name')?0:0;const t={id:'t1',name:'X',cols:['account'],heads:{},acctMode:'name'};TPL.push(t);RPT.acctMode='store';tplLoad('t1');const ok=RPT.acctMode==='name';TPL.splice(TPL.indexOf(t),1);return ok})()") === true);
      A.run("['AC-1','AC-2'].forEach(k=>{clearTimeout(ST[k]);ST[k]=0;PEND.delete(k)});CASES.length=0;__rc.forEach(c=>CASES.push(c));[RPT.from,RPT.to,RPT.account,RPT.type,RPT.status]=__rf;window.__petRealNames=__rn;RPT.cols=WEEKLY.slice();RPT.acctMode='store';RPT.view='weekly'");
      A.ctx.ExcelJS = xl0; A.ctx.saveBlob = sb0;
    }
    // Nov 24: next action = the item added last to the checklist (any day), last action = the item added before it
    const ra = J(A.run(`JSON.stringify((()=>{const n=Date.now(),D=864e5,c={id:'rby',items:[{text:'Call store',at:n-3*D,by:'Ana'},{text:'Confirm CE',at:n-2*D,by:'Ben',done:true,rem:{at:n-2*D,done:{at:n-2*D}}},{text:'Check part',at:n-D,by:'Cy',rem:{at:n+36e5}}]},
      tpl={id:'rbz',items:[{text:'First'},{text:'Second'}]},one={id:'rb1',items:[{text:'Only',at:n}]},done={...c,items:c.items.slice(0,2)};
      return{last:RF('lastAct').g(c),lastX:'Confirm CE (added '+xdt(n-2*D)+' by Ben)',next:RF('nextAct').g(c),nextCl:RF('nextAct').g({...c,closed:true}),due:RF('nextDue').g(c),dueX:xdt(n+36e5),dueCl:RF('nextDue').g({...c,closed:true}),
        tl:RF('lastAct').g(tpl),tn:RF('nextAct').g(tpl),ol:RF('lastAct').g(one),on:RF('nextAct').g(one),dn:RF('nextAct').g(done),dd:RF('nextDue').g(done)}})())`));
    check('next action = the item added last to the checklist (even added on another day); none once closed', ra.next === 'Check part' && ra.nextCl === '' && ra.tn === 'Second' && ra.on === 'Only' && ra.dn === 'Confirm CE', JSON.stringify(ra));
    check('last action = the item added before it (with when and by whom it was added)', ra.last === ra.lastX && ra.tl === 'First' && ra.ol === '', JSON.stringify(ra));
    check('next action due time = the reminder time of that last item (empty when it has none open)', ra.due === ra.dueX && ra.dueCl === '' && ra.dd === '', JSON.stringify(ra));
    check('the four columns can be added in the report builder', ['slaRun','lastAct','nextAct','nextDue'].every(k=>A.run(`!!RF('${k}')`)));
  // ---------- Hand-over queue (Nov 24) ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
    const st = l => A.run('STAFF=' + JSON.stringify(l) + ';ensureMgrs(STAFF);STAFFLOADED=true');
    const L = n => A.run(`CASES.filter(c=>!c.closed&&c.owner===${JSON.stringify(n)}).length`);
    const ago = (n, min) => A.run(`CASES.forEach(c=>{(c.ownh||[]).forEach((x,i,a)=>{if(i&&a[i-1].n===HOQ&&x.n===${JSON.stringify(n)})x.at-=${min}*6e4})})`);
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();window.__ao=ATT_OFF;ATT_OFF=true;window.__stf=STAFF;window.__cs=CASES.slice();window.__me=ME");   // log-ins are not part of these checks; the schedule and cases are put back after
    st([ag('Hq Gail', -540, -5), ag('Hq Amy', -100, 300), ag('Hq Ben', -100, 300)]);
    A.run("CASES.length=0;for(let i=0;i<12;i++)CASES.push(mkCase('HQ-'+String(i).padStart(2,'0'),'Hq Gail',{}))");
    A.run('eosCheck()');
    check('Hand-over queue: at EOS all open cases of the leaving agent go to the hand-over queue', L('Hq Gail') === 0);
    check('... each available agent gets 5 at once (12 cases, 2 agents: 5 + 5, 2 wait in the queue)', L('Hq Amy') === 5 && L('Hq Ben') === 5 && L(A.run('HOQ')) === 2, [L('Hq Amy'), L('Hq Ben'), L('Hand-over Queue')].join());
    check('... the case history shows the move to the queue and the assignment from it', A.run("CASES.filter(c=>c.owner==='Hq Amy').every(c=>c.log.some(l=>/moved to the hand-over queue/.test(l.details||''))&&c.log.some(l=>String(l.details||'').includes('Hand-over queue: case assigned to Hq Amy (from Hq Gail)')))") === true, A.run("JSON.stringify(CASES.find(c=>c.owner==='Hq Amy').log.map(l=>l.details))"));
    A.run('eosCheck()');
    check('... no second batch before the hour is up', L('Hq Amy') === 5 && L('Hq Ben') === 5 && L('Hand-over Queue') === 2);
    ago('Hq Amy', 61); ago('Hq Ben', 61); A.run('eosCheck()');
    check('... another batch an hour later (the 2 left go out)', L('Hand-over Queue') === 0 && L('Hq Amy') + L('Hq Ben') === 12 && Math.abs(L('Hq Amy') - L('Hq Ben')) <= 0, [L('Hq Amy'), L('Hq Ben')].join());
    check('... the queue owner is never counted as a person (productivity, misses)', A.run("QN(HOQ)&&!credsOf(CASES[0]).some(x=>x.n===HOQ)") === true);
    // priority: high priority, then past due (most overdue first), then nearest due, then the rest
    st([ag('Hq Gail', -540, -5), ag('Hq Cy', -100, 300)]);
    A.run(`CASES.length=0;(()=>{const n=Date.now(),mk=(id,o)=>{const c=mkCase(id,'Hq Gail',{});c.items.forEach(i=>i.rem=null);if(o.hp)c.hp=true;if(o.due!=null)c.items[0].rem={at:n+o.due*6e4};CASES.push(c)};
      mk('P-none',{});mk('P-late',{due:300});mk('P-soon',{due:20});mk('P-od1',{due:-10});mk('P-od2',{due:-90});mk('P-hp',{hp:1});mk('P-hp2',{hp:1,due:600});mk('P-none2',{})})()`);
    A.run('eosCheck()');
    check('Hand-over queue: high priority first, then past due (most overdue first), then nearest due', A.run("CASES.filter(c=>c.owner==='Hq Cy').map(c=>c.id).sort().join()") === ['P-hp', 'P-hp2', 'P-od1', 'P-od2', 'P-soon'].sort().join() && A.run("hoqList().map(c=>c.id).join()") === 'P-late,P-none,P-none2', A.run("CASES.filter(c=>c.owner==='Hq Cy').map(c=>c.id).join()") + ' | ' + A.run("hoqList().map(c=>c.id).join()"));
    check('... the order of the queue', A.run("(()=>{const l=CASES.slice().sort(hoqCmp(Date.now())).map(c=>c.id);return l.slice(0,5).join()})()") === 'P-hp2,P-hp,P-od2,P-od1,P-soon' || A.run("(()=>{const l=CASES.slice().sort(hoqCmp(Date.now())).map(c=>c.id);return l.slice(0,5).join()})()") === 'P-hp,P-hp2,P-od2,P-od1,P-soon', A.run("CASES.slice().sort(hoqCmp(Date.now())).map(c=>c.id).join()"));
    // a newly available agent gets 5 at once; nobody online: the cases wait in the queue
    st([ag('Hq Gail', -540, -5), ag('Hq Dee', -100, 300, 'unavailable')]);
    A.run("CASES.length=0;for(let i=0;i<7;i++)CASES.push(mkCase('HW-'+i,'Hq Gail',{}))");
    A.run('eosCheck()');
    check('Hand-over queue: nobody available: the cases wait in the queue (not with the leaving agent)', L('Hand-over Queue') === 7 && L('Hq Gail') === 0);
    A.run("STAFF.find(p=>p.name==='Hq Dee').status='available';eosCheck()");
    check('... an agent who becomes available gets 5 straight away', L('Hq Dee') === 5 && L('Hand-over Queue') === 2);
    // no agent-to-agent balancing any more
    st([ag('Hq Dee', -100, 300), ag('Hq Eve', -100, 300)]);
    check('... cases are no longer moved from one agent to another when someone becomes available', A.run("balanceOnSignIn('Hq Eve')") === 0 && L('Hq Dee') === 5);
    A.run('eosCheck()');
    check('... she gets her batch from the queue instead', L('Hq Eve') === 2 && L('Hand-over Queue') === 0);
    // hand-over by hand goes to the queue too
    st([ag('Hq Fay', -480, 30), ag('Hq Gus', -100, 300)]);
    A.run("CASES.length=0;for(let i=0;i<3;i++)CASES.push(mkCase('HM-'+i,'Hq Fay',{}));ME={role:'agent',name:'Hq Fay'};applyMe();xferAll();xferAll()");
    check('Hand-over queue: an agent handing over before EOS sends the cases to the queue', L('Hq Fay') === 0 && L('Hand-over Queue') === 3);
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();eosXferRender()");
    check('... the queue is shown with how many cases are waiting', String(A.els['eos-xfer'] ? A.els['eos-xfer'].innerHTML : A.run("document.getElementById('eos-xfer').innerHTML")).includes('Hand-over queue: 3 cases waiting'));
    A.run('eosCheck()');
    check('... and they go out from the queue', L('Hq Gus') === 3);
    // Nov 24: Hand-over Queue in the transfer options
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();window.__na=needApproval;needApproval=()=>false;CASES.push(mkCase('HT-1','Hq Gus',{}));openId='HT-1';renderCase()");
    check('Hand-over queue: it is in the transfer options of a case', String(A.els['case-body'].innerHTML).includes('<option value="Hand-over Queue"'));
    A.run("doTransfer('HT-1',HOQ)");
    check('... transferring a case there moves it to the queue (who sent it is kept, logged in Case History)', A.run("getCase('HT-1').owner") === 'Hand-over Queue' && A.run("getCase('HT-1').hoq.from") === 'Hq Gus' && A.run("getCase('HT-1').log.some(l=>/Moved to the hand-over queue by/.test(l.details||''))") === true);
    A.run("openId=null;CASES.push(mkCase('HT-2','Hq Gus',{}));SELX={ids:new Set(['HT-2']),to:HOQ};bulkGo()");
    check('... also when several ticked cases are transferred at once', A.run("getCase('HT-2').owner") === 'Hand-over Queue');
    // Nov 24 (18:20): an agent on a day off never gets a case, also not by a manual transfer
    A.run("(()=>{const o=J(STAFF.find(p=>p.name==='Hq Gus'));o.name='Hq Offday';o.msch={};o.msch[dkey(wall(Date.now()))]='OFF';o.msch[dkey(dayBefore(wall(Date.now())))]='OFF';STAFF.push(o);const q=J(o);q.name='Hq Ptoday';q.msch={};q.msch[dkey(wall(Date.now()))]='PTO';q.msch[dkey(dayBefore(wall(Date.now())))]='OFF';STAFF.push(q)})();CASES.push(mkCase('HO-1','Hq Gus',{}));CASES.push(mkCase('HO-2','Hq Gus',{}));doTransfer('HO-1','Hq Offday');doTransfer('HO-2','Hq Ptoday')");
    check('a manual transfer to an agent whose day is OFF or PTO is refused (the case stays)', A.run("getCase('HO-1').owner") === 'Hq Gus' && A.run("getCase('HO-2').owner") === 'Hq Gus' && A.run("dayOff(pers('Hq Offday'))") === true);
    A.run("SELX={ids:new Set(['HO-1']),to:'Hq Offday'};bulkGo()");
    check('... also when several ticked cases are transferred', A.run("getCase('HO-1').owner") === 'Hq Gus');
    A.run("reassign(getCase('HO-1'),'Hq Offday','test','System')");
    check('... and never by any automatic move either', A.run("getCase('HO-1').owner") === 'Hq Gus');
    A.run("getCase('HO-1').xreq={to:'Hq Offday',by:'Hq Gus',at:Date.now()};window.__sm=SIMON;SIMON=true;xreqApprove('HO-1');SIMON=__sm");
    check('... an approved transfer request to that agent leaves the case where it is (logged)', A.run("getCase('HO-1').owner") === 'Hq Gus' && A.run("getCase('HO-1').log.some(l=>/is off today/.test((l.details||'')+(l.by||'')))") === true, A.run("JSON.stringify(getCase('HO-1').log.slice(0,3).map(l=>l.action+': '+l.details))"));
    A.run("openId='HO-1';renderCase()");
    check('... the agent shows as "(day off)" and cannot be picked in the transfer list', /<option value="Hq Offday"[^>]*disabled[^>]*>[^<]*\(day off\)/.test(String(A.els['case-body'].innerHTML)));
    A.run("openId=null;doTransfer('HO-1','Hq Gus2')");
    check('agents on shift can still receive manual transfers', A.run("(()=>{const o=J(pers('Hq Gus'));o.name='Hq Onshift';STAFF.push(o);doTransfer('HO-1','Hq Onshift');return getCase('HO-1').owner})()") === 'Hq Onshift');
    A.run("STAFF=STAFF.filter(p=>!['Hq Offday','Hq Ptoday','Hq Onshift'].includes(p.name))");
    A.run("needApproval=__na");
    check('new cases still go round robin to the agents online (unchanged)', A.run("coverFor(simNow(),null,undefined,true)") === 'Hq Gus');
    // the sender is only skipped during the same shift: a case open for days that every agent already had still goes out
    st([ag('Hq Fay', -100, 300)]);
    A.run("CASES.length=0;(()=>{const c=mkCase('HB-1','Hq Fay',{});c.owner=HOQ;c.hoq={from:'Hq Fay',at:Date.now()-60000};c.ownh=['Hq Amy','Hq Ben','Hq Fay',HOQ].map((n,i)=>({n,at:Date.now()-(4-i)*864e5}));CASES.push(c)})();eosCheck()");
    check('the agent who sent a case to the queue does not get it back in that same shift', L('Hand-over Queue') === 1 && A.run("hoqBlocked(getCase('HB-1'),pers('Hq Fay'))") === true);
    A.run("getCase('HB-1').hoq.at=Date.now()-2*864e5;eosCheck()");
    check('... but from their next shift on they can (a case open for days that every agent already had still goes out)', A.run("getCase('HB-1').owner") === 'Hq Fay', A.run("getCase('HB-1').owner"));
    A.run("Object.keys(ST).filter(k=>/^(HQ|P|HW|HM|HB|HT|HO)-/.test(k)).forEach(k=>{clearTimeout(ST[k]);ST[k]=0;PEND.delete(k)})");   // these test cases are not saved
    A.run('ATT_OFF=__ao;STAFF=__stf;CASES.length=0;__cs.forEach(c=>CASES.push(c));ME=__me;applyMe()');
  }
    check('54 min late on a 9-hour shift counts 90%', A.run('attCr(54,540)') === 0.9 && A.run('attCr(600,540)') === 0 && A.run('attCr(0,540)') === 1);
    check('log-in times are shown in 24-hour format like the schedule', /^\d{2}:\d{2}$/.test(A.run("attTime(fromLI(ymd(wall(Date.now()))+'T21:07'),ymd(wall(Date.now())))")) && A.run("attTime(fromLI(ymd(wall(Date.now()))+'T21:07'),ymd(wall(Date.now())))") === '21:07' && A.run("attTime(0)") === '—');
    check('the attendance list and its Excel sheet use the 24-hour time', htmlSrc.includes("${td(attTime(x.in,x.k)+(x.st==='Late'?") && htmlSrc.includes("x.in?attTime(x.in,x.k)+(x.st==='Late'?' LATE':''):''"));
    check('a LATE tag is shown beside a late log-in time (list and Excel)', htmlSrc.includes('font-bold text-amber-700\\">LATE</span>') || htmlSrc.includes('font-bold text-amber-700">LATE</span>'));
    A.run("ATT_SINCE=Date.now()-2*864e5");
    const gm = J(A.run("JSON.stringify(['At Amy','At Cy'].map(n=>{const a=attOf(n,fromLI(ymd(wall(Date.now()))+'T00:00'),Date.now());return{sch:a.sch,pres:a.pres,abs:a.abs}}))"));
    check('the month attendance was set up in counts every scheduled shift as present (100%) except Absent on the schedule', gm[0].pres === 1 && gm[1].pres === 1 && gm[1].abs === 0 && attTxtCheck(), JSON.stringify(gm));
    A.run(`pers('At Cy').msch={[dkey(wall(Date.now()))]:'Absent'}`);
    check('an Absent tag on the schedule still counts as absent in that month', J(A.run("JSON.stringify(attOf('At Cy',fromLI(ymd(wall(Date.now()))+'T00:00'),Date.now()))")).abs === 1);
    A.run(`delete pers('At Cy').msch;ATT_SINCE=Date.now()-45*864e5`);
    A.run("RPT.view='perf';rptDays(1,true);setTabTo('reports')");
    const pb = String(A.els['set-body'].innerHTML);
    check('the productivity report shows attendance (per agent, in the full table and as a list)', pb.includes('>Attendance</th>') && pb.includes('Scheduled shifts') && pb.includes('🕘 Attendance (') && pb.includes('Absent'));
    check('the Excel file has an Attendance sheet', htmlSrc.includes("xlSheet(wb,sub,'Attendance'"));
    const S = r => J(A.run(`JSON.stringify(scRows({rows:[${JSON.stringify(r)}]}).map(x=>({s:x.score,rt:x.rt,we:x.we})))`))[0];
    const base = { n: 'X', rg: 'APJ', nw: 6, nwU: 6, ho: 4, hoU: 4, upN: 6, upO: 4, closed: 0, miss: 1, ackMs: 600000, ackN: 1, maxMs: 0, open: 0, act: 5, att: { sch: 20, pres: 19, late: 1, lateMin: 10, abs: 1, list: [] } };
    check('attendance is a scorecard KPI (15%): 95% is rated 4', S(base).rt.att === 4 && S(base).we.att === 15 && A.run("SCW.reduce((a,m)=>a+m.w,0)") === 100);
    check('100% attendance is rated 5, under 80% is rated 1', S({ ...base, att: { sch: 20, pres: 20, late: 0, abs: 0, list: [] } }).rt.att === 5 && S({ ...base, att: { sch: 10, pres: 7, late: 0, abs: 3, list: [] } }).rt.att === 1);
    A.run("DBON=__db;GOT.att=__ga;ATT={};ATT_SINCE=0;RPT.view='weekly';SCH_M=''");
  }
  // ---------- Nov 17 (f): follow-through, store number, quiet alerts, coordinator on duty, robust drawing ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Cd Amy', -120, 300), ag('Cd Ben', -120, 300), ag('Cd Coord', -120, 300), ag('Cd Coord2', -120, 300), ag('Joerolyn Franquelli', -120, 300)]) + ";STAFF.forEach(p=>p.sch=mkSch(p));ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false;CASES.length=0;RGH={};COORDS.push('Cd Coord','Cd Coord2');COD={cur:null,hist:[]};QUIET=null;rptDays(7,true);RPT.account='all';RPT.type='all'");
    // follow-through = productivity ÷ received
    A.run("(()=>{const n=Date.now();for(let i=0;i<4;i++){const c=mkCase('FT-'+i,'Cd Amy',{});c.credit={n:'Cd Amy',at:n-3600000};if(i<2)c.wk={'Cd Amy':[n-1800000]};CASES.push(c)}})()");
    check('follow-through = total productivity ÷ total cases received (2 updated of 4 = 50%)', A.run("Math.round(ftOf(perfData().rows.find(r=>r.n==='Cd Amy'))*100)") === 50 && A.run("Math.round(perfScore(perfData().rows.find(r=>r.n==='Cd Amy')).rate*100)") === 50);
    // store number
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();openId='FT-0';renderCase()");
    const cb = String(A.els['case-body'].innerHTML);
    check('case details: Store number beside Account name, marked required', /Account name<\/label>[\s\S]{0,400}Store number <span class="text-red-600">\*<\/span>/.test(cb) && cb.includes('id="cd-store-mode"') && cb.includes('>N/A</option>') && cb.includes('>Type store number</option>'));
    A.run("cdSet('FT-0','store','7788');getCase('FT-0').account='Account A';openId=null");
    check('the store number is saved and logged in Case History', A.run("getCase('FT-0').store") === '7788' && A.run("getCase('FT-0').log.some(l=>l.action==='Store number updated'&&l.details==='7788')") === true);
    check('Weekly report: the Account Name column shows the store number', A.run("RF('account').g(getCase('FT-0'))") === '7788' && htmlSrc.includes("x.value=k==='account'?(kind!=='weekly'&&RPT.acctMode==='name'?realOf(cs.account):acctCol(cs)):rv(rw,k);"));
    check('Weekly report: the Account Name column stays blank when there is no store number', A.run("RF('account').g(getCase('FT-1'))") === '');
    // Nov 18: Store number dropdown: N/A or Type store number
    A.run("window.__ft2=getCase('FT-0').store;openId='FT-0';RCID='';renderCase();storeModeSet('FT-0','na')");
    check('Store number: picking N/A saves N/A (counts as filled to close)', A.run("getCase('FT-0').store") === 'N/A' && !A.run("missingFields(getCase('FT-0'))").includes('Store Number'));
    check('Weekly report: when the store number is N/A, the Account Name column shows the account name entered', A.run("RF('account').g(getCase('FT-0'))") === 'Account A');
    A.run("storeModeSet('FT-0','type')");
    check('Store number: "Type store number" shows a box to type it in (N/A cleared)', String(A.els['case-body'].innerHTML).includes('id="cd-store"') && A.run("getCase('FT-0').store") === '');
    A.run("cdSet('FT-0','store','7788');STM={};openId=null");
    check('what is being typed is kept in the browser and put back after a reload', htmlSrc.includes("document.addEventListener('input',draftInput,true)") && htmlSrc.includes('function draftRestore()') && htmlSrc.includes("try{draftRestore()}catch(e){}"));
    // quiet alerts
    A.run("ME={role:'agent',name:'Joerolyn Franquelli'};applyMe()");
    check('Joerolyn Franquelli and Jose Teves get no alarms or alert pop-ups (announcements still pop up)', A.run('quietMe()') === true && A.run("isQuiet('Jose Teves')") === true && A.run("(()=>{const ss=syncSound;syncSound=()=>{};ASND={};alertSound('rem-pop','rem',true);const a=!ASND['rem-pop'];alertSound('ann-pop','ann',false);const b=!!ASND['ann-pop'];ASND={};syncSound=ss;return a&&b})()") === true);
    A.run("ME={role:'agent',name:'Cd Amy'};applyMe()");
    check('everyone else still gets them', A.run('quietMe()') === false);
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();setTabTo('prof')");
    check('Profiles has "Quiet alerts" to change the list', String(A.els['set-body'].innerHTML).includes('🔕 Quiet alerts'));
    A.run("quietSet('Jose Teves',false)");
    check('a person can be taken off the quiet list', A.run("isQuiet('Jose Teves')") === false && A.run("isQuiet('Joerolyn Franquelli')") === true);
    // coordinator on duty
    A.run("codSet('Cd Coord')");
    check('a coordinator can be elected on duty', A.run('codName()') === 'Cd Coord');
    check('the coordinator on duty gets no cases', !A.run("pool().some(p=>p.name==='Cd Coord')") && A.run("coverFor(simNow(),null,undefined,true)") !== 'Cd Coord');
    A.run('render()');
    const al = String(A.els['agent-list'].innerHTML);
    check('Agent Status shows the aux "Coordinator on duty" and who is on duty', al.includes('>Coordinator on duty</span>') && al.includes('🎧 Coordinator on duty:'));
    A.run("ME={role:'agent',name:'Cd Coord',coord:true};applyMe()");
    check('the coordinator on duty gets every pop-up and alert', A.run('monitorAll()') === true);
    A.run("ME={role:'agent',name:'Cd Coord2',coord:true};applyMe()");
    check('a coordinator not on duty only gets alerts for their own cases (and mentions)', A.run('monitorAll()') === false);
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe()");
    check('managers still get everything', A.run('monitorAll()') === true);
    // on-duty time is left out of productivity
    A.run("(()=>{const n=Date.now();COD.cur={n:'Cd Coord',from:n-7200000,by:'x'};const a=mkCase('CO-1','Cd Ben',{});a.credit={n:'Cd Ben',at:n-9000000};a.wk={'Cd Coord':[n-3600000]};CASES.push(a);const b=mkCase('CO-2','Cd Ben',{});b.credit={n:'Cd Ben',at:n-9000000};b.wk={'Cd Coord':[n-9000000]};CASES.push(b)})()");
    check('updates made while on duty do not count for productivity (only the one before duty counts)', A.run("prodOf(perfData().rows.find(r=>r.n==='Cd Coord')||{})") === 1);
    A.run("codSet('')");
    check('ending duty puts the coordinator back in the case pool', A.run("pool().some(p=>p.name==='Cd Coord')") === true && A.run("COD.hist.some(h=>h.n==='Cd Coord'&&h.to)") === true);
    // a damaged case record cannot blank the screen
    A.run("(()=>{const c=mkCase('BAD-1','Cd Amy',{});c.items=null;c.owner=null;c.log='x';normCase(c);CASES.unshift(c)})();render()");
    check('a case saved with missing or odd fields is tidied and the screen still draws', String(A.els['agent-list'].innerHTML).includes('Cd Amy') && Array.isArray(A.run("getCase('BAD-1').items")) && A.run("typeof getCase('BAD-1').owner") === 'string');
    check('if the screen ever fails to draw, it tidies the data and draws again', htmlSrc.includes("catch(e){if(window.console)console.error('render',e);try{CASES.forEach(normCase)"));
    A.run("COORDS.splice(COORDS.indexOf('Cd Coord'),2);QUIET=null;COD={cur:null,hist:[]}");
  }
  // ---------- Nov 17 (g): monthly filter by default; productivity 100% of the average = 5 ----------
  {
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();RPT.view='weekly';rptView('perf')");
    const mon = A.run("dkey(wall(Date.now())).slice(0,7)"), today = A.run("ymd(wall(Date.now()))");
    check('Agent productivity & due misses opens on this month (1st of the month to today)', A.run('RPT.from') === mon + '-01' && A.run('RPT.to') === today && String(A.els['set-body'].innerHTML).includes('type="month" value="' + mon + '"') && String(A.els['set-body'].innerHTML).includes('This month (recommended)'));
    A.run("RPT.view='weekly';rptView('score')");
    check('the Scorecard opens on this month too', A.run('RPT.from') === mon + '-01' && String(A.els['set-body'].innerHTML).includes('Last month'));
    A.run("rptMonth(-1)");
    check('Last month selects the whole previous month', A.run('RPT.from').endsWith('-01') && A.run('RPT.from') < mon + '-01' && A.run("RPT.to") === A.run("ymd(new Date(new Date(RPT.from+'T00:00:00').getFullYear(),new Date(RPT.from+'T00:00:00').getMonth()+1,0))"));
    A.run("rptMonth(0,false,'2026-10')");
    check('a month can be picked', A.run('RPT.from') === '2026-10-01' && A.run('RPT.to') === '2026-10-31');
    const S = r => J(A.run(`JSON.stringify(scRows({rows:[${JSON.stringify(r)}]}).map(x=>x.rt.prod))`))[0];
    check('productivity per active day: 100% of the region average is the top rating (5), then 85% = 4, 70% = 3, 55% = 2', A.run("SCW.find(m=>m.k==='prod').b.join('|')") === '100% of the average or more|85–99%|70–84%|55–69%|under 55%' && A.run("band(1,[1,.85,.7,.55])") === 5 && A.run("band(.9,[1,.85,.7,.55])") === 4 && A.run("band(.6,[1,.85,.7,.55])") === 2 && A.run("band(.5,[1,.85,.7,.55])") === 1);
    A.run("RPT.view='weekly';rptWeek(0)");
  }
  // ---------- Nov 17 (h): status changes never put back an older schedule; server clock ----------
  {
    A.run(`window.__wq=wq;wq=()=>{};window.__db0=DBON;DBON=true;STAFF=[{name:'Sv Amy',role:'Support',start:'06:00',end:'15:00',days:[1,1,1,1,1,1,1],status:'available',sch:['06:00-15:00','06:00-15:00','06:00-15:00','06:00-15:00','06:00-15:00','06:00-15:00','06:00-15:00']}];ensureMgrs(STAFF);
      STAFF_DOC={list:[{name:'Sv Amy',role:'Support',start:'06:00',end:'15:00',days:[1,1,1,1,1,1,1],status:'available',sch:['OFF','14:00-23:00','14:00-23:00','14:00-23:00','14:00-23:00','14:00-23:00','OFF'],msch:{'2026-12-01':'14:00-23:00'}}],ts:1,rgh:{}};
      const p=pers('Sv Amy');p.status='unavailable';p.reason='EOS';p.reasonAt=Date.now();saveStatus('Sv Amy')`);
    const d = J(A.run('JSON.stringify(STAFF_DOC.list[0])'));
    check('a status change (EOS, Available, aux) is written onto the newest saved schedule, never this screen\'s older copy', d.status === 'unavailable' && d.reason === 'EOS' && d.msch && d.msch['2026-12-01'] === '14:00-23:00' && d.sch[1] === '14:00-23:00', JSON.stringify(d));
    A.run('wq=__wq;DBON=__db0');
    check('the automatic EOS aux, availability, aux reasons, idle sign-in and coordinator on duty all save status only', (htmlSrc.match(/saveStatus\(/g) || []).length >= 6 && !/eosAux=e;chn\.push\(p\.name\);ch=true\}\}\);\nif\(ch\)\{if\(!SIMON\)saveStaff/.test(htmlSrc));
    check('a newer schedule from another screen is never ignored because of a computer\'s clock', htmlSrc.includes("mine=!!STAFFT||STAFF_BUSY>0;if(Array.isArray(l)&&l.length)STAFF_DOC=dd;") && !htmlSrc.includes('(dd.ts||0)<STAFF_TS'));
    check('the screen that runs the hand-over is chosen on the server\'s clock', htmlSrc.includes('function eosLeader(){if(SIMON||!DBON||!dbq||!MYID)return true;if(window.__petCacheOnly)return false;const now=srvNow();') && typeof A.run('srvNow()') === 'number');
  }
  // ---------- Nov 18: COD aux, transfer several cases, cached copy after a reload ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, extra) => Object.assign({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' }, extra || {});
    A.run('window.__ss=saveStatus;saveStatus=()=>{};STAFF=' + JSON.stringify([ag('Cd Amy', -200, 300, { coord: true }), ag('Cd Ben', -200, 300), ag('Cd Cy', -200, 300)]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false;ATT_OFF=true;COD={cur:null,hist:[]};ME={role:"manager",name:"Jeff Bote"};applyMe()');
    A.run("codSet('Cd Amy')");
    check('the coordinator on duty is set to Unavailable · COD by itself', A.run("[pers('Cd Amy').status,pers('Cd Amy').reason,auxLabel(pers('Cd Amy'))].join('|')") === 'unavailable|COD|COD (coordinator on duty)');
    check('the coordinator on duty is never in the pool for new or moved cases', !A.run("pool().map(p=>p.name)").includes('Cd Amy'));
    check('even a screen that does not know about the duty leaves them out (aux COD)', A.run("(()=>{const c=COD;COD={cur:null,hist:[]};const r=pool().some(p=>p.name==='Cd Amy');COD=c;return r})()") === false);
    A.run("CASES.length=0;for(let i=0;i<6;i++)CASES.push(mkCase('CD-'+i,'Cd Ben',{}));balanceJoiners&&balanceJoiners(true)");
    check('balancing gives the coordinator on duty no case', A.run("CASES.filter(c=>c.owner==='Cd Amy').length") === 0);
    A.run("codSet('')");
    check('when the duty ends they are Available again', A.run("pers('Cd Amy').status+'|'+pers('Cd Amy').reason") === 'available|');
    A.run("codSet('Cd Amy');ME={role:'agent',name:'Cd Amy',coord:true};applyMe();window.__ap=availP;availP=()=>pers('Cd Amy');toggleAvailability();availP=__ap");
    check('the coordinator on duty cannot switch themselves back to Available', A.run("pers('Cd Amy').status") === 'unavailable');
    A.run("ME={role:'manager',name:'Jeff Bote'};applyMe();codSet('')");
    A.run("COD={cur:{n:'Cd Amy',from:Date.now()},hist:[]};pers('Cd Amy').status='available';pers('Cd Amy').reason='';pers('Cd Ben').status='unavailable';pers('Cd Ben').reason='COD';codEnforce()");
    check('a coordinator on duty still shown Available (duty set earlier or by an older screen) is switched to Unavailable · COD', A.run("pers('Cd Amy').status+'|'+pers('Cd Amy').reason") === 'unavailable|COD');
    check('someone left on aux COD who is not on duty goes back to Available', A.run("pers('Cd Ben').status+'|'+pers('Cd Ben').reason") === 'available|');
    check('the hand-over screen and the coordinator\'s own screen keep it that way', htmlSrc.includes('try{codEnforce()}catch(e){}') && htmlSrc.includes('try{codSelf()}catch(e){}'));
    A.run("COD={cur:null,hist:[]};codEnforce()");
    // transfer several cases at once
    A.run("CASES.length=0;['TX-1','TX-2','TX-3'].forEach(id=>CASES.push(mkCase(id,'Cd Ben',{})));const z=mkCase('TX-4','Cd Ben',{});z.closed=true;CASES.push(z);TAB='all';render();SELX=null;bulkOpen()");
    { const rows = A.run("$('rows').innerHTML"); const ticks = (rows.match(/onchange="selTog\('([^']+)'/g) || []).map(x => x.slice(18, -1)).sort().join();
      check('Transfer cases puts a tick box beside each open case in the list itself (not on closed ones)', ticks === 'TX-1,TX-2,TX-3' && A.run("$('sel-bar').innerHTML").includes('case(s) selected')); }
    A.run("selTog('TX-1',true);selTog('TX-2',true);selTog('TX-4',true);bulkGo('Cd Cy')");
    check('several ticked cases move to the chosen person in one go (closed ones never move)', A.run("['TX-1','TX-2','TX-3','TX-4'].map(i=>getCase(i).owner).join()") === 'Cd Cy,Cd Cy,Cd Ben,Cd Ben');
    check('after the transfer the tick boxes go away', A.run("SELX") === null && !A.run("$('rows').innerHTML").includes('selTog('));
    A.run("bulkOpen();selPage(true)");
    check('"Select all on this page" ticks every open case shown', A.run("[...SELX.ids].sort().join()") === 'TX-1,TX-2,TX-3');
    A.run("SELX.ids.clear();selTog('TX-3',true);bulkGo('__next')");
    check('"Next available agent" picks someone for each case', A.run("getCase('TX-3').owner") !== 'Cd Ben');
    A.run("ME={role:'agent',name:'Cd Cy'};applyMe();SELX=null;bulkOpen()");
    { const rows = A.run("$('rows').innerHTML"); const ticks = (rows.match(/onchange="selTog\('([^']+)'/g) || []).map(x => x.slice(18, -1)).sort().join();
      check('an agent gets tick boxes only on their own open cases', ticks === 'TX-1,TX-2' + (A.run("getCase('TX-3').owner") === 'Cd Cy' ? ',TX-3' : '')); }
    A.run("SELX=null;TAB='active';ME={role:'manager',name:'Jeff Bote'};applyMe()");
    // Nov 18 (10:30): ownership history and the scorecard
    A.run("(()=>{const n=Date.now(),c=mkCase('OH-1','Cd Ben',{});c.log=[{ts:n-10*86400000,action:'Case created',by:'Cd Ben',details:''}];c.ts=n;c.credit=null;c.ownh=null;CASES.push(c)})()");
    check('a case never handed over counts as received when it was created, not when it was last updated', Math.abs(A.run("credOf(getCase('OH-1')).at") - (Date.now() - 10 * 86400000)) < 5000);
    A.run("reassign(getCase('OH-1'),'Cd Cy','test')");
    check('the first owner\'s entry in the ownership history starts when the case was created', Math.abs(A.run("getCase('OH-1').ownh[0].at") - (Date.now() - 10 * 86400000)) < 5000 && Math.abs(A.run("getCase('OH-1').credit.at") - (Date.now() - 10 * 86400000)) < 5000);
    A.run("(()=>{const n=Date.now(),c=mkCase('OH-2','Cd Cy',{});c.items=[{id:'r1',text:'Call the site',done:false,rem:{at:n-3600000,fired:true}}];c.ownh=[{n:'Cd Off',at:n-36000000},{n:'Cd Cy',at:n-600000}];c.credit={n:'Cd Off',at:n-36000000};CASES.push(c);STAFF.push(" + JSON.stringify(ag('Cd Off', -600, -300)) + ");ensureMgrs(STAFF)})()");
    { const e = A.run("JSON.stringify(dueEvents(1,Infinity).filter(e=>e.c.id==='OH-2').map(e=>({own:e.own,eosOf:e.eosOf,st:e.st})))");
      const x = JSON.parse(e)[0] || {};
      check('a due miss counts for whoever owned the case when the reminder fell due (not for the next owner)', x.own === 'Cd Off' && !x.eosOf && !x.st); }
    check('a late end-of-shift hand-over says when the shift ended and that nobody was available then', htmlSrc.includes('nobody was available then: case handed over to'));
    A.run("CASES.length=0;STAFF=STAFF.filter(p=>p.name!=='Cd Off')");
    // Nov 18 (11:45): reports include cases outside the 1,000 newest kept on screen, and every hand-over is logged
    A.run("(()=>{const n=Date.now(),c=caseFromDoc('OLD-9',{owner:'Cd Ben',ts:n-40*86400000,items:[]});c.log=[{ts:n-3600000,action:'Model number updated',by:'Cd Ben',details:'x',d:''}];REPCASE['OLD-9']=c;PD_CACHE.clear();CIX=null})()");
    check('reports count an older case worked on in the period even if it is not among the 1,000 newest on screen', A.run("perfCases().some(c=>c.id==='OLD-9')") && A.run("caseIndex().items.some(it=>it.c.id==='OLD-9'&&it.wd.has('Cd Ben'))"));
    A.run("delete REPCASE['OLD-9'];PD_CACHE.clear();CIX=null");
    check('a second hand-over between the same two people on the same day gets its own history line', htmlSrc.includes("+'_'+(Array.isArray(c.ownh)?c.ownh.length:0)}:null"));
    check('reports read the period day by day (no 20,000-entry cut-off) and the scorecard and Excel wait for it', htmlSrc.includes("for(let x=a0;x<=a1;x+=D)") && htmlSrc.includes("try{await Promise.race([Promise.all([loadRepAct(perfRange()[0]-21*864e5,perfRange()[1]),attHistLoad()]),new Promise(r=>setTimeout(r,20000))])}catch(e){}"));
    check('a "⇄ Transfer cases" button sits next to Add Case', htmlSrc.includes('onclick="bulkOpen()"'));
    // reload: the copy kept in the browser
    A.run("window.__petCacheOnly=true");
    check('while only the browser\'s kept copy is shown, no screen deals hand-overs', A.run("eosLeader()") === false || A.run("SIMON||!DBON") === true);
    check('... and no balancing runs on it', htmlSrc.split('STAFFLOADED&&!window.__petCacheOnly').length >= 5);
    A.run("window.__w=wq;window.__n=0;wq=()=>{__n++};window.__d=DBON;DBON=true;saveStatus=__ss;STAFF_DOC={list:J(STAFF),ts:1,rgh:{}};saveStatus('Cd Ben')");
    check('a status save waits for the server\'s copy (no older schedule written back)', A.run('__n') === 0);
    A.run("window.__petCacheOnly=false");
    await sleep(1400);
    check('then it is saved', A.run('__n') === 1, A.run('__n'));
    A.run("wq=__w;DBON=__d;ATT_OFF=false");
    check('a case field is saved within 0.25 s of a change, also while typing continues (no waiting for a pause)', htmlSrc.includes("PEND.add(c.id);if(ST[c.id])return;const one=c;ST[c.id]=setTimeout(()=>saveNow(one.id,one),250)}") && htmlSrc.includes("{try{rtSave(t)}catch(x){}}"));
    // Nov 22: a change still waiting for its 0.25 s bundle is sent at once when the page is hidden / closed
    A.run("window.__w=wq;window.__n=0;wq=()=>{__n++};window.__d=DBON;DBON=true;window.__fc={id:'zzflush',log:[],items:[],sfdc:[]};CASES.push(__fc);queueSave(__fc)");
    check('a waiting case save is not sent before its 0.25 s bundle', A.run('__n') === 0 && !!A.run('ST[__fc.id]'));
    A.run('flushSaves()');
    check('... and is sent at once when the page is hidden or closed (a reload loses no keys)', A.run('__n') === 1 && !A.run('ST[__fc.id]'));
    await sleep(400);
    check('... only once', A.run('__n') === 1);
    A.run("PEND.delete(__fc.id);SVN[__fc.id]=0");
    // IM•LOGIC messages that came in while PET was closed still go into the case history, once
    A.run("window.__wa=writeAct;window.__acts=[];writeAct=(e,id)=>__acts.push(id);window.__mt=Date.now()-3*864e5;brpLogIn([{id:'m1',pet:__fc.id,from:'IM',by:'Ana',text:'hello',ts:__mt},{id:'m0',pet:__fc.id,from:'IM',by:'Ana',text:'old',ts:Date.now()-9*864e5}])");
    check('an IM•LOGIC message from 3 days ago is written to the case history with its own time', A.run("__acts.join()") === 'brm_m1' && A.run("__fc.log.some(e=>e.action==='Message from IM•LOGIC'&&e.ts===__mt)") === true);
    A.run("ACTIDS.delete('brm_m1');brpLogIn([{id:'m1',pet:__fc.id,from:'IM',by:'Ana',text:'hello',ts:__mt}])");
    check('... and only once (also when a screen sees it again)', A.run("__acts.length") === 1);
    A.run("writeAct=__wa;wq=__w;DBON=__d;CASES.splice(CASES.indexOf(__fc),1)");
    check('an unsent IM•LOGIC message is kept like other unfinished entries', A.run("DFT_IDS.includes('brp-in')") === true);
    check('incoming copies of a case are held back until every save of it is done (no flicker back to an older value)', htmlSrc.includes("function pendDone(id){if(SVN[id]>0)SVN[id]--;if(ST[id]||SVN[id]>0)return;PEND.delete(id);"));
    check('managers and coordinators get "⬇ Download all data (Excel)" in Reports: every collection, one formatted file', htmlSrc.includes("btn('⬇ Download all data (Excel)','exportAll()'") && htmlSrc.includes("async function exportAll(){if(!isLead())") && htmlSrc.includes("'exportAll']]"));
    check('while the first data loads the counters stay empty (no 0, no loading sign)', htmlSrc.includes("${loadingNow?'&nbsp;':num}"));
  }
  // ---------- Nov 19: CSR only, COD approval of manual transfers, passwords, drafts ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, extra) => Object.assign({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' }, extra || {});
    A.run('STAFF=' + JSON.stringify([ag('Xr Amy', -200, 300, { coord: true }), ag('Xr Ben', -200, 300), ag('Xr Cy', -200, 300)]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false;ATT_OFF=true;COD={cur:null,hist:[]};ME={role:"manager",name:"Jeff Bote"};applyMe();CASES.length=0');
    // CSR only
    A.run("ADDT='aruba';openAdd()");
    check('Add Case has a "CSR only" tick box', A.run("$('add-card').innerHTML").includes('id="add-csr"'));
    A.run("hide('add-modal');CASES.push(mkCase('CSR-1','Xr Ben',{csr:true}));openId='CSR-1';RCID='';renderCase()");
    { const h = String(A.els['case-body'].innerHTML);
      check('a CSR only case has no CE arrival time, maintenance window, lift, Cabling/HOD or revisit', !h.includes('CE arrival time') && !h.includes('Maintenance window') && !h.includes('Lift required') && !h.includes('Cabling/HOD') && !h.includes('This case needs a revisit'));
      check('a CSR only case has the statuses Ordered, Escalated, Shipped and Delivered', ['Ordered', 'Escalated', 'Shipped', 'Delivered'].every(x => h.includes('<option >' + x + '</option>') || h.includes('<option>' + x + '</option>')) && !h.includes('>Tracking Number<') && h.includes('CSR only')); }
    check('closing a CSR only case does not ask for a maintenance window or CE arrival time', !A.run("missingFields(getCase('CSR-1'))").some(x => /Maintenance|CE Arrival/.test(x)));
    A.run("CASES.push(mkCase('STD-1','Xr Ben',{}));openId='STD-1';RCID='';renderCase()");
    check('a normal case keeps everything (CE arrival, maintenance window, revisit, usual statuses)', (h => h.includes('CE arrival time') && h.includes('Maintenance window') && h.includes('>Tracking Number<'))(String(A.els['case-body'].innerHTML)));
    A.run("closeCase()");
    // COD approval
    A.run("codSet('Xr Amy');['XR-1','XR-2','XR-3'].forEach(id=>CASES.push(mkCase(id,'Xr Ben',{})));SIM_USER='Xr Ben'");
    A.run("doTransfer('XR-1','Xr Cy');doTransfer('XR-2','Xr Cy')");
    check('a manual transfer becomes a request: the case stays put until the coordinator on duty approves', A.run("getCase('XR-1').owner") === 'Xr Ben' && A.run("getCase('XR-1').xreq&&getCase('XR-1').xreq.to") === 'Xr Cy' && A.run("getCase('XR-1').log.some(l=>l.action==='Transfer requested')"));
    A.run("SIM_USER='Xr Amy';xreqRender()");
    check('the coordinator on duty gets a notice with Approve / Reject', A.run("$('xreq-pop').innerHTML").includes('Transfer approval needed (2)') && A.run("$('xreq-pop').innerHTML").includes("xreqApprove('XR-1')"));
    A.run("xreqApprove('XR-1');xreqReject('XR-2')");
    check('approved: the case moves to the person asked for', A.run("getCase('XR-1').owner") === 'Xr Cy' && A.run("getCase('XR-1').xreq") === null);
    check('rejected: the case stays where it was', A.run("getCase('XR-2').owner") === 'Xr Ben' && A.run("getCase('XR-2').xreq") === null && A.run("getCase('XR-2').log.some(l=>l.action==='Transfer rejected')"));
    A.run("doTransfer('XR-3','Xr Cy')");
    check('the coordinator on duty\'s own transfers happen at once', A.run("getCase('XR-3').owner") === 'Xr Cy' && !A.run("getCase('XR-3').xreq"));
    A.run("codSet('');SIM_USER='Xr Ben';doTransfer('XR-2','Xr Cy')");
    check('without a coordinator on duty a manual transfer happens at once, as before', A.run("getCase('XR-2').owner") === 'Xr Cy');
    A.run("SIM_USER=ME.name||'Jeff Bote';xreqRender()");
    // passwords, drafts
    check('a cleared password stays cleared: the database copy decides (no merging of older browser copies)', htmlSrc.includes("else{PROFILE_HASHES=db;normalizeProfileHashes()}") && !htmlSrc.includes("PROFILE_HASHES={...local,...db}"));
    check('log-in picture: Maricar Dela Cruz (front, green blazer) has her own face, Director with manager access', A.run("seatName('d1')") === 'Maricar Dela Cruz' && A.run("isMgrName('Maricar Dela Cruz')") && A.run("(()=>{const l=ensureMgrs([]);const p=l.find(x=>x.name==='Maricar Dela Cruz');return !!p&&p.role==='Director'&&isMgr(p)&&roleTitle(p.name)==='Director'})()"));
    check('log-in picture: every earlier face is kept, on both pictures (web 1672x941, mobile 937x1678)', ['s1','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11','s12','s13','s14','s15','s16','m1','m2','j1','j2','a1','d1'].every(k => A.run("!!SEAT_GEO_B['" + k + "']")) && A.run("LP_B.w===1672&&LP_B.h===941&&LP_B.mw===937&&LP_B.mh===1678"));
    // Nov 19 (21:00): canceled cases, ownership timeline for due misses, first log-in
    A.run("(()=>{const c=mkCase('CN-1','Xr Ben',{});c.cstatus='Canceled';c.mw=null;CASES.push(c)})()");
    check('the maintenance window is optional when closing a Canceled case', !A.run("missingFields(getCase('CN-1'))").some(x => /Maintenance/.test(x)) && A.run("(()=>{const c=getCase('CN-1');c.cstatus='Resolved';const r=missingFields(c).includes('Maintenance Window');c.cstatus='Canceled';return r})()"));
    A.run("(()=>{const n=Date.now(),c=mkCase('TL-1','Xr Cy',{});c.ownh=[{n:'Xr Amy',at:n-5*36e5}];c.credit={n:'Xr Amy',at:n-5*36e5};c.log=[{ts:n-3*36e5,action:'Ownership transferred',by:'System',details:'Xr Amy reached end of shift (EOS): case handed over to Xr Ben. Xr Amy → Xr Ben.'},{ts:n-1*36e5,action:'Ownership transferred',by:'System',details:'Balanced. Xr Ben → Xr Cy.'}];CASES.push(c)})()");
    check('who owned a case when: hand-overs in the case history are included even if the saved ownership list missed them', A.run("(()=>{const tl=ownTimeline(getCase('TL-1')),n=Date.now();return [ownerAt(tl,n-4*36e5),ownerAt(tl,n-2*36e5),ownerAt(tl,n-1000)].join()})()") === 'Xr Amy,Xr Ben,Xr Cy');
    check('attendance keeps the first log-in of the day: it checks the saved record of the shift before writing', !htmlSrc.includes("if(DBON&&!GOT.att)return false;") && htmlSrc.includes("if(x&&x.in&&+x.in<=tin){ATT[id]=x;ATT_OK.add(id);return}"));
    A.run("CASES=CASES.filter(c=>!['CN-1','TL-1'].includes(c.id))");
    // Nov 20: the built-in sample schedule (e.g. Lucille Layug) is never shown or saved when the database is on
    A.run("window.__w9=wq;window.__n9=0;wq=(k,fn)=>{if(k==='staff')__n9++;else return __w9(k,fn)};window.__S9=STAFF;window.__D9=STAFF_DOC;window.__L9=STAFFLOADED;window.__db9=DBON;DBON=true;SIMON=false;STAFF=DEMO_STAFF;STAFF_DOC=null;STAFFLOADED=false;ME={role:'manager',name:'Jeff Bote'};saveStatus('Lucille Layug');saveStaff(true,true)");
    await sleep(400);
    check('the sample schedule is never written to the database (a status save before the real schedule arrives does nothing)', A.run('__n9') === 0 && A.run("hasDemo(DEMO_STAFF)"));
    check('with the database on, the page starts with no sample agents until the real schedule arrives', htmlSrc.includes("dbq=db;DBON=true;if(!STAFFLOADED){STAFF=[];try{ensureMgrs(STAFF)}catch(e){}}") && !htmlSrc.includes("else if(isLead()&&!STAFF_DOC)saveStaff()"));
    A.run("wq=__w9;STAFF=__S9;STAFF_DOC=__D9;STAFFLOADED=__L9;DBON=__db9");
    A.run("PROFILE_HASHES={};PROFILE_HASHES[profileKey('Xr Ben')]='salt:hash';clrPw('Xr Ben')");
    check('clearing a password leaves an empty entry, so the profile has no password', A.run("profileHashFor('Xr Ben')") === '' && A.run("PROFILE_HASHES[profileKey('Xr Ben')]") === '');
    check('a screen on an older version (merging its own copy into the database copy) cannot bring the cleared password back', A.run("(()=>{const local={},db=J(PROFILE_HASHES);local[profileKey('Xr Ben')]='salt:hash';const merged={...local,...db};return merged[profileKey('Xr Ben')]===''&&!Object.keys(merged).some(k=>db[k]!==merged[k])})()"));
    A.run("PROFILE_HASHES={};PROFILE_HASHES['Xr Ben']='';PROFILE_HASHES[profileKey('Xr Ben')+' ']='salt:old';normalizeProfileHashes()");
    check('when two copies of the same profile meet, the cleared one wins', A.run("profileHashFor('Xr Ben')") === '');
    A.run("PROFILE_HASHES={}");
    A.run("openId='STD-1';show('case-modal')");
    check('case details are no longer kept in the browser draft (they save while typing; no older copy put back)', A.run("draftWhich()") === '');
    A.run("hide('case-modal');openId=null;CASES.length=0;ATT_OFF=false");
    check('Settings has "Clear cache and reload" that keeps unsent changes and saved data', htmlSrc.includes('function clearCache()') && htmlSrc.includes("if(ob!=null)localStorage.setItem('pet_outbox',ob)"));
    check('Excel cells never get "not a number" or raw objects (Excel would repair the file and drop its formatting)', A.run("[xv(NaN),xv(undefined),xv({a:1}),xv(3)].join('|')") === '—||{"a":1}|3');
  }
  // ---------- Nov 14: closed cases, name merge, regions ----------
  {
    const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
    const nowM = A.run('minOf(simNow())');
    const ag = (name, a, b, st) => ({ name, role: 'Support', start: T(nowM + a), end: T(nowM + b), days: [1, 1, 1, 1, 1, 1, 1], status: st || 'available' });
    A.run('STAFF=' + JSON.stringify([ag('Cl Gone', -540, -2), ag('Cl Amy', -200, 300), ag('Cl Ben', -200, 300)]) + ';ensureMgrs(STAFF);STAFFLOADED=true;SIMON=false');
    A.run("(()=>{CASES.length=0;const c=mkCase('CL-1','Cl Gone',{});c.closed=true;c.closedAt=Date.now()-60000;CASES.push(c);CASES.push(mkCase('CL-2','Cl Gone',{}));eosCheck()})()");
    check('a closed case is not handed over at EOS (open ones are)', A.run("getCase('CL-1').owner") === 'Cl Gone' && A.run("getCase('CL-2').owner") !== 'Cl Gone');
    A.run("reassign(getCase('CL-1'),'Cl Amy','test')");
    check('a closed case never moves, whatever asks for it', A.run("getCase('CL-1').owner") === 'Cl Gone');
    A.run("(()=>{const d=mkCase('CL-3','Cl Amy',{});d.items.forEach(i=>{i.done=true});CASES.push(d);ME={role:'agent',name:'Cl Ben'};applyMe();finalizeClose('CL-3',{met:true})})()");
    check('a closed case is tagged to the agent who closed it', A.run("getCase('CL-3').owner") === 'Cl Ben' && A.run("getCase('CL-3').closedBy") === 'Cl Ben' && A.run("getCase('CL-3').closed") === true);
    A.run("(()=>{ME={role:'manager',name:'Jeff Bote'};applyMe();const e=mkCase('CL-4','Cl Amy',{});e.closed=true;e.closedAt=Date.now()-3600000;e.closedBy='Cl Amy';e.owner='Cl Ben';e.ownh=[{n:'Cl Amy',at:Date.now()-7200000},{n:'Cl Ben',at:Date.now()-60000}];CASES.push(e);fixClosedOwners()})()");
    check('closed cases moved after closing (before the fix) go back to the agent who closed them', A.run("getCase('CL-4').owner") === 'Cl Amy');
    check('Bonnylet Manalo and Bonylett Manalo are the same person (schedule name kept)', A.run("canon('Bonnylet Manalo')") === 'Bonylett Manalo' && A.run("canon('bonnylet  manalo')") === 'Bonylett Manalo' && A.run("canonCase({owner:'Bonnylet Manalo',credits:[{n:'Bonnylet Manalo',at:1}],items:[]}).credits[0].n") === 'Bonylett Manalo');
    check('the schedule keeps one Bonylett Manalo', A.run("(()=>{const l=[{name:'Bonnylet Manalo',start:'06:00',end:'15:00',days:[1,1,1,1,1,1,1]},{name:'Bonylett Manalo',start:'06:00',end:'15:00',days:[1,1,1,1,1,1,1]}];ensureMgrs(l);return l.filter(p=>/manalo/i.test(p.name)).map(p=>p.name).join('|')})()") === 'Bonylett Manalo');
    check('region from the schedule: 06:00 APJ, 14:00 EMEA, 22:00 AMS', A.run("[regionOfSched({start:'06:00',end:'15:00',days:[1,1,1,1,1,0,0]}),regionOfSched({start:'14:00',end:'23:00',days:[1,1,1,1,1,0,0]}),regionOfSched({start:'22:00',end:'07:00',days:[1,1,1,1,1,0,0]})].join()") === 'APJ,EMEA,AMS');
    A.run("RGH={};STAFF=[{name:'Rg Ann',role:'Support',start:'06:00',end:'15:00',days:[1,1,1,1,1,1,1],status:'available'}];STAFF.forEach(p=>p.sch=mkSch(p));rghUpdate();window.__t1=Date.now();RGH['Rg Ann'][0].at=0;STAFF[0].start='14:00';STAFF[0].end='23:00';STAFF[0].sch=mkSch(STAFF[0]);rghUpdate()");
    check('a schedule change does not move earlier records to the new region', A.run("regionAt('Rg Ann',__t1-86400000)") === 'APJ' && A.run("regionAt('Rg Ann',Date.now()+1000)") === 'EMEA');
    A.run("RGH={}");
  }
  // ---------- Case History: nothing gets lost ----------
  {
    A.run("DBON=!!dbq;SIMON=false;ME={role:'manager',name:'Jeff Bote'};applyMe();window.__hc=mkCase('HX-1','Jeff Bote',{});REAL.cases.unshift(__hc);CASES=REAL.cases;cdSet('HX-1','model','DL380 Gen11')");
    check('an action shows in Case History at once, before the server echoes it', A.run("getCase('HX-1').log.some(l=>l.action==='Model number updated'&&/DL380/.test(l.details))") === true);
    check('the case document does not grow with history (kept once, in the activity list)', !(A.run("JSON.stringify(getCase('HX-1').hist||[])")||'').includes('Model number'));
    await sleep(2500);
    A.run("REAL.act=REAL.act.filter(e=>e.case!=='HX-1');Object.keys(LOCALLOG).forEach(k=>delete LOCALLOG[k]);rebuildLogs()");
    check('(the dashboard window no longer has it)', A.run("getCase('HX-1').log.some(l=>l.action==='Model number updated')") === false);
    A.run("openCaseModal('HX-1')"); await sleep(2500);
    check('opening the case loads its complete history from the database, however old', A.run("getCase('HX-1').log.some(l=>l.action==='Model number updated'&&/DL380/.test(l.details))") === true);
    A.run("REAL.act.unshift({...CASEHIST['HX-1'][0]});rebuildLogs()");
    check('an entry found in both places is shown once', A.run("getCase('HX-1').log.filter(l=>l.action==='Model number updated').length") === 1);
    A.run("closeCase()");
    check('older entries show the date as well as the time', htmlSrc.includes('earlier days: date and time'));
    A.run("REAL.cases=REAL.cases.filter(c=>c.id!=='HX-1');CASES=REAL.cases");
  }
  // ---------- VM titles + New Year ----------
  {
    const lab = n => A.run(`ME={role:'manager',name:${JSON.stringify(n)}};meLabel()`);
    check('header shows June John Cruz as Auditor', lab('June John Cruz') === 'Auditor · June John Cruz');
    check('header shows Arianne (May) Escabillas as Developer', lab('Arianne Escabillas') === 'Developer · Arianne Escabillas' && A.run("roleTitle('Arianne May Escabillas')") === 'Developer');
    check('Jeff Bote stays Manager; other managers stay Manager', lab('Jeff Bote') === 'Manager · Jeff Bote' && A.run("roleTitle('Someone Else')") === 'Manager');
    check('Auditor and Developer keep manager access', A.run("ME={role:'manager',name:'June John Cruz'};isLead()") === true && A.run("ME={role:'manager',name:'Arianne Escabillas'};isLead()") === true);
    check('developer-only: another manager cannot clear the Developer password', A.run("ME={role:'manager',name:'Jeff Bote'};devGuard('Arianne Escabillas')") === true && A.run("ME={role:'manager',name:'Arianne Escabillas'};devGuard('Arianne Escabillas')") === false);
    check('an old agent sign-in of the Vendor Management Team is upgraded to manager access', A.run("ME={role:'agent',name:'June John Cruz'};aliasFix();ME.role") === 'manager');
    A.run("SSN=null");
    const k = d => A.run(`(seasonNow(new Date(${JSON.stringify(d)}))||{kind:'none'}).kind`);
    check('Christmas shows until Dec 30', k('2026-12-27T12:00:00') === 'christmas' && k('2026-12-30T12:00:00') === 'christmas');
    check('New Year takes over by itself from Dec 31 to Jan 7', k('2026-12-31T12:00:00') === 'newyear' && k('2027-01-03T12:00:00') === 'newyear' && k('2027-01-08T12:00:00') === 'none');
    A.run("SSN=Object.assign({},SSN_DEF,{ny:false})");
    check('"Then New Year" can be switched off', k('2026-12-31T12:00:00') === 'christmas');
    A.run("SSN=null");
    check('New Year decorations: fireworks, banner, flash, balloons countdown', ['function fwLoop', 'function nyBanner', 'function nyFlash', 'function nyCard', 'Countdown to New Year'].every(x => htmlSrc.includes(x)));
  }
  // ---------- only one screen deals the automatic hand-overs at a time ----------
  {
    const B = client({ role: 'manager', name: 'June John Cruz' });
    await B.run('initDb()'); await sleep(2500);
    A.run("DBON=!!dbq;SIMON=false;LEASE={id:'',until:0};LEASE_T=0");
    check('a screen does not deal hand-overs the moment it takes the lease', A.run('eosLeader()') === false);
    await sleep(2800);
    check('then it is the one screen that deals them', A.run('eosLeader()') === true);
    await sleep(1500);
    check('another open screen leaves it alone while the lease is held', B.run('LEASE.id') === A.run('MYID') && B.run('eosLeader()') === false);
    A.run("LEASE.until=0;LEASE_T=Date.now()+1e9");   // A closes: its lease runs out
    B.run("LEASE.until=Date.now()-1;LEASE_T=0"); B.run('eosLeader()'); await sleep(2800);
    check('when that screen closes another one takes over', B.run('eosLeader()') === true);
  }
  console.log(FAILS ? 'RESULT: FAIL (' + FAILS + ')' : 'RESULT: PASS'); py.kill(); process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error('ERROR', e); py.kill(); process.exit(2); });
