// Closing a case by accident, or opening another one from an alert, never loses what was typed (Nov 18).
const { chromium } = require('playwright'), path = require('path');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 850 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('file://' + path.join(__dirname, '..', 'web', 'pet_station.html')); await p.waitForTimeout(2500);
  await p.evaluate(() => { ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); document.getElementById('landing').style.display = 'none'; CASES.length = 0; CASES.push(mkCase('PET-7', STAFF[1].name, {})); CASES.push(mkCase('PET-8', STAFF[1].name, {})); render(); openCaseModal('PET-7'); });
  await p.waitForTimeout(300);
  await p.evaluate(() => storeModeSet('PET-7', 'type')); await p.waitForTimeout(100);
  const n0 = await p.evaluate(() => ({ items: getCase('PET-7').items.length, log: getCase('PET-7').log.length }));
  await p.click('#cd-store'); await p.keyboard.type('4455');
  await p.waitForTimeout(800);
  const rt = await p.evaluate(() => ({ store: getCase('PET-7').store, log: getCase('PET-7').log.filter(l => /Store/.test(l.action)).length, f: document.activeElement.id }));
  ok(rt.store === '4455' && rt.f === 'cd-store', 'a case field is saved while typing, quietly (still typing in it)');
  ok(rt.log === 0, 'no history line per key');
  await p.fill('#new-in', 'Call the site'); await p.fill('#wo-tid', 'T-100');
  await p.evaluate(() => { rvSet('PET-7', 'needed', true, true); rvSet('PET-7', 'cause', Object.keys(RVPH).find(k => k !== 'def'), true); });
  await p.fill('#rv-tid', 'RV-1');
  await p.evaluate(() => openCaseModal('PET-8'));   // an alert opens another case
  await p.waitForTimeout(100);
  const after = await p.evaluate(() => { const c = getCase('PET-7'); return { items: c.items.length, orders: c.orders.length, dft: c.dft, log: c.log.filter(l => /Store/.test(l.action)).length }; });
  ok(after.items === n0.items && after.orders === 0, 'nothing is added without its button');
  ok(after.dft && after.dft.f['new-in'] === 'Call the site' && after.dft.f['wo-tid'] === 'T-100' && after.dft.rv && after.dft.rv.tid === 'RV-1', 'what was typed is kept with the case ' + JSON.stringify(after.dft));
  ok(after.log === 1, 'leaving the field wrote its history line once');
  await p.evaluate(() => closeCase());
  await p.evaluate(() => { const c = getCase('PET-7'); c.rvDraft = null; c.rvEdit = false; openCaseModal('PET-7'); });   // reopened (also as on another screen)
  await p.waitForTimeout(200);
  const back = await p.evaluate(() => ({ s: document.getElementById('cd-store').value, ni: document.getElementById('new-in').value, t: document.getElementById('wo-tid').value, rv: (document.getElementById('rv-tid') || {}).value }));
  ok(back.s === '4455' && back.ni === 'Call the site' && back.t === 'T-100' && back.rv === 'RV-1', 'everything is there when the case is opened again ' + JSON.stringify(back));
  await p.evaluate(() => addItem('PET-7')); await p.waitForTimeout(600);
  const d2 = await p.evaluate(() => ({ items: getCase('PET-7').items.length, dft: getCase('PET-7').dft }));
  ok(d2.items === n0.items + 1 && d2.dft && !d2.dft.f['new-in'] && d2.dft.f['wo-tid'] === 'T-100', 'the Add button works as before and the kept copy of that entry is cleared');
  await p.evaluate(() => closeCase());
  ok(!errs.length, 'no browser errors ' + errs.join(' | '));
  await b.close();
  console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
