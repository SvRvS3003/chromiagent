// Chromiagent code mode runner, by SvRvS.
// Runs one agent script under Node's permission model (started by codemode.js with --permission and no
// fs/child-process grants), so the script can drive the browser but cannot touch files or start programs.
// Tool calls go back to codemode.js over IPC.
let seq = 0;
const waiting = new Map();

process.on('message', async (msg) => {
  if (msg.type === 'reply') {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    return msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.text);
  }
  if (msg.type !== 'run') return;

  const call = (ns, name, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    process.send({ type: 'call', id, ns, name, args: args || {} });
  });
  const api = (ns) => new Proxy({}, { get: (_, name) => (args) => call(ns, String(name), args) });
  const logs = [];
  const log = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' '));

  try {
    const main = new Function(`${msg.js}\nreturn __main;`)();
    const result = await main(api('chrome'), api('playwright'), api('engine'), { log, info: log, warn: log, error: log });
    process.send({ type: 'done', logs, result: result === undefined ? null : result });
  } catch (e) {
    // Only the script's own frames are useful to the agent; runner and Node internals are noise.
    const text = String(e && (e.stack || e.message) || e).split('\n').filter((l) => !/runner\.js|codemode\.js|node:internal|node:events|process\.emit|at emit /.test(l)).join('\n');
    process.send({ type: 'done', logs, error: text });
  }
});
