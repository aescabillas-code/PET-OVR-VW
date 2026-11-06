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

let FAILS = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + (extra || ''))); if (!ok) FAILS++; };
const J = s => JSON.parse(s);
let A; const setv = (id, v) => { A.ctx.document.getElementById(id).value = v; };

(async () => {
  A = client({ role: 'coordinator', name: 'Coordinator' });
  await A.run('initDb()'); await sleep(2500);

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
  A.run("(()=>{document.getElementById('profile-selected-name').value='Coordinator';document.getElementById('profile-new-password').value='secret1'})()");
  await A.run('setProfilePassword()'); await sleep(2000);
  const C = client({ role: null, name: '' });
  await C.run('initDb()'); await sleep(2500);
  check('a password set on one screen is known on a brand-new screen', String(C.run("PROFILE_HASHES['Coordinator']||''")).includes(':'));

  // ---------- Export current keeps the template look ----------
  const cells = {}; let blobName = '';
  const mkCell = key => cells[key] || (cells[key] = {});
  A.ctx.ExcelJS = { Workbook: function () { this.addWorksheet = () => ({ getColumn: () => ({}), getRow: r => ({ getCell: c => mkCell(r + ':' + c), set height(v) {} }) }); this.xlsx = { writeBuffer: async () => new Uint8Array([1]) }; } };
  A.ctx.saveBlob = (b, n) => { blobName = n; };
  A.run('STAFF=[{name:"Q One",role:"Support",days:[1,1,1,1,1,0,0],sch:["12:00-21:00","15:00-00:00","18:00-03:00","OFF","PTO","OFF","09:00-17:00"]}]');
  await A.run('sExport()');
  const col = (r, c) => (cells[r + ':' + c] && cells[r + ':' + c].fill && cells[r + ':' + c].fill.fgColor.argb);
  check('export: header dark with yellow day names', col(1, 1) === 'FF404040' && cells['1:2'].font.color.argb === 'FFFFFF00' && cells['1:2'].value === 'SUN');
  check('export: orange / orange / green shifts', col(2, 2) === 'FFFFC000' && col(2, 3) === 'FFFFC000' && col(2, 4) === 'FFB7E1A1');
  check('export: pink OFF with dark-red text, dark-green PTO with white text', col(2, 5) === 'FFFFC7CE' && cells['2:5'].font.color.argb === 'FFC00000' && col(2, 6) === 'FF1E6B34' && cells['2:6'].font.color.argb === 'FFFFFFFF');
  check('export: file name', blobName === 'PET_Shift_Schedule.xlsx');

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
  const exp2 = A.run(`hhmm(new Date(${R.qb}+120*60000))`);
  check('+1 hr twice adds up to +2 hours', R.qk === 120 && A.els['rm-time'].value === exp2, A.els['rm-time'].value + ' vs ' + exp2);
  A.run('remQuick(15)'); A.run('remQuick(15)'); A.run('remQuick(5)');
  check('minutes keep adding too', A.run('R.qk') === 155);
  A.run('remManual()');
  check('editing the time by hand restarts the count', A.run('R.qk') === 0);
  A.run('remQuick(60)'); A.run('remQuick(60)');
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
  check('a mentioned person is added to a "specific people" announcement', ann && Array.isArray(ann.to) && ann.to.includes('Karen Sabile'));
  const B = client({ role: 'agent', name: 'Karen Sabile' });
  await B.run('initDb()'); await sleep(2500);
  check('the mentioned person sees the announcement from the database', B.run('ANN.some(a=>a.title==="Queue update")') === true);
  check('mention is highlighted for that person', B.run('annMsgHtml(ANN.find(a=>a.title==="Queue update"))').includes('class="mention me"'));
  check('images are stored as shared assets and cases show as chips', B.run('annMedia(ANN.find(a=>a.title==="Queue update"),false)').includes('data-aid=') && B.run('annMedia(ANN.find(a=>a.title==="Queue update"),false)').includes('PET-FEAT-1'));
  check('script tags in a message stay inert', A.run(`annMsgHtml({msg:'<img src=x onerror=1> @Karen Sabile',mentions:['Karen Sabile']})`).indexOf('<img') < 0);

  // ---------- a new sign-in must not get old alerts ----------
  A.run("ME={role:'coordinator',name:'Coordinator'}");
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
  A.run("ME={role:'coordinator',name:'Coordinator'}");
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
  const n0 = A.run('ACT.length'); A.run("glog('Schedule changed','x','y');aglog('Announcement published','x','y')");
  check('general actions are no longer recorded', A.run('ACT.length') === n0);
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
  A.run("ME={role:'coordinator',name:'Coordinator'};GOT.coord=1;COORD={uid:'another-screen'};checkMe()");
  check('profile is not switched by another screen', A.run('ME.role') === 'coordinator' && A.run('ME.name') === 'Coordinator');
  A.run("pickAgent(0)"); const nm = A.run('ME.name');
  check('selected profile is saved on the device', JSON.parse(A.ctx.localStorage.getItem('pet_me')).name === nm);
  console.log(FAILS ? 'RESULT: FAIL (' + FAILS + ')' : 'RESULT: PASS'); py.kill(); process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error('ERROR', e); py.kill(); process.exit(2); });
