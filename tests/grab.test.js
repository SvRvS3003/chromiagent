// Feedback card regression: a trusted pick opens the card, the card takes the keyboard,
// typed feedback is sent with a real payload, and failures are shown instead of silently dropped.
const { chromium } = require('../node_modules/playwright');
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">
    <h1 id="title" style="margin:40px">Feedback test page</h1>
    <button id="btn" style="position:absolute;left:200px;top:200px;padding:24px">Pick me</button>
    <a id="lnk" href="https://example.com" style="position:absolute;left:500px;top:400px">link</a>
  </body></html>`);

  // Open shadow root for inspection; shipped behavior is identical with a closed one.
  let src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'grab.js'), 'utf8').replace("mode: 'closed'", "mode: 'open'");
  await page.evaluate(`window.chrome = { runtime: { lastError: null, sendMessage: (m, cb) => { window.__sent = m; cb && cb({ ok: true }); } } };`);
  await page.evaluate(src);

  await page.mouse.move(240, 230);
  await page.waitForTimeout(150);
  await page.mouse.click(240, 230);
  await page.waitForTimeout(450);

  const state = await page.evaluate(() => {
    const host = document.documentElement.lastElementChild;
    const sr = host.shadowRoot;
    const card = sr && sr.querySelector('.card');
    const overlay = sr && sr.querySelector('[popover]');
    return {
      hasCard: !!card,
      activeIsHost: document.activeElement === host,
      docFocused: document.hasFocus(),
      url: location.href,
      grabAlive: !!window.__chromiagentGrab,
      popoverOpen: overlay ? overlay.matches(':popover-open') : null,
    };
  });
  check('card opens on trusted click', state.hasCard);
  check('page document holds the keyboard', state.docFocused);
  check('shadow focus lands on the overlay host', state.activeIsHost);
  check('pick click does not navigate', state.url.startsWith('about:blank'), state.url);
  check('overlay popover stays open (no toggle loop)', state.popoverOpen !== false, state.popoverOpen);

  // A real user click must reach the textarea through the overlay (elementFromPoint quirks aside).
  await page.evaluate(() => {
    const area = document.documentElement.lastElementChild.shadowRoot.querySelector('textarea');
    window.__spy = { click: 0, focus: 0 };
    area.addEventListener('click', () => window.__spy.click++);
    area.addEventListener('focus', () => window.__spy.focus++);
    const r = area.getBoundingClientRect();
    window.__rc = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    document.activeElement.blur();
  });
  const rc = await page.evaluate(() => window.__rc);
  await page.mouse.click(rc.x, rc.y);
  await page.waitForTimeout(200);
  const clickRes = await page.evaluate(() => ({
    spy: window.__spy,
    activeIsHost: document.activeElement === document.documentElement.lastElementChild,
  }));
  check('a real click lands on the textarea and focuses it', clickRes.spy.click === 1 && clickRes.spy.focus >= 1 && clickRes.activeIsHost, JSON.stringify(clickRes));

  await page.keyboard.type('TEST-123 feedback');
  const typed = await page.evaluate(() => document.documentElement.lastElementChild.shadowRoot.querySelector('textarea').value);
  check('typing lands in the feedback box', typed === 'TEST-123 feedback', JSON.stringify(typed));

  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(250);
  const afterSend = await page.evaluate(() => {
    const sr = document.documentElement.lastElementChild.shadowRoot;
    const t = sr.querySelector('.toast');
    return {
      toast: t ? t.textContent : null,
      fail: !!(t && t.classList.contains('fail')),
      sent: window.__sent ? { type: window.__sent.type, feedback: window.__sent.feedback } : null,
      cardGone: !sr.querySelector('.card'),
    };
  });
  check('Ctrl+Enter sends the feedback payload', afterSend.sent && afterSend.sent.type === 'chromiagent-grab' && afterSend.sent.feedback === 'TEST-123 feedback', JSON.stringify(afterSend.sent));
  check('success toast shown, card closed', afterSend.toast === 'Sent to the agent' && !afterSend.fail && afterSend.cardGone, JSON.stringify(afterSend));

  await page.waitForTimeout(1100);
  await page.evaluate(`window.chrome.runtime.sendMessage = (m, cb) => cb && cb({ ok: false, why: 'panel closed' });`);
  await page.evaluate(src); // second press restarts, never toggles off
  await page.waitForTimeout(120);
  const restarted = await page.evaluate(() => {
    const sr = document.documentElement.lastElementChild.shadowRoot;
    return { hint: !!sr.querySelector('.hint'), oldCard: !!sr.querySelector('.card') };
  });
  check('second press restarts the overlay fresh', restarted.hint && !restarted.oldCard, JSON.stringify(restarted));

  await page.mouse.move(240, 230);
  await page.waitForTimeout(150);
  await page.mouse.click(240, 230);
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.documentElement.lastElementChild.shadowRoot.querySelector('textarea').value = 'second try'; });
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(250);
  const failToast = await page.evaluate(() => {
    const t = document.documentElement.lastElementChild.shadowRoot.querySelector('.toast');
    return t ? { text: t.textContent, fail: t.classList.contains('fail') } : null;
  });
  check('delivery failure shows a red toast with the reason', failToast && failToast.fail && /panel closed/.test(failToast.text), JSON.stringify(failToast));

  await page.waitForTimeout(3000);
  await page.evaluate(src);
  await page.waitForTimeout(120);
  await page.mouse.move(240, 230);
  await page.waitForTimeout(150);
  await page.mouse.click(240, 230);
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(150);
  const empty = await page.evaluate(() => {
    const card = document.documentElement.lastElementChild.shadowRoot.querySelector('.card');
    return { stillOpen: !!card, keys: card ? card.querySelector('.keys').textContent : null };
  });
  check('empty feedback keeps the card and says what is missing', empty.stillOpen && /write your feedback first/.test(empty.keys || ''), JSON.stringify(empty));
  check('no page errors during the run', errors.length === 0, errors.join(' | '));

  await browser.close();
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + JSON.stringify(r.extra)}`); }
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
