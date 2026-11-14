// Re-builds the pre-built Tailwind styles of web/pet_station.html (run after adding new Tailwind classes):
//   python3 tools/tailwind_tokens.py > /tmp/tokens.txt && node tools/tailwind_build.js /tmp/tokens.txt /tmp/tw.css
// then replace the contents of <style id="tw-static"> with /tmp/tw.css. Needs Playwright and the Tailwind 3.4 Play CDN script
// (path below, or download https://cdn.tailwindcss.com/3.4.17).
const { chromium } = require('playwright'); const fs = require('fs');
const TW = fs.readFileSync(process.env.TAILWIND_JS || '/opt/npm-tools/node_modules/@zenuml/core/dist/vendor/tailwindcss/tailwindcss.js', 'utf8');
const toks = fs.readFileSync(process.argv[2], 'utf8');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.setContent('<!doctype html><html><head></head><body></body></html>');
  await p.addScriptTag({ content: TW });
  await p.evaluate(t => { const d = document.createElement('div'); d.className = t; d.style.display = 'none'; document.body.appendChild(d); }, toks);
  await p.waitForTimeout(2500);
  const css = await p.evaluate(() => [...document.querySelectorAll('style')].map(s => s.textContent).filter(t => /tailwindcss|--tw-/.test(t)).join('\n'));
  fs.writeFileSync(process.argv[3], css); console.log('css bytes', css.length);
  await b.close();
})();
