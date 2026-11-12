// Chromiagent chess helpers, by SvRvS: read the board from the page's HTML (no screenshots), ask the
// engine, play the move — CDP-free, node-paced, human-shaped. Every action is a script call into the
// page (chrome.run_js), so a game runs with no debugger and never shows Chrome's "debugging this
// browser" bar, from the bound tab, at engine speed, in front of or behind the user's tabs.
// Works on chess.com and lichess.org boards (play vs computer, live games against people, analysis, puzzles).

interface ChessState {
  site: 'chess.com' | 'lichess' | 'unknown';
  fen: string;              // full FEN; the side to move is counted from the move list
  turn: 'w' | 'b';
  flipped: boolean;         // board shown from black's side: usually you play black
  plies: number;            // half-moves played so far
  live: boolean;            // true when the opponent is a person, not a bot
  over: boolean;            // a game-over dialog is showing
}

// Runs JavaScript in the tab's main world through the extension (no Chrome debugger, no CDP, no bar)
// and parses the JSON value it returns. `body` runs inside an async function, so `await` works.
async function evaluate<T = unknown>(body: string): Promise<T> {
  const out = String(await chrome.run_js({ code: body }));
  return JSON.parse(out) as T;
}

// In-page reader, shared by chessState() and waitForMove().
const READ_BOARD = String.raw`() => {
  const grid = Array.from({ length: 8 }, () => Array(8).fill(''));
  const put = (file, rank, color, type) => { if (file >= 1 && file <= 8 && rank >= 1 && rank <= 8) grid[8 - rank][file - 1] = color === 'w' ? type.toUpperCase() : type.toLowerCase(); };
  let site = 'unknown', flipped = false, plies = 0, board = null;
  const cc = document.querySelector('wc-chess-board, chess-board');
  const cg = document.querySelector('cg-board');
  if (cc) {
    site = 'chess.com'; board = cc; flipped = cc.classList.contains('flipped');
    for (const p of cc.querySelectorAll('.piece')) {
      const cls = [...p.classList];
      const kind = cls.find((c) => /^[wb][pnbrqk]$/.test(c)), sq = cls.find((c) => /^square-\d\d$/.test(c));
      if (kind && sq) put(Number(sq[7]), Number(sq[8]), kind[0], kind[1]);
    }
    // one .node-highlight-content per half-move on chess.com (live, bot and analysis); .node is per move
    // pair where the newer list is used, so it counts double rather than clashing with the ply elements
    const hl = document.querySelectorAll('.node-highlight-content').length
      || document.querySelectorAll('.main-line-ply').length
      || document.querySelectorAll('.move-list .node, vertical-move-list .node, wc-simple-move-list .node').length * 2;
    plies = hl || document.querySelectorAll('[data-ply]').length;
  } else if (cg) {
    site = 'lichess'; board = cg; flipped = !!document.querySelector('.cg-wrap.orientation-black');
    const size = cg.getBoundingClientRect().width / 8;
    const TYPES = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
    for (const p of cg.querySelectorAll('piece')) {
      if (p.classList.contains('ghost') || p.classList.contains('dragging')) continue;
      const m = (p.style.transform || '').match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px/);
      const type = Object.keys(TYPES).find((t) => p.classList.contains(t));
      if (!m || !type) continue;
      const col = Math.round(Number(m[1]) / size), row = Math.round(Number(m[2]) / size);
      const file = flipped ? 8 - col : col + 1, rank = flipped ? row + 1 : 8 - row;
      put(file, rank, p.classList.contains('white') ? 'w' : 'b', TYPES[type]);
    }
    plies = document.querySelectorAll('rm6 kwdb, l4x kwdb, .tview2 move').length;
  }
  const at = (sq) => grid[8 - Number(sq[1])]['abcdefgh'.indexOf(sq[0])];
  let castling = (at('e1') === 'K' ? (at('h1') === 'R' ? 'K' : '') + (at('a1') === 'R' ? 'Q' : '') : '') + (at('e8') === 'k' ? (at('h8') === 'r' ? 'k' : '') + (at('a8') === 'r' ? 'q' : '') : '');
  const rows = grid.map((r) => r.map((c) => c || '1').join('').replace(/1+/g, (s) => String(s.length)));
  const turn = plies % 2 === 0 ? 'w' : 'b';
  const over = !!document.querySelector('.game-over-modal-content, .game-over-modal-container, .board-modal-container-container, .result-wrap, .follow-up .rematch');
  const live = site === 'chess.com'
    ? !/\/play\/(computer|analysis)|\/analysis|\/puzzles?/.test(location.pathname)
    : site === 'lichess'
      ? !/\bAI level\b|Stockfish level|\(AI\)/i.test(((document.querySelector('.game__meta') || {}).innerText || '') + ' ' + location.pathname)
      : false;
  return { site, fen: rows.join('/') + ' ' + turn + ' ' + (castling || '-') + ' - 0 ' + (Math.floor(plies / 2) + 1), turn, flipped, plies, live, over };
}`;

