// Nov 27 (19:20): opening a case without a (future) maintenance window now shows a pop-up asking to add / update it.
// Tests that open cases to check other things launch the browser through here, so that pop-up stays out of their way
// (the pop-up itself is checked in tests/feature_checks.js and tests/live_mw_reminders.js).
const { chromium } = require('playwright');
const QUIET = `(function(){var n=0,t=setInterval(function(){n++;try{if(typeof window.mwqShow==='function'&&!window.mwqShow.__q){window.mwqShow=function(){};window.mwqShow.__q=1}}catch(e){}if(n>600)clearInterval(t)},10)})();`;
async function launch(o) {
  const b = await chromium.launch(o);
  const np = b.newPage.bind(b), nc = b.newContext.bind(b);
  b.newContext = async (...a) => { const c = await nc(...a); await c.addInitScript(QUIET); return c; };
  b.newPage = async (...a) => { const p = await np(...a); await p.addInitScript(QUIET); return p; };
  return b;
}
module.exports = { launch, QUIET };
