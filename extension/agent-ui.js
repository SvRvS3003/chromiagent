// Chromiagent agent cursor and question card, by SvRvS.
// Injected into a web page (the extension's isolated world). The agent gets its own pointer, in the
// logo's animated neon green and white, separate from the user's mouse: it glides to whatever the agent
// is about to click or type into. When the agent needs the user, a card pops out next to that pointer
// with a reply box and/or ready answers; for passwords and codes it points at the field and the user
// types into the page directly, so the agent never sees the value.
(() => {
  if (globalThis.__chromiagentUI) return;

  const ARROW = 'M3 1.5v19.2l5.1-4.9 3.3 7.2 3.4-1.5-3.3-7.1h7.1z';
  const SPARKLE = 'M12 0C12 6.6 17.4 12 24 12C17.4 12 12 17.4 12 24C12 17.4 6.6 12 0 12C6.6 12 12 6.6 12 0Z';
  const svgMask = (d) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='${d}'/></svg>`)}") center / contain no-repeat`;
  const LOGO = 'conic-gradient(from var(--chromiagent-a, 0deg), #39ff14, #c8ffb8, #ffffff, #00ff88, #39ff14)';
  const ASK_TIMEOUT_MS = 10 * 60 * 1000;

  const CSS = `
    .layer { position:fixed; inset:0; width:100vw; height:100vh; max-width:none; max-height:none; margin:0; padding:0;
      border:0; background:transparent; overflow:visible; pointer-events:none; color-scheme:dark;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .spin { animation: spin 2.6s linear infinite; }
    @keyframes spin { to { --chromiagent-a: 360deg; } }

    .cursor { position:fixed; left:0; top:0; width:26px; height:26px; opacity:0;
      transition: opacity .25s ease;
      animation: spin 2.6s linear infinite, halo 1.6s ease-in-out infinite; will-change: transform; }
    .cursor.on { opacity:1; }
    .cursor .fill { position:absolute; inset:0; background:${LOGO}; -webkit-mask:${svgMask(ARROW)}; mask:${svgMask(ARROW)}; }
    .cursor svg { position:absolute; inset:0; overflow:visible; }
    .cursor svg path { fill:none; stroke:#062b00; stroke-width:1.1; stroke-linejoin:round; }
    @keyframes halo {
      0%,100% { filter: drop-shadow(0 0 3px rgba(57,255,20,.75)) drop-shadow(0 1px 1.5px rgba(0,0,0,.55)); }
      50% { filter: drop-shadow(0 0 9px rgba(57,255,20,.95)) drop-shadow(0 0 2px #fff) drop-shadow(0 1px 1.5px rgba(0,0,0,.55)); }
    }
    .tag { position:absolute; left:19px; top:21px; display:flex; align-items:center; gap:5px; white-space:nowrap;
      padding:2px 8px 2px 5px; border-radius:999px; font-size:11px; font-weight:600; color:#eaffe4;
      background: linear-gradient(#101410,#101410) padding-box, ${LOGO} border-box; border:1px solid transparent;
      box-shadow: 0 2px 10px rgba(0,0,0,.45); }
    .hint-pill { position:fixed; animation: rise .25s ease-out; }
    .logo { width:12px; height:12px; flex:none; background:${LOGO}; -webkit-mask:${svgMask(SPARKLE)}; mask:${svgMask(SPARKLE)}; }

    .ripple { position:fixed; width:34px; height:34px; margin:-17px 0 0 -17px; border-radius:50%;
      border:2px solid #39ff14; box-shadow: 0 0 12px #39ff14, inset 0 0 8px rgba(255,255,255,.6);
      animation: ripple .55s ease-out forwards; }
    @keyframes ripple { from { transform:scale(.25); opacity:1; } to { transform:scale(1.5); opacity:0; } }

    .mark { position:fixed; border-radius:8px; pointer-events:none;
      box-shadow: 0 0 0 2px #39ff14, 0 0 18px 4px rgba(57,255,20,.55), 0 0 0 9999px rgba(0,0,0,.28);
      animation: markpulse 1.4s ease-in-out infinite; transition: all .12s linear; }
    @keyframes markpulse { 50% { box-shadow: 0 0 0 2px #fff, 0 0 26px 8px rgba(57,255,20,.75), 0 0 0 9999px rgba(0,0,0,.28); } }

    .card { position:fixed; width:min(340px, calc(100vw - 24px)); pointer-events:auto; color:#e8ece6;
      background: linear-gradient(#141615f2,#141615f2) padding-box, ${LOGO} border-box; border:1.5px solid transparent;
      border-radius:14px; padding:12px 12px 10px; box-shadow: 0 12px 40px rgba(0,0,0,.55), 0 0 24px rgba(57,255,20,.22);
      transform-origin: var(--ox, 0) var(--oy, 0); animation: spin 2.6s linear infinite, pop .38s cubic-bezier(.2,1.3,.35,1) both;
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
    .card.out { animation: spin 2.6s linear infinite, popout .22s ease-in forwards; }
    @keyframes pop { from { opacity:0; transform: scale(.6); } to { opacity:1; transform:none; } }
    @keyframes popout { to { opacity:0; transform: scale(.85); } }
    .head { display:flex; align-items:center; gap:7px; font-size:12px; color:#a9b8a4; }
    .head b { color:#eaffe4; font-weight:650; }
    .head .logo { width:14px; height:14px; }
    .x { margin-left:auto; width:22px; height:22px; border:0; border-radius:50%; background:transparent; color:#a9b8a4;
      font-size:16px; line-height:1; cursor:pointer; }
    .x:hover { background:#262a26; color:#fff; }
    .q { margin:8px 0 10px; font-size:14px; color:#f4f7f2; white-space:pre-wrap; word-wrap:break-word; }
    .q::after { content:''; display:inline-block; width:7px; height:1em; margin-left:2px; vertical-align:-2px;
      background:#39ff14; animation: caret .8s steps(1) infinite; }
    .q.typed::after { display:none; }
    @keyframes caret { 50% { opacity:0; } }
    .opts { display:flex; flex-direction:column; gap:6px; }
    .opt { display:flex; align-items:center; gap:8px; text-align:left; width:100%; padding:7px 10px; border-radius:9px;
      border:1px solid #2d3a2a; background:#1a1f19; color:#e8ece6; font:inherit; cursor:pointer;
      opacity:0; animation: rise .3s ease-out forwards; }
    .opt:hover, .opt:focus-visible { border-color:#39ff14; background:#1f2b1c; outline:none; box-shadow:0 0 0 1px #39ff14 inset; }
    .opt kbd { flex:none; min-width:18px; padding:0 4px; border-radius:5px; background:#0e120d; color:#39ff14;
      font:600 11px/18px ui-monospace, Menlo, monospace; text-align:center; }
    @keyframes rise { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform:none; } }
    .row { display:flex; gap:6px; align-items:flex-end; margin-top:8px; }
    textarea { flex:1; min-height:34px; max-height:140px; resize:none; padding:8px 10px; border-radius:9px;
      border:1px solid #2d3a2a; background:#0e120d; color:#f4f7f2; font:inherit; outline:none; }
    textarea:focus { border-color:#39ff14; box-shadow: 0 0 0 1px #39ff14, 0 0 12px rgba(57,255,20,.3); }
    .send, .done { flex:none; height:34px; padding:0 12px; border:0; border-radius:9px; cursor:pointer;
      background:#39ff14; color:#062b00; font-family:inherit; font-size:13px; font-weight:650; box-shadow: 0 0 14px rgba(57,255,20,.45); }
    .send:hover, .done:hover { background:#c8ffb8; }
    .done { flex:1; }
    .note { margin-top:8px; font-size:11.5px; color:#8f9e8a; }
    .hint { margin-top:7px; font-size:11px; color:#6f7d6b; text-align:right; }
    @media (prefers-reduced-motion: reduce) {
      .cursor, .card, .card.out, .opt, .mark, .q::after { animation:none !important; opacity:1; }
      .cursor { transition: opacity .2s; }
    }`;

  // @property is ignored inside shadow roots, so the spinning angle is registered on the document.
  try { CSS.registerProperty({ name: '--chromiagent-a', syntax: '<angle>', inherits: true, initialValue: '0deg' }); } catch {}

  let host = null, root = null, layer = null, cursor = null, tag = null;
  let pos = null;      // where the agent's pointer is now (viewport px)
  let card = null;     // the open question, if any

  function mount() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = '__chromiagent-ui';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div class="layer" popover="manual">
      <div class="cursor"><div class="fill"></div><svg viewBox="0 0 24 24"><path d="${ARROW}"/></svg>
      <div class="tag"><i class="logo"></i><span>Chromiagent</span></div></div></div>`;
    document.documentElement.appendChild(host);
    layer = root.querySelector('.layer');
    // The top layer keeps the pointer and card above fullscreen video and the page's own dialogs.
    try { layer.showPopover(); } catch {}
    cursor = root.querySelector('.cursor');
    tag = root.querySelector('.tag span');
  }

  const place = (x, y) => { cursor.style.transform = `translate(${x - 3}px, ${y - 1.5}px)`; };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Glide to (x, y) along a human arc — a wide bezier bend, a bit of noise that fades at the ends, a
  // per-move randomized duration, and sometimes a small overshoot that gets corrected, the way a hand
  // approaches a target. Resolves when the pointer has arrived, so the action happens under it.
  function move(x, y, label, from) {
    mount();
    guard(true);
    tag.textContent = label || 'Chromiagent';
    const start = pos || from || { x: innerWidth * 0.62, y: innerHeight * 0.72 };
    if (!cursor.classList.contains('on')) {
      place(start.x, start.y);
      cursor.getBoundingClientRect(); // commit the start point before animating
      cursor.classList.add('on');
    }
    const dx = x - start.x, dy = y - start.y, dist = Math.hypot(dx, dy) || 1;
    // A hidden tab neither animates nor runs timers on time, so the pointer just jumps there.
    if (dist < 3 || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      place(x, y);
      pos = { x, y };
      return Promise.resolve(pos);
    }
    const dur = Math.round(Math.min(720, Math.max(170, dist * 0.55)) * (0.85 + Math.random() * 0.35));
    const overshoot = dist > 110 && Math.random() < 0.35;
    const nx = -dy / dist, ny = dx / dist;
    const bend = (0.10 + Math.random() * 0.26) * dist * (Math.random() < 0.5 ? 1 : -1);
    const cx = (start.x + x) / 2 + nx * bend, cy = (start.y + y) / 2 + ny * bend;
    const over = overshoot ? 5 + Math.random() * 7 : 0;
    const ax = x + (dx / dist) * over, ay = y + (dy / dist) * over; // the approach passes the target a little
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = () => {
        const t = Math.min(1, (performance.now() - t0) / dur);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // cubic ease in-out
        const m = 1 - e;
        const jitter = Math.sin(Math.PI * e) * 1.7; // noise that fades at both ends
        const px = m * m * start.x + 2 * m * e * cx + e * e * ax + (Math.random() - 0.5) * jitter * nx * 2;
        const py = m * m * start.y + 2 * m * e * cy + e * e * ay + (Math.random() - 0.5) * jitter * ny * 2;
        place(px, py);
        if (t < 1) { requestAnimationFrame(step); return; }
        if (!overshoot) { pos = { x, y }; resolve(pos); return; }
        // Correct the overshoot in a short second glide — the "oops, just there" hand.
        const s2 = performance.now(), d2 = 90 + Math.random() * 80, sx = ax, sy = ay;
        const fix = () => {
          const t2 = Math.min(1, (performance.now() - s2) / d2);
          const e2 = 1 - Math.pow(1 - t2, 2);
          place(sx + (x - sx) * e2, sy + (y - sy) * e2);
          if (t2 < 1) requestAnimationFrame(fix);
          else { pos = { x, y }; resolve(pos); }
        };
        requestAnimationFrame(fix);
      };
      requestAnimationFrame(step);
    });
  }

  // Centers of the pieces of one color, for the pre-move "scan" of a human player.
  function pieceCenters(color) {
    const out = [];
    for (const el of document.querySelectorAll('.piece, piece')) {
      const cls = [...el.classList];
      let c = '';
      const cc = cls.find((k) => /^[wb][pnbrqk]$/.test(k));
      if (cc) c = cc[0];
      else if (cls.includes('white')) c = 'w';
      else if (cls.includes('black')) c = 'b';
      if (!c || (color && c !== color)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }
    return out;
  }

  // A full human-like move: glance at one friendly piece or two (the scan before committing), glide to
  // `from`, a short hover dwell, the press, the glide to `to`, the release, and a small settle drift —
  // all in one call, so a drag (a chess move) reads like one motion of a hand.
  async function stroke(fromX, fromY, toX, toY, opts = {}) {
    mount();
    guard(true);
    const decoys = Math.min(2, Math.max(0, Number(opts.decoys) || 0));
    if (decoys > 0) {
      const pieces = pieceCenters(opts.color).sort(() => Math.random() - 0.5);
      let used = 0;
      for (const p of pieces) {
        if (used >= decoys) break;
        if (Math.hypot(p.x - fromX, p.y - fromY) < 32) continue; // not the piece we mean to move
        await move(p.x, p.y, null, null);
        await wait(140 + Math.random() * 260);
        used++;
      }
    }
    await move(fromX, fromY, opts.label, null);
    await wait(70 + Math.random() * 170);
    press();
    await wait(45 + Math.random() * 90);
    await move(toX, toY, opts.label, { x: fromX, y: fromY });
    press();
    await move(toX + (Math.random() - 0.5) * 40, toY + (Math.random() - 0.5) * 40, null, { x: toX, y: toY }); // the hand rests near the board
    return pos;
  }

  function press() {
    if (!pos) return;
    const ring = document.createElement('div');
    ring.className = 'ripple';
    ring.style.left = `${pos.x}px`;
    ring.style.top = `${pos.y}px`;
    layer.appendChild(ring);
    setTimeout(() => ring.remove(), 600);
  }

  function idle() {
    if (card || !cursor) return;
    cursor.classList.remove('on');
    guard(false);
    tookOver = false;
  }

  // ---- while the agent works on this page, only its pointer acts here ----
  // The user's real mouse is held back (their cursor shows "not allowed"), so the two never mix.
  // Esc gives the mouse back. The agent's own input is let through by pass() around each event.
  const HELD = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
    'pointermove', 'mousemove', 'pointerover', 'pointerout', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave'];
  let guarding = false, letThrough = false, tookOver = false, hint = null, hintTimer = 0;
  const busyStyle = document.createElement('style');
  busyStyle.textContent = 'html[data-chromiagent-busy], html[data-chromiagent-busy] * { cursor: not-allowed !important; }';

  function guard(on) {
    guarding = on && !tookOver && !card;
    if (guarding) { document.documentElement.setAttribute('data-chromiagent-busy', ''); if (!busyStyle.isConnected) document.documentElement.appendChild(busyStyle); }
    else { document.documentElement.removeAttribute('data-chromiagent-busy'); hideHint(); }
  }
  function hold(e) {
    if (!guarding || letThrough || !e.isTrusted || (host && e.composedPath().includes(host))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'pointerdown') showHint(e.clientX, e.clientY);
  }
  for (const t of HELD) addEventListener(t, hold, true);
  addEventListener('keydown', (e) => {
    if (hint && e.key === 'Escape' && e.isTrusted) { e.preventDefault(); e.stopImmediatePropagation(); tookOver = true; guard(false); }
  }, true);

  function showHint(x, y) {
    mount();
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'tag hint-pill';
      hint.innerHTML = '<i class="logo"></i><span>Chromiagent is working here · Esc to use your mouse</span>';
      layer.appendChild(hint);
    }
    hint.style.left = `${Math.min(x + 14, innerWidth - 330)}px`;
    hint.style.top = `${Math.min(y + 46, innerHeight - 30)}px`;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 2600);
  }
  function hideHint() { clearTimeout(hintTimer); hint?.remove(); hint = null; }
  const pass = (on) => { letThrough = on; };

  const findField = (ref, selector) => (selector ? document.querySelector(selector)
    : ref != null ? document.querySelector(`[data-ca="${ref}"]`) : null);

  // Put the card beside the pointer (or the field), flipped to stay on screen.
  function position(el, anchor) {
    const w = el.offsetWidth, h = el.offsetHeight, m = 12;
    let x, y;
    if (anchor) {
      x = anchor.x + 14; y = anchor.y + 48; // below the pointer's tag
      if (x + w > innerWidth - m) x = anchor.x - w - 10;
      if (y + h > innerHeight - m) y = anchor.y - h - 12;
    } else {
      x = (innerWidth - w) / 2; y = innerHeight - h - 28;
    }
    x = Math.max(m, Math.min(x, innerWidth - w - m));
    y = Math.max(m, Math.min(y, innerHeight - h - m));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (anchor) { el.style.setProperty('--ox', `${anchor.x - x}px`); el.style.setProperty('--oy', `${anchor.y - y}px`); }
  }

  function typeOut(el, text) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || text.length > 220) { el.textContent = text; el.classList.add('typed'); return; }
    let i = 0;
    const step = Math.max(1, Math.ceil(text.length / 60));
    const t = setInterval(() => {
      i += step;
      el.textContent = text.slice(0, i);
      if (i >= text.length) { clearInterval(t); el.classList.add('typed'); }
    }, 16);
  }

  // Resolves with { type: 'text' | 'option' | 'done' | 'cancel' | 'timeout', value? }.
  function ask({ question, options = [], placeholder, ref, selector } = {}) {
    mount();
    guard(false); // the user needs the page while answering
    if (card) card.finish({ type: 'cancel' });
    const field = findField(ref, selector);
    if ((ref != null || selector) && !field) return Promise.resolve({ type: 'error', value: 'field not found; call read_page again' });
    const fieldMode = !!field;

    const el = document.createElement('div');
    el.className = 'card';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Chromiagent question');
    el.innerHTML = `<div class="head"><i class="logo"></i><b>Chromiagent</b><span>${fieldMode ? 'needs you here' : 'asks'}</span>
      <button class="x" title="Cancel (Esc)" aria-label="Cancel">×</button></div><p class="q" aria-live="polite"></p>`;
    const opts = document.createElement('div');
    opts.className = 'opts';
    options.slice(0, 9).forEach((label, i) => {
      const b = document.createElement('button');
      b.className = 'opt';
      b.style.animationDelay = `${120 + i * 45}ms`;
      b.innerHTML = '<kbd></kbd><span></span>';
      b.querySelector('kbd').textContent = String(i + 1);
      b.querySelector('span').textContent = String(label);
      b.onclick = () => finish({ type: 'option', value: String(label) });
      opts.appendChild(b);
    });
    if (options.length) el.appendChild(opts);

    let input = null, onKey = null;
    if (fieldMode) {
      el.insertAdjacentHTML('beforeend', `<div class="row"><button class="done">Done</button></div>
        <div class="note">Type it into the highlighted field yourself. Chromiagent never sees it.</div>
        <div class="hint">Ctrl+Enter when done · Esc to cancel</div>`);
      el.querySelector('.done').onclick = () => finish({ type: 'done' });
      // Finishing from the page field itself, where the user is typing.
      onKey = (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopImmediatePropagation(); finish({ type: 'done' }); }
        else if (e.key === 'Escape' && e.target === field) finish({ type: 'cancel' });
      };
      addEventListener('keydown', onKey, true);
    } else {
      el.insertAdjacentHTML('beforeend', `<form class="row"><textarea rows="1"></textarea><button class="send" type="submit" aria-label="Send">↵</button></form>
        <div class="hint">Enter to send · Shift+Enter new line · Esc to cancel</div>`);
      input = el.querySelector('textarea');
      input.placeholder = placeholder || (options.length ? 'Or write your own answer…' : 'Your answer…');
      input.oninput = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); el.querySelector('form').requestSubmit(); }
      };
      el.querySelector('form').onsubmit = (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v) finish({ type: 'text', value: v });
      };
    }
    el.querySelector('.x').onclick = () => finish({ type: 'cancel' });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish({ type: 'cancel' }); }
      else if (/^[1-9]$/.test(e.key) && e.target !== input && options[e.key - 1] !== undefined) finish({ type: 'option', value: String(options[e.key - 1]) });
      e.stopPropagation(); // keep the page's own shortcuts from firing while the user answers
    });
    for (const t of ['keyup', 'keypress', 'input', 'mousedown', 'pointerdown', 'click']) el.addEventListener(t, (e) => e.stopPropagation());

    // In field mode, a ring follows the field (it may move with scrolling or layout changes).
    let mark = null, raf = 0;
    if (fieldMode) {
      mark = document.createElement('div');
      mark.className = 'mark';
      layer.appendChild(mark);
      const track = () => {
        const r = field.getBoundingClientRect();
        Object.assign(mark.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
        raf = requestAnimationFrame(track);
      };
      track();
    }

    layer.appendChild(el);
    position(el, pos);
    typeOut(el.querySelector('.q'), String(question || ''));
    setTimeout(() => (fieldMode ? field.focus() : input.focus()), 60);

    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const timer = setTimeout(() => finish({ type: 'timeout' }), ASK_TIMEOUT_MS);
    function finish(result) {
      if (card !== handle) return;
      card = null;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      if (onKey) removeEventListener('keydown', onKey, true);
      mark?.remove();
      el.classList.add('out');
      setTimeout(() => el.remove(), 230);
      resolve(result);
    }
    const handle = { finish };
    card = handle;
    return done;
  }

  globalThis.__chromiagentUI = { move, press, stroke, idle, ask, pass };
})();
