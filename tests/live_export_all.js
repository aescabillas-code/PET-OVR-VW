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
  const b = await chromium.launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!ok) fails++; };
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); const A = p.frames().find(x => x.url().includes('/app'));
  await A.evaluate(MOCK);
  await A.evaluate(() => { STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide(); try { hideWelcome() } catch (e) {}
    window.saveBlob = (bl, n) => { window.__xl.saved.push(n) };
    const ag = STAFF.filter(p => !isMgr(p)).map(p => p.name), H = 36e5, now = Date.now();
    for (let i = 0; i < 12; i++) { const c = mkCase('XA-' + i, ag[i % ag.length], { account: 'Store ' + (100 + i) }); c.recv = now - (40 - i * 3) * 24 * H; c.ts = c.recv; c.slaT = ['NBD', '4H', '6H'][i % 3];
      logc(c, 'Case received', 'System', 'Test case ' + i, { ts: c.recv, nosave: true });
      if (i % 2 === 0) { c.closed = true; c.closedAt = c.recv + (5 + i) * H; c.closedBy = c.owner; c.sla = i % 4 === 0 ? { met: true, who: '', other: '' } : { met: false, who: i % 3 ? 'Customer' : 'Other', other: i % 3 ? '' : 'Road closed' }; logc(c, 'Case closed', c.owner, 'closed', { ts: c.closedAt, nosave: true }) }
      CASES.push(c); queueSave(c) }
    render() });
  await sleep(4000);
  await A.evaluate(async () => { await exportAll() });
  await sleep(500);
  const res = await A.evaluate(() => { const wb = window.__xl.books[window.__xl.books.length - 1]; if (!wb) return null; const grid = ws => { const out = {}; Object.keys(ws.rows).forEach(r => { Object.keys(ws.rows[r].cells).forEach(c => { const v = ws.rows[r].cells[c].value; out[r + ':' + c] = v instanceof Date ? 'D:' + v.toISOString() : v }) }); return out };
    return { names: wb.sheets.map(s => s.name), saved: window.__xl.saved.slice(), sheets: Object.fromEntries(wb.sheets.map(s => [s.name, { g: grid(s), images: s.images, af: !!s.autoFilter, rows: Object.keys(s.rows).length }])) } });
  check('the workbook is built and saved', res && res.saved.some(n => /^PAT_All_Data_\d{4}-\d{2}-\d{2}\.xlsx$/.test(n)), res && res.saved);
  const want = ['Summary', 'All Cases', 'Case History', 'SLA Report', 'Agent Attendance', 'Agent Full Numbers', 'Due Misses Report', 'Monthly Scorecard'];
  check('sheets in the asked order, with complete names', JSON.stringify(res.names.slice(0, 8)) === JSON.stringify(want), res.names);
  check('... the raw data (backup) follows, with complete names (31 characters or fewer)', res.names.slice(8).every(n => n.startsWith('Raw data - ') && n.length <= 31) && res.names.includes('Raw data - cases'), res.names.slice(8));
  const S = res.sheets.Summary, vals = Object.values(S.g).map(String);
  check('Summary: title and tiles (received, active, closed, SLA met / missed / rate, due misses, productivity)', vals.includes('PAT · All Data — Summary Dashboard') && ['Cases received', 'Active cases', 'Closed cases', 'SLA met', 'SLA missed', 'SLA met rate', 'Due misses', 'Productivity (updated cases)'].every(t => vals.includes(t)));
  check('... graphs are added (cases, SLA, SLA reasons, due misses, productivity)', S.images >= 5, S.images);
  check('... Performance by region and period with filter buttons (View / Period / Region) for monthly, weekly and daily', vals.includes('Performance by region and period') && ['Monthly', 'Weekly', 'Daily'].every(v => vals.includes(v)) && vals.includes('All regions') && S.af);
  check('... SLA missed reasons listed', vals.includes('Customer') && vals.some(v => v === 'Other: Road closed'));
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
  check('after the download the report data is back to normal (screen data unchanged)', await A.evaluate(() => REPACT_KEY !== '__all__' && CASES.filter(c => /^XA-/.test(c.id)).length === 12));
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