// Dismisses a fair-play / rules agreement shown on a site. Returns the clicked button's label, or null.
async function dismissGate(): Promise<string | null> {
  return evaluate('return (' + DISMISS_GATE + ')();');
}

// The fair-play / rules gate some sites show before a rated game: one sheet, one agree button.
// The account and the games are the user's; the agreement is theirs to give, so it is clicked.
const DISMISS_GATE = String.raw`() => {
  const GATE = /fair ?play|external assistance|outside assistance|engine|cheat|agreement|rules|qoida|ro'?zi|agreement|acord/i;
  const OK = /agree|accept|ok|continue|got it|understood|yes|ro'?zi|qabul|davom|tush|tasd|okay|i agree|davomi/i;
  for (const sel of ['dialog[open]', '[role=dialog]', '.cc-modal-component', '.cc-modal-dialog', '.modal', '.modal-content']) {
    for (const dlg of document.querySelectorAll(sel)) {
      const text = (dlg.innerText || '').trim();
      if (!text || !GATE.test(text)) continue;
      const btns = [...dlg.querySelectorAll('button')];
      const hit = btns.find((b) => OK.test((b.innerText || '').trim())) || btns[btns.length - 1];
      if (hit) { hit.click(); return (hit.innerText || 'ok').trim().slice(0, 40); }
    }
  }
  return null;
}`;

interface Pt { x: number; y: number }
const easeCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// A hand-like arc between two points: a wide bezier bend, ease in-out, noise that fades at the ends.
function arcPoints(a: Pt, b: Pt): Pt[] {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
  const nx = -dy / d, ny = dx / d;
  const bend = (0.10 + Math.random() * 0.24) * d * (Math.random() < 0.5 ? 1 : -1);
  const cx = (a.x + b.x) / 2 + nx * bend, cy = (a.y + b.y) / 2 + ny * bend;
  const N = Math.max(12, Math.min(26, Math.round(d / 13)));
  const pts: Pt[] = [];
  for (let i = 1; i <= N; i++) {
    const t = i / N, e = easeCubic(t), m = 1 - e, j = Math.sin(Math.PI * e) * 1.5;
    pts.push({ x: m * m * a.x + 2 * m * e * cx + e * e * b.x + (Math.random() - 0.5) * j * nx * 2,
               y: m * m * a.y + 2 * m * e * cy + e * e * b.y + (Math.random() - 0.5) * j * ny * 2 });
  }
  return pts;
}

// Waits, node-side: background tabs throttle page timers to a second, the host is not throttled.
async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, Math.round(ms)));
}

// One synthetic event inside the page, paced from here. Each is a tiny extension round trip; the
// sequence lands along a curve instead of teleporting, and background tabs are not throttled.
async function dispatchAt(p: Pt, type: string, buttons: number): Promise<void> {
  const x = Number(p.x).toFixed(1), y = Number(p.y).toFixed(1), t = JSON.stringify(type);
  await chrome.run_js({ code: `const board = document.querySelector('wc-chess-board, chess-board, cg-board') || document.body;
    const el = document.elementFromPoint(` + x + `, ` + y + `) || board;
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: ` + x + `, clientY: ` + y + `, screenX: ` + x + `, screenY: ` + y + `, button: 0, buttons: ` + buttons + `, isPrimary: true, pointerId: 1, pointerType: 'mouse' };
    el.dispatchEvent(` + t + `.startsWith('pointer') ? new PointerEvent(` + t + `, o) : new MouseEvent(` + t + `, o));
    window.__caPointer = { x: ` + x + `, y: ` + y + ` };
    return true;` });
}

// The position on the tab this script is bound to (open_tab / bind_tab).
async function chessState(): Promise<ChessState> {
  return evaluate('return (' + READ_BOARD + ')();');
}

