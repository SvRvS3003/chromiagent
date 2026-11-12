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
// instructions there through the files each CLI already reads from its project folder (AGENTS.md,
// .mcp.json, opencode.json, .qwen/.gemini/.grok/.pi/.kimi-code/.kiro/.cursor/... settings), so every
// agent drives the browser the same way, and a CLI not listed here still finds them.
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
    // ask_user waits up to 10 minutes; observe() scripts run up to 30.
    mcpServers: Object.fromEntries(Object.entries(MCP_SERVERS).map(([k, v]) => [k, { ...v, timeout: 1900000 }])),
    context: { fileName: ['AGENTS.md'] },
    tools: { exclude: ['run_shell_command', 'write_file', 'replace', 'edit', 'read_file', 'read_many_files', 'glob', 'search_file_content', 'grep_search', 'list_directory'] },
  };
  write('.qwen/settings.json', geminiStyle);
  write('.gemini/settings.json', geminiStyle);

  // The common project formats: { mcpServers } in each CLI's own place.
  const plain = { mcpServers: MCP_SERVERS };
  for (const f of ['.mcp.json', '.agents/mcp.json', '.pi/mcp.json', '.kimi-code/mcp.json', '.kiro/settings/mcp.json',
    '.cursor/mcp.json', '.factory/mcp.json', '.kilocode/mcp.json', '.roo/mcp.json']) write(f, plain);
  write('.amp/settings.json', { 'amp.mcpServers': MCP_SERVERS });
  write('crush.json', { $schema: 'https://charm.land/crush.json', mcp: Object.fromEntries(Object.entries(MCP_SERVERS).map(([k, v]) => [k, { type: 'stdio', ...v, timeout: 1900 }])) });
  write('.vscode/mcp.json', { servers: Object.fromEntries(Object.entries(MCP_SERVERS).map(([k, v]) => [k, { type: 'stdio', ...v }])) });
  write('.grok/config.toml', Object.entries(MCP_SERVERS).map(([k, v]) => `[mcp_servers.${k}]\ncommand = ${JSON.stringify(v.command)}\nargs = ${JSON.stringify(v.args)}\nenabled = true\n`).join('\n'));
  // Kiro: an agent that has only the browser tools.
  write('.kiro/agents/chromiagent.json', { name: 'chromiagent', description: 'Chromiagent: works only inside the browser', prompt,
    mcpServers: MCP_SERVERS, includeMcpJson: false, tools: ['@chrome', '@codemode'], allowedTools: ['@chrome', '@codemode'] });
  // Instructions under the names other CLIs look for.
  for (const f of ['CLAUDE.md', 'knowledge.md', '.goosehints', '.clinerules/chromiagent.md', '.kiro/steering/chromiagent.md', '.cursor/rules/chromiagent.md']) write(f, prompt);
  writeClineConfig();
  // Its own git root: CLIs that look for the project root (or offer to switch to it) stop at the workspace.
  if (!fs.existsSync(path.join(WORKSPACE, '.git'))) { try { require('child_process').execFileSync('git', ['init', '-q'], { cwd: WORKSPACE, stdio: 'ignore' }); } catch {} }
}

// Cline keeps MCP servers only in its global settings (which may hold desktop or file tools). It gets its
// own settings folder with just the browser tools; the user's sign-in and model are linked in from ~/.cline.
const CLINE_DIR = path.join(WORKSPACE, '.cline-config');
function writeClineConfig() {
  const home = path.join(os.homedir(), '.cline');
  fs.mkdirSync(path.join(CLINE_DIR, 'data', 'settings'), { recursive: true });
  for (const f of ['data/secrets.json', 'data/globalState.json', 'data/settings/providers.json', 'data/settings/global-settings.json']) {
    const from = path.join(home, f), to = path.join(CLINE_DIR, f);
    if (!fs.existsSync(from)) continue;
    try { fs.rmSync(to, { force: true }); fs.symlinkSync(from, to); } catch { try { fs.copyFileSync(from, to); } catch {} } // Windows without symlink rights
  }
  fs.writeFileSync(path.join(CLINE_DIR, 'data', 'settings', 'cline_mcp_settings.json'), JSON.stringify({
    mcpServers: Object.fromEntries(Object.entries(MCP_SERVERS).map(([k, v]) => [k, { transport: { type: 'stdio', ...v } }])),
  }, null, 2));
}
writeWorkspace();

