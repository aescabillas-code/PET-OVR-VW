// Live (Nov 27): (1) tools added and named quickly are saved the first time — they stay on this screen and reach the other
// screen, even while copies from before the save come back; (2) a long announcement is wider, scrolls inside, and the
// Acknowledge button can always be reached.
//   python3 tests/live_host.py . 8827 &   node tests/live_tools_and_announcement.js 8827 [screenshot-dir]
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const shots = process.argv[3] || '';
  const open = async (vp) => { const ctx = await b.newContext({ viewport: vp || { width: 1400, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); return [p, p.frames().find(x => x.url().includes('/app'))]; };
  const until = async (F, fn, arg) => { for (let i = 0; i < 48; i++) { if (await F.evaluate(fn, arg)) return i * 250; await sleep(250) } return -1 };
  const [pa, A] = await open();
  await A.evaluate(() => { STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide(); try { hideWelcome() } catch (e) {} render() });
  await sleep(1200);
  const [pb, B] = await open(); await B.evaluate(() => { ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); lpHide(); try { hideWelcome() } catch (e) {} }); await sleep(1000);
  // (1) tools: add three tools back to back and type their names/links like a person would
  await A.evaluate(() => { TOOLS = []; toolSave(true) }); await sleep(2500);   // start from an empty tool list
  await A.evaluate(() => { openSettings(); setTabTo('tools') }); await sleep(400);
  for (let k = 1; k <= 3; k++) {
    await A.evaluate(() => [...document.querySelectorAll('#set-body button')].find(x => /Add a tool/.test(x.textContent)).click()); await sleep(120);
    const ins = await A.$$('#tl-editor input[oninput*="\'name\'"]'); await ins[ins.length - 1].fill(''); await ins[ins.length - 1].type('Tool ' + k, { delay: 15 });
    const urls = await A.$$('#tl-editor input[oninput*="\'url\'"]'); await urls[urls.length - 1].fill('https://example.com/t' + k + '?id={ritm}');
    // a copy from before these changes arrives (the echo that used to undo them)
    await A.evaluate(() => toolsSnap({ list: [], log: false, ts: Date.now() - 5000 }));
    await A.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur() });
    await A.evaluate(() => toolsSnap({ list: [], log: false, ts: Date.now() - 5000 }));
  }
  await sleep(900);
  check('three tools added quickly stay on this screen with their names', await A.evaluate(() => TOOLS.map(t => t.name).join('|')) === 'Tool 1|Tool 2|Tool 3', await A.evaluate(() => TOOLS.map(t => t.name)));
  let w = await until(B, () => TOOLS.map(t => t.name + '>' + t.url).join('|') === 'Tool 1>https://example.com/t1?id={ritm}|Tool 2>https://example.com/t2?id={ritm}|Tool 3>https://example.com/t3?id={ritm}');
  check('... saved the first time: the other screen gets all three (names and links)', w >= 0, await B.evaluate(() => TOOLS.map(t => t.name)));
  await sleep(2500);
  check('... still there a few seconds later (not undone by older copies)', await A.evaluate(() => TOOLS.length) === 3 && await B.evaluate(() => TOOLS.length) === 3);
  // reload A: the tools come back from the server
  await pa.reload(); await sleep(4000); const A2 = pa.frames().find(x => x.url().includes('/app'));
  check('... and after a reload', await A2.evaluate(() => TOOLS.map(t => t.name).join('|')) === 'Tool 1|Tool 2|Tool 3');
  // another lead's later change is still accepted
  await B.evaluate(() => { openSettings(); setTabTo('tools'); window.confirmOk = () => true; toolDel(1) }); await sleep(200);
  w = await until(A2, () => TOOLS.map(t => t.name).join('|') === 'Tool 1|Tool 3');
  check('... a later change from another screen still comes through', w >= 0, await A2.evaluate(() => TOOLS.map(t => t.name)));
  // (2) long announcement
  const [pc, C] = await open({ width: 1280, height: 720 });
  await C.evaluate(() => { ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); lpHide(); try { hideWelcome() } catch (e) {}
    const a = { id: 'ann-long', title: 'Holiday coverage plan', msg: Array.from({ length: 90 }, (_, i) => 'Line ' + (i + 1) + ': please read the coverage notes for the holiday week carefully.').join('\n'), by: 'Jeff Bote', at: fmt12(new Date()), ts: Date.now(), to: 'all', mentions: [] }; ANN.unshift(a); showAnn('ann-long') });
  await sleep(2600);
  const box = await C.evaluate(() => { const c = document.getElementById('ann-pop-card').getBoundingClientRect(), bt = [...document.querySelectorAll('#ann-pop-card button')].find(x => /Acknowledge/.test(x.textContent)).getBoundingClientRect(), body = document.querySelector('#ann-pop-card .ann-body'); return { w: Math.round(c.width), top: Math.round(c.top), bottom: Math.round(c.bottom), bt: Math.round(bt.bottom), vh: innerHeight, scroll: body.scrollHeight > body.clientHeight } });
  check('long announcement: wider card (42rem ≈ 546 px at the 13 px text size; was 32rem ≈ 416 px)', box.w >= 520 && box.w <= 700, box);
  check('... it fits the screen and its text scrolls inside', box.top >= 0 && box.bottom <= box.vh && box.scroll, box);
  check('... the Acknowledge button is on screen without scrolling', box.bt <= box.vh, box);
  if (shots) await pc.screenshot({ path: shots + '/announcement_long.png' });
  await C.evaluate(() => { const b = document.querySelector('#ann-pop-card .ann-body'); b.scrollTop = b.scrollHeight }); await sleep(200);
  check('... the last line can be scrolled to', await C.evaluate(() => { const b = document.querySelector('#ann-pop-card .ann-body'); return Math.abs(b.scrollTop + b.clientHeight - b.scrollHeight) < 3 }));
  await C.click('#ann-pop-card button:has-text("Acknowledge")'); await sleep(400);
  check('... Acknowledge works and closes it', await C.evaluate(() => document.getElementById('ann-pop').classList.contains('hidden') && ACKS.some(x => x.ann === 'ann-long')));
  // phone size
  const [pd, D] = await open({ width: 390, height: 740 });
  await D.evaluate(() => { ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); lpHide(); try { hideWelcome() } catch (e) {}
    const a = { id: 'ann-long2', title: 'Holiday coverage plan', msg: Array.from({ length: 90 }, (_, i) => 'Line ' + (i + 1)).join('\n'), by: 'Jeff Bote', at: fmt12(new Date()), ts: Date.now(), to: 'all', mentions: [] }; ANN.unshift(a); showAnn('ann-long2') });
  await sleep(2600);
  check('... on a phone the Acknowledge button is reachable too', await D.evaluate(() => { const bt = [...document.querySelectorAll('#ann-pop-card button')].find(x => /Acknowledge/.test(x.textContent)).getBoundingClientRect(); return bt.bottom <= innerHeight && bt.top >= 0 }));
  if (shots) await pd.screenshot({ path: shots + '/announcement_phone.png' });
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
