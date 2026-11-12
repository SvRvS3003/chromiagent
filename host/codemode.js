#!/usr/bin/env node
// Chromiagent code mode, by SvRvS.
// One MCP tool, `run_typescript`: the agent writes a TypeScript script that calls the Playwright MCP and
// Chromiagent tab tools as typed async functions (`playwright.*`, `chrome.*`), so a whole multi-step task
// runs in one call.
// Safety, the same on Windows, macOS and Linux: agent scripts run in host/runner.js and Playwright MCP
// (whose browser_run_code_unsafe also runs agent code) runs as its own process, both under Node's
// permission model: no reading or writing the user's files, no starting programs.
const { spawn, fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripTypeScriptTypes } = require('node:module');
const engine = require('./engine');

const DIR = fs.realpathSync(path.join(__dirname, '..'));
// Short on Unix: Playwright opens sockets in here, and socket paths max out near 104 bytes.
const OUT = process.platform === 'win32' ? path.join(os.tmpdir(), 'chromiagent-playwright') : '/tmp/chromiagent-pw';
fs.mkdirSync(OUT, { recursive: true });
const OUT_REAL = fs.realpathSync(OUT);
// Playwright keeps caches under the home and temp folders; point them at the scratch folder it may use.
const SCRATCH_ENV = { HOME: OUT_REAL, USERPROFILE: OUT_REAL, LOCALAPPDATA: OUT_REAL, XDG_CACHE_HOME: OUT_REAL, TMPDIR: OUT_REAL, TEMP: OUT_REAL, TMP: OUT_REAL };

// ---------- minimal MCP stdio client ----------
function mcpClient(command, args, env) {
  const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } });
  const waiting = new Map();
  let buf = '';
  let seq = 0;
  // A spawn failure (ENOENT/EACCES/resource limits) emits 'error', not 'exit': without this handler
  // the whole codemode process dies as an uncaught exception and every tool call reports "Transport closed".
  const died = (message) => { for (const w of waiting.values()) w({ error: { message } }); waiting.clear(); };
  proc.on('error', (e) => died(String(e && e.message || e)));
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  proc.on('exit', (c) => died(`Playwright stopped (exit ${c})`));
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const ready = (async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chromiagent-codemode', version: '1.0.0' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return (await rpc('tools/list', {})).tools;
  })();
  return { ready, proc, call: async (name, args) => { await ready; return rpc('tools/call', { name, arguments: args || {} }); } };
}

const startPlaywright = () => mcpClient(process.execPath, [
    '--permission', `--allow-fs-read=${DIR}`, `--allow-fs-read=${OUT_REAL}`, `--allow-fs-write=${OUT_REAL}`, '--allow-worker',
    path.join(DIR, 'node_modules', '@playwright', 'mcp', 'cli.js'),
    '--cdp-endpoint', `ws://127.0.0.1:17371/cdp?panel=${process.env.CHROMIAGENT_PANEL || ''}`, '--output-dir', OUT_REAL,
  // Scripts read what they need themselves; a full page snapshot after every action made each call slow.
  '--snapshot-mode', 'none', '--image-responses', 'omit',
  ], SCRATCH_ENV);
const servers = { chrome: mcpClient(process.execPath, [path.join(__dirname, 'mcp.js')]), playwright: startPlaywright() };

// While Playwright is connected Chrome shows its "is debugging this browser" bar on every tab. It is
// closed a little after the last script ends, so the bar goes away, and started again on demand.
// Kept alive for 5 minutes after the last script: killing the connection between steps of one task
// forced reconnects and made the agent look like it opened a new code mode for every move.
const PLAYWRIGHT_IDLE_MS = 300000;
let running = 0, idleTimer = null;
function playwrightBusy() {
  running++;
  clearTimeout(idleTimer);
  if (servers.playwright.proc.exitCode !== null || servers.playwright.proc.killed) {
    try { servers.playwright = startPlaywright(); } catch (e) { console.error('could not restart Playwright:', e); }
  }
}
function playwrightDone() {
  if (--running) return;
  idleTimer = setTimeout(() => servers.playwright.proc.kill(), PLAYWRIGHT_IDLE_MS);
}

