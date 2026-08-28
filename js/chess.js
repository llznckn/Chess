/* =========================================================================
 * chess.js — 国际象棋核心引擎（纯逻辑，无 DOM 依赖）
 * 坐标系：board[r][c]，r=0 为第 8 横线(黑方底线)，r=7 为第 1 横线(白方底线)
 * 白方棋子为大写，黑方为小写：K/Q/R/B/N/P
 * 在浏览器中作为全局脚本加载（function/var 挂全局，const/class 进全局词法环境）；
 * 在 Node 中通过 module.exports 导出以便测试。
 * 注意：MATE 必须用 var（使 ai.js 能通过 globalThis.MATE 取到）。
 * ========================================================================= */

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
// 用 var 而非 const：使 MATE 挂到全局对象，便于 ai.js 在浏览器中通过 globalThis 取用
var MATE = 1000000;

// 颜色查表：比 toUpperCase 判断更快更稳
const COLOR_MAP = {
  K: 'w', Q: 'w', R: 'w', B: 'w', N: 'w', P: 'w',
  k: 'b', q: 'b', r: 'b', b: 'b', n: 'b', p: 'b'
};

function initialBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (let c = 0; c < 8; c++) {
    b[0][c] = back[c];            // 黑方底线
    b[1][c] = 'p';               // 黑方兵
    b[6][c] = 'P';               // 白方兵
    b[7][c] = back[c].toUpperCase(); // 白方底线
  }
  return b;
}

function cloneBoard(b) { return b.map(row => row.slice()); }

function squareName(r, c) { return FILES[c] + (8 - r); }

function colorOf(p) { return p ? (COLOR_MAP[p] || null) : null; }

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

/* 局面指纹（用于三次重复检测 / 置换表）：棋盘 + 轮到 + 王车易位 + 吃过路兵格 */
function positionKey(board, turn, castling, enPassant) {
  let s = turn + '|';
  s += (castling.wK ? 'K' : '') + (castling.wQ ? 'Q' : '') +
       (castling.bK ? 'k' : '') + (castling.bQ ? 'q' : '') + '|';
  s += (enPassant || '-') + '|';
  for (let r = 0; r < 8; r++) {
    let row = '', empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += p;
    }
    if (empty) row += empty;
    s += row + '/';
  }
  return s;
}

function findKing(board, color) {
  const k = color === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] === k) return [r, c];
  return null;
}

/* ---------- 走法生成辅助 ---------- */

function mk(board, r, c, nr, nc, extra) {
  return Object.assign({
    from: [r, c], to: [nr, nc], piece: board[r][c], captured: board[nr][nc] || null
  }, extra || {});
}

function pawnMoves(board, r, c, color, enPassant) {
  const moves = [];
  const dir = color === 'w' ? -1 : 1;
  const startRow = color === 'w' ? 6 : 1;
  const promoRow = color === 'w' ? 0 : 7;

  // 向前一格
  const nr = r + dir;
  if (inBounds(nr, c) && !board[nr][c]) {
    if (nr === promoRow) {
      for (const pr of ['q', 'r', 'b', 'n']) moves.push(mk(board, r, c, nr, c, { promotion: pr }));
    } else {
      moves.push(mk(board, r, c, nr, c));
    }
    // 向前两格
    if (r === startRow) {
      const nr2 = r + 2 * dir;
      if (!board[nr2][c]) moves.push(mk(board, r, c, nr2, c, { double: true }));
    }
  }
  // 斜吃
  for (const dc of [-1, 1]) {
    const nc = c + dc;
    const tr = r + dir;
    if (!inBounds(tr, nc)) continue;
    const target = board[tr][nc];
    if (target && colorOf(target) !== color) {
      if (tr === promoRow) {
        for (const pr of ['q', 'r', 'b', 'n']) moves.push(mk(board, r, c, tr, nc, { promotion: pr }));
      } else {
        moves.push(mk(board, r, c, tr, nc));
      }
    } else if (enPassant && squareName(tr, nc) === enPassant) {
      moves.push(mk(board, r, c, tr, nc, { enpassant: true, captured: (color === 'w' ? 'p' : 'P') }));
    }
  }
  return moves;
}

