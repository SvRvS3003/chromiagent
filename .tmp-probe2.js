const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:17371/mcp');
const results = [];
const t = setTimeout(() => { console.log('TIMEOUT results so far:', JSON.stringify(results, null, 1)); process.exit(0); }, 10000);
ws.on('open', () => ws.send(JSON.stringify({ id: 1, tool: 'list_tabs', args: {} })));
let step = 1;
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (step === 1) { results.push({ list: (m.result || []).map(x => ({ id: x.tabId, active: x.active, title: x.title?.slice(0,40) })) }); ws.send(JSON.stringify({ id: 2, tool: 'read_page', args: {} })); step = 2; return; }
  if (step === 2) { clearTimeout(t); results.push({ read: m.result ? String(m.result).slice(0, 300) : m }); console.log(JSON.stringify(results, null, 1)); process.exit(0); }
});
ws.on('error', (e) => { console.log('ws error:', e.message); process.exit(1); });
