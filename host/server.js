// Chromiagent local host, by SvRvS. Listens on ws://127.0.0.1:17371
//   /        terminal (PTY) for the side panel            - extension origin only
//   /bridge  the panel's Chrome-control bridge            - extension origin only
//   /mcp     relay for host/mcp.js (agent tab tools)      - local processes only (no Origin header)
//   /cdp     CDP endpoint for Playwright                 - local processes only, relayed to the panel
// Every panel has its own id (?panel=...). The agent started in a panel's terminal gets that id in
// CHROMIAGENT_PANEL, so its tools always drive the browser that panel lives in, never another one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const PORT = 17371;
const EXT_ORIGIN = 'chrome-extension://lagobfbebmgoaemfkbnmeljdfagpaefj';
const LOCAL_PATHS = new Set(['/mcp', '/cdp']);
const route = (req) => new URL(req.url, 'http://localhost');
const WIN = process.platform === 'win32';

// The agent's tool servers, written once at start so no shell has to quote JSON.
const MCP_CONFIG = path.join(__dirname, 'mcp-config.json');
fs.writeFileSync(MCP_CONFIG, JSON.stringify({ mcpServers: {
  chrome: { command: process.execPath, args: [path.join(__dirname, 'mcp.js')] },
  codemode: { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'codemode.js')] },
} }, null, 2));
const PROMPT = path.join(__dirname, 'agent-prompt.md');

// Typed into the user's own shell, so their `claude` alias or function still applies.
// Chrome-only: Claude Code's built-in shell/file tools are off and no other MCP servers load.
const q = (s) => (WIN ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);
const AGENT_COMMAND = `claude --tools ${WIN ? '""' : "''"} --strict-mcp-config --mcp-config ${q(MCP_CONFIG)} --append-system-prompt-file ${q(PROMPT)}`;
// Windows: cmd.exe passes "" through to claude reliably; Windows PowerShell 5 drops it.
const SHELL = WIN ? [process.env.COMSPEC || 'cmd.exe', []] : [process.env.SHELL || '/bin/bash', ['-il']];

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

// Terminal sessions outlive the panel: closing the side panel only detaches, and reopening it in the
// same window reattaches to the same agent. The panel's own ✕ / + buttons end a session.
const sessions = new Map();          // panel id -> { term, buf, ws, timer }
const KEEP_DETACHED_MS = 12 * 60 * 60 * 1000;
const REPLAY_BYTES = 512 * 1024;

function spawnSession(panel, msg) {
  const term = pty.spawn(SHELL[0], SHELL[1], {
    name: 'xterm-256color',
    cols: msg.cols || 80,
    rows: msg.rows || 24,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8', CHROMIAGENT_PANEL: panel },
  });
  const session = { term, buf: '', ws: null, timer: null };
  term.onData((d) => {
    session.buf = (session.buf + d).slice(-REPLAY_BYTES);
    if (isOpen(session.ws)) session.ws.send(d);
  });
  term.onExit(() => {
    clearTimeout(session.timer);
    if (sessions.get(panel) === session) sessions.delete(panel);
    if (isOpen(session.ws)) session.ws.close();
  });
  if (msg.agent) term.write(`${AGENT_COMMAND}\r`);
  return session;
}

function endSession(panel) {
  const session = sessions.get(panel);
  if (!session) return;
  sessions.delete(panel);
  clearTimeout(session.timer);
  session.term.kill();
}

function onTerminal(ws) {
  let session = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'start' && !session) {
      const panel = /^[\w-]{1,64}$/.test(msg.panel || '') ? msg.panel : '';
      if (msg.fresh) endSession(panel);
      session = panel && sessions.get(panel);
      if (session) {
        // Reattach: show what happened meanwhile, then make full-screen programs redraw at the new size.
        clearTimeout(session.timer);
        if (isOpen(session.ws)) session.ws.close();
        session.ws = ws;
        ws.send(session.buf);
        const { cols = 80, rows = 24 } = msg;
        session.term.resize(Math.max(cols - 1, 2), rows);
        setTimeout(() => session.term.resize(cols, rows), 60);
      } else {
        session = spawnSession(panel, msg);
        session.ws = ws;
        if (panel) sessions.set(panel, session);
      }
      session.panel = panel;
    } else if (!session) {
      return;
    } else if (msg.type === 'in') {
      session.term.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
      session.term.resize(msg.cols, msg.rows);
    } else if (msg.type === 'kill') {
      if (session.panel) endSession(session.panel); else session.term.kill();
    }
  });
  ws.on('close', () => {
    if (!session || session.ws !== ws) return;
    session.ws = null;
    if (!session.panel) return session.term.kill();
    session.timer = setTimeout(() => endSession(session.panel), KEEP_DETACHED_MS);
  });
}

console.log(`chromiagent host on ws://127.0.0.1:${PORT}`);
