// Live: ticking Lift required asks THD / Non-THD and the weekly report shows it; an agent can download Excel from the report builder;
// a change on one screen shows on another within seconds (realtime unchanged).
//   python3 tests/live_host.py . 8824 &   node tests/live_lift_and_agent_excel.js 8824
const MOCKXL = require('fs').readFileSync(require('path').join(__dirname, 'mock_exceljs.js'), 'utf8');   // the Excel library comes from the internet; this test uses a stand-in
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await require('./_pw_quiet').launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const open = async () => { const ctx = await b.newContext({ acceptDownloads: true }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); return [p, p.frames().find(x => x.url().includes('/app'))]; };
  const [pa, A] = await open();
  const cid = await A.evaluate(() => { STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide(); try { hideWelcome() } catch (e) {}
    const c = mkCase('LF-88', STAFF.find(p => !isMgr(p)).name, { caseType: 'aruba', arubaNo: 'LF-88', account: 'Account A', recv: Date.now() }); CASES.unshift(c); logc(c, 'Case created', 'Jeff Bote', 't'); render(); return c.id });
  await sleep(2000);
  const [pb, B] = await open(); await B.evaluate(() => { ME = { role: 'agent', name: STAFF.find(p => !isMgr(p)).name }; applyMe(); lpHide(); try { hideWelcome() } catch (e) {} }); await sleep(1500);
  // lift pop-up on screen A
  await A.evaluate(id => openCaseModal(id), cid); await sleep(800);
  const lift = A.locator('#case-body input[onchange^="cdLift("]'); await lift.check(); await sleep(300);
  check('ticking Lift required opens the THD / Non-THD question', await A.evaluate(() => !!document.getElementById('lift-pop')));
  await A.click('#lift-pop button:has-text("Non-THD lift")'); await sleep(500);
  check('choosing Non-THD lift sets it and closes the question', await A.evaluate(id => getCase(id).lift === true && getCase(id).liftT === 'non' && !document.getElementById('lift-pop'), cid));
  check('the case shows "Yes - Non-THD lift"', await A.evaluate(() => document.getElementById('case-body').textContent.includes('Yes - Non-THD lift')));
  // realtime: screen B sees it
  let w = -1; for (let i = 0; i < 40; i++) { if (await B.evaluate(id => { const c = getCase(id); return !!c && c.liftT === 'non' }, cid)) { w = i * 250; break } await sleep(250) }
  check('the other screen gets the change within seconds (realtime)', w >= 0, w);
  check('weekly report value on the other screen: "Yes - Non-THD lift"', await B.evaluate(id => RF('lift').g(getCase(id)), cid) === 'Yes - Non-THD lift');
  // typing on A reaches B
  const sel = `#case-body input[onchange^="cdSet('${cid}','ritm'"]`; await A.click(sel); await A.type(sel, 'RITM777', { delay: 25 });
  w = -1; for (let i = 0; i < 40; i++) { if (await B.evaluate(id => (getCase(id) || {}).ritm === 'RITM777', cid)) { w = i * 250; break } await sleep(250) }
  check('typing in a case field reaches the other screen within seconds', w >= 0, w);
  // agent downloads Excel from the report builder
  await B.evaluate(src => { if (!window.ExcelJS) (0, eval)(src) }, MOCKXL);
  await B.evaluate(() => { openSettings(); setTabTo('rbuild'); RPT.from = RPT.to = ymd(wall(Date.now())) }); await sleep(500);
  const [d1] = await Promise.all([pb.waitForEvent('download', { timeout: 30000 }).catch(() => null), B.evaluate(() => exportXlsx('custom'))]);
  check('an agent can download the report builder Excel', !!d1, null);
  const [d2] = await Promise.all([pb.waitForEvent('download', { timeout: 30000 }).catch(() => null), B.evaluate(() => exportXlsx('weekly'))]);
  check('an agent can download the weekly report Excel', !!d2, null);
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