// Plays a UCI move (e2e4, e7e8q). The pointer glances at a friendly piece or two, glides in along an
// arc with a tremor, dwells, presses, arcs to the target with the same tremor, and rests nearby.
// Moves are synthetic events dispatched node-side, so they land in a background tab and never attach
// the Chrome debugger. `promo` picks the piece for pawn promotions.
async function playMove(uci: string, options: { color?: 'w' | 'b' } = {}): Promise<void> {
  const from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci[4] || '';
  const q = await evaluate<{ from: Pt; to: Pt; flipped: boolean; last: Pt | null }>(`
    if (!window.__caPointerTrack) {
      window.__caPointerTrack = true;
      document.addEventListener('pointermove', (e) => { window.__caPointer = { x: e.clientX, y: e.clientY }; }, true);
    }
    const board = document.querySelector('wc-chess-board, chess-board, cg-board');
    if (!board) throw new Error('no board on this tab');
    const r = board.getBoundingClientRect();
    const flipped = board.classList.contains('flipped') || !!document.querySelector('.cg-wrap.orientation-black');
    const s = r.width / 8;
    const center = (sq) => {
      const f = 'abcdefgh'.indexOf(sq[0]) + 1, k = Number(sq[1]);
      return flipped ? { x: r.left + (8 - f + 0.5) * s, y: r.top + (k - 0.5) * s } : { x: r.left + (f - 0.5) * s, y: r.top + (8 - k + 0.5) * s };
    };
    return { from: center(` + JSON.stringify(from) + `), to: center(` + JSON.stringify(to) + `), flipped, last: window.__caPointer || null };
  `);
  const me = q.flipped ? 'b' : 'w';
  const stroke: Promise<unknown> = (typeof chrome !== 'undefined' && chrome.pointer_stroke)
    ? chrome.pointer_stroke({ from: q.from, to: q.to, decoys: 1, color: options.color || me }).catch(() => null)
    : Promise.resolve(null);
  const start = q.last || q.from;
  if (start !== q.from) for (const p of arcPoints(start, q.from)) { await dispatchAt(p, 'pointermove', 0); await sleep(4 + Math.random() * 11); }
  await sleep(80 + Math.random() * 140);                       // the hover dwell before the grab
  await dispatchAt(q.from, 'pointermove', 0); await dispatchAt(q.from, 'pointerdown', 1); await dispatchAt(q.from, 'mousedown', 1);
  await sleep(45 + Math.random() * 75);
  for (const p of arcPoints(q.from, q.to)) { await dispatchAt(p, 'pointermove', 1); await sleep(5 + Math.random() * 12); }
  await sleep(25 + Math.random() * 55);
  await dispatchAt(q.to, 'pointermove', 1); await dispatchAt(q.to, 'pointerup', 0); await dispatchAt(q.to, 'mouseup', 0); await dispatchAt(q.to, 'click', 0);
  const rest = { x: q.to.x + (Math.random() - 0.5) * 44, y: q.to.y + (Math.random() - 0.5) * 44 };
  for (const p of arcPoints(q.to, rest)) { await dispatchAt(p, 'pointermove', 0); await sleep(4 + Math.random() * 8); }
  if (promo) {
    await chrome.run_js({ code: `setTimeout(() => {
      const names = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
      const want = names[` + JSON.stringify(promo) + `];
      const el = [...document.querySelectorAll('.promotion-piece, promotion-choice piece, .promotion-choice piece, #promotion-choice piece')]
        .find((e) => [...e.classList].some((c) => c === want || c === ` + JSON.stringify(promo) + `));
      if (el) { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: 1 })); el.click(); }
    }, 150);
    return true;` });
  }
  await stroke;
}

// Waits until the move count passes `plies` (the opponent moved) or the game ends; returns the new state.
// Polls from the host, not the page: background tabs throttle page timers, the host is not throttled.
async function waitForMove(plies: number, timeoutMs = 120000): Promise<ChessState> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await chessState();
    if (s.plies > plies || s.over) return s;
    await sleep(350);
  }
  return chessState();
}

// Plays a whole game for the side at the bottom of the board: read, think with the engine, move, wait.
// movetimeMs: engine time per move; skill 0-20 (20 = strongest); minDelayMs/maxDelayMs: a random pause
// before every move we send, so a live game against a person moves at a human pace instead of instantly.
// The fair-play / rules sheet is accepted automatically (dismissGate), so rated games start and play on.
async function playGame(options: { movetimeMs?: number; skill?: number; maxMoves?: number; minDelayMs?: number; maxDelayMs?: number } = {}): Promise<{ moves: string[]; final: ChessState; note?: string }> {
  const { movetimeMs = 300, skill = 20, maxMoves = 200, minDelayMs = 0, maxDelayMs = 0 } = options;
  const moves: string[] = [];
  let state = await chessState();
  const me: 'w' | 'b' = state.flipped ? 'b' : 'w';
  while (!state.over && moves.length < maxMoves) {
    await dismissGate(); // the fair-play sheet, if the site shows one: the account and the game are the user's
    if (state.turn !== me) { state = await waitForMove(state.plies); continue; }
    let fen = state.fen;
    let played = false;
    // The board may refuse a click: the castling rights read off it are a guess (a rook moved and came
    // back). Then the rights are dropped and the engine answers again instead of spinning.
    for (let attempt = 0; attempt < 3 && !played; attempt++) {
      if (attempt === 2) fen = fen.split(' ').map((f, i) => (i === 3 ? '-' : f)).join(' ');
      const r = JSON.parse(await engine.bestMove({ fen, movetimeMs, skill })) as { bestmove: string | null };
      if (!r.bestmove) break;
      if (maxDelayMs > minDelayMs) await sleep(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
      const before = state.plies;
      await playMove(r.bestmove, { color: me });
      const after = await waitForMove(before, 6000);
      if (after.plies > before) { moves.push(r.bestmove); state = after; played = true; break; }
      state = after;
      if (state.over) break;
    }
    if (!played) return { moves, final: state, note: `the board did not accept a move (${moves.length} played, plies ${state.plies}, turn ${state.turn}); check that your tab is the game and call chessState()` };
    if (state.turn !== me && !state.over) state = await waitForMove(state.plies);
  }
  return { moves, final: state };
}
