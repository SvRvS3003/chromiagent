#!/usr/bin/env node
// Chromiagent MCP server, by SvRvS: gives the agent tools for every open Chrome tab, via the side panel bridge.
const WebSocket = require('ws');

const TAB = { tabId: { type: 'number', description: 'Tab id from list_tabs' } };
const TARGET = {
  ...TAB,
  ref: { type: 'number', description: 'Element number from read_page' },
  selector: { type: 'string', description: 'CSS selector (alternative to ref)' },
};
const TOOLS = [
  ['list_tabs', 'List every open tab in every Chrome window (id, window, active, title, url, audible).', {}, []],
  ['activate_tab', 'Switch to a tab and focus its window.', TAB, ['tabId']],
  ['open_tab', 'Open a new tab in the background (the user stays where they are). active: true only if the user asked to see it.', { url: { type: 'string' }, active: { type: 'boolean' } }, ['url']],
  ['close_tab', 'Close a tab.', TAB, ['tabId']],
  ['navigate', 'Load a URL in a tab, or go back/forward/reload.', { ...TAB, url: { type: 'string' }, action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, ['tabId']],
  ['read_page', 'Read a tab: title, url, visible text, and numbered interactive elements (use the numbers as ref).', { ...TAB, maxChars: { type: 'number', description: 'Text limit, default 15000' } }, ['tabId']],
  ['click', 'Click an element in a tab (by ref from read_page or CSS selector).', TARGET, ['tabId']],
  ['type', 'Type text into an input/textarea/contenteditable; optional submit presses Enter / submits the form.', { ...TARGET, text: { type: 'string' }, submit: { type: 'boolean' } }, ['tabId', 'text']],
  ['press_key', 'Send a real key press to the tab (e.g. Enter, Escape, Tab, ArrowDown).', { ...TAB, key: { type: 'string' } }, ['tabId', 'key']],
  ['scroll', 'Scroll a tab by pixels (positive = down).', { ...TAB, dy: { type: 'number' } }, ['tabId', 'dy']],
  ['run_js', 'Evaluate JavaScript in the page (bypasses page CSP). Returns the value; promises are awaited.', { ...TAB, code: { type: 'string' } }, ['tabId', 'code']],
  ['screenshot', 'Screenshot of a tab (activates it first).', TAB, ['tabId']],
  ['watch', 'Watch a tab like a short video: captures it about twice a second for `seconds` (1-30, default 6) and returns the frames where something changed as one timeline image, with times. Use it for video, animation, loading, live feeds, or to see what a click set off. untilChange: return the moment the page changes; untilText: return the moment that text appears. Loop watch -> decide -> act -> watch to react in real time.',
    { ...TAB, seconds: { type: 'number' }, untilChange: { type: 'boolean' }, untilText: { type: 'string' } }, ['tabId']],
  ['ask_user', 'Ask the user something without leaving the page: a card pops up next to your pointer with a reply box and, if given, ready answers to click. Waits up to 10 minutes and returns their answer. With ref/selector the card points at that field and the user types into it on the page (passwords, verification codes, card details); you get "done", never the value.',
    { tabId: { type: 'number', description: 'Tab to ask on; default: the active tab' },
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, description: 'Ready answers shown as buttons (max 9); the user can still type their own' },
      placeholder: { type: 'string' },
      ref: { type: 'number', description: 'Field from read_page that the user fills in themselves' },
      selector: { type: 'string', description: 'CSS selector of that field (alternative to ref)' } }, ['question']],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required } }));

let ws = null;
let seq = 0;
const waiting = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) return resolve(ws);
    const s = new WebSocket(`ws://127.0.0.1:17371/mcp?panel=${process.env.CHROMIAGENT_PANEL || ''}`);
    s.on('open', () => { ws = s; resolve(s); });
    s.on('error', reject);
    s.on('message', (raw) => {
      const msg = JSON.parse(raw);
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    });
    s.on('close', () => { if (ws === s) ws = null; });
  });
}

async function callBridge(tool, args) {
  const s = await connect();
  const id = ++seq;
  const ms = tool === 'ask_user' ? 11 * 60000 : tool === 'watch' ? 90000 : 60000; // the user gets 10 minutes to answer
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: `${tool} timed out after ${ms / 1000}s` }); }, ms);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    s.send(JSON.stringify({ id, tool, args }));
  });
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'chrome', version: '1.0.0' } });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    let res;
    try { res = await callBridge(params.name, params.arguments || {}); } catch (e) { res = { error: `Chromiagent host unreachable: ${e.message}` }; }
    if (res.error) return reply(id, { isError: true, content: [{ type: 'text', text: res.error }] });
    if (res.image) return reply(id, { content: [{ type: 'image', data: res.image, mimeType: 'image/jpeg' }, ...(res.result ? [{ type: 'text', text: res.result }] : [])] });
    return reply(id, { content: [{ type: 'text', text: typeof res.result === 'string' ? res.result : JSON.stringify(res.result, null, 1) }] });
  }
  if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } }) + '\n');
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