// Typed into the user's own shell, so their aliases and functions (e.g. a `claude` wrapper) still apply.
const q = (s) => (WIN ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`);
const withEnv = (vars, cmd) => Object.entries(vars).map(([k, v]) => (WIN ? `set ${k}=${v}&& ` : `${k}=${v} `)).join('') + cmd;
// MCP servers the user set up globally for a CLI (a Node REPL, desktop control, another browser) stay off in the panel.
const globalTomlServers = (file) => { try { return [...fs.readFileSync(file, 'utf8').matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((m) => m[1]); } catch { return []; } };
const codexOff = globalTomlServers(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')).filter((n) => !MCP_SERVERS[n]);
const tomlArgs = (name, v) => [`mcp_servers.${name}.command=${JSON.stringify(v.command)}`, `mcp_servers.${name}.args=${JSON.stringify(v.args)}`, `mcp_servers.${name}.tool_timeout_sec=1900`];
const AGENTS = {
  // Browser-only: Claude Code's built-in shell/file tools are off and no other MCP servers load.
  // Windows runs cmd.exe, which passes "" through to claude (Windows PowerShell 5 would drop it).
  claude: `claude --tools ${WIN ? '""' : "''"} --no-chrome --strict-mcp-config --mcp-config ${q(MCP_CONFIG)} --append-system-prompt-file ${q(PROMPT)}`,
  opencode: 'opencode',
  // Codex reads AGENTS.md from the folder; its own shell stays read-only, and its tool calls always
  // run without asking the user to approve each one (the browser tools are the whole job).
  codex: `codex --sandbox read-only -c ${q('approval_policy="never"')} ${[...Object.entries(MCP_SERVERS).flatMap(([k, v]) => tomlArgs(k, v)), ...codexOff.map((n) => `mcp_servers.${n}.enabled=false`)].map((a) => `-c ${q(a)}`).join(' ')}`,
  qwen: 'qwen',
  gemini: 'gemini',
  // Built-in file and shell tools off where the CLI allows it; the others are told by AGENTS.md.
  pi: `pi --approve --no-builtin-tools --append-system-prompt ${q(PROMPT)}`,
  'kiro-cli': 'kiro-cli chat --agent chromiagent',
  freebuff: withEnv({ CODEBUFF_TRUST_AGENT_DIRS: 1 }, 'freebuff'),
  codebuff: withEnv({ CODEBUFF_TRUST_AGENT_DIRS: 1 }, 'codebuff'),
  cline: `cline --config ${q(CLINE_DIR)}`,
  kimi: withEnv({ KIMI_CODE_TRUST_WORKSPACE: 1 }, 'kimi'),
  grok: withEnv({ GROK_CLAUDE_MCPS_ENABLED: 'false', GROK_CURSOR_MCPS_ENABLED: 'false', GROK_MANAGED_MCPS_ENABLED: 'false' }, 'grok --trust --disallowed-tools run_terminal_command,read_file,search_replace,list_dir,grep,write,kill_command_or_subagent,get_command_or_subagent_output'),
  opencode2: 'opencode2',
  copilot: `copilot --additional-mcp-config ${q('@' + path.join(WORKSPACE, '.mcp.json'))} --deny-tool shell --deny-tool write`,
  'cursor-agent': 'cursor-agent',
  crush: 'crush',
  droid: 'droid',
  amp: 'amp',
  auggie: `auggie --mcp-config ${q(path.join(WORKSPACE, '.mcp.json'))}`,
  goose: `goose session ${Object.values(MCP_SERVERS).map((v) => `--with-extension ${q([v.command, ...v.args].join(' '))}`).join(' ')}`,
  kilocode: 'kilocode',
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
  const custom = msg.agent === 'custom' && typeof msg.command === 'string' && msg.command.trim() ? msg.command.trim().slice(0, 500) : null;
  const agent = custom ? 'custom' : msg.agent === true ? 'claude' : (Object.hasOwn(AGENTS, msg.agent) ? msg.agent : 'shell');
  const term = pty.spawn(USER_SHELL, shellArgs(custom || AGENTS[agent]), {
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
