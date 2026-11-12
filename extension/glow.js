// Chromiagent working glow, by SvRvS.
// While the agent acts on a tab, a neon light runs along the edges of that tab's page and pulses;
// it fades out a moment after the agent stops. Purely visual: it never takes clicks or keys.
const GLOW_IDLE_MS = 2500;
const glowTimers = new Map(); // tabId -> fade-out timer

function glowOn() {
  if (document.getElementById('__chromiagent-glow')) return;
  // @property is ignored inside shadow roots, so the sweep's angle is registered on the document.
  try { CSS.registerProperty({ name: '--chromiagent-a', syntax: '<angle>', inherits: true, initialValue: '0deg' }); } catch {}
  const host = document.createElement('div');
  host.id = '__chromiagent-glow';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    .layer { position:fixed; inset:0; width:100vw; height:100vh; max-width:none; max-height:none; margin:0; padding:0;
      border:0; background:transparent; overflow:visible; pointer-events:none; opacity:0; animation: in .4s ease-out forwards; }
    .layer.out { animation: out .6s ease-in forwards; }
    .pulse { position:absolute; inset:0; animation: pulse 1.8s ease-in-out infinite;
      box-shadow: inset 0 0 0 2px rgba(57,255,20,.75), inset 0 0 26px 6px rgba(57,255,20,.38), inset 0 0 90px 22px rgba(255,255,255,.07); }
    .sweep { position:absolute; inset:0; padding:3px; animation: spin 3.2s linear infinite;
      background: conic-gradient(from var(--chromiagent-a, 0deg), transparent 0 62%, rgba(57,255,20,.25) 70%, #39ff14 80%, #ffffff 84%, #39ff14 88%, transparent 96%);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); filter: drop-shadow(0 0 6px #39ff14); }
    @keyframes spin { to { --chromiagent-a: 360deg; } }
    @keyframes pulse {
      0%, 100% { box-shadow: inset 0 0 0 2px rgba(57,255,20,.6), inset 0 0 22px 4px rgba(57,255,20,.3), inset 0 0 80px 18px rgba(255,255,255,.05); }
      50% { box-shadow: inset 0 0 0 2px rgba(200,255,184,.95), inset 0 0 38px 10px rgba(57,255,20,.5), inset 0 0 120px 30px rgba(255,255,255,.12); }
    }
    @keyframes in { to { opacity:1; } }
    @keyframes out { from { opacity:1; } to { opacity:0; } }
    @media (prefers-reduced-motion: reduce) { .pulse, .sweep { animation: none; } }
  </style><div class="layer" popover="manual"><div class="pulse"></div><div class="sweep"></div></div>`;
  document.documentElement.appendChild(host);
  // The top layer keeps the glow above fullscreen video and modal dialogs.
  try { shadow.querySelector('.layer').showPopover(); } catch {}
  host.__layer = shadow.querySelector('.layer');
}

function glowOff() {
  globalThis.__chromiagentUI?.idle(); // the agent's pointer rests with the glow (it stays while a question is open)
  const host = document.getElementById('__chromiagent-glow');
  if (!host) return;
  host.__layer?.classList.add('out');
  setTimeout(() => host.remove(), 600);
}

// Call on every agent action on a tab; the glow stays while actions keep coming.
function glow(tabId) {
  if (typeof tabId !== 'number') return;
  const timer = glowTimers.get(tabId);
  if (timer) clearTimeout(timer);
  else chrome.scripting.executeScript({ target: { tabId }, func: glowOn }).catch(() => {}); // chrome://, file:// or closed tab
  glowTimers.set(tabId, setTimeout(() => {
    glowTimers.delete(tabId);
    chrome.scripting.executeScript({ target: { tabId }, func: glowOff }).catch(() => {});
  }, GLOW_IDLE_MS));
}

// A navigation wipes the page; bring the glow back if the agent is still working there.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'complete' && glowTimers.has(tabId)) {
    chrome.scripting.executeScript({ target: { tabId }, func: glowOn }).catch(() => {});
  }
});
