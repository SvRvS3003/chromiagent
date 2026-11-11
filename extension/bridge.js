// Chromiagent bridge, by SvRvS: runs in the side panel and executes the agent's tool calls on any tab.
const BRIDGE = 'ws://127.0.0.1:17371/bridge';
// The agent stays inside the web: local files via file:// are refused everywhere.
const noFile = (url) => { if (/^\s*file:/i.test(url || '')) throw new Error('file:// URLs are blocked (Chrome web tasks only)'); };


// ---- in-page helpers (serialized into the tab by chrome.scripting) ----
function pageSnapshot(maxChars) {
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  document.querySelectorAll('[data-ca]').forEach((e) => e.removeAttribute('data-ca'));
  const lines = [];
  let n = 0;
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect();
    const st = getComputedStyle(e);
    if (r.width < 1 || r.height < 1 || st.visibility === 'hidden' || st.display === 'none') continue;
    if (n >= 400) break;
    e.setAttribute('data-ca', n);
    const label = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || e.alt || e.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const kind = e.tagName.toLowerCase() + (e.type ? `:${e.type}` : '') + (e.getAttribute('role') ? `[${e.getAttribute('role')}]` : '');
    const inView = r.bottom > 0 && r.top < innerHeight ? '' : ' (offscreen)';
    lines.push(`[${n}] ${kind} "${label}"${e.href ? ' -> ' + e.href : ''}${inView}`);
    n++;
  }
  const text = (document.body?.innerText || '').slice(0, maxChars || 15000);
  return { title: document.title, url: location.href, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, text, elements: lines.join('\n') };
}

function pageAct(action, ref, selector, text, submit, dy) {
  if (action === 'scroll') { scrollBy(0, dy); return `scrolled to y=${Math.round(scrollY)}`; }
  const el = selector ? document.querySelector(selector) : document.querySelector(`[data-ca="${ref}"]`);
  if (!el) return { error: `element not found (${selector || 'ref ' + ref}); call read_page again` };
  el.scrollIntoView({ block: 'center' });
  if (action === 'click') {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    el.click();
    return 'clicked';
  }
  // type
  el.focus();
  if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  } else {
    // Native setter so React/Vue controlled inputs see the change.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (submit) {
    for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
  }
  return 'typed';
}

// ---- chrome.debugger helpers (real input, CSP-free eval) ----
const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35 };

async function withDebugger(tabId, fn) {
  noFile((await chrome.tabs.get(tabId)).url);
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try { return await fn((method, params) => chrome.debugger.sendCommand(target, method, params)); }
  finally { await chrome.debugger.detach(target).catch(() => {}); }
}

async function inPage(tabId, func, args) {
  noFile((await chrome.tabs.get(tabId)).url);
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r.result;
}

const tools = {
  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({ tabId: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url, audible: t.audible || undefined, pinned: t.pinned || undefined }));
  },
  async activate_tab({ tabId }) {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return `active: ${t.title}`;
  },
  async open_tab({ url, active = true }) {
    noFile(url);
    const t = await chrome.tabs.create({ url, active });
    return { tabId: t.id, windowId: t.windowId };
  },
  async close_tab({ tabId }) { await chrome.tabs.remove(tabId); return 'closed'; },
  async navigate({ tabId, url, action }) {
    noFile(url);
    if (url) await chrome.tabs.update(tabId, { url });
    else if (action === 'back') await chrome.tabs.goBack(tabId);
    else if (action === 'forward') await chrome.tabs.goForward(tabId);
    else if (action === 'reload') await chrome.tabs.reload(tabId);
    else throw new Error('give url or action');
    await waitLoaded(tabId);
    const t = await chrome.tabs.get(tabId);
    return { title: t.title, url: t.url };
  },
  read_page: ({ tabId, maxChars }) => inPage(tabId, pageSnapshot, [maxChars || 15000]),
  click: ({ tabId, ref, selector }) => inPage(tabId, pageAct, ['click', ref ?? null, selector ?? null, null, false, 0]),
  type: ({ tabId, ref, selector, text, submit }) => inPage(tabId, pageAct, ['type', ref ?? null, selector ?? null, text, !!submit, 0]),
  scroll: ({ tabId, dy }) => inPage(tabId, pageAct, ['scroll', null, null, null, false, dy]),
  press_key: ({ tabId, key }) => withDebugger(tabId, async (send) => {
    const code = KEYS[key] ?? key.toUpperCase().charCodeAt(0);
    const text = key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, windowsVirtualKeyCode: code, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code });
    return `pressed ${key}`;
  }),
  run_js: ({ tabId, code }) => withDebugger(tabId, async (send) => {
    const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value === undefined ? '(undefined)' : r.result.value;
  }),
  async screenshot({ tabId }) {
    const t = await chrome.tabs.update(tabId, { active: true });
    noFile(t.url);
    await chrome.windows.update(t.windowId, { focused: true });
    await new Promise((r) => setTimeout(r, 400));
    const url = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 60 });
    return { image: url.split(',')[1] };
  },
};

async function waitLoaded(tabId, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await chrome.tabs.get(tabId)).status === 'complete') return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function connectBridge() {
  const ws = new WebSocket(BRIDGE);
  ws.onmessage = async (e) => {
    const { id, tool, args } = JSON.parse(e.data);
    let out;
    try {
      if (!tools[tool]) throw new Error(`unknown tool ${tool}`);
      const r = await tools[tool](args);
      out = r && r.image ? { id, image: r.image } : r && r.error ? { id, error: r.error } : { id, result: r };
    } catch (err) {
      out = { id, error: String(err.message || err) };
    }
    ws.send(JSON.stringify(out));
  };
  ws.onclose = () => setTimeout(connectBridge, 2000);
}
connectBridge();
