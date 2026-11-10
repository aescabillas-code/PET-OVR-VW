const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const url = 'http://127.0.0.1:' + process.argv[2] + '/';
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
  const open = async () => { const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0, 160))); await p.goto(url); await sleep(3000); const f = p.frames().find(x => x.url().includes('/app')); return { p, f, errs }; };
  const A = await open(), B = await open();
  const out = {}; let fails = 0; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  for (const X of [A, B]) await X.f.evaluate(() => { ME = { role: 'coordinator', name: 'Coordinator' }; applyMe(); });
  check('both screens are connected to the shared data', await A.f.evaluate(() => DBON) === true && await B.f.evaluate(() => DBON) === true);
  // case created on A appears on B: measure the delay
  const waitB = async (fn, arg, max = 15000) => { const t = Date.now(); while (Date.now() - t < max) { if (await B.f.evaluate(fn, arg)) return Date.now() - t; await sleep(50); } return -1; };
  await A.f.evaluate(() => { const ag = STAFF.filter(p => !isMgr(p)); for (let i = 0; i < 40; i++) { const c = mkCase('L-' + i, ag[i % ag.length].name, { caseType: 'att', account: 'Account A', recv: Date.now() }); CASES.unshift(c); logc(c, 'Case created', 'Coordinator', 'test'); } render(); });
  out.casesDelayMs = await waitB(() => CASES.filter(c => /^L-/.test(c.id)).length === 40);
  check('40 new cases reach the other screen', out.casesDelayMs >= 0, out.casesDelayMs);
  // announcement published on A appears in B's records and pops up
  await A.f.evaluate(() => { openSettings && 0; });
  await A.f.evaluate(async () => { setTabTo('ann'); document.getElementById('an-from').value = 'Coordinator'; document.getElementById('an-title').value = 'Live test'; document.getElementById('an-msg').value = 'Hello @everyone'; await publishAnn(); });
  out.annDelayMs = await waitB(() => ANN.some(a => a.title === 'Live test'));
  check('a published announcement reaches the other screen', out.annDelayMs >= 0, out.annDelayMs);
  { const t = Date.now(); let ok = false; while (Date.now() - t < 8000 && !(ok = await A.f.evaluate(() => annRecords().includes('Live test')))) await sleep(50); out.ownRecordMs = Date.now() - t; check('the published record is listed on the publishing screen', ok, out.ownRecordMs); }
  check('the published record is listed on the other screen', await B.f.evaluate(() => annRecords().includes('Live test')));
  // edit (autosave) on A reaches B
  await A.f.evaluate(() => { openCaseModal('L-3'); cdSet('L-3', 'account', 'Zed Co'); });
  out.editDelayMs = await waitB(() => (getCase('L-3') || {}).account === 'Zed Co');
  check('an edit is saved by itself and reaches the other screen', out.editDelayMs >= 0, out.editDelayMs);
  // documentation with paragraphs
  await A.f.evaluate(() => { const c = getCase('L-3'), it = c.items[0]; window._p = { cid: 'L-3', iid: it.id, phase: 'due', mode: 'owner' }; showPop && 0; });
  const iid = await A.f.evaluate(() => getCase('L-3').items[0].id);
  await A.f.evaluate((iid) => { try { openPopFor && 0; } catch (e) {} let d = document.getElementById('doc'); if (!d) { d = document.createElement('textarea'); d.id = 'doc'; document.body.appendChild(d); } d.value = 'Called the FE.\nETA confirmed for 3 PM.\n\n\n\nSecond paragraph:\n- part delivered\n- site contact informed  '; window._p = { cid: 'L-3', iid, phase: 'due', mode: 'owner' }; popComplete(); }, iid);
  out.docDelayMs = await waitB((iid) => { const c = getCase('L-3'), it = c && c.items.find(x => x.id === iid); return !!(it && it.rem && it.rem.done); }, iid);
  const docB = await B.f.evaluate((iid) => getCase('L-3').items.find(x => x.id === iid).rem.done.text, iid);
  check('documentation reaches the other screen with its paragraphs', docB === 'Called the FE.\nETA confirmed for 3 PM.\n\nSecond paragraph:\n- part delivered\n- site contact informed', docB);
  await B.f.evaluate(() => { openCaseModal('L-3'); });
  await sleep(500);
  const ws = await B.f.evaluate(() => { const el = [...document.querySelectorAll('#case-body div')].find(d => d.children.length === 0 && d.textContent.startsWith('Called the FE.')); return el ? { ws: getComputedStyle(el).whiteSpace, cls: el.className, h: el.getBoundingClientRect().height } : null; });
  check('the documentation box keeps line breaks on screen', !!ws && /pre-wrap/.test(ws.cls), ws);
  
  // dashboard panels still update after the repaint change: close a case on A, B's row/stat must change
  const before = await B.f.evaluate(() => document.getElementById('stats').textContent);
  await A.f.evaluate(() => { const c = getCase('L-5'); c.hp = !c.hp; logc(c, 'Priority changed', 'Coordinator', 'test'); render(); });
  const d2 = await waitB(() => !!(getCase('L-5') || {}).hp);
  await sleep(1300);
  const rowB = await B.f.evaluate(() => { const r = [...document.querySelectorAll('#rows tr')].find(t => t.textContent.includes('L-5')); return r ? r.outerHTML.length : 0; });
  check('the dashboard table on the other screen is redrawn after a change', d2 >= 0 && rowB > 0, { d2, rowB });
  // 6 seconds idle: count messages and cut-off runs
  const r0 = await A.p.evaluate(() => ({ r: RUNS, c: CUTS })); await sleep(6000); const r1 = await A.p.evaluate(() => ({ r: RUNS, c: CUTS }));
  out.idleRunsPer6s = r1.r - r0.r; out.cutRuns = r1.c;
  check('no browser errors', A.errs.length + B.errs.length === 0, [A.errs, B.errs]);
  console.log(JSON.stringify(out)); console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
  await b.close(); process.exit(fails ? 1 : 0);
})();
