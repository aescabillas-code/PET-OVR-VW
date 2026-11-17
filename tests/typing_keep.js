// Background redraws never disturb typing; case fields save quietly while typing, history when the field is left (Nov 18).
const { chromium } = require('playwright'), path = require('path');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 850 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('file://' + path.join(__dirname, '..', 'web', 'pet_station.html')); await p.waitForTimeout(2500);
  await p.evaluate(() => { ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); document.getElementById('landing').style.display = 'none'; CASES.length = 0; CASES.push(mkCase('PET-9', STAFF[1].name, {})); render(); openCaseModal('PET-9'); });
  await p.waitForTimeout(300);
  await p.click('#cd-store'); await p.keyboard.type('12');
  await p.evaluate(() => { for (let i = 0; i < 3; i++) { renderCase(); render(); } });   // another screen's change, the 1-second timer
  await p.keyboard.type('34');
  const r1 = await p.evaluate(() => ({ v: document.getElementById('cd-store').value, f: document.activeElement.id }));
  ok(r1.v === '1234' && r1.f === 'cd-store', 'typing continues through background redraws (text and cursor kept) ' + JSON.stringify(r1));
  await p.waitForTimeout(2400);
  ok(await p.evaluate(() => getCase('PET-9').store === '1234' && !getCase('PET-9').log.some(l => /Store/.test(l.action) && l.details === '1234')), 'saved quietly while typing (no history line yet)');
  await p.click('#cd-model'); await p.waitForTimeout(150);
  ok(await p.evaluate(() => getCase('PET-9').store) === '1234', 'leaving the field saves it, as before');
  await p.keyboard.type('AP'); await p.click('#cd-store'); await p.waitForTimeout(150);
  ok(await p.evaluate(() => getCase('PET-9').model) === 'AP', 'leaving the next field saves it too');
  await p.evaluate(() => { getCase('PET-9').model = 'AP-999'; renderCase(); });   // another screen changed it while the case is open
  await p.waitForTimeout(100);
  ok(await p.evaluate(() => document.getElementById('cd-model').value) === 'AP-999', 'a saved change from another screen shows in the open case (the old value is not kept on screen)');
  await p.evaluate(() => { document.getElementById('new-in').focus(); });
  await p.keyboard.type('Check cable'); await p.keyboard.press('Enter'); await p.waitForTimeout(150);
  ok(await p.evaluate(() => document.getElementById('new-in').value) === '', 'a submitted entry (Enter) is not put back after the redraw');
  ok(!errs.length, 'no browser errors ' + errs.join(' | '));
  await b.close();
  console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
