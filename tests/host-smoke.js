// Read-only smoke of the running host: /mcp tab tools + /agents. Never clicks or types on a page.
const WebSocket = require('../node_modules/ws');

const call = (ws, id, tool, args = {}) => new Promise((resolve) => {
  const onMessage = (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id !== id) return;
    ws.off('message', onMessage);
    resolve(m);
  };
  ws.on('message', onMessage);
  ws.send(JSON.stringify({ id, tool, args }));
});

(async () => {
  const ws = new WebSocket('ws://127.0.0.1:17371/mcp');
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const tabs = await call(ws, 1, 'list_tabs');
  const web = Array.isArray(tabs.result) ? tabs.result.find((t) => /^https?:/i.test(t.url || '')) : null;
  const results = [];
  if (!Array.isArray(tabs.result)) {
    console.log('SKIP  bridge-dependent checks: no panel bridge — open the Chromiagent panel and rerun');
  } else {
    results.push(['list_tabs', tabs.result.length > 0, `${tabs.result.length} tabs`]);
  }

  if (web) {
    const id = web.tabId ?? web.id;
    const read = await call(ws, 2, 'read_page', { tabId: id, maxChars: 600 });
    results.push(['read_page', !!(read.result && read.result.title !== undefined), JSON.stringify(read.result && read.result.title).slice(0, 80)]);
    const js = await call(ws, 3, 'run_js', { tabId: id, code: 'return JSON.stringify({title:document.title, ready:document.readyState})' });
    results.push(['run_js', js.result && !js.error && /ready/.test(String(js.result)), String(js.result || js.error).slice(0, 140)]);
    const shot = await call(ws, 4, 'screenshot', { tabId: id });
    results.push(['screenshot', !!(shot.result && shot.result.image && !shot.error), `${String((shot.result || {}).image || '').length} b64 chars`]);
  }
  ws.close();

  const agents = await new Promise((resolve) => {
    const a = new WebSocket('ws://127.0.0.1:17371/agents');
    a.once('close', (e) => resolve(e.reason || ''));
    a.once('error', () => resolve(''));
  });
  if (agents) results.push(['/agents', /opencode|codex|claude|shell/.test(agents), agents.slice(0, 120)]);
  else console.log(`SKIP  /agents: no close reason returned${results.length ? '' : ' (panel is closed)'}`);

  let failed = 0;
  for (const [name, ok, extra] of results) { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -> ${extra}`); }
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('SMOKE ERROR', e.message); process.exit(2); });