function knightMoves(board, r, c, color) {
  const moves = [];
  const deltas = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  for (const [dr, dc] of deltas) {
    const nr = r + dr, nc = c + dc;
    if (!inBounds(nr, nc)) continue;
    const t = board[nr][nc];
    if (!t || colorOf(t) !== color) moves.push(mk(board, r, c, nr, nc));
  }
  return moves;
}

function slideMoves(board, r, c, color, dirs) {
  const moves = [];
  for (const [dr, dc] of dirs) {
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc)) {
      const t = board[nr][nc];
      if (!t) {
        moves.push(mk(board, r, c, nr, nc));
      } else {
        if (colorOf(t) !== color) moves.push(mk(board, r, c, nr, nc));
        break;
      }
      nr += dr; nc += dc;
    }
  }
  return moves;
}

function addCastling(board, color, castling, moves) {
  const enemy = color === 'w' ? 'b' : 'w';
  const kpos = findKing(board, color);
  if (!kpos || isSquareAttacked(board, kpos[0], kpos[1], enemy)) return;

  if (color === 'w') {
    if (castling.wK && board[7][5] === null && board[7][6] === null && board[7][7] === 'R' &&
        !isSquareAttacked(board, 7, 5, enemy) && !isSquareAttacked(board, 7, 6, enemy))
      moves.push(mk(board, 7, 4, 7, 6, { castle: 'K' }));
    if (castling.wQ && board[7][1] === null && board[7][2] === null && board[7][3] === null && board[7][0] === 'R' &&
        !isSquareAttacked(board, 7, 3, enemy) && !isSquareAttacked(board, 7, 2, enemy))
      moves.push(mk(board, 7, 4, 7, 2, { castle: 'Q' }));
  } else {
    if (castling.bK && board[0][5] === null && board[0][6] === null && board[0][7] === 'r' &&
        !isSquareAttacked(board, 0, 5, enemy) && !isSquareAttacked(board, 0, 6, enemy))
      moves.push(mk(board, 0, 4, 0, 6, { castle: 'K' }));
    if (castling.bQ && board[0][1] === null && board[0][2] === null && board[0][3] === null && board[0][0] === 'r' &&
        !isSquareAttacked(board, 0, 3, enemy) && !isSquareAttacked(board, 0, 2, enemy))
      moves.push(mk(board, 0, 4, 0, 2, { castle: 'Q' }));
  }
}

function kingMoves(board, r, c, color, castling) {
  const moves = [];
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const t = board[nr][nc];
      if (!t || colorOf(t) !== color) moves.push(mk(board, r, c, nr, nc));
    }
  addCastling(board, color, castling, moves);
  return moves;
}

function generatePseudo(board, color, castling, enPassant) {
  const moves = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || colorOf(p) !== color) continue;
      const pt = p.toLowerCase();
      if (pt === 'p') moves.push(...pawnMoves(board, r, c, color, enPassant));
      else if (pt === 'n') moves.push(...knightMoves(board, r, c, color));
      else if (pt === 'b') moves.push(...slideMoves(board, r, c, color, [[1, 1], [1, -1], [-1, 1], [-1, -1]]));
      else if (pt === 'r') moves.push(...slideMoves(board, r, c, color, [[1, 0], [-1, 0], [0, 1], [0, -1]]));
      else if (pt === 'q') moves.push(...slideMoves(board, r, c, color, [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]));
      else if (pt === 'k') moves.push(...kingMoves(board, r, c, color, castling));
    }
  return moves;
}

function makeMove(board, move) {
  const b = cloneBoard(board);
  const [fr, fc] = move.from, [tr, tc] = move.to;
  const piece = b[fr][fc];
  b[fr][fc] = null;
  if (move.enpassant) b[fr][tc] = null; // 吃过路兵：移除同排目标列的兵
  if (move.promotion) {
    const col = colorOf(piece);
    b[tr][tc] = col === 'w' ? move.promotion.toUpperCase() : move.promotion;
  } else {
    b[tr][tc] = piece;
  }
  if (move.castle === 'K') { b[tr][5] = b[tr][7]; b[tr][7] = null; }
  if (move.castle === 'Q') { b[tr][3] = b[tr][0]; b[tr][0] = null; }
  return b;
}

