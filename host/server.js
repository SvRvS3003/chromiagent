// Chromiagent local host, by SvRvS. Listens on ws://127.0.0.1:17371
//   /        terminal (PTY) for the side panel     - extension origin only
//   /bridge  the panel's Chrome-control bridge     - extension origin only
//   /mcp     relay for host/mcp.js (agent tools)   - local processes only (no Origin header)
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const PORT = 17371;
const EXT_ORIGIN = 'chrome-extension://lagobfbebmgoaemfkbnmeljdfagpaefj';

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  maxPayload: 64 * 1024 * 1024,
  // Browsers always send Origin, so web pages can only reach the extension paths and are rejected there.
  verifyClient: ({ origin, req }) => (req.url === '/mcp' ? !origin : origin === EXT_ORIGIN),
});

let bridge = null;            // latest side panel bridge socket
const pending = new Map();    // relay id -> { ws, id }
let seq = 0;

wss.on('connection', (ws, req) => {
  if (req.url === '/bridge') return onBridge(ws);
  if (req.url === '/mcp') return onMcp(ws);
  onTerminal(ws);
});

function onBridge(ws) {
  bridge = ws;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    p.ws.readyState === p.ws.OPEN && p.ws.send(JSON.stringify({ ...msg, id: p.id }));
  });
  ws.on('close', () => { if (bridge === ws) bridge = null; });
}

function onMcp(ws) {
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!bridge || bridge.readyState !== bridge.OPEN) {
      return ws.send(JSON.stringify({ id: msg.id, error: 'Chromiagent side panel is not open in Chrome.' }));
    }
    const rid = ++seq;
    pending.set(rid, { ws, id: msg.id });
    bridge.send(JSON.stringify({ id: rid, tool: msg.tool, args: msg.args || {} }));
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
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' },
      });
      term.onData((d) => ws.readyState === ws.OPEN && ws.send(d));
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