// ---------- JSON Schema -> TypeScript declarations ----------
const ident = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
function tsType(s = {}) {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (s.anyOf || s.oneOf) return (s.anyOf || s.oneOf).map(tsType).join(' | ');
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') return `Array<${tsType(s.items)}>`;
  if (t === 'object' || s.properties) {
    const req = new Set(s.required || []);
    const props = Object.entries(s.properties || {}).map(([k, v]) =>
      `${v.description ? `/** ${v.description.replace(/\*\//g, '* /').replace(/\s+/g, ' ')} */ ` : ''}${ident(k)}${req.has(k) ? '' : '?'}: ${tsType(v)};`);
    return props.length ? `{ ${props.join(' ')} }` : 'Record<string, unknown>';
  }
  return 'unknown';
}

let declarations = '';
const ready = (async () => {
  const blocks = [];
  for (const [ns, client] of Object.entries(servers)) {
    const tools = await client.ready;
    const fns = tools.map((t) => `  /** ${(t.description || '').replace(/\*\//g, '* /').replace(/\s+/g, ' ').slice(0, 400)} */\n  ${t.name}(args: ${tsType(t.inputSchema)}): Promise<string>;`);
    blocks.push(`declare const ${ns}: {\n${fns.join('\n')}\n};`);
  }
  declarations = blocks.join('\n\n');
})();

