// Live check of attendance across screens: an agent signs in (or reopens PAT with the saved sign-in), the log-in is saved with the
// right time, and a manager's screen that is already open stops showing the agent Absent within seconds.
//   python3 tests/live_host.py . 8807 &   node tests/live_attendance.js 8807
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); let fails = 0; const errs = [];
  const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const open = async ctx => { const p = await (ctx || b).newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); return [p, p.frames().find(x => x.url().includes('/app'))]; };
  const [, m] = await open();
  const names = await m.evaluate(() => { const nm = minOf(simNow()), T = x => { x = ((x % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
    STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); const ag = STAFF.filter(p => !isMgr(p)).slice(0, 2); const k = dkey(wall(Date.now()));
    ag.forEach(a => { a.msch = {}; a.msch[k] = T(nm - 45) + '-' + T(nm + 300) }); STAFFLOADED = true; saveStaff(true, true); ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide(); return ag.map(a => a.name) });
  await sleep(3000);
  check('before signing in, the agents are shown Absent on the manager screen', await m.evaluate(n => n.every(x => isAbsentNow(pers(x), simNow())), names));
  // agent 1 signs in now (45 min after the start)
  const c1 = await b.newContext(); const [, a1] = await open(c1);
  const t1 = Date.now(); await a1.evaluate(n => { ME = { role: 'agent', name: n }; applyMe(); saveMe(); SIGNED_IN_AT = Date.now(); ATT_FROM = +simNow(); recordAtt() }, names[0]);
  let w = -1; for (let i = 0; i < 60; i++) { if (await m.evaluate(n => !isAbsentNow(pers(n), simNow()), names[0])) { w = i * 250; break } await sleep(250) }
  check('agent signs in: the manager screen stops showing Absent within seconds', w >= 0, w);
  const r1 = await m.evaluate(n => ATT[attId(n, dkey(wall(Date.now())))] || null, names[0]);
  check('... with the log-in time when they signed in (45 min late)', r1 && Math.abs(r1.in - t1) < 5000 && r1.late >= 44 && r1.late <= 46, r1);
  // agent 2: signed in earlier on a page that was open until just now, then the page is reopened
  const c2 = await b.newContext(); const [p2, a2] = await open(c2);
  const sa = Date.now() - 50 * 60000;
  await a2.evaluate(([n, sa]) => { ME = { role: 'agent', name: n }; saveMe(); localStorage.setItem('pet_signed_in_at', String(sa)); localStorage.setItem('pat_seen_' + seenK(), String(Date.now() - 30000)) }, [names[1], sa]);
  await p2.reload(); await sleep(1000);
  w = -1; for (let i = 0; i < 80; i++) { if (await m.evaluate(n => !isAbsentNow(pers(n), simNow()), names[1])) { w = i * 250; break } await sleep(250) }
  const r2 = await m.evaluate(n => ATT[attId(n, dkey(wall(Date.now())))] || null, names[1]);
  check('agent reopens PAT with the saved sign-in: recorded, with the time they first signed in (on time: before the start)', w >= 0 && r2 && r2.late === 0, { w, r2 });
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
