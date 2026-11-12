const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:17371/mcp');
const timeout = setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 8000);
ws.on('open', () => {
  ws.send(JSON.stringify({ id: 1, tool: 'list_tabs', args: {} }));
});
ws.on('message', (raw) => {
  clearTimeout(timeout);
  const msg = JSON.parse(raw.toString());
  console.log(JSON.stringify(msg, null, 1).slice(0, 4000));
  process.exit(0);
});
ws.on('error', (e) => { console.log('ws error:', e.message); process.exit(1); });
