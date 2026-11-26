// Alert sound upload: a manager's sound is kept on the server and reaches another screen (loaded before any alert needs it).
//   python3 tests/live_host.py . 8818 &   node tests/live_sound_upload.js 8818
const { chromium } = require('playwright'); const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); let fails = 0; const errs = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + JSON.stringify(x))); if (!ok) fails++; };
  const open = async () => { const p = await (await b.newContext()).newPage(); p.on('pageerror', e => errs.push(String(e).slice(0, 200))); await p.goto('http://127.0.0.1:' + process.argv[2] + '/'); await sleep(3500); return p.frames().find(x => x.url().includes('/app')); };
  const m = await open();
  await m.evaluate(() => { STAFF = J(DEMO_STAFF).map(p => { delete p.demo; return p }); ensureMgrs(STAFF); STAFFLOADED = true; saveStaff(true, true); ME = { role: 'manager', name: 'Jeff Bote' }; applyMe(); saveMe(); lpHide(); });
  // a tiny valid WAV file
  const r = await m.evaluate(async () => { const n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true); for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(60 * Math.sin(i / 3)));
    SNDPICK = 'rem'; await uploadSnd(new File([buf], 'ding.wav', { type: 'audio/wav' })); return { s: SOUNDS.rem || null, l: !!LSOUNDS.rem }; });
  check('a manager uploads a sound: it is kept on the server for every screen (not only this device)', r.s && r.s.id && r.s.name === 'ding.wav' && !r.l, r);
  await sleep(2500);
  const o = await open(); await sleep(4000);
  const g = await o.evaluate(() => { const s = sndFor('rem'); return { from: s.from, url: (s.url || '').slice(0, 22), name: s.name }; });
  check('another screen has the sound ready (loaded as soon as the settings arrived)', g.from === 'shared' && g.url.startsWith('data:audio/wav') && g.name === 'ding.wav', g);
  check('no browser errors', !errs.length, errs);
  await b.close(); console.log(fails ? 'RESULT: FAIL (' + fails + ')' : 'RESULT: PASS'); process.exit(fails ? 1 : 0);
})();
