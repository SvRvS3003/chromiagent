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
  return { ready, call: (name, args) => rpc('tools/call', { name, arguments: args || {} }) };
}

const servers = {
  chrome: mcpClient(process.execPath, [path.join(__dirname, 'mcp.js')]),
  playwright: mcpClient(process.execPath, [
    '--permission', `--allow-fs-read=${DIR}`, `--allow-fs-read=${OUT_REAL}`, `--allow-fs-write=${OUT_REAL}`, '--allow-worker',
    path.join(DIR, 'node_modules', '@playwright', 'mcp', 'cli.js'),
    '--cdp-endpoint', `ws://127.0.0.1:17371/cdp?panel=${process.env.CHROMIAGENT_PANEL || ''}`, '--output-dir', OUT_REAL,
  ], SCRATCH_ENV),
};

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
// The script runs in a fresh, permission-restricted process; its tool calls come back here over IPC.
function runTypeScript(code) {
  const js = stripTypeScriptTypes(`async function __main(chrome, playwright, console) {\n${code}\n}`, { mode: 'strip' });
  const child = fork(path.join(__dirname, 'runner.js'), [], {
    execArgv: ['--permission', `--allow-fs-read=${path.join(__dirname, 'runner.js')}`],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Script timed out after 5 minutes')); }, 300000);
    child.on('message', async (msg) => {
      if (msg.type === 'call') {
        try {
          if (!servers[msg.ns]) throw new Error(`Unknown API ${msg.ns}`);
          child.send({ type: 'reply', id: msg.id, text: asText(await servers[msg.ns].call(msg.name, msg.args)) });
        } catch (e) {
          child.send({ type: 'reply', id: msg.id, error: String(e.message || e) });
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
  });
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
      name: 'run_typescript',
      description: 'Code mode: run a TypeScript script against the user\'s real Chrome. The script is the body of an async function: use await, and `return` the final value (it is sent back as JSON). console.log output is returned too. Every call returns the tool\'s text output. Playwright state (selected tab) persists between scripts. Available APIs:\n\n' + declarations,
      inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'TypeScript function body' } }, required: ['code'] },
    }] });
  }
  if (method === 'tools/call') {
    try {
      await ready;
      return reply(id, { content: [{ type: 'text', text: await runTypeScript(params.arguments.code) }] });
    } catch (e) {
      return reply(id, { isError: true, content: [{ type: 'text', text: String(e.stack || e.message || e) }] });
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
