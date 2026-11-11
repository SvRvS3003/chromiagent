// Chromiagent local host, by SvRvS. Listens on ws://127.0.0.1:17371
//   /        terminal (PTY) for the side panel            - extension origin only
//   /bridge  the panel's Chrome-control bridge            - extension origin only
//   /mcp     relay for host/mcp.js (agent tab tools)      - local processes only (no Origin header)
//   /cdp     CDP endpoint for Playwright                 - local processes only, relayed to the panel
// Every panel has its own id (?panel=...). The agent started in a panel's terminal gets that id in
// CHROMIAGENT_PANEL, so its tools always drive the browser that panel lives in, never another one.
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const PORT = 17371;
const EXT_ORIGIN = 'chrome-extension://lagobfbebmgoaemfkbnmeljdfagpaefj';
const LOCAL_PATHS = new Set(['/mcp', '/cdp']);
const route = (req) => new URL(req.url, 'http://localhost');

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  maxPayload: 64 * 1024 * 1024,
  // Browsers always send Origin, so web pages can only reach the extension paths and are rejected there.
  verifyClient: ({ origin, req }) => (LOCAL_PATHS.has(route(req).pathname) ? !origin : origin === EXT_ORIGIN),
});

const bridges = new Map();    // panel id -> bridge socket
let latestBridge = null;      // for tools started outside a panel terminal
const pending = new Map();    // relay id -> { ws, id }
let seq = 0;

const isOpen = (ws) => ws && ws.readyState === ws.OPEN;
// With a panel id: that panel's bridge or nothing. Without one: the most recent panel.
const bridgeFor = (panel) => (panel ? bridges.get(panel) : latestBridge);
const notOpen = (panel) => (panel ? 'The Chromiagent panel this agent was started from is closed. Reopen the panel.' : 'Chromiagent side panel is not open in Chrome.');

wss.on('connection', (ws, req) => {
  const { pathname, searchParams } = route(req);
  const panel = searchParams.get('panel') || '';
  if (pathname === '/bridge') return onBridge(ws, panel);
  if (pathname === '/mcp') return onMcp(ws, panel);
  if (pathname === '/cdp') return onCdp(ws, panel);
  onTerminal(ws);
});

function onBridge(ws, panel) {
  if (panel) bridges.set(panel, ws);
  latestBridge = ws;
  ws.cdpClient = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.cdp) return isOpen(ws.cdpClient) && ws.cdpClient.send(JSON.stringify(msg.cdp));
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    isOpen(p.ws) && p.ws.send(JSON.stringify({ ...msg, id: p.id }));
  });
  ws.on('close', () => {
    if (bridges.get(panel) === ws) bridges.delete(panel);
    if (latestBridge === ws) latestBridge = [...bridges.values()].pop() || null;
    if (ws.cdpClient) ws.cdpClient.close(1011, 'Chromiagent panel closed');
  });
}

function onMcp(ws, panel) {
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const bridge = bridgeFor(panel);
    if (!isOpen(bridge)) return ws.send(JSON.stringify({ id: msg.id, error: notOpen(panel) }));
    const rid = ++seq;
    pending.set(rid, { ws, id: msg.id });
    bridge.send(JSON.stringify({ id: rid, tool: msg.tool, args: msg.args || {} }));
  });
}

function onCdp(ws, panel) {
  const bridge = bridgeFor(panel);
  if (!isOpen(bridge)) return ws.close(1011, notOpen(panel));
  if (bridge.cdpClient) bridge.cdpClient.close();
  bridge.cdpClient = ws;
  bridge.send(JSON.stringify({ cdpOpen: true }));
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    isOpen(bridge) && bridge.send(JSON.stringify({ cdp: msg }));
  });
  ws.on('close', () => {
    if (bridge.cdpClient !== ws) return;
    bridge.cdpClient = null;
    isOpen(bridge) && bridge.send(JSON.stringify({ cdpClose: true }));
  });
}

function onTerminal(ws) {
  let term = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'start' && !term) {
      term = pty.spawn(process.env.SHELL || '/bin/zsh', ['-il'], {
        name: 'xterm-256color',
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        cwd: os.homedir(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          LANG: process.env.LANG || 'en_US.UTF-8',
          CHROMIAGENT_PANEL: /^[\w-]{1,64}$/.test(msg.panel || '') ? msg.panel : '',
        },
      });
      term.onData((d) => isOpen(ws) && ws.send(d));
      term.onExit(() => ws.close());
      if (msg.agent) term.write(`'${path.join(__dirname, 'agent.sh')}'\r`);
    } else if (msg.type === 'in' && term) {
      term.write(msg.data);
    } else if (msg.type === 'resize' && term && msg.cols > 0 && msg.rows > 0) {
      term.resize(msg.cols, msg.rows);
    }
  });
  ws.on('close', () => term && term.kill());
}

console.log(`chromiagent host on ws://127.0.0.1:${PORT}`);
