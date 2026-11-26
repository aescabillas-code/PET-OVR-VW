// Two screens change the same case's checklist at the same moment: nothing is lost (items and alarms from both are kept).
//   python3 tests/live_host.py . 8821 &   node tests/live_checklist_merge.js 8821
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const open = async () => { const p = await (await b.newContext()).newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); return p.frames().find(x => x.url().includes('/app')); };
  const A = await open();
  const cid = await A.evaluate(() => { STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide();
    const c = mkCase('MG-77', STAFF.find(p => !isMgr(p)).name, { caseType: 'aruba', arubaNo: 'MG-77', account: 'Account A', recv: Date.now() }); CASES.unshift(c); logc(c, 'Case created', 'Jeff Bote', 't'); render(); return c.id });
  await sleep(2500);
  const B = await open(); await B.evaluate(() => { ME = { role: 'manager', name: 'Jose Teves' }; applyMe(); lpHide() }); await sleep(1500);
  for (let round = 0; round < 3; round++) {
    // both screens add an item at the same moment; B also sets an alarm on its item
    await Promise.all([
      A.evaluate(([id, r]) => { const c = getCase(id); c.items.push({ id: uid(), text: 'From A #' + r, done: false, rem: null, by: 'Jeff Bote', at: Date.now() }); queueSave(c) }, [cid, round]),
      B.evaluate(([id, r]) => { const c = getCase(id); c.items.push({ id: uid(), text: 'From B #' + r, done: false, rem: { at: Date.now() + 36e5, text: 'alarm', by: 'Jose Teves' }, by: 'Jose Teves', at: Date.now() }); queueSave(c) }, [cid, round])
    ]);
    await sleep(1200);
  }
  await sleep(4000);
  const db = await A.evaluate(async id => { const s = await dbq.doc('cases/' + id).get(); return s.data().items.map(x => x.text + (x.rem ? ' ⏰' : '')) }, cid);
  const onA = await A.evaluate(id => getCase(id).items.map(x => x.text), cid), onB = await B.evaluate(id => getCase(id).items.map(x => x.text), cid);
  const want = [0, 1, 2].flatMap(r => ['From A #' + r, 'From B #' + r]);
  check('every item added on either screen is saved', want.every(w => db.some(x => x.startsWith(w))), db);
  check('the alarms set on screen B are all kept', db.filter(x => x.startsWith('From B') && x.endsWith('⏰')).length === 3, db);
  check('both screens show all the items', want.every(w => onA.includes(w)) && want.every(w => onB.includes(w)), { onA, onB });
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
