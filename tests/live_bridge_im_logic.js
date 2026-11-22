// Live check of the IM•LOGIC ⇄ PET message thread with BOTH apps running:
//   BRIDGE_FAKE_FILE=/tmp/br.json BRIDGE_TEST_SIDE= python tests/live_host.py . 8780 &
//   BRIDGE_FAKE_FILE=/tmp/br.json python <pet-station patched by pet_bridge/apply_to_pet.py>/tests/live_host.py <pet-station> 8781 &
//   node tests/live_bridge.js 8780 8781
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch();
  const open = async port => { const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + port + '/'); await sleep(3500); const f = p.frames().find(x => x.url().includes('/app')); return { p, f, errs }; };
  let fails = 0; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const wait = async (X, fn, arg, max = 10000) => { const t = Date.now(); while (Date.now() - t < max) { if (await X.f.evaluate(fn, arg)) return Date.now() - t; await sleep(50); } return -1; };
  const IM = await open(process.argv[2]), PET = await open(process.argv[3]);
  for (const X of [IM, PET]) await X.f.evaluate(() => { ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide(); try { hideWelcome() } catch (e) {} render() });
  await PET.f.evaluate(() => { const c = mkCase('AR-77', (STAFF.find(p => !isMgr(p)) || { name: 'Test Agent' }).name, { caseType: 'aruba', arubaNo: 'AR-77', account: 'Account A', recv: Date.now() }); CASES.unshift(c); logc(c, 'Case created', 'Jeff Bote', 't'); render() });
  await IM.f.evaluate(() => { const c = mkCase('IM-77', (STAFF.find(p => !isMgr(p)) || { name: 'Test Agent' }).name, { caseType: 'aruba', account: 'Account A', recv: Date.now() }); CASES.unshift(c); logc(c, 'Case created', 'Jeff Bote', 't'); PETS = { cid: 'IM-77', q: 'AR-77', busy: false, items: [{ id: 'AR-77', caseType: 'aruba', arubaNo: 'AR-77', owner: 'PET Owner' }], err: '' }; petUse('IM-77', 0); render() });
  await sleep(1500);
  await IM.f.evaluate(() => openCaseModal('IM-77')); await sleep(500);
  await IM.f.click('#br-in'); await IM.f.type('#br-in', 'Hello PET, CE is on the way'); await IM.f.press('#br-in', 'Enter');
  check('IM•LOGIC: the message shows in its thread', await wait(IM, () => document.getElementById('br-list').textContent.includes('Hello PET, CE is on the way')) >= 0);
  await PET.f.evaluate(() => openCaseModal('AR-77'));
  const t1 = await wait(PET, () => { const b = document.getElementById('case-body').textContent; return b.includes('Hello PET, CE is on the way') && /Linked to IM•LOGIC case/.test(b) });
  check('PET: the linked case shows the IM•LOGIC link and the message', t1 >= 0, t1);
  await PET.f.click('#brp-in'); await PET.f.type('#brp-in', 'Thanks, store manager informed'); await PET.f.press('#brp-in', 'Enter');
  const t2 = await wait(IM, () => document.getElementById('br-list').textContent.includes('Thanks, store manager informed'));
  check('IM•LOGIC: the PET reply shows in the open case within a few seconds', t2 >= 0 && t2 < 5000, t2);
  check('IM•LOGIC case history records both messages', await wait(IM, () => { const l = getCase('IM-77').log; return l.some(x => x.action === 'Message to PET') && l.some(x => x.action === 'Message from PET' && /store manager/.test(x.details)) }) >= 0);
  check('PET case history records both messages', await wait(PET, () => { const l = getCase('AR-77').log; return l.some(x => x.action === 'Message from IM•LOGIC') && l.some(x => x.action === 'Message to IM•LOGIC') }) >= 0);
  // a PET message while the IM case is closed: badge on the dashboard row
  await IM.f.evaluate(() => closeCase());
  await PET.f.fill('#brp-in', 'Part delivered'); await PET.f.press('#brp-in', 'Enter');
  check('IM•LOGIC: a new PET message shows a 💬 badge on the case row', await wait(IM, () => [...document.querySelectorAll('#rows tr')].some(t => t.textContent.includes('AR-77') && t.textContent.includes('💬 1'))) >= 0);
  await IM.f.evaluate(() => openCaseModal('IM-77')); await sleep(800); await IM.f.evaluate(() => closeCase()); await sleep(300);
  check('opening the case marks it read (badge gone)', await IM.f.evaluate(() => ![...document.querySelectorAll('#rows tr')].some(t => t.textContent.includes('💬'))));
  check('the thread survives a refresh (it is kept in the database)', await (async () => { await IM.p.reload(); await sleep(4000); IM.f = IM.p.frames().find(x => x.url().includes('/app')); await IM.f.evaluate(() => { try { hideWelcome() } catch (e) {} openCaseModal('IM-77') }); return (await wait(IM, () => { const l = document.getElementById('br-list'); return l && l.textContent.includes('Hello PET') && l.textContent.includes('Part delivered') })) >= 0 })());
  check('no browser errors', !IM.errs.length && !PET.errs.length, [IM.errs, PET.errs]);
  console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS')); await b.close(); process.exit(fails ? 1 : 0);
})();
