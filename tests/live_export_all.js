// Live (Nov 27): "Download all data (Excel)" builds the new workbook — Summary dashboard (tiles, graphs, Performance by region
// and period with filters), All Cases, Case History, SLA Report, Agent Attendance, Agent Full Numbers, Due Misses Report,
// Monthly Scorecard, then the raw data sheets — with complete sheet names; the quick exports are Excel, not CSV.
// The Excel library comes from the internet, so a recording stand-in is used and the written cells are checked.
//   python3 tests/live_host.py . 8829 &   node tests/live_export_all.js 8829
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  const b = await chromium.launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(JSON.stringify(x)).slice(0, 600))); if (!ok) fails++; };
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); const A = p.frames().find(x => x.url().includes('/app'));
  await A.evaluate(MOCK);
  await A.evaluate(() => { STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide(); try { hideWelcome() } catch (e) {}
    window.saveBlob = (bl, n) => { window.__xl.saved.push(n) };
    const ag = STAFF.filter(p => !isMgr(p)).map(p => p.name), H = 36e5, now = Date.now();
    for (let i = 0; i < 12; i++) { const c = mkCase('XA-' + i, ag[i % ag.length], { account: 'Store ' + (100 + i) }); c.recv = now - (40 - i * 3) * 24 * H; c.ts = c.recv; c.slaT = ['NBD', '4H', '6H'][i % 3];
      logc(c, 'Case received', 'System', 'Test case ' + i, { ts: c.recv, nosave: true });
      if (i % 2 === 0) { c.closed = true; c.closedAt = c.recv + (5 + i) * H; c.closedBy = c.owner; c.sla = i % 4 === 0 ? { met: true, who: '', other: '' } : { met: false, who: i % 3 ? 'Customer' : 'Other', other: i % 3 ? '' : 'Road closed' }; logc(c, 'Case closed', c.owner, 'closed', { ts: c.closedAt, nosave: true }) }
      if (i % 3 === 0) { c.orders = [{ id: 'o1', tid: 'T' + i + 'A', label: 'Replace PSU', by: 'Jeff Bote', at: '' }, { id: 'o2', tid: 'T' + i + 'B', label: 'Replace fan', by: 'Jeff Bote', at: '' }] }
      if (i % 4 === 1) { c.revisit = { cause: 'DOA', causeOther: '', tid: 'RV' + i, doc: 'Part dead on arrival', by: 'Jeff Bote', at: '' }; c.rvMore = [{ id: 'r2', cause: 'Customer', causeOther: '', tid: 'RV' + i + 'b', doc: 'No access', by: 'Jeff Bote', at: '' }] }
      CASES.push(c); queueSave(c) }
    for (let i = 0; i < 300; i++) { const c = mkCase('XB-' + i, ag[i % ag.length], { account: 'Bulk ' + i }); c.recv = now - (i % 60) * 24 * H; c.ts = c.recv; for (let k = 0; k < 8; k++) logc(c, 'Note', c.owner, 'x'.repeat(60), { ts: c.recv + k * H, nosave: true }); CASES.push(c); queueSave(c) }
    render() });
  await sleep(4000);
  // the view picked next to the button (Daily for this month) and the weekly / monthly views build too
  await A.evaluate(() => { XA.mode = 'all' });   // Nov 27 (18:20): the test cases span ~6 weeks, so the main checks download everything
  for (const v of ['weekly', 'monthly']) { await A.evaluate(async v => { XA.view = v; await exportAll() }, v); }
  const vw = await A.evaluate(() => window.__xl.books.map(b => { const s = b.sheets.find(x => x.name === 'Summary'); return s ? String(s.rows[2].cells[1].value) : '' }));
  check('Summary view can be Weekly or Monthly (picked next to the download button)', vw[0].includes('week by week') && vw[1].includes('month by month'), vw);
  await A.evaluate(() => { XA.view = 'daily'; XA.month = ''; XA.mode = 'all' });
  const t0 = Date.now(); await A.evaluate(async () => { await exportAll() }); const took = Date.now() - t0; console.log('export took ' + took + ' ms (312 cases, ~2,500 history lines; Excel writing itself is stubbed here)');
  await sleep(500);
  const res = await A.evaluate(() => { const wb = window.__xl.books[window.__xl.books.length - 1]; if (!wb) return null; const grid = ws => { const out = {}; Object.keys(ws.rows).forEach(r => { Object.keys(ws.rows[r].cells).forEach(c => { const v = ws.rows[r].cells[c].value; out[r + ':' + c] = v instanceof Date ? 'D:' + v.toISOString() : v }) }); return out };
    return { names: wb.sheets.map(s => s.name), saved: window.__xl.saved.slice(), sheets: Object.fromEntries(wb.sheets.map(s => [s.name, { g: grid(s), images: s.images, af: !!s.autoFilter, rows: Object.keys(s.rows).length }])) } });
  check('the workbook is built and saved', res && res.saved.some(n => /^PAT_All_Data_\d{4}-\d{2}-\d{2}\.xlsx$/.test(n)), res && res.saved);
  const want = ['Summary', 'Performance by Region', 'All Cases', 'Case History', 'SLA Report', 'Work Orders and Revisits', 'Agent Attendance', 'Agent Full Numbers', 'Due Misses Report', 'Monthly Scorecard'];
  check('sheets in order, complete names: Summary, Performance by Region, All Cases, Case History, SLA Report, Work Orders and Revisits, Attendance, Full Numbers, Due Misses, Scorecard; no raw data', JSON.stringify(res.names) === JSON.stringify(want), res.names);
  { const W = res.sheets['Work Orders and Revisits'].g, wv = Object.values(W).map(String);
    check('Work Orders and Revisits: cases with several Task IDs and revisits with their reasons', W['4:6'] === 'Number of Task IDs' && W['4:10'] === 'Revisit reasons' && wv.includes('XA-0') && wv.includes('XA-1') && wv.some(v => v.includes('#1 DOA') && v.includes('#2 Customer')) && wv.some(v => v.includes('T0A — Replace PSU')) && !wv.includes('XB-5'));
  }
  check('the download takes a reasonable time', took < 60000, took);
  const S = res.sheets.Summary, vals = Object.values(S.g).map(String);
  check('Summary: graphs only — title, view line and section titles, no table', vals.includes('PAT · All Data — Summary Dashboard') && vals.length <= 10 && !S.af && !vals.includes('Cases received') && vals.some(v => v.startsWith('View: ') && v.includes('day by day')), vals);
  check('... 10 graphs: key figures, cases, SLA, SLA reasons, due misses, productivity, performance by region, agents, revisit reasons, several Task IDs', S.images === 10, S.images);
  check('... sections for cases / SLA, reasons / due misses, productivity / region, agents, revisits / work orders', ['Cases and SLA', 'SLA missed reasons and due misses', 'Productivity and performance by region', 'Agent productivity and due misses', 'Revisits and cases with several Task IDs (work orders)'].every(x => vals.includes(x)), vals);
  const R = res.sheets['Performance by Region'].g, rv2 = Object.values(R).map(String);
  check('Performance by Region: its own tab with separate Monthly, Weekly and Daily tables', rv2.some(v => v.startsWith('Monthly view')) && rv2.some(v => v.startsWith('Weekly view')) && rv2.some(v => v.startsWith('Daily view')) && rv2.filter(v => v === 'Cases received').length === 3 && rv2.includes('All regions') && rv2.includes('SLA met rate'));
  const AC = res.sheets['All Cases'].g;
  check('All Cases: every case with its fields', Object.values(AC).filter(v => /^XA-\d+$/.test(String(v))).length >= 12 && String(AC['4:1']) === 'Case ID');
  const CH = res.sheets['Case History'].g;
  check('Case History: every logged action', Object.values(CH).filter(v => v === 'Case received').length >= 12 && Object.values(CH).filter(v => v === 'Case closed').length >= 6);
  const SL = res.sheets['SLA Report'].g, slH = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(c => SL['4:' + c]);
  check('SLA Report: received, closed, duration, met / missed and reason', JSON.stringify(slH) === JSON.stringify(['Case ID', 'Account', 'Owner', 'SLA type', 'Date and time received', 'Date and time closed', 'Duration (received to closed)', 'Duration in hours', 'SLA result', 'Reason (responsible party)', 'Closed by']), slH);
  const slRow = Object.keys(SL).filter(k => SL[k] === 'XA-2').map(k => k.split(':')[0])[0];
  check('... e.g. a case closed 7 h after it was received: "7 h 0 min", 7, Missed, Customer', slRow && SL[slRow + ':7'] === '7 h 0 min' && SL[slRow + ':8'] === 7 && SL[slRow + ':9'] === 'Missed' && SL[slRow + ':10'] === 'Customer', slRow && [SL[slRow + ':7'], SL[slRow + ':8'], SL[slRow + ':9'], SL[slRow + ':10']]);
  const AT = res.sheets['Agent Attendance'].g;
  check('Agent Attendance: name, date, logged-in time, status (Present / Late / Absent) only', JSON.stringify([1, 2, 3, 4].map(c => AT['4:' + c])) === JSON.stringify(['Name', 'Date', 'Logged-in time', 'Status']) && Object.values(AT).every(v => typeof v !== 'string' || !/^(On time|Absent \(schedule\))$/.test(v)));
  const FN = res.sheets['Agent Full Numbers'].g;
  check('Agent Full Numbers: the full numbers per agent, month by month', FN['4:1'] === 'Month' && FN['4:3'] === 'Agent' && FN['4:8'] === 'Productivity (updated cases)' && FN['4:9'] === 'Follow-through');
  const DM = res.sheets['Due Misses Report'].g;
  check('Due Misses Report: who it counts for and why', DM['4:8'] === 'Counted for' && DM['4:10'] === 'Why it counts for them');
  const MS = res.sheets['Monthly Scorecard'].g;
  check('Monthly Scorecard: running month first ("month to date")', MS['4:5'] === 'Score (1–5)' && Object.values(MS).some(v => /\(month to date\)$/.test(String(v))));
  check('every data sheet has filter buttons', ['All Cases', 'Case History', 'SLA Report', 'Agent Full Numbers', 'Monthly Scorecard'].every(n => res.sheets[n].af));
  // quick exports are Excel now
  await A.evaluate(async () => { await exportReport('cases'); await exportReport('actions'); await exportReport('checklist') });
  const q = await A.evaluate(() => window.__xl.saved.slice(-3));
  check('quick exports download formatted Excel files (not CSV)', JSON.stringify(q.map(n => n.replace(/_\d{4}-\d{2}-\d{2}/, ''))) === JSON.stringify(['PAT_Case_Report.xlsx', 'PAT_Case_Updates.xlsx', 'PAT_Checklist_Detail.xlsx']), q);
  check('... the report screen calls them Excel exports', await A.evaluate(() => { openSettings(); setTabTo('reports'); const h = document.getElementById('set-body').innerHTML; hide('settings'); return h.includes('Quick Excel exports') && !h.includes('CSV') }));
  // Nov 27 (18:20): period filter — one month, a date range, or everything
  { const per = await A.evaluate(async () => { const out = {}; const ids = wb => { const s = wb.sheets.find(x => x.name === 'All Cases'); const v = new Set(); Object.values(s.rows).forEach(r => Object.values(r.cells).forEach(c => { if (/^X[AB]-\d+$/.test(String(c.value))) v.add(c.value) })); return v };
      const H = 36e5, now = Date.now(), d = new Date(getCase('XA-11').recv); XA.mode = 'range'; XA.from = ymd(wall(+getCase('XA-11').recv)); XA.to = XA.from; await exportAll(); let wb = window.__xl.books[window.__xl.books.length - 1]; out.range = [...ids(wb)].filter(x => /^XA-/.test(x)); out.rangeSub = String(wb.sheets[0].rows[2].cells[1].value);
      XA.mode = 'month'; XA.month = curYM(); await exportAll(); wb = window.__xl.books[window.__xl.books.length - 1]; out.month = [...ids(wb)].filter(x => /^XA-/.test(x)).length; out.monthWant = new Set(CASES.filter(c => /^XA-/.test(c.id) && dkey(wall(+c.recv)).slice(0, 7) === curYM()).map(c => c.id)).size;
      XA.mode = 'all'; return out });
    check('period filter: a single date downloads only that day\'s cases (and says the period)', per.range.length >= 1 && per.range.includes('XA-11') && per.rangeSub.includes('Period: ') , per);
    check('... one month downloads the cases of that month (received, closed or worked on in it)', per.month >= per.monthWant && per.month < 12, per); }
  check('... the reports screen has Period (one month / date range / everything) and the Summary view picker next to Download all data', await A.evaluate(() => { XA.mode = 'range'; openSettings(); setTabTo('reports'); const h = document.getElementById('set-body').innerHTML; XA.mode = 'month'; setTabTo('reports'); const h2 = document.getElementById('set-body').innerHTML; hide('settings'); XA.mode = 'all'; return h.includes('Period:') && (h.match(/type="date"/g) || []).length >= 2 && h2.includes('type="month"') && h.includes('value="everything"') === false && h.includes('Everything') }));
  check('... the reports screen has the Summary view picker (Daily / Weekly / Monthly + month) next to Download all data', await A.evaluate(() => { XA.mode = 'month'; openSettings(); setTabTo('reports'); const h = document.getElementById('set-body').innerHTML; hide('settings'); return h.includes('Summary graphs:') && h.includes('value="weekly"') && h.includes('value="monthly"') && h.includes('type="month"') }));
  check('after the download the report data is back to normal (screen data unchanged)', await A.evaluate(() => REPACT_KEY !== '__all__' && new Set(CASES.filter(c => /^XA-/.test(c.id)).map(c => c.id)).size === 12));
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
