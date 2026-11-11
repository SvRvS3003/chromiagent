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

// ---------- agent CLIs ----------
// Any CLI started from the panel works in host/workspace: it finds the Chrome tools and the
// instructions there through the files each CLI already reads (AGENTS.md, opencode.json,
// .qwen/.gemini settings), so every agent drives the browser the same way.
const WORKSPACE = path.join(__dirname, 'workspace');
const PROMPT = path.join(__dirname, 'agent-prompt.md');
const MCP_SERVERS = {
  chrome: { command: process.execPath, args: [path.join(__dirname, 'mcp.js')] },
  codemode: { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'codemode.js')] },
};
const MCP_CONFIG = path.join(WORKSPACE, 'mcp-config.json');

function writeWorkspace() {
  const write = (rel, data) => {
    const file = path.join(WORKSPACE, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };
  const prompt = fs.readFileSync(PROMPT, 'utf8');
  write('AGENTS.md', prompt);
  write('mcp-config.json', { mcpServers: MCP_SERVERS });
  const deny = (action) => ({ action, resource: '*', effect: 'deny' });
  write('opencode.json', {
    $schema: 'https://opencode.ai/config.json',
    mcp: Object.fromEntries(Object.entries(MCP_SERVERS).map(([k, v]) => [k, { type: 'local', command: [v.command, ...v.args], enabled: true }])),
    default_agent: 'chromiagent',
    agents: { chromiagent: {
      description: 'Chromiagent: works only inside the browser',
      mode: 'all',
      permissions: ['shell', 'edit', 'read', 'glob', 'grep', 'list', 'subagent'].map(deny),
    } },
  });
  // Qwen Code and Gemini CLI share the settings format.
  const geminiStyle = {
    mcpServers: MCP_SERVERS,
    context: { fileName: ['AGENTS.md'] },
    tools: { exclude: ['run_shell_command', 'write_file', 'replace', 'edit', 'read_file', 'read_many_files', 'glob', 'search_file_content', 'grep_search', 'list_directory'] },
  };
  write('.qwen/settings.json', geminiStyle);
  write('.gemini/settings.json', geminiStyle);
}
writeWorkspace();

// Typed into the user's own shell, so their aliases and functions (e.g. a `claude` wrapper) still apply.
const q = (s) => (WIN ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`);
const tomlArgs = (name, v) => [`mcp_servers.${name}.command=${JSON.stringify(v.command)}`, `mcp_servers.${name}.args=${JSON.stringify(v.args)}`];
const AGENTS = {
  // Browser-only: Claude Code's built-in shell/file tools are off and no other MCP servers load.
  // Windows runs cmd.exe, which passes "" through to claude (Windows PowerShell 5 would drop it).
  claude: `claude --tools ${WIN ? '""' : "''"} --strict-mcp-config --mcp-config ${q(MCP_CONFIG)} --append-system-prompt-file ${q(PROMPT)}`,
  opencode: 'opencode',
  // Codex reads AGENTS.md from the folder; its own shell stays read-only.
  codex: `codex --sandbox read-only ${Object.entries(MCP_SERVERS).flatMap(([k, v]) => tomlArgs(k, v)).map((a) => `-c ${q(a)}`).join(' ')}`,
  qwen: 'qwen',
  gemini: 'gemini',
  shell: '',
};

// Which CLIs are installed, asked from the user's login shell so its PATH counts.
let installedAgents = ['shell'];
(function detectAgents() {
  const names = Object.keys(AGENTS).filter((a) => a !== 'shell');
  const { execFile } = require('child_process');
  const done = (out) => { installedAgents = [...names.filter((n) => out.split(/\r?\n/).some((l) => l.trim() === n)), 'shell']; };
  if (WIN) {
    let found = '';
    let left = names.length;
    names.forEach((n) => execFile('where', [n], (err) => { if (!err) found += n + '\n'; if (--left === 0) done(found); }));
  } else {
    const script = names.map((n) => `command -v ${n} >/dev/null 2>&1 && echo ${n}`).join('; ');
    execFile(process.env.SHELL || '/bin/bash', ['-ilc', script], { timeout: 20000 }, (_, stdout) => done(String(stdout || '')));
  }
})();

// The agent command is handed to the user's shell as its startup command, not typed into the terminal:
// typed text races the shell's startup and some setups drop it. Profiles still load, so aliases and
// functions work, and when the agent exits the panel keeps a normal shell.
const USER_SHELL = WIN ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash';
const shellArgs = (cmd) => (WIN ? (cmd ? ['/k', cmd] : []) : cmd ? ['-ilc', `${cmd}; exec ${q(USER_SHELL)} -il`] : ['-il']);

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
  if (pathname === '/agents') return ws.close(1000, JSON.stringify(installedAgents));
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
  // `agent: true` is what panels from 1.3 and earlier send.
  const agent = msg.agent === true ? 'claude' : (Object.hasOwn(AGENTS, msg.agent) ? msg.agent : 'shell');
  const term = pty.spawn(USER_SHELL, shellArgs(AGENTS[agent]), {
    name: 'xterm-256color',
    cols: msg.cols || 80,
    rows: msg.rows || 24,
    cwd: agent === 'shell' ? os.homedir() : WORKSPACE,
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
