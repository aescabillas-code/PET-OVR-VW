// A page left open with an older version shows a large red "please refresh" message (it no longer reloads by itself).
//   python3 tests/live_host.py . 8804 &   node tests/live_new_version.js 8804
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); let fails = 0; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const p = await b.newPage(); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500);
  let f = p.frames().find(x => x.url().includes('/app'));
  check('the page knows its version and the server sends the current one', await f.evaluate(() => typeof window.__PET_BUILD === 'string' && window.__PET_BUILD.length === 12));
  check('no message while the page is up to date', await f.evaluate(() => !document.getElementById('pet-update')));
  await f.evaluate(() => { window.__mark = 1; window.__PET_BUILD = 'oldversion00'; });
  await sleep(6000);
  const st = await f.evaluate(() => { const d = document.getElementById('pet-update'); return d ? { txt: d.textContent, bg: getComputedStyle(d).backgroundColor, fixed: getComputedStyle(d).position, w: d.getBoundingClientRect().width, vw: innerWidth } : null; });
  check('an older page shows a large red message across the screen asking to refresh', !!st && /refresh/i.test(st.txt) && st.bg === 'rgb(212, 0, 50)' && st.fixed === 'fixed' && st.w >= st.vw - 2, st);
  await sleep(65000);
  f = p.frames().find(x => x.url().includes('/app'));
  check('the page does not reload by itself (no interruptions)', await f.evaluate(() => window.__mark === 1));
  await f.evaluate(() => document.getElementById('pet-update-go').click()); await sleep(5000);
  f = p.frames().find(x => x.url().includes('/app'));
  const after = await f.evaluate(() => ({ mark: window.__mark || 0, msg: !!document.getElementById('pet-update') })).catch(() => ({ mark: 'gone' }));
  check('"Refresh now" reloads to the current version and the message is gone', after.mark !== 1 && after.msg === false, after);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
