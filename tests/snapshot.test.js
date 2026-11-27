// What read_page sees when a page has dialogs, popovers, native selects, custom menus,
// shadow roots and same-origin frames — the cases where agents lost popups and dropdowns.
const { chromium } = require('../node_modules/playwright');
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra });

function extract(src, marker) {
  const i = src.indexOf(marker);
  const j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced');
}

(async () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'extension', 'bridge.js'), 'utf8');
  const cmd = extract(bridge, 'function pageCmd');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent(`<!doctype html><html><body>
    <button id="open">Open menu</button>
    <select id="native"><option value="a">Alpha</option><option value="b" selected>Beta</option><option value="c">Gamma</option></select>
    <div id="shadow"></div>
    <iframe id="frame" srcdoc="<button id='inner' onclick='parent.window.__frameClicked=1'>Inside frame</button><input id='fld'>"></iframe>
    <dialog id="dlg" open><p>Dialog text</p><button id="in-dialog">Confirm</button></dialog>
    <div id="pop" popover="manual"><p>Popover text</p><input id="in-pop" placeholder="Popover field"></div>
    <div role="menu" id="menu"><div role="menuitem">Menu item</div><div role="menuitem">Second item</div></div>
    <div role="listbox" id="list"><div role="option">Option one</div><div role="option">Option two</div></div>
    <script>
      document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML = '<button id="shadow-btn" onclick="window.__shadowClicked=1">Shadow button</button>';
      document.getElementById('pop').showPopover();
    </script>
  </body></html>`);
  await page.waitForTimeout(300);

  const out = await page.evaluate(`(() => { ${cmd} return pageCmd('snapshot', null, null, null, false, 20000); })()`);
  check('dialog, popover, menu, list are listed as overlays', /dialog/.test(out.overlays) && /Popover text/.test(out.overlays) && /menu/.test(out.overlays), out.overlays);
  check('native select shows every option and the selected one', /value=b/.test(out.selects) && /Alpha/.test(out.selects) && /Gamma/.test(out.selects) && /Beta\*/.test(out.selects), out.selects);
  check('open shadow root is discovered', /shadow nodes/.test(out.shadows), out.shadows);
  check('same-origin frame is discovered', /iframe#frame/.test(out.frames), out.frames);
  check('shadow element is numbered with its path', /shadow#shadow > button.*Shadow button/.test(out.elements), out.elements);
  check('frame element is numbered with its path', /frame#frame > button.*Inside frame/.test(out.elements), out.elements);
  for (const word of ['Dialog text', 'Popover text', 'Menu item', 'Option one', 'Shadow button', 'Inside frame']) {
    check(`text includes ${word}`, out.text.includes(word), out.text.slice(-300));
  }

  // Refs found inside shadow roots and frames must be clickable, not just visible.
  const shadowRef = Number((out.elements.match(/\[(\d+)\] shadow#shadow > button/) || [])[1]);
  const frameRef = Number((out.elements.match(/\[(\d+)\] frame#frame > button/) || [])[1]);
  const clicked = await page.evaluate(`(() => { ${cmd}
    const a = pageCmd('click', ${shadowRef}); const b = pageCmd('click', ${frameRef});
    return { a, b, shadow: window.__shadowClicked || 0, frame: window.__frameClicked || 0 };
  })()`);
  check('ref click works inside an open shadow root', clicked.shadow === 1, JSON.stringify(clicked));
  check('ref click works inside a same-origin iframe', clicked.frame === 1, JSON.stringify(clicked));

  const selected = await page.evaluate(`(() => { ${cmd}
    const a = pageCmd('type', null, '#native', 'Gamma'); const v1 = document.getElementById('native').value;
    const b = pageCmd('type', null, '#native', 'Alpha'); const v2 = document.getElementById('native').value;
    return { a, v1, b, v2 };
  })()`);
  check('native select can be set by value or label', selected.a === 'selected c' && selected.v1 === 'c' && selected.v2 === 'a', JSON.stringify(selected));

  const pierced = await page.evaluate(`(() => { ${cmd}
    return { byRef: pageCmd('locate', ${shadowRef}), bySelector: pageCmd('locate', null, '#shadow >>> shadow:button') };
  })()`);
  check('piercing selector reaches shadow content', pierced.bySelector && pierced.byRef && Math.abs(pierced.bySelector.x - pierced.byRef.x) < 2, JSON.stringify(pierced));

  check('no page errors during the run', errors.length === 0, errors.join(' | '));
  await browser.close();
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + JSON.stringify(r.extra)}`); }
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
