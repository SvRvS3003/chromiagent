// Chromiagent chess helpers, by SvRvS: read the board from the page's HTML (no screenshots), ask the
// engine, play the move, wait for the reply, all in one code mode script, so a game moves at engine speed.
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

// The position on the selected tab.
async function chessState(): Promise<ChessState> {
  return pw<ChessState>(`async (page) => page.evaluate(${READ_BOARD})`);
}

// Plays a UCI move (e2e4, e7e8q) by pressing the two squares inside the page: synthetic pointer events,
// so the move lands while the tab sits in the background and the user never gets pulled to it. With
// `real: true` it sends Playwright mouse clicks instead, for a board that ignores synthetic events.
async function playMove(uci: string, options: { real?: boolean } = {}): Promise<void> {
  const from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci[4] || '';
  if (options.real) {
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
      const [a, b] = [center('${from}'), center('${to}')];
      await page.mouse.click(a[0], a[1]);
      await page.mouse.click(b[0], b[1]);
      if ('${promo}') {
        await page.waitForTimeout(150);
        const p = '${promo}';
        const names = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
        const pick = page.locator('.promotion-piece.w' + p + ', .promotion-piece.b' + p + ', #promotion-choice piece.' + names[p]).first();
        if (await pick.count()) await pick.click();
      }
      return true;
    }`);
    return;
  }
  await pw(`async (page) => {
    await page.evaluate(({ from, to, promo }) => {
      const board = document.querySelector('wc-chess-board, chess-board, cg-board');
      if (!board) throw new Error('no board on this tab');
      const r = board.getBoundingClientRect();
      const flipped = board.classList.contains('flipped') || !!document.querySelector('.cg-wrap.orientation-black');
      const s = r.width / 8;
      const center = (sq) => {
        const f = 'abcdefgh'.indexOf(sq[0]) + 1, k = Number(sq[1]);
        return flipped ? [r.left + (8 - f + 0.5) * s, r.top + (k - 0.5) * s] : [r.left + (f - 0.5) * s, r.top + (8 - k + 0.5) * s];
      };
      const send = (px, py, type, buttons) => {
        // The deepest element under the point, so the event starts where a real cursor would.
        const el = document.elementFromPoint(px, py) || board;
        const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: px, clientY: py, screenX: px, screenY: py, button: 0, buttons, isPrimary: true, pointerId: 1, pointerType: 'mouse' };
        el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, o) : new MouseEvent(type, o));
      };
      const [a, b] = [center(from), center(to)];
      send(a[0], a[1], 'pointermove', 0); send(a[0], a[1], 'pointerdown', 1); send(a[0], a[1], 'mousedown', 1);
      send(b[0], b[1], 'pointermove', 1); send(b[0], b[1], 'pointerup', 0); send(b[0], b[1], 'mouseup', 0); send(b[0], b[1], 'click', 0);
      if (promo) {
        const names = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
        setTimeout(() => {
          const want = names[promo];
          const el = [...document.querySelectorAll('.promotion-piece, promotion-choice piece, .promotion-choice piece, #promotion-choice piece')]
            .find((e) => [...e.classList].some((c) => c === want || c === promo));
          if (el) { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: 1 })); el.click(); }
        }, 150);
      }
      return true;
    }, { from: '${from}', to: '${to}', promo: '${promo}' });
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

// Waits in the page (the code mode script has no timers of its own).
async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await pw(`async (page) => { await page.waitForTimeout(${Math.round(ms)}); return true; }`);
}

// Plays a whole game for the side at the bottom of the board: read, think with the engine, move, wait.
// movetimeMs: engine time per move; skill 0-20 (20 = strongest); minDelayMs/maxDelayMs: a random pause
// before every move we send, so a live game against a person moves at a human pace instead of instantly.
async function playGame(options: { movetimeMs?: number; skill?: number; maxMoves?: number; minDelayMs?: number; maxDelayMs?: number } = {}): Promise<{ moves: string[]; final: ChessState; note?: string }> {
  const { movetimeMs = 300, skill = 20, maxMoves = 200, minDelayMs = 0, maxDelayMs = 0 } = options;
  const moves: string[] = [];
  let state = await chessState();
  const me: 'w' | 'b' = state.flipped ? 'b' : 'w';
  while (!state.over && moves.length < maxMoves) {
    if (state.turn !== me) { state = await waitForMove(state.plies); continue; }
    let fen = state.fen;
    let played = false;
    // The board may refuse a click: the castling rights read off it are a guess (a rook moved and came
    // back), or the site ignores synthetic events. Then the rights are dropped and a real click follows.
    for (let attempt = 0; attempt < 3 && !played; attempt++) {
      if (attempt === 2) fen = fen.split(' ').map((f, i) => (i === 3 ? '-' : f)).join(' ');
      const r = JSON.parse(await engine.bestMove({ fen, movetimeMs, skill })) as { bestmove: string | null };
      if (!r.bestmove) break;
      if (maxDelayMs > minDelayMs) await sleep(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
      const before = state.plies;
      await playMove(r.bestmove, { real: attempt > 0 });
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
