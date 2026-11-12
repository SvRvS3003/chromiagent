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

// Dismisses a fair-play / rules agreement shown on a site. Returns the clicked button's label, or null.
async function dismissGate(): Promise<string | null> {
  return pw<string | null>(`async (page) => page.evaluate(${DISMISS_GATE})`);
}

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

// The position on the selected tab.
async function chessState(): Promise<ChessState> {
  return pw<ChessState>(`async (page) => page.evaluate(${READ_BOARD})`);
}

// Plays a UCI move (e2e4, e7e8q). The pointer arcs in like a hand: it glances at a friendly piece or
// two, glides to the from-square, dwells, presses, drags along a curved path with noise, releases, and
// rests near the board. With `real: true` the drag goes through Playwright's mouse instead, for a board
// that ignores synthetic events. The visible pointer is driven through the extension, so what the user
// sees is one motion, not a teleport.
async function playMove(uci: string, options: { real?: boolean; color?: 'w' | 'b' } = {}): Promise<void> {
  const from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci[4] || '';
  const q = await pw<{ from: Pt; to: Pt; flipped: boolean; last: Pt | null }>(`async (page) => page.evaluate(() => {
    document.addEventListener('pointermove', (e) => { window.__caPointer = { x: e.clientX, y: e.clientY }; }, true);
    const board = document.querySelector('wc-chess-board, chess-board, cg-board');
    if (!board) throw new Error('no board on this tab');
    const r = board.getBoundingClientRect();
    const flipped = board.classList.contains('flipped') || !!document.querySelector('.cg-wrap.orientation-black');
    const s = r.width / 8;
    const center = (sq) => {
      const f = 'abcdefgh'.indexOf(sq[0]) + 1, k = Number(sq[1]);
      return flipped ? { x: r.left + (8 - f + 0.5) * s, y: r.top + (k - 0.5) * s } : { x: r.left + (f - 0.5) * s, y: r.top + (8 - k + 0.5) * s };
    };
    return { from: center('${from}'), to: center('${to}'), flipped, last: window.__caPointer || null };
  })`);
  const me = q.flipped ? 'b' : 'w';
  const stroke: Promise<unknown> = (typeof chrome !== 'undefined' && chrome.pointer_stroke)
    ? chrome.pointer_stroke({ from: q.from, to: q.to, decoys: 1, color: options.color || me }).catch(() => null)
    : Promise.resolve(null);
  if (options.real) {
    const stretch = arcPoints(q.last || { x: q.from.x, y: q.from.y + 140 }, q.from);
    const drag = arcPoints(q.from, q.to);
    await pw(`async (page) => {
      const approach = ${JSON.stringify(stretch)};
      const drag = ${JSON.stringify(drag)};
      for (const p of approach) { await page.mouse.move(p.x, p.y); await page.waitForTimeout(4 + Math.random() * 9); }
      await page.waitForTimeout(60 + Math.random() * 140);
      await page.mouse.down();
      await page.waitForTimeout(35 + Math.random() * 70);
      for (const p of drag) { await page.mouse.move(p.x, p.y); await page.waitForTimeout(4 + Math.random() * 9); }
      await page.waitForTimeout(25 + Math.random() * 60);
      await page.mouse.up();
      if ('${promo}') {
        await page.waitForTimeout(150);
        const p = '${promo}';
        const names = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
        const pick = page.locator('.promotion-piece.w' + p + ', .promotion-piece.b' + p + ', #promotion-choice piece.' + names[p]).first();
        if (await pick.count()) await pick.click();
      }
      return true;
    }`);
    await stroke;
    return;
  }
  await Promise.all([stroke, pw(`async (page) => {
    await page.evaluate(({ from: A, to: B, promo, last }) => {
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const board = document.querySelector('wc-chess-board, chess-board, cg-board');
      if (!board) throw new Error('no board on this tab');
      const send = (p, type, buttons) => {
        const el = document.elementFromPoint(p.x, p.y) || board;
        const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y, button: 0, buttons, isPrimary: true, pointerId: 1, pointerType: 'mouse' };
        el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, o) : new MouseEvent(type, o));
      };
      const arc = (a, b) => {
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const nx = -dy / d, ny = dx / d;
        const bend = (0.10 + Math.random() * 0.24) * d * (Math.random() < 0.5 ? 1 : -1);
        const cx = (a.x + b.x) / 2 + nx * bend, cy = (a.y + b.y) / 2 + ny * bend;
        const N = Math.max(12, Math.min(26, Math.round(d / 13)));
        const pts = [];
        for (let i = 1; i <= N; i++) {
          const t = i / N, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2, m = 1 - e;
          const j = Math.sin(Math.PI * e) * 1.5;
          pts.push({ x: m * m * a.x + 2 * m * e * cx + e * e * b.x + (Math.random() - 0.5) * j * nx * 2,
                     y: m * m * a.y + 2 * m * e * cy + e * e * b.y + (Math.random() - 0.5) * j * ny * 2 });
        }
        return pts;
      };
      const start = last || { x: A.x, y: A.y + 120 };
      return (async () => {
        for (const p of arc(start, A)) { send(p, 'pointermove', 0); window.__caPointer = p; await sleep(4 + Math.random() * 9); }
        await sleep(70 + Math.random() * 170);              // the hover dwell before the grab
        send(A, 'pointerdown', 1); send(A, 'mousedown', 1);
        await sleep(40 + Math.random() * 80);
        for (const p of arc(A, B)) { send(p, 'pointermove', 1); window.__caPointer = p; await sleep(4 + Math.random() * 9); }
        send(B, 'pointermove', 1);
        await sleep(25 + Math.random() * 60);
        send(B, 'pointerup', 0); send(B, 'mouseup', 0); send(B, 'click', 0);
        const rest = { x: B.x + (Math.random() - 0.5) * 40, y: B.y + (Math.random() - 0.5) * 40 };
        for (const p of arc(B, rest)) { send(p, 'pointermove', 0); window.__caPointer = p; await sleep(4 + Math.random() * 8); }
        window.__caPointer = rest;
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
      })();
    }, { from: ${JSON.stringify(q.from)}, to: ${JSON.stringify(q.to)}, promo: '${promo}', last: ${JSON.stringify(q.last)} });
    return true;
  }`)]);
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
    await dismissGate(); // the fair-play sheet, if the site shows one: the account and the game are the user's
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
      await playMove(r.bestmove, { real: attempt > 0, color: me });
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
