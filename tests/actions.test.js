// Regression for the bridge's in-page actions (read_page/click/type/scroll/press_key) and the
// agent's pointer + question card. Extracts the real functions from bridge.js / agent-ui.js.
const { chromium } = require('../node_modules/playwright');
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra });

function extract(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('marker not found: ' + marker);
  const j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced braces for: ' + marker);
}

(async () => {
  const dir = path.join(__dirname, '..', 'extension');
  const bridge = fs.readFileSync(path.join(dir, 'bridge.js'), 'utf8');
  const snapshotFn = extract(bridge, 'function pageSnapshot');
  const actFn = extract(bridge, 'function pageAct');
  const pressFn = extract(bridge, 'inPage(tabId, (k) => {').replace('inPage(tabId, ', '');

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.setContent(`<!doctype html><html><head><title>Action test</title></head><body style="margin:0">
    <h1 id="head">Action test</h1>
    <button id="go" onclick="window.__clicked=(window.__clicked||0)+1">Go</button>
    <input id="field" />
    <form id="f" onsubmit="event.preventDefault(); window.__submitted=document.getElementById('f2').value">
      <input id="f2" /><button id="sub" type="submit">Send</button>
    </form>
    <div style="height:3000px"></div>
    <a id="tail" href="#bottom">bottom</a>
  </body></html>`);

  const snap = await page.evaluate(`(() => { ${snapshotFn} ${actFn}
    const s = pageSnapshot(2000);
    return { title: s.title, elements: s.elements, pageHeight: s.pageHeight };
  })()`);
  check('read_page snapshot: title and element list', snap.title === 'Action test' && /\[0\] button:submit "Go"/.test(snap.elements) && /input:text/.test(snap.elements), snap.elements.slice(0, 200));

  const clickRes = await page.evaluate(`(() => { ${snapshotFn} ${actFn}
    const s = pageSnapshot(2000);
    const ref = s.elements.split('\\n').findIndex((l) => l.includes('"Go"'));
    return pageAct('click', ref, null, null, false, 0);
  })()`);
  const clicked = await page.evaluate(() => window.__clicked || 0);
  check('click hits the button (synthetic pointer events + .click())', clickRes === 'clicked' && clicked === 1, JSON.stringify({ clickRes, clicked }));

  const typeRes = await page.evaluate(`(() => { ${snapshotFn} ${actFn}
    const r = pageAct('type', null, '#field', 'hello-123', false, 0);
    return { r, v: document.getElementById('field').value };
  })()`);
  check('type fills the input through the native setter', typeRes.r === 'typed' && typeRes.v === 'hello-123', JSON.stringify(typeRes));

  const submitRes = await page.evaluate(`(() => { ${actFn}
    return pageAct('type', null, '#f2', 'typed-too', true, 0);
  })()`);
  const submitted = await page.evaluate(() => window.__submitted);
  check('type with submit sends the form', submitRes === 'typed' && submitted === 'typed-too', JSON.stringify({ submitRes, submitted }));

  const scrollBefore = await page.evaluate(() => scrollY);
  await page.evaluate(`(() => { ${actFn} return pageAct('scroll', null, null, null, false, 600); })()`);
  const scrollAfter = await page.evaluate(() => scrollY);
  check('scroll moves the page', scrollAfter > scrollBefore, JSON.stringify({ scrollBefore, scrollAfter }));

  const pressRes = await page.evaluate(`(() => { const pressKey = ${pressFn};
    window.__keys = [];
    document.getElementById('field').addEventListener('keydown', (e) => window.__keys.push([e.key, e.code, e.keyCode]));
    document.getElementById('field').focus();
    const r = pressKey('Enter');
    const r2 = pressKey('a');
    return [r, r2, window.__keys];
  })()`);
  check('press_key dispatches keydown/keyup a handler sees', pressRes[0] === 'pressed Enter' && pressRes[1] === 'pressed a' && JSON.stringify(pressRes[2]) === JSON.stringify([['Enter', 'Enter', 13], ['a', 'a', 65]]), JSON.stringify(pressRes));

  const uiSrc = fs.readFileSync(path.join(dir, 'agent-ui.js'), 'utf8').replace("mode: 'closed'", "mode: 'open'");
  await page.evaluate(uiSrc);
  const moveRes = await page.evaluate(async () => {
    const p1 = await globalThis.__chromiagentUI.move(120, 140, 'go', null);
    await new Promise((r) => setTimeout(r, 900));
    const p2 = await globalThis.__chromiagentUI.move(500, 380, 'go', p1);
    return { p1, p2 };
  });
  check('agent pointer move returns positions and runs', moveRes.p1 && moveRes.p2 && moveRes.p1.x === 120 && moveRes.p2.x === 500, JSON.stringify(moveRes));

  const askRes = await page.evaluate(async () => {
    const done = globalThis.__chromiagentUI.ask({ question: 'Qaysi variant?', options: ['Birikki', 'Ikkinchi'] });
    await new Promise((r) => setTimeout(r, 500));
    const host = document.getElementById('__chromiagent-ui');
    const card = host && host.shadowRoot && host.shadowRoot.querySelector('.card');
    const focused = document.activeElement === host;
    const opt = card && [...card.querySelectorAll('.opt')].find((b) => b.textContent.includes('Ikkinchi'));
    if (opt) opt.click();
    const answer = await done;
    return { hasCard: !!card, focused, answer };
  });
  check('question card opens, takes the keyboard, answers by option', askRes.hasCard && askRes.focused && askRes.answer.type === 'option' && askRes.answer.value === 'Ikkinchi', JSON.stringify(askRes));

  const askType = await page.evaluate(async () => {
    const done = globalThis.__chromiagentUI.ask({ question: 'Yozing:', options: [] });
    await new Promise((r) => setTimeout(r, 500));
    const host = document.getElementById('__chromiagent-ui');
    const input = host.shadowRoot.querySelector('textarea');
    const focused = document.activeElement === host;
    input.value = 'javob matni';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const answer = await Promise.race([done, new Promise((r) => setTimeout(() => r({ type: 'timeout' }), 1500))]);
    return { focused, answer };
  });
  check('question card accepts a typed answer', askType.focused && askType.answer.type === 'text' && askType.answer.value === 'javob matni', JSON.stringify(askType));
  check('no page errors during the run', errors.length === 0, errors.join(' | '));

  await browser.close();
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + JSON.stringify(r.extra)}`); }
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
