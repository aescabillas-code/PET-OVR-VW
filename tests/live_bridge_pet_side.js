// Live check of PET's side of the IM•LOGIC thread without the IM•LOGIC app: IM•LOGIC's messages are written straight
// into the shared test file (as IM•LOGIC would), PET shows them and records them in the case history, and PET's reply lands in the file.
//   BRIDGE_FAKE_FILE=/tmp/br.json python3 tests/live_host.py . 8791 &
//   BRIDGE_FAKE_FILE=/tmp/br.json node tests/live_bridge_pet_side.js 8791
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FILE = process.env.BRIDGE_FAKE_FILE || '/tmp/br.json';
const im = (op, a) => JSON.parse(execFileSync('python3', ['-I', '-c',
  'import sys,json;sys.path.insert(0,sys.argv[1]);import im_pet_bridge as b;print(json.dumps(b.execute(b.FakeDB(sys.argv[2]),sys.argv[3],json.loads(sys.argv[4]),"IM")))',
  path.join(__dirname, '..'), FILE, op, JSON.stringify(a)]).toString());
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500);
  const f = p.frames().find(x => x.url().includes('/app'));
  let fails = 0; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const wait = async (fn, arg, max = 12000) => { const t = Date.now(); while (Date.now() - t < max) { if (await f.evaluate(fn, arg)) return Date.now() - t; await sleep(100); } return -1; };
  await f.evaluate(() => { if (!STAFF.length) { STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true) } ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide(); try { hideWelcome() } catch (e) {} render() });
  const cid = await f.evaluate(() => { const c = mkCase('AR-88', (STAFF.find(p => !isMgr(p)) || { name: 'Test Agent' }).name, { caseType: 'aruba', arubaNo: 'AR-88', account: 'Account A', recv: Date.now() }); CASES.unshift(c); logc(c, 'Case created', 'Jeff Bote', 't'); render(); return c.id });
  await sleep(1500);
  im('bridge_link', { pet: cid, im: 'IM-88', imNo: 'IM-88', station: 'ST1', owner: 'IM Owner', by: 'Ana' });
  im('bridge_send', { pet: cid, text: 'CE is on the way', by: 'Ana' });
  await f.evaluate(id => openCaseModal(id), cid);
  const t1 = await wait(() => { const b = document.getElementById('case-body'); return b && /Linked to IM•LOGIC case/.test(b.textContent) && b.textContent.includes('CE is on the way') });
  check('the linked case shows the IM•LOGIC link and its message', t1 >= 0, t1);
  check('the IM•LOGIC message is in the case history', await wait(id => (getCase(id).log || []).some(e => e.action === 'Message from IM•LOGIC' && e.details === 'CE is on the way'), cid) >= 0);
  await f.click('#brp-in'); await f.type('#brp-in', 'Thanks, store informed');
  await f.evaluate(() => caseRedraw && caseRedraw());
  check('an unsent reply survives a redraw of the case', await f.evaluate(() => document.getElementById('brp-in').value) === 'Thanks, store informed');
  await f.press('#brp-in', 'Enter');
  const t2 = await wait(() => document.getElementById('brp-list').textContent.includes('Thanks, store informed'));
  check('the reply shows in the thread', t2 >= 0, t2);
  const th = im('bridge_thread', { pet: cid });
  check('the reply is saved in the shared thread (IM•LOGIC sees it)', th.items.some(m => m.from === 'PET' && m.text === 'Thanks, store informed'));
  check('the reply is in the case history', await f.evaluate(id => (getCase(id).log || []).some(e => e.action === 'Message to IM•LOGIC'), cid));
  check('the message box is empty again', await f.evaluate(() => document.getElementById('brp-in').value) === '');
  im('bridge_send', { pet: cid, text: 'Second update', by: 'Ana' });
  check('a new IM•LOGIC message shows in the open case within a few seconds', await wait(() => document.getElementById('brp-list').textContent.includes('Second update')) >= 0);
  check('no browser errors', !errs.length, errs);
  await b.close();
  console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
