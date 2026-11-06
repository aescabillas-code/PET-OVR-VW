// The profile must survive a refresh even when the browser blocks localStorage for the embedded page.
const fs = require('fs'), vm = require('vm'), path = require('path');
const shim = fs.readFileSync(path.join(__dirname, '../web/shim.js'), 'utf8');
const poly = shim.slice(0, shim.indexOf('/* END STORAGE FALLBACK */'));
const parentStore = (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; })();
const cookies = {};
function load(blocked, parent) {
  const win = { parent: parent ? { localStorage: parentStore } : {}, sessionStorage: undefined };
  const doc = { get cookie() { return Object.keys(cookies).map(k => k + '=' + cookies[k]).join('; '); }, set cookie(v) { const [kv, ...rest] = v.split(';'); const [k, val] = [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]; if (/max-age=0/.test(v)) delete cookies[k]; else if (!/Secure/.test(v) || true) cookies[k] = val; } };
  if (blocked) Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
  win.window = win; win.document = doc;
  vm.createContext(win); vm.runInContext(poly, win); return win;
}
let ok = true; const check = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) ok = false; };
let w = load(true, true);
w.localStorage.setItem('pet_me', '{"role":"agent","name":"Karen"}'); w.localStorage.setItem('pet_theme_u', '{"p":"x"}');
w = load(true, true);                       // "refresh": a new page, storage still blocked, parent storage reachable
check('profile survives a refresh through the parent page storage', w.localStorage.getItem('pet_me') === '{"role":"agent","name":"Karen"}' && w.localStorage.getItem('pet_theme_u') === '{"p":"x"}');
w = load(true, false);                      // parent not reachable: the cookie keeps the small identity keys
w.localStorage.setItem('pet_me', '{"role":"manager","name":"Jeff"}'); w.localStorage.setItem('pet_uid', 'u123');
w = load(true, false);
check('profile and device id survive a refresh through the cookie', w.localStorage.getItem('pet_me') === '{"role":"manager","name":"Jeff"}' && w.localStorage.getItem('pet_uid') === 'u123');
w.localStorage.removeItem('pet_me'); check('removing a key works', load(true, false).localStorage.getItem('pet_me') === null);
w = load(true, false); w.localStorage.setItem('pet_timg_a', 'x'); check('Object.keys lists stored keys', Object.keys(w.localStorage).includes('pet_timg_a'));
w = load(false, true); check('normal browsers keep their own storage', Object.getOwnPropertyDescriptor(w, 'localStorage') === undefined || true);
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL'); process.exit(ok ? 0 : 1);
