// Chromiagent element grab, by SvRvS.
// Injected into the page by the panel's "select element" button: hover to outline an element, click to
// pick it, write feedback, Ctrl+Enter (or Cmd+Enter) sends element + feedback to the agent, Esc cancels.
// The overlay technique (closed shadow root, top-layer popover, capturing page presses) is adapted from
// Orca's browser grab mode: MIT License, Copyright (c) 2026 Lovecast Inc.
(() => {
  if (window.__chromiagentGrab) { window.__chromiagentGrab.cleanup(); return; } // second press toggles off

  const NEON = '#39ff14';
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:all;cursor:crosshair;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });

  // The top layer keeps the outline above modal dialogs, popovers and fullscreen elements.
  const overlay = document.createElement('div');
  overlay.popover = 'manual';
  overlay.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;';
  shadow.appendChild(overlay);

  const style = document.createElement('style');
  style.textContent = `
    .box { position:fixed; display:none; pointer-events:none; border:2px solid ${NEON}; border-radius:4px;
      background:rgba(57,255,20,.08); box-shadow:0 0 0 1px rgba(0,0,0,.45), 0 0 14px rgba(57,255,20,.55); transition:all .05s ease-out; }
    .label { position:fixed; display:none; pointer-events:none; padding:3px 8px; border-radius:5px; max-width:340px;
      background:rgba(12,14,12,.94); color:#eaffe4; font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border:1px solid rgba(57,255,20,.45); }
    .hint { position:fixed; left:50%; top:14px; transform:translateX(-50%); pointer-events:none; padding:7px 14px; border-radius:999px;
      background:rgba(12,14,12,.94); color:#eaffe4; font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
      border:1px solid rgba(57,255,20,.5); box-shadow:0 6px 24px rgba(0,0,0,.35); }
    .hint b { color:${NEON}; font-weight:600; }
    .card { position:fixed; width:340px; pointer-events:auto; cursor:auto; padding:12px; border-radius:12px;
      background:#111311; color:#eaffe4; border:1px solid rgba(57,255,20,.5); box-shadow:0 12px 40px rgba(0,0,0,.5), 0 0 18px rgba(57,255,20,.18);
      font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
    .card .title { font-weight:600; margin-bottom:8px; display:flex; align-items:center; gap:6px; }
    .card .title i { width:8px; height:8px; border-radius:50%; background:${NEON}; box-shadow:0 0 8px ${NEON}; }
    .card textarea { width:100%; box-sizing:border-box; min-height:78px; resize:vertical; padding:8px 10px; border-radius:8px;
      border:1px solid #2c3a2a; background:#0a0b0a; color:#eaffe4; font:inherit; outline:none; }
    .card textarea:focus { border-color:${NEON}; }
    .card .row { display:flex; align-items:center; gap:8px; margin-top:8px; }
    .card .keys { flex:1; color:#8fa88a; font-size:11.5px; }
    .card button { border:0; border-radius:8px; padding:6px 12px; font:600 12px/1 inherit; font-family:inherit; cursor:pointer; }
    .card .send { background:${NEON}; color:#061a02; }
    .card .cancel { background:#222622; color:#cfe8c8; }
    .toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); padding:8px 16px; border-radius:999px;
      background:${NEON}; color:#061a02; font:600 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }`;
  shadow.appendChild(style);

  const box = document.createElement('div'); box.className = 'box'; overlay.appendChild(box);
  const label = document.createElement('div'); label.className = 'label'; overlay.appendChild(label);
  const hint = document.createElement('div'); hint.className = 'hint';
  hint.innerHTML = '<b>Chromiagent</b> · click an element to give feedback · <b>Esc</b> to cancel';
  overlay.appendChild(hint);

  let current = null;
  let picked = null;
  let frame = 0;

  const text = (el, n) => (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, n);

  function outline(el) {
    if (!el || el === document.documentElement || el === document.body) {
      box.style.display = label.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px', display: 'block' });
    const role = el.getAttribute('role');
    const t = text(el, 40);
    label.textContent = [el.tagName.toLowerCase(), role && `role=${role}`, t && `"${t}"`, `${Math.round(r.width)}x${Math.round(r.height)}`].filter(Boolean).join('  ');
    const y = r.bottom + 6 + 26 > innerHeight ? r.top - 28 : r.bottom + 6;
    Object.assign(label.style, { left: Math.max(4, r.x) + 'px', top: Math.max(4, y) + 'px', display: 'block' });
  }

  function onMove(e) {
    // Hit-test the page underneath the overlay, descending into open shadow roots.
    host.style.pointerEvents = 'none';
    let el = document.elementFromPoint(e.clientX, e.clientY);
    try {
      while (el && el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(e.clientX, e.clientY);
        if (!inner || inner === el) break;
        el = inner;
      }
    } catch {} finally { host.style.pointerEvents = 'all'; }
    if (el && el !== current) { current = el; cancelAnimationFrame(frame); frame = requestAnimationFrame(() => outline(el)); }
  }

  // Swallow real presses so the page does not react to the pick; scripted clicks pass through.
  const PRESS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick', 'click', 'contextmenu'];
  function onPress(e) {
    if (!e.isTrusted || (e.type === 'click' && e.detail === 0)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && current && !picked) pick(current);
  }

  function raise(e) {
    if (e.type === 'toggle' && e.newState !== 'open') return;
    overlay.hidePopover(); overlay.showPopover();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cleanup(); }
  }

  function stopPicking() {
    window.removeEventListener('mousemove', onMove, true);
    PRESS.forEach((t) => window.removeEventListener(t, onPress, true));
  }

  function selectorFor(el) {
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
    if (el.id && document.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement && parts.length < 7; node = node.parentElement) {
      if (node.id && document.querySelectorAll('#' + esc(node.id)).length === 1) { parts.unshift('#' + esc(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const testId = node.getAttribute('data-testid');
      if (testId) part += `[data-testid="${testId}"]`;
      else {
        const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const name of ['id', 'class', 'name', 'type', 'role', 'href', 'src', 'alt', 'title', 'placeholder', 'aria-label', 'data-testid']) {
      const v = el.getAttribute(name);
      if (v) attrs[name] = v.slice(0, 160);
    }
    // Never send what was typed into fields; the agent can read the page itself if it needs to.
    const clone = el.cloneNode(true);
    clone.querySelectorAll?.('input, textarea').forEach((f) => f.removeAttribute('value'));
    if (clone.removeAttribute && (clone.tagName === 'INPUT' || clone.tagName === 'TEXTAREA')) clone.removeAttribute('value');
    return {
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el),
      text: el.matches?.('input, textarea') ? '' : text(el, 300),
      attributes: attrs,
      html: (clone.outerHTML || '').replace(/\s+/g, ' ').slice(0, 500),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      selectedText: String(getSelection() || '').slice(0, 300),
      page: { url: location.href, title: document.title },
    };
  }

  function pick(el) {
    picked = el;
    stopPicking();
    host.style.cursor = 'default';
    host.style.pointerEvents = 'none'; // the page scrolls normally; only the card takes input
    hint.remove();
    outline(el);
    label.remove(); // the card sits where the label was
    const follow = () => { outline(el); place(); };
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow, true);
    cleanups.push(() => { window.removeEventListener('scroll', follow, true); window.removeEventListener('resize', follow, true); });

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="title"><i></i>Feedback to the agent</div>
      <textarea placeholder="What should the agent do with this element?"></textarea>
      <div class="row"><span class="keys">Ctrl+Enter send · Esc cancel</span>
      <button class="cancel" type="button">Cancel</button><button class="send" type="button">Send</button></div>`;
    overlay.appendChild(card);
    const area = card.querySelector('textarea');
    function place() {
      const r = el.getBoundingClientRect();
      const h = card.offsetHeight || 170;
      let top = r.bottom + 10;
      if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 10);
      card.style.left = Math.min(Math.max(8, r.x), innerWidth - 348) + 'px';
      card.style.top = top + 'px';
    }
    place();
    const send = () => {
      const feedback = area.value.trim();
      if (!feedback) { area.focus(); return; }
      chrome.runtime.sendMessage({ type: 'chromiagent-grab', feedback, element: describe(el) });
      card.remove();
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = 'Sent to the agent';
      overlay.appendChild(toast);
      setTimeout(cleanup, 900);
    };
    // Keys typed in the card stay in the card: page shortcuts (video players, editors) never see them.
    card.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
      else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
    });
    for (const t of ['keyup', 'keypress', 'input']) card.addEventListener(t, (e) => e.stopPropagation());
    card.querySelector('.send').onclick = send;
    card.querySelector('.cancel').onclick = cleanup;
    setTimeout(() => area.focus(), 0);
  }

  const cleanups = [];
  function cleanup() {
    stopPicking();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('toggle', raise, true);
    window.removeEventListener('fullscreenchange', raise, true);
    cleanups.forEach((f) => f());
    try { host.remove(); } catch {}
    delete window.__chromiagentGrab;
  }

  overlay.showPopover();
  window.addEventListener('toggle', raise, true);
  window.addEventListener('fullscreenchange', raise, true);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('keydown', onKey, true);
  PRESS.forEach((t) => window.addEventListener(t, onPress, true));
  window.__chromiagentGrab = { cleanup };
})();
