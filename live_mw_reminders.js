// Live (Nov 27, 19:20): Maintenance Window Reminder tile (blinks red, lists cases whose maintenance window start passed),
// pop-up when a case without a future maintenance window is opened, the owner's notice 10 minutes before the start
// (Acknowledge is recorded in the case and reaches the other screen), and the stronger Due Reminders flash.
//   python3 tests/live_host.py . 8831 &   node tests/live_mw_reminders.js 8831 [screenshot-dir]
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');
const MOCK = `(function(){window.__xl={books:[],saved:[]};
function Cell(){this.value=undefined}
function Row(ws,r){this.ws=ws;this.r=r;this.cells={}}
Row.prototype.getCell=function(c){return this.cells[c]||(this.cells[c]=new Cell())};
Object.defineProperty(Row.prototype,'height',{set(v){},get(){return 0}});
Row.prototype.eachCell=function(o,cb){if(typeof o==='function')cb=o;Object.keys(this.cells).sort((a,b)=>a-b).forEach(k=>cb(this.cells[k],+k))};
function WS(name){this.name=name;this.rows={};this.merges=[];this.images=0;this._cols=[];this.autoFilter=null;this.n=0}
WS.prototype.getRow=function(r){return this.rows[r]||(this.rows[r]=new Row(this,r))};
WS.prototype.getCell=function(r,c){return this.getRow(r).getCell(c)};
WS.prototype.getColumn=function(i){return this._cols[i]||(this._cols[i]={width:10})};
WS.prototype.mergeCells=function(){this.merges.push([].slice.call(arguments))};
WS.prototype.addImage=function(){this.images++};
Object.defineProperty(WS.prototype,'columns',{set(v){this._keys=v.map(x=>x.key);const r=this.getRow(1);v.forEach((x,i)=>{r.getCell(i+1).value=x.header});this.n=1},get(){return this._keys}});
WS.prototype.addRow=function(o){const r=this.getRow(++this.n);(this._keys||[]).forEach((k,i)=>{r.getCell(i+1).value=o[k]});return r};
WS.prototype.eachRow=function(cb){Object.keys(this.rows).sort((a,b)=>a-b).forEach(k=>cb(this.rows[k],+k))};
window.ExcelJS={Workbook:function(){const wb={sheets:[],addWorksheet(n){const w=new WS(n);this.sheets.push(w);return w},addImage(){return 1},xlsx:{writeBuffer:async()=>new Uint8Array([1,2,3])}};window.__xl.books.push(wb);return wb}};
})();`;
(async () => {
  const b = await chromium.launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(JSON.stringify(x)).slice(0, 400))); if (!ok) fails++; };
  const shots = process.argv[3] || '';
  const open = async () => { const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); return [p, p.frames().find(x => x.url().includes('/app'))]; };
  const until = async (F, fn, arg) => { for (let i = 0; i < 48; i++) { if (await F.evaluate(fn, arg)) return i * 250; await sleep(250) } return -1 };
  const [pa, A] = await open();
  const agent = await A.evaluate(() => { const T = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') }, nm = minOf(simNow()), on = name => ({ name, role: 'Support', start: T(nm - 60), end: T(nm + 400), days: [1, 1, 1, 1, 1, 1, 1], status: 'available' });
    STAFF = [on('Mwl Agent'), on('Mwl Other')]; ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); const a = 'Mwl Agent';
    ME = { role: 'agent', name: a }; SIM_USER = a; applyMe(); saveMe(); lpHide(); try { hideWelcome() } catch (e) {}
    const M = 60000, n = Date.now(), mk = (id, s, x) => { const c = mkCase(id, a, { account: 'Store ' + id }); if (s != null) c.mw = { s: n + s, e: null, tz: 'ET', by: 'System', ts: n - 36e5 }; Object.assign(c, x || {}); CASES.unshift(c); queueSave(c); return c };
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
  check('clicking the Maintenance Window Reminder tile stops its blinking (Nov 28)', await A.evaluate(() => { const t = document.querySelector('#stats .tile-mw'); return !t.classList.contains('mw-tile') && t.classList.contains('stat-sel') }));
  // Extract Excel for the selected tile: on the same line as + Add Case, only the cases under that tile
  const bl = await A.evaluate(() => { const m = ME, su = SIM_USER; ME = { role: 'manager', name: 'Jeff Bote' }; SIM_USER = 'Jeff Bote'; applyMe(); render(); const a = document.getElementById('add-btn').getBoundingClientRect(), x = document.getElementById('xv-btn').getBoundingClientRect(); const o = { a: Math.round(a.top + a.height / 2), x: Math.round(x.top + x.height / 2), vis: x.width > 0, after: x.left > a.left }; ME = m; SIM_USER = su; applyMe(); render(); o.agent = document.getElementById('xv-btn').getBoundingClientRect().width > 0; return o });
  check('"Extract Excel" sits on the same line as + Add Case (and agents have it too)', bl.vis && Math.abs(bl.a - bl.x) <= 2 && bl.after && bl.agent, bl);
  await A.evaluate(MOCK); await A.evaluate(() => { window.saveBlob = (bl, n) => { window.__xl.saved.push(n) } });
  await A.click('#xv-btn'); await sleep(600);
  const xv = await A.evaluate(() => { const wb = window.__xl.books.slice(-1)[0], ws = wb && wb.sheets[0]; if (!ws) return null; const cell = (r, c) => { const x = ws.rows[r] && ws.rows[r].cells[c]; return x ? x.value : undefined }; const ids = []; for (let r = 5; r < 5 + 50; r++) { const v = cell(r, 1); if (v == null || v === '') break; ids.push(String(v)) } return { name: ws.name, title: cell(1, 1), sub: cell(2, 1), h: [cell(4, 1), cell(4, 4), cell(4, 5)], ids, file: window.__xl.saved.slice(-1)[0], font: ws.rows[4] && ws.rows[4].cells[1] && ws.rows[4].cells[1].font, filt: !!ws.autoFilter } });
  check('... it downloads only the cases under the selected tile (Maintenance Window Passed), formatted', !!xv && xv.name === 'Maintenance Window Passed' && /PAT · Maintenance Window Passed/.test(xv.title) && xv.ids.join() === 'MWL-PAST' && xv.h[1] === 'Maintenance window start (EST)' && /EST/.test(String(xv.sub)) && /^PAT_Maintenance_Window_Passed_\d{4}-\d\d-\d\d\.xlsx$/.test(xv.file) && !!xv.font && xv.font.bold && xv.filt, xv);
  if (shots) await pa.screenshot({ path: shots + '/toolbar.png', clip: { x: 0, y: 300, width: 1440, height: 260 } });
  const rows = await A.evaluate(() => [...document.querySelectorAll('#rows tr')].map(r => r.textContent).join('|'));
  check('clicking the tile lists the cases whose maintenance window start passed', rows.includes('MWL-PAST') && !rows.includes('MWL-SOON') && !rows.includes('MWL-NONE') && !rows.includes('MWL-LATER'), rows.slice(0, 300));
  await A.click('#stats .tile-mw', { force: true }); await sleep(300);
  await A.click('#xv-btn'); await sleep(600);
  check('... with the Active Cases view it downloads the active cases', await A.evaluate(() => { const wb = window.__xl.books.slice(-1)[0], ws = wb.sheets[0]; const ids = []; for (let r = 5; r < 60; r++) { const x = ws.rows[r] && ws.rows[r].cells[1]; if (!x || !x.value) break; ids.push(x.value) } return ws.name === 'Active Cases' && ['MWL-NONE', 'MWL-PAST', 'MWL-SOON', 'MWL-LATER', 'MWL-DUE'].every(i => ids.includes(i)) }));
  await A.evaluate(() => ackTile()); await sleep(300); await A.click('#xv-btn'); await sleep(600);
  check('... and with Due Reminders selected only the cases with a due reminder (with the reminder and ETA)', await A.evaluate(() => { const wb = window.__xl.books.slice(-1)[0], ws = wb.sheets[0]; const ids = []; for (let r = 5; r < 60; r++) { const x = ws.rows[r] && ws.rows[r].cells[1]; if (!x || !x.value) break; ids.push(x.value) } return ws.name === 'Due Reminders' && ids.includes('MWL-DUE') && !ids.includes('MWL-SOON') && ws.rows[4].cells[4].value === 'Due reminders (past their ETA)' && /Call the store/.test(ws.rows[5 + ids.indexOf('MWL-DUE')].cells[4].value) }));
  await A.evaluate(() => setDash('active')); await sleep(300);
  check('the Maintenance Window Reminder tile stays still after the click (same cases)', await A.evaluate(() => !document.querySelector('#stats .tile-mw').classList.contains('mw-tile')));
  await A.evaluate(() => { const c = mkCase('MWL-NEW', 'Mwl Agent', { account: 'Store new' }); c.mw = { s: Date.now() - 5 * 60000, e: null, tz: 'ET', by: 'System', ts: Date.now() - 36e5 }; CASES.unshift(c); queueSave(c); RID++; render() }); await sleep(400);
  check('... and blinks again when another case passes its maintenance window start', await A.evaluate(() => document.querySelector('#stats .tile-mw').classList.contains('mw-tile')));
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