// Every tool result becomes plain text; screenshots are saved by Playwright and referenced in that text.
const asText = (r) => {
  const text = (r.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  if (r.isError) throw new Error(text);
  return text;
};
// observe() and untilEvent() (host/observe.ts) are available inside every script.
const LIBRARY = ['observe.ts', 'chess.ts'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');

// The script runs in a fresh, permission-restricted process; its tool calls come back here over IPC.
function runTypeScript(code, timeoutSec = 300) {
  const limit = Math.min(Math.max(timeoutSec, 10), 1800);
  const js = stripTypeScriptTypes(`async function __main(chrome, playwright, engine, console) {\n${LIBRARY}\n${code}\n}`, { mode: 'strip' });
  playwrightBusy();
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'runner.js'), [], {
      execArgv: ['--permission', `--allow-fs-read=${path.join(__dirname, 'runner.js')}`],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    // fork() failure is an 'error' event on the child: without a handler the whole codemode dies.
    child.on('error', (e) => reject(new Error(`the script process could not start: ${(e && e.message) || e}`)));
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Script timed out after ${limit}s (raise timeoutSec, up to 1800)`)); }, limit * 1000);
    child.on('message', async (msg) => {
      if (msg.type === 'call') {
        try {
          if (msg.ns === 'engine') {
            if (msg.name !== 'bestMove') throw new Error('engine has only bestMove');
            child.send({ type: 'reply', id: msg.id, text: JSON.stringify(await engine.bestMove(msg.args)) });
            return;
          }
          if (!servers[msg.ns]) throw new Error(`Unknown API ${msg.ns}`);
          child.send({ type: 'reply', id: msg.id, text: asText(await servers[msg.ns].call(msg.name, msg.args)) });
        } catch (e) {
          let error = String(e.message || e);
          // The browser connection dropped (panel reloaded, host restarted): start Playwright fresh for the next script.
          if (msg.ns === 'playwright' && /has been closed|Target closed|Browser closed|Playwright stopped|not connected/i.test(error)) {
            servers.playwright.proc.kill();
            error += '\n(Chromiagent reconnects Playwright: run the script again.)';
          }
          child.send({ type: 'reply', id: msg.id, error });
        }
        return;
      }
      clearTimeout(timer);
      child.kill();
      if (msg.error) return reject(new Error([msg.logs.length ? `console:\n${msg.logs.join('\n')}` : '', msg.error].filter(Boolean).join('\n\n')));
      const r = msg.result;
      resolve([msg.logs.length ? `console:\n${msg.logs.join('\n')}` : '', `result:\n${r === null ? 'undefined' : typeof r === 'string' ? r : JSON.stringify(r, null, 1)}`].filter(Boolean).join('\n\n'));
    });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`Script process exited (${c})`)); });
    child.send({ type: 'run', js });
  }).finally(playwrightDone);
}

// ---------- MCP server (stdio) ----------
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

async function handle({ id, method, params }) {
  if (method === 'initialize') {
    return reply(id, { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codemode', version: '1.0.0' } });
  }
  if (method === 'tools/list') {
    await ready;
    return reply(id, { tools: [{
      name: 'best_move',
      description: 'Stockfish 19 Lite: the best move for a position (FEN or "startpos" plus UCI moves), with score and main line. For a whole game use code mode playGame() — it plays bots, analysis and live games against people.',
      inputSchema: { type: 'object', properties: { fen: { type: 'string' }, moves: { type: 'array', items: { type: 'string' } }, movetimeMs: { type: 'number', description: 'Think time, default 300' }, skill: { type: 'number', description: '0-20, default 20' }, multipv: { type: 'number', description: 'Best N lines, 1-5' } } },
    }, {
      name: 'run_typescript',
      description: 'Code mode: run ONE TypeScript script that does the whole task, start to finish — plan first, then one call. Fast multi-step work: clicks, fills, waits, retries, loops and live watching, all inside the script. Never alternate `run_typescript` with quick `chrome.*` calls mid-task — a script that needs to navigate, click, read, verify and act on the result does all of that itself and returns one answer; if it fails, rerun one corrected script, not a chain of quick calls. Real-time watching is ONE observe() call with a handler that reads values from `chrome.run_js` and acts on them (price, P/L, inventory) — never per-tick polling with separate calls. Direct quick-mode tools are for a single trivial action only. The script is the body of an async function: use await, and `return` the final value (it is sent back as JSON). console.log output is returned too. Every call returns the tool\'s text output. Playwright stays connected for 5 minutes between the scripts of one session, so one task never reconnects mid-way. Work in your own tab (open_tab / bind_tab): the script drives a tab the user is not looking at, so never take the one they are on. Scripts stop after timeoutSec (default 300, max 1800).\n\nContinuous watching: `observe(tabId, handler, { seconds })` calls your handler with every new batch of page events the moment they happen (DOM changes, network, WebSocket, console, errors, navigation, user actions, media) until time runs out or the handler returns true; the handler can analyse and act in between. `untilEvent(tabId, match)` waits for one event. Their source:\n\n' + LIBRARY + '\n\nChess engine: `engine.bestMove({ fen, moves?, movetimeMs?, depth?, skill?, multipv? })` returns JSON text `{ bestmove, ponder, lines: [{ depth, cp | mate, pv }] }` from Stockfish 19 Lite. It plays computer bots, analysis and puzzles, and rated live games against people too: `playGame({ movetimeMs, minDelayMs, maxDelayMs })` answers every move on your turn, accepts the site\'s fair-play agreement if one is shown (dismissGate() does that), and waits through the opponent\'s. Moves land through arc-shaped synthetic events paced by the host together with `chrome.pointer_stroke`, so they read as one motion of a hand — no debugger is attached during a game, so the Chrome debug bar never shows. `dismissGate()` presses the agree button on any rules/fair-play sheet, wherever the task needs it.\n\nAvailable APIs:\n\n' + declarations,
      inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'TypeScript function body' }, timeoutSec: { type: 'number', description: 'Longest run in seconds (default 300, max 1800); raise it for long observe() loops' } }, required: ['code'] },
    }] });
  }
  if (method === 'tools/call') {
    if (params.name === 'best_move') {
      try { return reply(id, { content: [{ type: 'text', text: JSON.stringify(await engine.bestMove(params.arguments || {})) }] }); }
      catch (e) { return reply(id, { isError: true, content: [{ type: 'text', text: String(e.message || e) }] }); }
    }
    try {
      await ready;
      return reply(id, { content: [{ type: 'text', text: await runTypeScript(params.arguments.code, params.arguments.timeoutSec) }] });
    } catch (e) {
      return reply(id, { isError: true, content: [{ type: 'text', text: String(e.message || e).replace(/^(Error: )+/, '') }] });
    }
  }
  if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } }) + '\n');
}

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  let i;
  while ((i = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, i).trim();
    input = input.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
