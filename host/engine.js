// Chromiagent chess engine, by SvRvS: Stockfish 19 Lite (WASM, GPL-3, see engine/LICENSE-stockfish.txt)
// as a long-lived UCI process. It may only read its own folder (Node permission model).
const { spawn } = require('child_process');
const path = require('path');

const DIR = path.join(__dirname, 'engine');
let proc = null, buf = '', listener = null, queue = Promise.resolve();

function start() {
  proc = spawn(process.execPath, ['--permission', `--allow-fs-read=${DIR}`, path.join(DIR, 'stockfish-19-lite-single.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); listener?.(line); }
  });
  proc.on('exit', () => { proc = null; });
  proc.stdin.write('uci\n');
}

// Sends commands and resolves with every line up to (and including) the first matching `until`.
function ask(commands, until, ms) {
  if (!proc) start();
  return new Promise((resolve, reject) => {
    const lines = [];
    const timer = setTimeout(() => { listener = null; proc?.kill(); reject(new Error('engine did not answer')); }, ms);
    listener = (line) => { lines.push(line); if (until.test(line)) { clearTimeout(timer); listener = null; resolve(lines); } };
    proc.stdin.write(commands.join('\n') + '\n');
  });
}

// fen (or "startpos"), optional UCI moves played after it, and a time budget per move.
// skill 0-20 plays weaker on purpose (20 = full strength).
function bestMove({ fen = 'startpos', moves = [], movetimeMs = 300, depth, skill = 20, multipv = 1 } = {}) {
  const run = async () => {
    await ask([`setoption name Skill Level value ${Math.max(0, Math.min(20, skill))}`, `setoption name MultiPV value ${Math.max(1, Math.min(5, multipv))}`, 'isready'], /^readyok/, 10000);
    const pos = fen === 'startpos' ? 'position startpos' : `position fen ${fen}`;
    const go = depth ? `go depth ${depth}` : `go movetime ${Math.max(20, Math.min(movetimeMs, 30000))}`;
    const lines = await ask([`${pos}${moves.length ? ` moves ${moves.join(' ')}` : ''}`, go], /^bestmove/, Math.max(movetimeMs, 1000) + 20000);
    const best = lines[lines.length - 1].match(/^bestmove (\S+)(?: ponder (\S+))?/);
    // Last info line per multipv slot: score and principal variation.
    const lineFor = new Map();
    for (const l of lines) {
      const m = l.match(/^info .*?depth (\d+).*?(?:multipv (\d+) )?.*?score (cp|mate) (-?\d+).*? pv (.+)$/);
      if (m) lineFor.set(Number(m[2] || 1), { depth: Number(m[1]), [m[3]]: Number(m[4]), pv: m[5].split(' ').slice(0, 8) });
    }
    if (!best || best[1] === '(none)') return { bestmove: null, note: 'no legal moves (checkmate or stalemate)' };
    return { bestmove: best[1], ponder: best[2] || null, lines: [...lineFor.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

module.exports = { bestMove };
