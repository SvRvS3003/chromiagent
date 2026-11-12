// Chromiagent page recorder, by SvRvS.
// Injected into the page's own world while the agent monitors a tab. It records what happens on the
// page as a stream of small events: DOM changes, network requests, WebSocket traffic, console output and
// errors, URL / title changes, the user's clicks and typing, dialogs and media. The panel collects them.
// Values typed into password fields are never recorded; other fields only record their length.
(() => {
  if (window.__chromiagentRec) return;
  const MAX = 2000;            // events kept in the page between two collections
  const events = [];
  let seq = 0, dropped = 0;
  const t0 = Date.now(), id = Math.random().toString(36).slice(2);
  const cut = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
  function emit(type, data) {
    events.push({ seq: ++seq, t: Date.now(), type, ...data });
    if (events.length > MAX) { events.shift(); dropped++; }
  }

  // Short, stable description of an element: tag#id.class "text" [role/name].
  function describe(el) {
    if (!el || el.nodeType !== 1) return el?.nodeType === 3 ? `text "${cut(el.data, 60)}"` : '';
    let d = el.tagName.toLowerCase();
    if (el.id) d += `#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).filter(Boolean) : [];
    if (cls.length) d += `.${cls.join('.')}`;
    const label = el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    if (label) d += `[${cut(label, 40)}]`;
    const text = el.innerText !== undefined && el.children.length < 20 ? cut(el.innerText, 60) : '';
    if (text) d += ` "${text}"`;
    return d;
  }
  const ours = (el) => el?.id?.startsWith?.('__chromiagent');

  // ---- DOM: batched every 250 ms into one summary event ----
  let batch = null;
  const flushSoon = () => { if (!batch) { batch = { added: [], removed: [], text: [], attrs: [], n: 0 }; setTimeout(flush, 250); } };
  function flush() {
    const b = batch; batch = null;
    if (!b || !b.n) return;
    emit('dom', { changes: b.n, added: b.added.slice(0, 8), removed: b.removed.slice(0, 8), text: b.text.slice(0, 8), attrs: b.attrs.slice(0, 8) });
  }
  new MutationObserver((list) => {
    for (const m of list) {
      const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (ours(target) || target?.closest?.('[id^="__chromiagent"]')) continue;
      flushSoon();
      batch.n++;
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if ((n.nodeType === 1 && !ours(n)) || (n.nodeType === 3 && n.data.trim())) batch.added.length < 8 && batch.added.push(describe(n));
        for (const n of m.removedNodes) if ((n.nodeType === 1 && !ours(n)) || (n.nodeType === 3 && n.data.trim())) batch.removed.length < 8 && batch.removed.push(describe(n));
      } else if (m.type === 'characterData') {
        batch.text.length < 8 && batch.text.push(`${describe(target)}: "${cut(m.oldValue, 40)}" -> "${cut(m.target.data, 60)}"`);
      } else if (m.type === 'attributes' && /^(class|disabled|hidden|aria-|open|checked|selected|value|src|href|style)/.test(m.attributeName)) {
        batch.attrs.length < 8 && batch.attrs.push(`${describe(target)} ${m.attributeName}`);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, characterDataOldValue: true, attributes: true });

  // ---- network: fetch, XMLHttpRequest, WebSocket ----
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    const method = (init?.method || input?.method || 'GET').toUpperCase();
    const start = performance.now();
    try {
      const res = await origFetch.apply(this, arguments);
      emit('fetch', { method, url: cut(url, 200), status: res.status, ms: Math.round(performance.now() - start), mime: res.headers.get('content-type')?.split(';')[0] });
      return res;
    } catch (e) {
      emit('fetch', { method, url: cut(url, 200), error: cut(e?.message || e), ms: Math.round(performance.now() - start) });
      throw e;
    }
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__ca = { method: String(method).toUpperCase(), url: cut(url, 200) }; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const info = this.__ca, start = performance.now();
    if (info) this.addEventListener('loadend', () => emit('xhr', { ...info, status: this.status, ms: Math.round(performance.now() - start) }), { once: true });
    return XS.apply(this, arguments);
  };
  const WS = window.WebSocket;
  if (WS) {
    window.WebSocket = new Proxy(WS, {
      construct(target, args) {
        const ws = Reflect.construct(target, args);
        const url = cut(args[0], 200);
        emit('ws', { event: 'open', url });
        ws.addEventListener('message', (e) => emit('ws', { event: 'message', url, data: typeof e.data === 'string' ? cut(e.data, 200) : `[${e.data?.constructor?.name}]` }));
        ws.addEventListener('close', (e) => emit('ws', { event: 'close', url, code: e.code }));
        const send = ws.send;
        ws.send = function (d) { emit('ws', { event: 'send', url, data: typeof d === 'string' ? cut(d, 200) : '[binary]' }); return send.apply(this, arguments); };
        return ws;
      },
    });
  }

  // ---- console and errors ----
  for (const level of ['error', 'warn', 'info', 'log']) {
    const orig = console[level];
    console[level] = function (...a) {
      emit('console', { level, text: cut(a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' '), 300) });
      return orig.apply(this, a);
    };
  }
  addEventListener('error', (e) => {
    if (e.target && e.target !== window) emit('error', { kind: 'resource', what: describe(e.target), url: cut(e.target.src || e.target.href, 200) });
    else emit('error', { kind: 'script', text: cut(e.message, 300), where: `${cut(e.filename, 120)}:${e.lineno}` });
  }, true);
  addEventListener('unhandledrejection', (e) => emit('error', { kind: 'promise', text: cut(e.reason?.message || e.reason, 300) }));

  // ---- navigation, title, visibility ----
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function () { const r = orig.apply(this, arguments); emit('nav', { how: fn, url: location.href }); return r; };
  }
  addEventListener('popstate', () => emit('nav', { how: 'popstate', url: location.href }));
  addEventListener('hashchange', () => emit('nav', { how: 'hash', url: location.href }));
  let title = document.title;
  setInterval(() => { if (document.title !== title) { emit('title', { from: cut(title, 80), to: cut(document.title, 120) }); title = document.title; } }, 500);
  document.addEventListener('visibilitychange', () => emit('visibility', { state: document.visibilityState }));

  // ---- what the user does (trusted events only; the agent's own input is reported by its tools) ----
  addEventListener('click', (e) => e.isTrusted && emit('user', { action: 'click', on: describe(e.target), x: e.clientX, y: e.clientY }), true);
  addEventListener('change', (e) => {
    const el = e.target;
    if (!e.isTrusted || !el) return;
    const secret = el.type === 'password';
    emit('user', { action: 'input', on: describe(el), value: secret ? '(password, hidden)' : el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.tagName === 'SELECT' ? cut(el.value, 60) : `(${String(el.value || '').length} chars)` });
  }, true);
  addEventListener('submit', (e) => emit('user', { action: 'submit', on: describe(e.target) }), true);
  let lastScroll = 0;
  addEventListener('scroll', () => { const now = Date.now(); if (now - lastScroll > 1000) { lastScroll = now; emit('scroll', { y: Math.round(scrollY), of: document.documentElement.scrollHeight }); } }, { passive: true, capture: true });

  // ---- dialogs and media ----
  for (const fn of ['alert', 'confirm', 'prompt']) {
    const orig = window[fn];
    window[fn] = function (msg) { emit('dialog', { kind: fn, text: cut(msg, 200) }); return orig.apply(this, arguments); };
  }
  for (const t of ['play', 'pause', 'ended', 'seeked', 'waiting', 'error']) {
    addEventListener(t, (e) => {
      const m = e.target;
      if (m instanceof HTMLMediaElement) emit('media', { event: t, what: describe(m), at: Math.round(m.currentTime), of: Math.round(m.duration || 0) });
    }, true);
  }

  emit('start', { url: location.href, title: document.title, ms: Date.now() - t0 });
  window.__chromiagentRec = {
    // Events after `since`, oldest first, and how many were dropped because nobody collected them.
    id,
    take(since) {
      flush();
      const out = events.filter((e) => e.seq > since);
      events.splice(0, events.length - out.length); // collected events are not kept twice
      const d = dropped; dropped = 0;
      return { id, events: out, dropped: d, url: location.href, title: document.title };
    },
  };
})();
