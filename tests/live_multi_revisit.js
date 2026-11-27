// Live (Nov 26, 09:15): several revisits per case reach the other screen; a half-typed added revisit survives a reload;
// logout and gear stay readable (white on a dark backdrop) on a light theme.
//   python3 tests/live_host.py . 8826 &   node tests/live_multi_revisit.js 8826 [screenshot-dir]
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await require('./_pw_quiet').launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const shots = process.argv[3] || '';
  const open = async () => { const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); return [p, p.frames().find(x => x.url().includes('/app'))]; };
  const until = async (F, fn, arg) => { for (let i = 0; i < 40; i++) { if (await F.evaluate(fn, arg)) return i * 250; await sleep(250) } return -1 };
  const [pa, A] = await open();
  await A.evaluate(() => { STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide(); try { hideWelcome() } catch (e) {} const c = mkCase('RV-LIVE-1', STAFF[0].name, {}); CASES.unshift(c); queueSave(c); render() });
  await sleep(1500);
  const [pb, B] = await open(); await B.evaluate(() => { ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); lpHide(); try { hideWelcome() } catch (e) {} }); await sleep(1200);
  await A.evaluate(() => { openCaseModal('RV-LIVE-1'); rvSet('RV-LIVE-1', 'needed', true, true); rvSet('RV-LIVE-1', 'cause', 'Customer', true); rvSet('RV-LIVE-1', 'tid', 'T-1'); rvSet('RV-LIVE-1', 'doc', 'No access'); rvSave('RV-LIVE-1') }); await sleep(300);
  await A.evaluate(() => document.querySelector('#case-body button[onclick^="rvAddStart("]').click()); await sleep(300);
  await A.evaluate(() => document.querySelector('#case-body button[data-k="DOA"]').click()); await sleep(200);
  await A.fill('#rv-tid', 'T-2'); await A.fill('#rv-doc', 'Part dead'); await A.evaluate(() => [...document.querySelectorAll('#case-body button')].find(x => x.textContent.trim() === 'Add revisit').click()); await sleep(400);
  check('two revisits on the case', await A.evaluate(() => rvAll(getCase('RV-LIVE-1')).map(x => x.tid).join(',')) === 'T-1,T-2');
  const w = await until(B, () => rvAll(getCase('RV-LIVE-1') || {}).length === 2);
  check('the other screen gets both revisits within seconds', w >= 0, w);
  // half-typed third revisit survives a reload
  await A.evaluate(() => document.querySelector('#case-body button[onclick^="rvAddStart("]').click()); await sleep(300); await A.evaluate(() => document.querySelector('#case-body button[data-k="Tools"]').click()); await sleep(200); await A.fill('#rv-tid', 'T-3 draft'); await sleep(2500);
  if (shots) await pa.screenshot({ path: shots + '/revisits.png' });
  await pa.reload(); await sleep(4000); const A2 = pa.frames().find(x => x.url().includes('/app'));
  await A2.evaluate(() => { lpHide(); try { hideWelcome() } catch (e) {} openCaseModal('RV-LIVE-1') }); await sleep(600);
  check('a half-typed added revisit is still there after a reload', await A2.evaluate(() => { const i = document.getElementById('rv-tid'); return !!i && i.value === 'T-3 draft' && getCase('RV-LIVE-1').rvAdd === 'new' }), await A2.evaluate(() => [getCase('RV-LIVE-1').rvAdd, (document.getElementById('rv-tid') || {}).value]));
  // light theme: logout + gear readable
  await A2.evaluate(() => { hide('case-modal'); THEME_PREVIEW = { p: 'custom', c: '#fff6cc' }; applyTheme() }); await sleep(300);
  const col = await A2.evaluate(() => ['logout-btn', 'set-btn'].map(id => { const s = getComputedStyle(document.getElementById(id)); return [s.color, s.backgroundColor] }));
  check('logout and gear: white on a dark backdrop with a light theme', col.every(([c, bg]) => c === 'rgb(255, 255, 255)' && /rgba\(10, 28, 46/.test(bg)), col);
  if (shots) await pa.screenshot({ path: shots + '/header_light.png', clip: { x: 700, y: 0, width: 700, height: 80 } });
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
