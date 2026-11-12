// Chromiagent side panel, by SvRvS: opens straight into a terminal running the Chrome agent.
const HOST = 'ws://127.0.0.1:17371';
const $ = (id) => document.getElementById(id);
let session = null; // { ws, term, ro }

async function startSession(fresh = false) {
  endSession();
  const { id: panel } = await panelReady;
  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Consolas, "DejaVu Sans Mono", monospace', fontSize: 12.5, cursorBlink: true,
    allowProposedApi: true, macOptionIsMeta: true, scrollback: 5000,
    theme: { background: '#131314', foreground: '#e3e3e3', cursor: '#39ff14', selectionBackground: '#2f4a2a' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Unicode 11 widths keep emoji and box drawing aligned in full-screen TUIs (opencode, codex...).
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open($('term'));
  // GPU rendering keeps busy TUIs smooth; the DOM renderer takes over if WebGL is unavailable.
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {}
  fit.fit();

  const ws = new WebSocket(HOST);
  const send = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  ws.onopen = () => send({ type: 'start', agent: $('agent').value, panel, fresh, cols: term.cols, rows: term.rows });
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = (e) => term.write(e.wasClean
    ? '\r\n\x1b[90m[session ended - press + for a new terminal]\x1b[0m\r\n'
    : '\r\n\x1b[31mHost not reachable on 127.0.0.1:17371 - run the installer again\x1b[0m\r\n');
  term.onData((data) => send({ type: 'in', data }));
  term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

  const ro = new ResizeObserver(() => fit.fit());
  ro.observe($('termview'));
  session = { ws, term, ro, send };
  term.focus();
}

function endSession() {
  if (!session) return;
  session.ro.disconnect();
  session.ws.close();
  session.term.dispose();
  session = null;
}

// ---- element grab: pick an element on the page, write feedback, Ctrl+Enter sends it to the agent ----
$('grab').onclick = async () => {
  const { windowId } = await panelReady;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  try {
    if (!/^https?:/i.test(tab?.url || '')) throw new Error('only web pages can be selected');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['grab.js'] });
  } catch (e) {
    session?.term.write(`\r\n\x1b[33m[select element: ${e.message}]\x1b[0m\r\n`);
  }
};

function grabMessage({ feedback, element: el }, tabId) {
  const attrs = Object.entries(el.attributes).map(([k, v]) => `${k}="${v}"`).join(' ');
  return [
    feedback,
    '',
    `[Element selected in tab ${tabId}: "${el.page.title}" ${el.page.url}]`,
    `selector: ${el.selector}`,
    `tag: <${el.tag}>${attrs ? ' ' + attrs : ''}`,
    el.text ? `text: "${el.text}"` : null,
    el.selectedText ? `selected text: "${el.selectedText}"` : null,
    `box: ${el.rect.width}x${el.rect.height} at (${el.rect.x}, ${el.rect.y}) in the viewport`,
    `html: ${el.html}`,
  ].filter((l) => l !== null).join('\n');
}

chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg?.type !== 'chromiagent-grab' || !session) return;
  const { windowId } = await panelReady;
  if (sender.tab?.windowId !== windowId) return; // another window's panel owns it
  // Bracketed paste keeps the multi-line message as one input; Enter then submits it to the agent.
  session.send({ type: 'in', data: `\x1b[200~${grabMessage(msg, sender.tab.id)}\x1b[201~` });
  setTimeout(() => session?.send({ type: 'in', data: '\r' }), 150);
  session.term.focus();
});

// ---- agent picker: any installed CLI (Claude Code, opencode, Codex, Qwen, Gemini) or a plain shell ----
const AGENT_NAMES = { claude: 'Claude Code', opencode: 'opencode', codex: 'Codex', qwen: 'Qwen Code', gemini: 'Gemini CLI', shell: 'Shell' };
const savedAgent = () => { try { return localStorage.getItem('chromiagent.agent'); } catch { return null; } };
function fillAgents(list) {
  const pick = list.includes(savedAgent()) ? savedAgent() : list[0];
  $('agent').replaceChildren(...list.map((a) => new Option(AGENT_NAMES[a] || a, a, false, a === pick)));
}
$('agent').onchange = () => {
  try { localStorage.setItem('chromiagent.agent', $('agent').value); } catch {}
  startSession(true); // a different CLI means a new session
};
// The host reports the installed CLIs in the close reason of a one-shot socket.
const loadAgents = () => new Promise((resolve) => {
  const ws = new WebSocket(`${HOST}/agents`);
  ws.onclose = (e) => { try { fillAgents(JSON.parse(e.reason)); } catch {} resolve(); };
});

// Closing the browser's side panel keeps the agent running; these two buttons end it.
$('restart').onclick = () => startSession(true);
$('close').onclick = () => { session?.send({ type: 'kill' }); setTimeout(() => window.close(), 50); };
loadAgents().then(() => startSession());

// ---- the agent's question shown in the panel itself, when the active tab is not a web page ----
let closeAsk = null;
function panelAsk({ question, options = [], placeholder }) {
  closeAsk?.({ type: 'cancel' });
  const form = $('ask'), input = $('ask-in');
  $('ask-q').textContent = String(question || '');
  $('ask-opts').replaceChildren(...options.slice(0, 9).map((label, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.append(Object.assign(document.createElement('kbd'), { textContent: i + 1 }), String(label));
    b.onclick = () => closeAsk({ type: 'option', value: String(label) });
    return b;
  }));
  input.value = '';
  input.placeholder = placeholder || (options.length ? 'Or write your own answer…' : 'Your answer…');
  form.hidden = false;
  input.focus();
  return new Promise((resolve) => {
    const timer = setTimeout(() => closeAsk({ type: 'timeout' }), 10 * 60 * 1000);
    closeAsk = (r) => { clearTimeout(timer); closeAsk = null; form.hidden = true; session?.term.focus(); resolve(r); };
  });
}
$('ask').onsubmit = (e) => { e.preventDefault(); const v = $('ask-in').value.trim(); if (v) closeAsk?.({ type: 'text', value: v }); };
$('ask-in').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('ask').requestSubmit(); } };
$('ask-x').onclick = () => closeAsk?.({ type: 'cancel' });
$('ask').onkeydown = (e) => {
  if (e.key === 'Escape') closeAsk?.({ type: 'cancel' });
  else if (/^[1-9]$/.test(e.key) && e.target !== $('ask-in')) $('ask-opts').children[e.key - 1]?.click();
};

// The agent waits for the user on a tab they are not looking at; the button takes them there.
function panelNotice(text, tab) {
  $('notice-q').textContent = text;
  $('notice-go').onclick = async () => {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  };
  $('notice').hidden = false;
  return () => { $('notice').hidden = true; };
}
