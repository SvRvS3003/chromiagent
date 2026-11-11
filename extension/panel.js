// Chromiagent side panel, by SvRvS: opens straight into a terminal running the Chrome agent.
const HOST = 'ws://127.0.0.1:17371';
const $ = (id) => document.getElementById(id);
let session = null; // { ws, term, ro }

function startSession() {
  endSession();
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
  ws.onopen = () => send({ type: 'start', agent: true, cols: term.cols, rows: term.rows });
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = (e) => term.write(e.wasClean
    ? '\r\n\x1b[90m[session ended - press + for a new terminal]\x1b[0m\r\n'
    : '\r\n\x1b[31mHost not reachable on 127.0.0.1:17371 - run the installer again\x1b[0m\r\n');
  term.onData((data) => send({ type: 'in', data }));
  term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

  const ro = new ResizeObserver(() => fit.fit());
  ro.observe($('termview'));
  session = { ws, term, ro };
  term.focus();
}

function endSession() {
  if (!session) return;
  session.ro.disconnect();
  session.ws.close();
  session.term.dispose();
  session = null;
}

$('restart').onclick = startSession;
$('close').onclick = () => window.close();
startSession();
