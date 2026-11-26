// Two screens edit different fields of the same case at the same time (one keeps typing): every value is kept and both screens
// show everything (case number, SFDC Case ID, RITM, store, model).
//   python3 tests/live_host.py . 8824 &   node tests/live_fields_two_screens.js 8824
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const open = async () => { const p = await (await b.newContext()).newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); return [p, p.frames().find(x => x.url().includes('/app'))]; };
  const [pa, A] = await open();
  const cid = await A.evaluate(() => { STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide();
    const c = mkCase('FX-9', STAFF.find(p => !isMgr(p)).name, { caseType: 'aruba', arubaNo: 'FX-9', account: 'Account A', recv: Date.now() }); CASES.unshift(c); logc(c, 'Case created', 'Jeff Bote', 't'); render(); return c.id });
  await sleep(2500);
  const [pb, B] = await open(); await B.evaluate(() => { ME = { role: 'manager', name: 'Jose Teves' }; applyMe(); lpHide() }); await sleep(1500);
  await A.evaluate(id => openCaseModal(id), cid); await sleep(800);
  const sel = `#case-body input[onchange^="cdSet('${cid}','model'"]`;
  await A.click(sel);
  const typing = A.type(sel, 'DL380 Gen10 Plus server', { delay: 90 });   // keeps typing for ~2 s (saves every 0.25 s)
  await sleep(300);
  await B.evaluate(id => { cdSet(id, 'ritm', 'RITM0012345'); sfSet(id, 0, '5400998877'); cdSet(id, 'store', '4321') }, cid);
  await typing; await A.evaluate(() => document.activeElement && document.activeElement.blur());
  await sleep(5000);
  const db = await A.evaluate(async id => { const s = await dbq.doc('cases/' + id).get(); const d = s.data(); return { arubaNo: d.arubaNo, ritm: d.ritm, sfdc: d.sfdc, store: d.store, model: d.model } }, cid);
  const sa = await A.evaluate(id => { const c = getCase(id); return { no: dispNo(c), ritm: c.ritm, sfdc: c.sfdc, store: c.store, model: c.model } }, cid);
  const sb = await B.evaluate(id => { const c = getCase(id); return { no: dispNo(c), ritm: c.ritm, sfdc: c.sfdc, store: c.store, model: c.model } }, cid);
  check('every value from both screens is saved', db.arubaNo === 'FX-9' && db.ritm === 'RITM0012345' && (db.sfdc || [])[0] === '5400998877' && db.store === '4321' && db.model === 'DL380 Gen10 Plus server', db);
  check('the typing screen shows the other screen\'s values too', sa.no === 'FX-9' && sa.ritm === 'RITM0012345' && sa.sfdc[0] === '5400998877' && sa.store === '4321', sa);
  check('the other screen shows the typed value', sb.model === 'DL380 Gen10 Plus server' && sb.no === 'FX-9', sb);
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
