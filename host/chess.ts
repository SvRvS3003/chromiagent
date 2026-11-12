// Chromiagent chess helpers, by SvRvS: read the board from the page's HTML (no screenshots), ask the
// engine, play the move, wait for the reply, all in one code mode script, so a game moves at engine speed.
// Works on chess.com and lichess.org boards (play vs computer, analysis, puzzles).

interface ChessState {
  site: 'chess.com' | 'lichess' | 'unknown';
  fen: string;              // full FEN; the side to move is counted from the move list
  turn: 'w' | 'b';
  flipped: boolean;         // board shown from black's side: usually you play black
  plies: number;            // half-moves played so far
  over: boolean;            // a game-over dialog is showing
}

// Runs a Playwright function on the selected tab and returns its value.
async function pw<T = unknown>(fn: string): Promise<T> {
  const text = await playwright.browser_run_code_unsafe({ code: fn });
  const m = text.match(/### Result\n([\s\S]*?)(?:\n###|$)/);
  if (!m) throw new Error(text.slice(0, 400));
  return JSON.parse(m[1]) as T;
}

// Selects the Playwright tab whose URL contains `urlPart` (e.g. 'chess.com/play').
async function selectTab(urlPart: string): Promise<number> {
  const list = await playwright.browser_tabs({ action: 'list' });
  const line = list.split('\n').find((l) => l.includes(urlPart));
  const index = Number(line?.match(/(\d+):/)?.[1]);
  if (Number.isNaN(index)) throw new Error(`no tab with "${urlPart}"`);
  await playwright.browser_tabs({ action: 'select', index });
  return index;
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
    plies = document.querySelectorAll('.main-line-ply, .move-list .node .node-highlight-content, vertical-move-list .node').length
      || document.querySelectorAll('[data-ply]').length;
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
  return { site, fen: rows.join('/') + ' ' + turn + ' ' + (castling || '-') + ' - 0 ' + (Math.floor(plies / 2) + 1), turn, flipped, plies, over };
}`;

// The position on the selected tab.
async function chessState(): Promise<ChessState> {
  return pw<ChessState>(`async (page) => page.evaluate(${READ_BOARD})`);
}

// Plays a UCI move (e2e4, e7e8q) by clicking the two squares; promotions pick the piece.
async function playMove(uci: string): Promise<void> {
  await pw(`async (page) => {
    const info = await page.evaluate(() => {
      const b = document.querySelector('wc-chess-board, chess-board, cg-board');
      const r = b.getBoundingClientRect();
      const flipped = b.classList.contains('flipped') || !!document.querySelector('.cg-wrap.orientation-black');
      return { x: r.left, y: r.top, s: r.width / 8, flipped };
    });
    const center = (sq) => {
      const f = 'abcdefgh'.indexOf(sq[0]) + 1, r = Number(sq[1]);
      return info.flipped ? [info.x + (8 - f + 0.5) * info.s, info.y + (r - 0.5) * info.s] : [info.x + (f - 0.5) * info.s, info.y + (8 - r + 0.5) * info.s];
    };
    const [a, b] = [center('${uci.slice(0, 2)}'), center('${uci.slice(2, 4)}')];
    await page.mouse.click(a[0], a[1]);
    await page.mouse.click(b[0], b[1]);
    if ('${uci[4] || ''}') {
      await page.waitForTimeout(150);
      const p = '${uci[4] || 'q'}';
      const names = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
      const pick = page.locator('.promotion-piece.w' + p + ', .promotion-piece.b' + p + ', #promotion-choice piece.' + names[p]).first();
      if (await pick.count()) await pick.click();
    }
    return true;
  }`);
}

// Waits until the move count passes `plies` (the opponent moved) or the game ends; returns the new state.
async function waitForMove(plies: number, timeoutMs = 120000): Promise<ChessState> {
  // An expression string runs through the debugger, so the page's CSP (no eval) does not apply.
  const until = `(() => { const s = (${READ_BOARD})(); return s.plies > ${plies} || s.over; })()`;
  await pw(`async (page) => {
    await page.waitForFunction(${JSON.stringify(until)}, null, { timeout: ${timeoutMs}, polling: 100 }).catch(() => null);
    return true;
  }`);
  return chessState();
}

// Plays a whole game for the side at the bottom of the board: read, think with the engine, move, wait.
// movetimeMs: engine time per move; skill 0-20 (20 = strongest).
async function playGame(options: { movetimeMs?: number; skill?: number; maxMoves?: number } = {}): Promise<{ moves: string[]; final: ChessState }> {
  const { movetimeMs = 300, skill = 20, maxMoves = 200 } = options;
  const moves: string[] = [];
  let state = await chessState();
  const me: 'w' | 'b' = state.flipped ? 'b' : 'w';
  while (!state.over && moves.length < maxMoves) {
    if (state.turn !== me) { state = await waitForMove(state.plies); continue; }
    const r = JSON.parse(await engine.bestMove({ fen: state.fen, movetimeMs, skill })) as { bestmove: string | null };
    if (!r.bestmove) break;
    await playMove(r.bestmove);
    moves.push(r.bestmove);
    state = await waitForMove(state.plies); // our own move lands first
    if (state.turn !== me && !state.over) state = await waitForMove(state.plies);
  }
  return { moves, final: state };
}
