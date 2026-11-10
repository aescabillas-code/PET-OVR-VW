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
  A.run("LP={v:'setpw',name:'Karen Sabile'}"); setv('lp-pw', 'secret1'); setv('lp-pw2', 'secret1');
  await A.run('lpSavePw()'); await sleep(2000);
  A.run("ME={role:'coordinator',name:'Coordinator'};applyMe()");
  const C = client({ role: null, name: '' });
  await C.run('initDb()'); await sleep(2500);
  check('a password set on one screen is known on a brand-new screen', String(C.run("PROFILE_HASHES['karensabile']||''")).includes(':'));

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
  A.run("ME={role:'coordinator',name:'Coordinator'};checkMe()");
  check('profile is not switched by another screen', A.run('ME.role') === 'coordinator' && A.run('ME.name') === 'Coordinator');
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
  check('bulk cases count for the agent they were assigned to', A.run("CASES.every(c=>credOf(c).n===c.owner)"));
  A.run("var __c=CASES[0],__o=__c.owner,__t=pool().find(p=>p.name!==__o).name;reassign(__c,__t,'test');");
  check('a transferred case stays in the first agent\'s daily count', A.run("credOf(CASES[0]).n")===A.run("__o")&&A.run("dayN(__o,simNow())")>=1);

  // ---------- statuses, same-case-number merge, daily trend ----------
  check('case statuses are FE Name, Tracking Number, Service Window, Scheduled, TR2, Resolved', JSON.stringify(A.run("CSTAT"))===JSON.stringify(['FE Name','Tracking Number','Service Window','Scheduled','TR2','Resolved']));
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
  check('cases handed over at EOS are shared back when the agent is available again', A.run("loadOf(__a)")>=3 && Math.abs(A.run("loadOf(__a)")-A.run("loadOf(__b)"))<=1);
  check('only EOS-handed-over cases move; the holder keeps its own', A.run("getCase('K-1').owner")===A.run("__b"));
  check('a moved case keeps the first agent\'s productivity credit and is no longer flagged', A.run("CASES.filter(c=>c.owner===__a).every(c=>!c.eos&&credOf(c).n===__b)"));
  A.run("var __l=loadOf(__a);rebalanceEos(simNow());");
  check('rebalancing is stable (no further moves when even)', A.run("loadOf(__a)")===A.run("__l"));
  A.run("SIMON=true;var __os2=onShiftAt;onShiftAt=function(){return true};STAFF.push({name:'EOD Support',role:'EOD Support',shift:'Night',start:'00:00',end:'23:59',days:{},status:'available'});render();");
  check('EOD support does not appear in the agent status panel or its counts', !/EOD Support/.test(String(A.els['agent-list']?A.els['agent-list'].innerHTML:'')) && A.run("isEod(STAFF[STAFF.length-1])") && !A.run("isEod(STAFF[0])"));
  A.run("STAFF.pop();onShiftAt=__os2;SIMON=false");
  A.run("SIMON=true;CASES=[];var __o3=onShiftAt,__sl=STAFF.length;onShiftAt=function(){return true};while(STAFF.filter(function(p){return !isMgr(p)&&!isEod(p)}).length<3)STAFF.push({name:'Test Agent '+STAFF.length,role:'Support',shift:'Morning',start:'06:00',end:'14:00',days:WK([0,1,2,3,4,5,6]),status:'available'});var __q=STAFF.filter(function(p){return !isMgr(p)&&!isEod(p)}),__x=__q[0].name,__y=__q[1].name,__z=__q[2].name;__q.forEach(function(p){p.status='available'});function mkN(o,cn,n,t){for(var i=0;i<n;i++){var c=mkCase(t+i,o,{caseType:'att',account:'Account A',recv:Date.now()});c.credit={n:cn,at:Date.now()};CASES.push(c)}}mkN(__x,__x,29,'X');mkN(__y,__y,29,'Y');mkN(__z,__z,29,'Z');mkN(__x,'Gone Agent',11,'G');var __bef=loadOf(__x);toggleAvailability_test=null;rebalanceEos(simNow());");
  check('the 40 / 29 / 29 pile is evened out by sharing the handed-over cases', A.run("__bef")===40 && Math.max(A.run("loadOf(__x)"),A.run("loadOf(__y)"),A.run("loadOf(__z)"))-Math.min(A.run("loadOf(__x)"),A.run("loadOf(__y)"),A.run("loadOf(__z)"))<=1);
  check('an agent\'s own cases are never taken away by the balancing', A.run("CASES.filter(c=>/^X\\d/.test(c.id)).every(c=>c.owner===__x)")&&A.run("CASES.filter(c=>/^Y\\d/.test(c.id)).every(c=>c.owner===__y)"));
  A.run("onShiftAt=function(p){return p.name!==__z};render();");
  check('an agent past end of shift (EOS) is not listed in the agent status section', !A.run("String(document.getElementById('agent-list').innerHTML).includes(__z)") && A.run("String(document.getElementById('agent-list').innerHTML).includes(__x)"));
  A.run("onShiftAt=__o3;CASES=[];STAFF.length=__sl;SIMON=false");
  A.run("onShiftAt=__os;SIMON=false");
  // ---------- the Template button downloads the repo file ----------
  {let got=null;const __sb=A.ctx.saveBlob;if(!A.ctx.Blob)A.ctx.Blob=Blob;if(!A.ctx.atob)A.ctx.atob=atob;A.ctx.saveBlob=(b,n)=>{got={b,n}};
   const repoB64=require('fs').readFileSync(path.join(root,'templates/PET_Shift_Schedule_Template.xlsx')).toString('base64');
   A.ctx.__petTemplate=()=>Promise.resolve({name:'PET_Shift_Schedule_Template.xlsx',b64:repoB64});
   await A.ctx.sTemplate();check('the shift Template button downloads the file kept in the repo (templates/)', !!got&&got.n==='PET_Shift_Schedule_Template.xlsx'&&got.b.size===Buffer.from(repoB64,'base64').length);
   got=null;A.ctx.__petTemplate=()=>Promise.reject(new Error('offline'));await A.ctx.sTemplate();check('it falls back to the built-in copy when the repo file cannot be reached', !!got&&got.b.size>1000);
   A.ctx.__petTemplate=undefined;A.ctx.saveBlob=__sb}
  A.run("RPT.view='weekly'");
  A.run("SIMON=false;CASES=REAL.cases");
  A.run("ME={role:'coordinator',name:'Coordinator'};saveMe()");
  A.run("ME={role:null,name:''};loadMe()");
  check('a profile saved on the device is not restored when the app opens', A.run('ME.role') === null);
  A.run("pickAgent(0)");
  check('the header shows the profile that was selected', A.run('meLabel()').includes(A.run('ME.name')) && !!A.run('ME.name'));
  A.run("ME={role:null,name:''};DBON=true;GOT={};MEASKED=false;LP_T0=Date.now()");
  check('faces cannot be used before the profile data is loaded', A.run('lpReady()') === false);
  A.run("GOT={staff:1,profileHashes:1,seats:1,acct:1,coords:1}");
  check('faces work once the profile data is loaded', A.run('lpReady()') === true);
  A.run("DBON=false;ME={role:'coordinator',name:'Coordinator'}");

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
  check('the report keeps the original and lists every update', (() => { const t = String(A.run("mwX(getCase('MWE-1'))")); return t.includes('Original:') && t.includes('Update 1:') && t.includes('Update 3 (current):'); })());
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
  A.run("closeCase()");

  // ---------- case modal layout, closing rule, availability toggle, simulation ----------
  A.run("ME={role:'coordinator',name:'Coordinator'};CASES.length=0;(()=>{const c=mkCase('MODAL-1','Haina Azuela',{hp:true});c.items.forEach(i=>{i.done=true});c.sev='Sev 3';c.cstatus=CSTAT[0];c.model='AP-1';c.sfdc=['5001'];c.ritm='RITM1';c.pOrd=1;c.pDel=2;c.ceArr=3;c.mw={s:Date.now()-36e5,e:null,by:'x',ts:Date.now()};CASES.push(c)})()");
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
  check('16 team faces + 2 managers, 17 clickable on the mobile picture', P.run('SEAT_IDS.length') === 18 && P.run('SEAT_IDS.filter(i=>SEAT_GEO[i].length>4).length') === 17);
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
  check('a signed-in profile becomes coordinator when a manager assigns it', Q.run('ME.coord') === true && Q.run('isLead()') === true && Q.run('meKey()') === 'Coordinator');
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
  check('the agent is now unavailable', A.run("pers('Karen Sabile').status") === 'unavailable');
  check('open cases stay with the owner after marking unavailable', A.run("CASES.every(c=>c.owner==='Karen Sabile')") === true);
  check('an unavailable agent is excluded from new assignments', A.run("pool().some(p=>p.name==='Karen Sabile')") === false);
  A.run('eosCheck()');
  check('still on shift: eosCheck leaves the cases with the unavailable owner', A.run("CASES.every(c=>c.owner==='Karen Sabile')") === true);
  A.run("(()=>{const k=pers('Karen Sabile');k.days=[0,0,0,0,0,0,0];k.sch=['OFF','OFF','OFF','OFF','OFF','OFF','OFF']})()");
  A.run('eosCheck()');
  check("at the owner's end of shift the cases are transferred automatically", A.run("CASES.every(c=>c.owner==='Haina Azuela')") === true);
  A.run("ME={role:'coordinator',name:'Coordinator'};applyMe()");
  console.log(FAILS ? 'RESULT: FAIL (' + FAILS + ')' : 'RESULT: PASS'); py.kill(); process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error('ERROR', e); py.kill(); process.exit(2); });
