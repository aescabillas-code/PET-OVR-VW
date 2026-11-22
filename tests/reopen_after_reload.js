// If the page reloads (the app restarted or the connection was replaced), the case that was open comes back (Nov 18).
// Usage: start `python3 tests/live_host.py "$PWD" PORT`, then `node tests/reopen_after_reload.js PORT`.
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const port = process.argv[2] || '8765';
  const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  const fr = () => p.frames().find(f => f.url().includes('/app'));
  const signIn = () => fr().evaluate(() => { ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); });
  await p.goto('http://127.0.0.1:' + port + '/'); await p.waitForTimeout(6000);
  await signIn();
  await fr().evaluate(() => { const c = mkCase('RO-1', STAFF[1] ? STAFF[1].name : 'Jeff Bote', {}); CASES.push(c); queueSave(c); });
  await p.waitForTimeout(2500);
  await fr().evaluate(() => openCaseModal('RO-1'));
  await p.reload(); await p.waitForTimeout(6000); await signIn(); await p.waitForTimeout(2500);
  ok(await fr().evaluate(() => openId) === 'RO-1', 'the open case is open again after the page reloads');
  await fr().evaluate(() => closeCase()); await p.reload(); await p.waitForTimeout(6000); await signIn(); await p.waitForTimeout(2500);
  ok(await fr().evaluate(() => openId) == null, 'a case the user closed does not come back');
  ok(!errs.length, 'no browser errors ' + errs.join(' | '));
  await b.close();
  console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
