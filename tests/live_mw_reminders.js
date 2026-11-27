// Live (Nov 27, 19:20): Maintenance Window Reminder tile (blinks red, lists cases whose maintenance window start passed),
// pop-up when a case without a future maintenance window is opened, the owner's notice 10 minutes before the start
// (Acknowledge is recorded in the case and reaches the other screen), and the stronger Due Reminders flash.
//   python3 tests/live_host.py . 8831 &   node tests/live_mw_reminders.js 8831 [screenshot-dir]
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(JSON.stringify(x)).slice(0, 400))); if (!ok) fails++; };
  const shots = process.argv[3] || '';
  const open = async () => { const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); return [p, p.frames().find(x => x.url().includes('/app'))]; };
  const until = async (F, fn, arg) => { for (let i = 0; i < 48; i++) { if (await F.evaluate(fn, arg)) return i * 250; await sleep(250) } return -1 };
  const [pa, A] = await open();
  const agent = await A.evaluate(() => { const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') }, nm = minOf(simNow()), on = name => ({ name, role: 'Support', start: T(nm - 60), end: T(nm + 400), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    STAFF = [on('Mwl Agent'), on('Mwl Other')]; ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); const a = 'Mwl Agent';
    ME = { role: 'agent', name: a }; SIM_USER = a; applyMe(); saveMe(); lpHide(); try { hideWelcome() } catch (e) {}
    const M = 60000, n = Date.now(), mk = (id, s, x) => { const c = mkCase(id, a, { account: 'Store ' + id }); if (s != null) c.mw = { s: n + s, e: null, by: 'System', ts: n - 36e5 }; Object.assign(c, x || {}); CASES.unshift(c); queueSave(c); return c };
    mk('MWL-NONE', null); mk('MWL-PAST', -45 * M); mk('MWL-SOON', 8 * M); mk('MWL-LATER', 3 * 36e5);
    const d = mk('MWL-DUE', 5 * 36e5); d.items.push({ id: 'dl1', text: 'Call the store', done: false, rem: { at: n - 60000, text: 'Call the store', by: a, setAt: n - 36e5 } }); queueSave(d);
    TRIG++; render(); return a });
  await sleep(1500);
  const tiles = await A.evaluate(() => [...document.querySelectorAll('#stats > div')].map(t => ({ t: t.textContent.replace(/\s+/g, ' ').trim().slice(0, 40), cls: t.className, top: t.offsetTop })));
  check('five tiles in one row on a wide screen; Maintenance Window Reminder right after Active Cases', tiles.length === 5 && /Active Cases/.test(tiles[1].t) && /Maintenance Window Reminder/.test(tiles[2].t) && /Due Reminders/.test(tiles[3].t) && tiles.every(x => x.top === tiles[0].top), tiles);
  check('... it blinks red (cases past their maintenance window start) and the Due Reminders tile flashes', /mw-tile/.test(tiles[2].cls) && /due-tile/.test(tiles[3].cls), tiles.map(x => x.cls));
  const anim = await A.evaluate(() => { const t = document.querySelector('#stats .due-tile'), a = getComputedStyle(t), f = getComputedStyle(t, '::after'); return { name: a.animationName, dur: a.animationDuration, after: f.animationName, afterDur: f.animationDuration, content: f.content } });
  check('... flashing: pulsing red ring and glow plus a fast flashing red inner border', anim.name === 'dueblink' && anim.dur === '0.7s' && anim.after === 'dueflash' && anim.afterDur === '0.35s', anim);
  if (shots) await pa.screenshot({ path: shots + '/tiles.png', clip: { x: 0, y: 0, width: 1440, height: 330 } });
  await A.click('#stats .tile-mw', { force: true }); await sleep(400);
  const rows = await A.evaluate(() => [...document.querySelectorAll('#rows tr')].map(r => r.textContent).join('|'));
  check('clicking the tile lists the cases whose maintenance window start passed', rows.includes('MWL-PAST') && !rows.includes('MWL-SOON') && !rows.includes('MWL-NONE') && !rows.includes('MWL-LATER'), rows.slice(0, 300));
  await A.click('#stats .tile-mw', { force: true }); await sleep(300);
  check('... clicking it again shows the active cases again', await A.evaluate(() => !MWF && [...document.querySelectorAll('#rows tr')].some(r => r.textContent.includes('MWL-SOON'))));
  // the notice 10 minutes before the start (with the case that started 45 min ago still waiting)
  let w = await until(A, () => { const b = document.getElementById('mwn-pop'); return b && !b.classList.contains('hidden') && b.textContent.includes('MWL-SOON') });
  const nt = await A.evaluate(() => document.getElementById('mwn-pop').textContent + (document.getElementById('mwn-pop').textContent ? '' : ' DEBUG ' + JSON.stringify({ me: ME, n: CASES.length, l: mwnList().map(c => c.id), c: (getCase('MWL-SOON') || {}).owner, mw: (getCase('MWL-SOON') || {}).mw })));
  check('the owner gets the maintenance window notice (bottom right, like the transfer notice)', w >= 0 && nt.includes('Maintenance window reminder') && /starts in (8|9|10) min/.test(nt) && !nt.includes('MWL-LATER'), nt.slice(0, 300));
  if (shots) await pa.screenshot({ path: shots + '/notice.png' });
  // second screen (manager) to see the acknowledgement arrive
  const [pb, B] = await open(); await B.evaluate(() => { ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); lpHide(); try { hideWelcome() } catch (e) {} }); await sleep(800);
  check('the manager screen gets no notice for the agent\'s case', await B.evaluate(() => document.getElementById('mwn-pop').classList.contains('hidden')));
  await A.evaluate(() => [...document.querySelectorAll('#mwn-pop button')].find(x => x.textContent.trim() === 'Acknowledge' && x.getAttribute('onclick').includes('MWL-SOON')).click()); await sleep(500);
  check('Acknowledge records it in the case', await A.evaluate(() => { const c = getCase('MWL-SOON'); return !!(c.mwAck && c.mwAck.s === c.mw.s && c.log.some(l => l.action === 'Maintenance window reminder acknowledged')) }));
  w = await until(B, () => { const c = getCase('MWL-SOON'); return !!(c && c.mwAck && c.mwAck.s) });
  check('... and the other screen gets it within seconds (realtime)', w >= 0, w);
  // pop-up when opening a case
  await A.evaluate(() => openCaseModal('MWL-NONE')); await sleep(500);
  const q = await A.evaluate(() => { const b = document.getElementById('mwq-pop'); const r = b.firstElementChild && b.firstElementChild.getBoundingClientRect(); return { vis: !b.classList.contains('hidden'), t: b.textContent, w: r ? Math.round(r.width) : 0 } });
  check('opening a case with no maintenance window start shows the pop-up', q.vis && q.t.includes('Add the maintenance window') && q.w > 300, q);
  if (shots) await pa.screenshot({ path: shots + '/popup_add.png' });
  await A.click('#mwq-pop button:has-text("Go to maintenance window")'); await sleep(900);
  check('... "Go to maintenance window" closes it and brings the maintenance window section into view', await A.evaluate(() => { const b = document.getElementById('mwq-pop'), s = document.getElementById('mw-sec'), r = s.getBoundingClientRect(); return b.classList.contains('hidden') && r.top >= 0 && r.bottom <= innerHeight + 40 && s.classList.contains('mw-hl') }));
  if (shots) await pa.screenshot({ path: shots + '/mw_section.png' });
  await A.evaluate(() => { hide('case-modal'); openId = null; openCaseModal('MWL-PAST') }); await sleep(500);
  check('... a case whose start already passed asks to update it', await A.evaluate(() => { const b = document.getElementById('mwq-pop'); return !b.classList.contains('hidden') && b.textContent.includes('Update the maintenance window') }));
  if (shots) await pa.screenshot({ path: shots + '/popup_update.png' });
  await A.click('#mwq-pop button:has-text("Later")'); await sleep(300);
  check('... "Later" closes it and the case window stays open', await A.evaluate(() => document.getElementById('mwq-pop').classList.contains('hidden') && !document.getElementById('case-modal').classList.contains('hidden')));
  await A.evaluate(() => { hide('case-modal'); openId = null; openCaseModal('MWL-PAST') }); await sleep(500);
  check('... after the owner clicked Later it does not pop up again for that case (Nov 27, 21:35)', await A.evaluate(() => document.getElementById('mwq-pop').classList.contains('hidden') && !!getCase('MWL-PAST').mwLater));
  w = await until(B, () => { const c = getCase('MWL-PAST'); return !!(c && c.mwLater && c.mwLater.k) });
  check('... and that choice reaches the other screen (it stays hidden there while the owner keeps the case)', w >= 0 && await B.evaluate(() => { hide('case-modal'); openId = null; openCaseModal('MWL-PAST'); return document.getElementById('mwq-pop').classList.contains('hidden') }));
  await B.evaluate(() => { hide('case-modal'); openId = null });
  await A.evaluate(() => { hide('case-modal'); openId = null; openCaseModal('MWL-LATER') }); await sleep(400);
  check('... no pop-up for a future maintenance window', await A.evaluate(() => document.getElementById('mwq-pop').classList.contains('hidden')));
  // phone size: tiles wrap, pop-up fits
  await pa.setViewportSize({ width: 390, height: 780 }); await A.evaluate(() => { hide('case-modal'); openId = null; openCaseModal('MWL-NONE') }); await sleep(500);
  check('on a phone the pop-up fits the screen', await A.evaluate(() => { const r = document.querySelector('#mwq-pop > div').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }));
  if (shots) await pa.screenshot({ path: shots + '/popup_phone.png' });
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
