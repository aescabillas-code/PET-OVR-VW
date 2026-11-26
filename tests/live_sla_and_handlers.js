// Live (Nov 26): + Add Case sets the SLA (NBD / 4hr / 6hr CTR), the case list shows a Priority & SLA column, the checklist has
// no per-item delete button and the Acknowledge pop-up has no Change reminder button; the coordinator on duty approves
// temporary ownership on their own screen (3 handlers per case); changes reach the other screen (realtime unchanged).
//   python3 tests/live_host.py . 8825 &   node tests/live_sla_and_handlers.js 8825 [screenshot-dir]
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const shots = process.argv[3] || '';
  const open = async () => { const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); return [p, p.frames().find(x => x.url().includes('/app'))]; };
  const [pa, A] = await open();
  await A.evaluate(() => { STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide(); try { hideWelcome() } catch (e) {} render() });
  await sleep(1500);
  const [pb, B] = await open(); await B.evaluate(() => { ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); lpHide(); try { hideWelcome() } catch (e) {} }); await sleep(1500);
  // + Add Case with 4hr CTR
  await A.evaluate(() => openAdd()); await sleep(400);
  check('+ Add Case shows the SLA choice with NBD selected', await A.evaluate(() => { const on = document.querySelector('#add-card button[data-sla][aria-pressed="true"]'); return !!on && on.dataset.sla === 'NBD' && document.querySelectorAll('#add-card button[data-sla]').length === 3 && !document.querySelector('#add-card input[type="radio"]') }));
  await A.fill('#add-id', 'SLA-LIVE-1'); await A.click('#add-card button[data-sla="4H"]'); await sleep(200);
  if (shots) await pa.screenshot({ path: shots + '/add_case.png' });
  await A.evaluate(() => addCase()); await sleep(700);
  check('the new case has the 4hr CTR SLA', await A.evaluate(() => (getCase('SLA-LIVE-1') || {}).slaT) === '4H');
  await A.evaluate(() => { hide('case-modal'); openId = null; render() }); await sleep(300);
  const hdr = await A.evaluate(() => [...document.querySelectorAll('#cases-scroll thead th')].map(t => t.textContent.trim()).slice(0, 3).join('|'));
  check('Priority & SLA column right after Account Name', hdr === 'Account Name|Priority & SLA|Case Number', hdr);
  const row = await A.evaluate(() => { const tr = [...document.querySelectorAll('#rows tr')].find(r => r.textContent.includes('SLA-LIVE-1')); return tr ? [...tr.children].map(td => td.textContent.trim()) : [] });
  check('the row shows Standard and ⚡ 4hr CTR there, and the status cell no longer shows the priority', /Standard/.test(row[1] || '') && /4hr CTR/.test(row[1] || '') && !/Standard|High priority/.test(row[3] || ''), row);
  if (shots) await pa.screenshot({ path: shots + '/case_list.png' });
  // realtime: B sees the SLA
  let w = -1; for (let i = 0; i < 40; i++) { if (await B.evaluate(() => (getCase('SLA-LIVE-1') || {}).slaT === '4H')) { w = i * 250; break } await sleep(250) }
  check('the other screen gets the case with its SLA within seconds', w >= 0, w);
  // case window: SLA select, no delete button on checklist rows, no Change reminder in Acknowledge
  await A.evaluate(() => { openCaseModal('SLA-LIVE-1'); const c = getCase('SLA-LIVE-1'); c.items.push({ id: 'xit1', text: 'Call the store', done: false, rem: { at: Date.now() + 3600000, text: 'Call the store', by: 'Jeff Bote', setAt: Date.now() } }); renderCase() }); await sleep(500);
  check('case window has the SLA tiles', await A.evaluate(() => document.querySelectorAll('#case-body button[data-sla]').length === 3));
  check('no delete button on the checklist items', await A.evaluate(() => !document.querySelector('#case-body button[onclick^="delItem("]')));
  if (shots) await pa.screenshot({ path: shots + '/case_window.png' });
  await A.evaluate(() => openAck('SLA-LIVE-1', 'xit1')); await sleep(400);
  check('Acknowledge pop-up has no Change reminder button', await A.evaluate(() => document.getElementById('rem-pop-card').textContent.includes('Acknowledge') && !document.getElementById('rem-pop-card').textContent.includes('Change reminder')));
  await A.evaluate(() => popClose()); await A.evaluate(() => openCaseModal('SLA-LIVE-1')); await sleep(300); await A.click('#case-body button[data-sla="6H"]'); await sleep(200);
  w = -1; for (let i = 0; i < 40; i++) { if (await B.evaluate(() => (getCase('SLA-LIVE-1') || {}).slaT === '6H')) { w = i * 250; break } await sleep(250) }
  check('changing the SLA in the case window reaches the other screen', w >= 0, w);
  // temporary ownership: a request for the coordinator shown on B (signed in as that coordinator)
  const cod = await A.evaluate(() => { const p = STAFF.find(x => !isMgr(x)); return p.name });
  await A.evaluate(nm => { const c = getCase('SLA-LIVE-1'); reassign(c, HOQ, 'test', 'Jeff Bote'); c.tmp = { st: 'ask', to: nm, for: 'Someone Away', rg: 'EMEA', at: Date.now() }; queueSave(c); render() }, cod);
  await B.evaluate(nm => { ME = { role: 'agent', name: nm, coord: true }; applyMe() }, cod);
  w = -1; for (let i = 0; i < 40; i++) { if (await B.evaluate(() => { try { render() } catch (e) {} return !document.getElementById('xreq-pop').classList.contains('hidden') && document.getElementById('xreq-pop').textContent.includes('Temporary ownership') && document.getElementById('mention-modal').classList.contains('hidden') })) { w = i * 250; break } await sleep(250) }
  check('the coordinator gets the temporary-ownership request in the corner notification (no pop-up)', w >= 0, w);
  if (shots) await pb.screenshot({ path: shots + '/cod_popup.png' });
  await B.click('#xreq-pop button:has-text("Approve")'); await sleep(400);
  w = -1; for (let i = 0; i < 40; i++) { if (await A.evaluate(nm => (getCase('SLA-LIVE-1') || {}).owner === nm, cod)) { w = i * 250; break } await sleep(250) }
  check('approved: the case is with the coordinator on both screens', w >= 0 && await B.evaluate(() => getCase('SLA-LIVE-1').tmp.st) === 'ok', w);
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
