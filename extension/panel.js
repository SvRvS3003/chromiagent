// Chromiagent side panel, by SvRvS: opens straight into a terminal running the Chrome agent.
const HOST = 'ws://127.0.0.1:17371';
const $ = (id) => document.getElementById(id);
let session = null; // { ws, term, ro }

async function startSession(fresh = false) {
  endSession();
  const { id: panel } = await panelReady;
  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", monospace', fontSize: 12.5, cursorBlink: true, allowTransparency: true,
    theme: { background: '#00000000', foreground: '#e3e3e3', cursor: '#8ab4f8', selectionBackground: '#3c4a6b' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('term'));
  fit.fit();

  const ws = new WebSocket(HOST);
  const send = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  ws.onopen = () => send({ type: 'start', agent: true, panel, fresh, cols: term.cols, rows: term.rows });
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

// Closing the browser's side panel keeps the agent running; these two buttons end it.
$('restart').onclick = () => startSession(true);
$('close').onclick = () => { session?.send({ type: 'kill' }); setTimeout(() => window.close(), 50); };
startSession();