/* 原地走子（AI 搜索用，避免整盘克隆）。用 move.captured 记录的信息保证可精确撤销 */
function makeMoveInPlace(board, move) {
  const [fr, fc] = move.from, [tr, tc] = move.to;
  const piece = board[fr][fc];
  board[fr][fc] = null;
  if (move.enpassant) board[fr][tc] = null;
  if (move.promotion) {
    const col = colorOf(piece);
    board[tr][tc] = col === 'w' ? move.promotion.toUpperCase() : move.promotion;
  } else {
    board[tr][tc] = piece;
  }
  if (move.castle === 'K') { board[tr][5] = board[tr][7]; board[tr][7] = null; }
  if (move.castle === 'Q') { board[tr][3] = board[tr][0]; board[tr][0] = null; }
}

function undoMove(board, move) {
  const [fr, fc] = move.from, [tr, tc] = move.to;
  const piece = move.piece;
  // 王先回到原位（王翼易位时 to=(r,6)，后翼易位 to=(r,2)）
  board[fr][fc] = piece;
  // 易位：车回到原位
  if (move.castle === 'K') { board[tr][7] = board[tr][5]; board[tr][5] = null; }
  if (move.castle === 'Q') { board[tr][0] = board[tr][3]; board[tr][3] = null; }
  // 吃过路兵：被吃兵放回同排源列
  if (move.enpassant) {
    board[fr][tc] = move.captured;
    board[tr][tc] = null;
  } else if (move.captured) {
    board[tr][tc] = move.captured;
  } else {
    board[tr][tc] = null;
  }
}

function isSquareAttacked(board, r, c, byColor) {
  // 兵
  const dir = byColor === 'w' ? -1 : 1;
  for (const dc of [-1, 1]) {
    const pr = r - dir, pc = c + dc;
    if (inBounds(pr, pc)) {
      const p = board[pr][pc];
      if (p && colorOf(p) === byColor && p.toLowerCase() === 'p') return true;
    }
  }
  // 马
  const kn = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  for (const [dr, dc] of kn) {
    const nr = r + dr, nc = c + dc;
    if (inBounds(nr, nc)) {
      const p = board[nr][nc];
      if (p && colorOf(p) === byColor && p.toLowerCase() === 'n') return true;
    }
  }
  // 王
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (inBounds(nr, nc)) {
        const p = board[nr][nc];
        if (p && colorOf(p) === byColor && p.toLowerCase() === 'k') return true;
      }
    }
  // 斜线（象/后）
  const diags = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const [dr, dc] of diags) {
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc)) {
      const p = board[nr][nc];
      if (p) { if (colorOf(p) === byColor && (p.toLowerCase() === 'b' || p.toLowerCase() === 'q')) return true; break; }
      nr += dr; nc += dc;
    }
  }
  // 直线（车/后）
  const straights = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dr, dc] of straights) {
    let nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc)) {
      const p = board[nr][nc];
      if (p) { if (colorOf(p) === byColor && (p.toLowerCase() === 'r' || p.toLowerCase() === 'q')) return true; break; }
      nr += dr; nc += dc;
    }
  }
  return false;
}

function generateLegal(board, color, castling, enPassant) {
  const pseudo = generatePseudo(board, color, castling, enPassant);
  const legal = [];
  const enemy = color === 'w' ? 'b' : 'w';
  for (const m of pseudo) {
    const nb = makeMove(board, m);
    const kpos = findKing(nb, color);
    if (kpos && !isSquareAttacked(nb, kpos[0], kpos[1], enemy)) legal.push(m);
  }
  return legal;
}

/* 原地版合法走法生成：伪走法 → 原地走 → 验证 → 撤销，全程零克隆（AI 搜索热路径） */
function generateLegalInPlace(board, color, castling, enPassant) {
  const pseudo = generatePseudo(board, color, castling, enPassant);
  const legal = [];
  const enemy = color === 'w' ? 'b' : 'w';
  for (const m of pseudo) {
    makeMoveInPlace(board, m);
    const kpos = findKing(board, color);
    if (kpos && !isSquareAttacked(board, kpos[0], kpos[1], enemy)) legal.push(m);
    undoMove(board, m);
  }
  return legal;
}

function updateCastling(cr, move) {
  const n = Object.assign({}, cr);
  const [fr, fc] = move.from, [tr, tc] = move.to;
  const p = move.piece;
  if (p.toLowerCase() === 'k') {
    if (colorOf(p) === 'w') { n.wK = false; n.wQ = false; }
    else { n.bK = false; n.bQ = false; }
  }
  if (p.toLowerCase() === 'r') {
    if (fr === 7 && fc === 0) n.wQ = false;
    if (fr === 7 && fc === 7) n.wK = false;
    if (fr === 0 && fc === 0) n.bQ = false;
    if (fr === 0 && fc === 7) n.bK = false;
  }
  if (tr === 7 && tc === 0) n.wQ = false;
  if (tr === 7 && tc === 7) n.wK = false;
  if (tr === 0 && tc === 0) n.bQ = false;
  if (tr === 0 && tc === 7) n.bK = false;
  return n;
}

/* =========================================================================
 * ChessGame — 带状态的对局封装
 * ========================================================================= */
class ChessGame {
  constructor() { this.reset(); }

  reset() {
    this.board = initialBoard();
    this.turn = 'w';
    this.castling = { wK: true, wQ: true, bK: true, bQ: true };
    this.enPassant = null;
    this.halfmove = 0;
    this.fullmove = 1;
    this.history = [];   // 撤销用快照
    this.moveLog = [];   // 记谱
    this.moves = [];     // 着法对象列表（回放/复盘用）
    this.lastMove = null;
    this.positionHistory = [this._key()];
    this.repetitionDraw = false;
  }
  _key() { return positionKey(this.board, this.turn, this.castling, this.enPassant); }
  _countCurrent() {
    const k = this._key(); let c = 0;
    for (let i = 0; i < this.positionHistory.length; i++) if (this.positionHistory[i] === k) c++;
    return c;
  }
  /* 三次重复判和（合规处理：第三次出现时本局终止） */
  isThreefoldRepetition() { return this._countCurrent() >= 3; }
  isFiftyMoveRule() { return this.halfmove >= 100; }
  isInsufficientMaterial() {
    const pieces = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const p = this.board[r][c]; if (p) pieces.push([p, r, c]); }
    if (pieces.length === 2) return true; // 仅剩双王
    if (pieces.length === 3) {
      const last = pieces[2][0];
      if (last.toLowerCase() === 'b' || last.toLowerCase() === 'n') return true; // 单象或单马
    }
    return false;
  }
  inCheck(color) {
    const k = findKing(this.board, color);
    return k && isSquareAttacked(this.board, k[0], k[1], color === 'w' ? 'b' : 'w');
  }
  legalMoves() { return generateLegal(this.board, this.turn, this.castling, this.enPassant); }
  legalMovesFrom(r, c) {
    return this.legalMoves().filter(m => m.from[0] === r && m.from[1] === c);
  }
  isGameOver(ignoreRepeat) { return this.legalMoves().length === 0 || (ignoreRepeat ? false : this.isThreefoldRepetition()) || this.repetitionDraw || this.isFiftyMoveRule() || this.isInsufficientMaterial(); }
  isCheckmate() { return this.legalMoves().length === 0 && this.inCheck(this.turn); }
  isStalemate() { return this.legalMoves().length === 0 && !this.inCheck(this.turn); }
  isDrawByRepetition() { return this.isThreefoldRepetition(); }

  /* 应用一步走法并更新状态（含记谱） */
  apply(move) {
    // 撤销快照
    this.history.push({
      board: cloneBoard(this.board),
      turn: this.turn, castling: Object.assign({}, this.castling),
      enPassant: this.enPassant, halfmove: this.halfmove,
      fullmove: this.fullmove, lastMove: this.lastMove,
      positionHistory: this.positionHistory.slice()
    });
    this.moves.push(move);
    const san = this.moveToSAN(move);
    const piece = this.board[move.from[0]][move.from[1]];
    const isPawn = piece.toLowerCase() === 'p';
    const isCapture = !!move.captured || move.enpassant;

    this.castling = updateCastling(this.castling, move);
    this.enPassant = move.double
      ? squareName(move.from[0] + (this.turn === 'w' ? -1 : 1), move.from[1])
      : null;

    this.board = makeMove(this.board, move);
    this.lastMove = move;

    this.halfmove = (isPawn || isCapture) ? 0 : this.halfmove + 1;
    if (this.turn === 'b') this.fullmove++;
    this.turn = this.turn === 'w' ? 'b' : 'w';

    this.moveLog.push(san);
    this.positionHistory.push(this._key());
    return san;
  }

  undo() {
    const snap = this.history.pop();
    if (!snap) return false;
    this.board = snap.board;
    this.turn = snap.turn;
    this.castling = snap.castling;
    this.enPassant = snap.enPassant;
    this.halfmove = snap.halfmove;
    this.fullmove = snap.fullmove;
    this.lastMove = snap.lastMove;
    this.moveLog.pop();
    this.moves.pop();
    this.positionHistory = snap.positionHistory;
    return true;
  }

  /* 回放：用传入的完整着法列表把对局恢复到第 n 手（0 = 初始局面） */
  restoreToPly(movesArr, n) {
    const mvs = movesArr.slice(0, Math.max(0, Math.min(movesArr.length, n)));
    this.reset();
    for (let i = 0; i < mvs.length; i++) this.apply(mvs[i]);
    return this.moves.length;
  }

  /* 生成标准代数记谱（SAN） */
  moveToSAN(move) {
    const color = colorOf(move.piece);
    const enemy = color === 'w' ? 'b' : 'w';
    const dest = squareName(move.to[0], move.to[1]);

    if (move.castle === 'K') return this._withCheck('O-O', move, enemy);
    if (move.castle === 'Q') return this._withCheck('O-O-O', move, enemy);

    const pt = move.piece.toLowerCase();
    let san = '';
    if (pt !== 'p') {
      san += pt.toUpperCase();
      // 歧义消解：同类型棋子是否还有别的也能走到该格
      const moverMoves = generateLegal(this.board, this.turn, this.castling, this.enPassant);
      const others = moverMoves.filter(m =>
        m.piece === move.piece && m.to[0] === move.to[0] && m.to[1] === move.to[1] &&
        !(m.from[0] === move.from[0] && m.from[1] === move.from[1]));
      if (others.length > 0) {
        const sameFile = others.some(m => m.from[1] === move.from[1]);
        const sameRank = others.some(m => m.from[0] === move.from[0]);
        if (!sameFile) san += FILES[move.from[1]];
        else if (!sameRank) san += String(8 - move.from[0]);
        else san += FILES[move.from[1]] + String(8 - move.from[0]);
      }
    }

    const isCapture = !!move.captured || move.enpassant;
    if (pt === 'p' && isCapture) san += FILES[move.from[1]]; // 兵吃子时标出原列
    if (isCapture) san += 'x';
    san += dest;
    if (move.promotion) san += '=' + move.promotion.toUpperCase();

    return this._withCheck(san, move, enemy);
  }

  _withCheck(san, move, enemy) {
    const nb = makeMove(this.board, move);
    const nextCast = updateCastling(this.castling, move);
    const nextEp = move.double ? squareName(move.from[0] + (colorOf(move.piece) === 'w' ? -1 : 1), move.from[1]) : null;
    const enemyMoves = generateLegal(nb, enemy, nextCast, nextEp);
    const ek = findKing(nb, enemy);
    const givesCheck = ek && isSquareAttacked(nb, ek[0], ek[1], colorOf(move.piece));
    if (enemyMoves.length === 0 && givesCheck) return san + '#';
    if (givesCheck) return san + '+';
    return san;
  }
}

/* ---------- Node 测试导出 ---------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ChessGame, initialBoard, makeMove, makeMoveInPlace, undoMove,
    isSquareAttacked, findKing, generateLegal, generateLegalInPlace,
    generatePseudo, updateCastling, squareName, colorOf,
    positionKey, cloneBoard, MATE
  };
}
