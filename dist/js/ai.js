/* =========================================================================
 * ai.js — 国际象棋 AI
 * negamax + α-β 剪枝 + 置换表(positionKey) + 静态搜索(quiescence)
 * + 走法排序(MVV-LVA + 杀手着法 + 历史表) + 空着剪枝(null move)
 * + 迭代加深 + 时间管理(timeLimit) + 重复局面惩罚
 * 评估函数：子力 + 位置表(PST) + 兵结构/象对/王安全/机动性/开放线/悬兵。
 * 搜索热路径使用棋盘原地走子/撤销（零克隆），见 chess.js 的
 * makeMoveInPlace / undoMove / generateLegalInPlace。
 *
 * 重要：本文件顶层绝不声明与 chess.js 全局同名的词法名（如 generateLegal、
 * makeMove 等）——浏览器中全局 function 与顶层 const 同名会直接抛
 * SyntaxError，导致整个脚本加载失败（表现即“AI 不会动”）。
 * 因此引擎函数统一放进命名空间对象 ch，通过 ch.xxx 取用。
 * ========================================================================= */

const _isNode = (typeof require !== 'undefined') && (typeof module !== 'undefined' && module && module.exports);

let _src;
if (_isNode) {
  _src = require('./chess.js');
} else {
  const g = (typeof globalThis !== 'undefined') ? globalThis
          : (typeof window !== 'undefined' ? window : {});
  _src = {
    generateLegal: g.generateLegal,
    generateLegalInPlace: g.generateLegalInPlace,
    generatePseudo: g.generatePseudo,
    makeMove: g.makeMove,
    makeMoveInPlace: g.makeMoveInPlace,
    undoMove: g.undoMove,
    isSquareAttacked: g.isSquareAttacked,
    findKing: g.findKing,
    updateCastling: g.updateCastling,
    squareName: g.squareName,
    positionKey: g.positionKey,
    MATE: g.MATE
  };
}

// 引擎函数命名空间（避免与 chess.js 全局词法同名冲突）
const ch = {
  legal:    _src.generateLegal,        // 备用：克隆版合法走法
  legalIn:  _src.generateLegalInPlace, // 零克隆合法走法（搜索热路径）
  pseudo:   _src.generatePseudo,
  move:     _src.makeMove,             // 备用：克隆版走子
  moveIn:   _src.makeMoveInPlace,
  undo:     _src.undoMove,
  attacked: _src.isSquareAttacked,
  king:     _src.findKing,
  castle:   _src.updateCastling,
  sq:       _src.squareName,
  key:      _src.positionKey,
  mate:     _src.MATE
};

const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// 位置表（row0 = 第8横线，自顶向下；白方直接使用，黑方纵向镜像）
const PST = {
  p: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [50, 50, 50, 50, 50, 50, 50, 50],
    [10, 10, 20, 30, 30, 20, 10, 10],
    [5, 5, 10, 25, 25, 10, 5, 5],
    [0, 0, 0, 20, 20, 0, 0, 0],
    [5, -5, -10, 0, 0, -10, -5, 5],
    [5, 10, 10, -20, -20, 10, 10, 5],
    [0, 0, 0, 0, 0, 0, 0, 0]
  ],
  n: [
    [-50, -40, -30, -30, -30, -30, -40, -50],
    [-40, -20, 0, 0, 0, 0, -20, -40],
    [-30, 0, 10, 15, 15, 10, 0, -30],
    [-30, 5, 15, 20, 20, 15, 5, -30],
    [-30, 0, 15, 20, 20, 15, 0, -30],
    [-30, 5, 10, 15, 15, 10, 5, -30],
    [-40, -20, 0, 5, 5, 0, -20, -40],
    [-50, -40, -30, -30, -30, -30, -40, -50]
  ],
  b: [
    [-20, -10, -10, -10, -10, -10, -10, -20],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-10, 0, 5, 10, 10, 5, 0, -10],
    [-10, 5, 5, 10, 10, 5, 5, -10],
    [-10, 0, 10, 10, 10, 10, 0, -10],
    [-10, 10, 10, 10, 10, 10, 10, -10],
    [-10, 5, 0, 0, 0, 0, 5, -10],
    [-20, -10, -10, -10, -10, -10, -10, -20]
  ],
  r: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [5, 10, 10, 10, 10, 10, 10, 5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [0, 0, 0, 5, 5, 0, 0, 0]
  ],
  q: [
    [-20, -10, -10, -5, -5, -10, -10, -20],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-10, 0, 5, 5, 5, 5, 0, -10],
    [-5, 0, 5, 5, 5, 5, 0, -5],
    [0, 0, 5, 5, 5, 5, 0, -5],
    [-10, 5, 5, 5, 5, 5, 0, -10],
    [-10, 0, 5, 0, 0, 0, 0, -10],
    [-20, -10, -10, -5, -5, -10, -10, -20]
  ],
  k: [
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-20, -30, -30, -40, -40, -30, -30, -20],
    [-10, -20, -20, -20, -20, -20, -20, -10],
    [20, 20, 0, 0, 0, 0, 20, 20],
    [20, 30, 10, 0, 0, 10, 30, 20]
  ]
};

/* 残局王表：残局时鼓励王向中心靠拢（配合逼杀） */
const PST_K_END = [
  [-50, -30, -30, -30, -30, -30, -30, -50],
  [-30, -10,   0,   0,   0,   0, -10, -30],
  [-30,   0,  20,  30,  30,  20,   0, -30],
  [-30,   0,  30,  40,  40,  30,   0, -30],
  [-30,   0,  30,  40,  40,  30,   0, -30],
  [-30,   0,  20,  30,  30,  20,   0, -30],
  [-30, -10,   0,   0,   0,   0, -10, -30],
  [-50, -30, -30, -30, -30, -30, -30, -50]
];

/* 轻量机动性计数：马/象的可落点数（不生成完整走法，纯偏移扫描，评估热路径安全） */
function mobilityCount(board, r, c, pt, col) {
  let n = 0;
  const isW = col === 'w';
  if (pt === 'n') {
    const offs = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    for (let i = 0; i < 8; i++) {
      const rr = r + offs[i][0], cc = c + offs[i][1];
      if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
      const t = board[rr][cc];
      if (!t) { n++; continue; }
      const tIsW = t === t.toUpperCase();
      if (tIsW !== isW) n++; // 可吃对方子
    }
  } else { // 象
    const dirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    for (let i = 0; i < 4; i++) {
      let rr = r + dirs[i][0], cc = c + dirs[i][1];
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        const t = board[rr][cc];
        if (!t) { n++; }
        else {
          const tIsW = t === t.toUpperCase();
          if (tIsW !== isW) n++;
          break;
        }
        rr += dirs[i][0]; cc += dirs[i][1];
      }
    }
  }
  return n;
}

function evaluate(board) {
  let score = 0;
  // 收集双方棋子与子力（不含王）；同时统计每列兵数（开放线/悬兵判断用）
  const pieces = { w: [], b: [] };
  const material = { w: 0, b: 0 };
  const pawnFile = { w: new Array(8).fill(0), b: new Array(8).fill(0) };
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const pt = p.toLowerCase();
      const col = p === p.toUpperCase() ? 'w' : 'b';
      const pstVal = col === 'w' ? PST[pt][r][c] : PST[pt][7 - r][c];
      const s = PIECE_VALUE[pt] + pstVal;
      score += col === 'w' ? s : -s;
      pieces[col].push({ pt, r, c });
      if (pt !== 'k') material[col] += PIECE_VALUE[pt];
      if (pt === 'p') pawnFile[col][c]++;
    }

  const totalMat = material.w + material.b;
  const endgame = totalMat < 2400; // 子力少 → 残局模式

  for (const col of ['w', 'b']) {
    const sign = col === 'w' ? 1 : -1;
    const me = pieces[col];
    const opp = pieces[col === 'w' ? 'b' : 'w'];
    const oppCol = col === 'w' ? 'b' : 'w';

    // 象对：双象 +30（开放局面优势）
    let bishops = 0;
    for (const x of me) if (x.pt === 'b') bishops++;
    if (bishops >= 2) score += sign * 30;

    // 兵结构（纯静态扫描，不生成走法）
    const pawns = [];
    const oppPawns = [];
    for (const x of me) if (x.pt === 'p') pawns.push(x);
    for (const x of opp) if (x.pt === 'p') oppPawns.push(x);
    const pawnFiles = new Set(pawns.map(x => x.c));
    for (const p of pawns) {
      let val = 0;
      // 叠兵：同列有同色兵
      if (pawnFile[col][p.c] > 1) val -= 15;
      // 孤兵：相邻列无同色兵（且非叠兵——叠兵已单独罚）
      const adjHas = (p.c > 0 && pawnFiles.has(p.c - 1)) || (p.c < 7 && pawnFiles.has(p.c + 1));
      if (!adjHas && pawnFile[col][p.c] === 1) val -= 12;
      // 通路兵：同列与相邻列前方无敌兵阻挡
      let blocked = false;
      for (const q of oppPawns) {
        if (q.c === p.c) {
          if (col === 'w' ? q.r < p.r : q.r > p.r) { blocked = true; break; }
        } else if (Math.abs(q.c - p.c) === 1) {
          if (col === 'w' ? q.r <= p.r : q.r >= p.r) { blocked = true; break; }
        }
      }
      if (!blocked) {
        const adv = col === 'w' ? (7 - p.r) : p.r; // 推进距离 0~6
        val += 14 + adv * 8;
      }
      // 中心与扩展中心兵
      if (p.c === 3 || p.c === 4) val += 10;
      else if (p.c === 2 || p.c === 5) val += 5;
      // 推进鼓励（避免原地不动）
      const fwd = col === 'w' ? (6 - p.r) : (p.r - 1);
      if (fwd > 0 && fwd <= 4) val += 6;
      score += sign * val;
    }

    // 兵链：斜前方同色兵互相支撑（结构稳固，利于王侧/中心控制）
    for (const p of pawns) {
      const pr = col === 'w' ? p.r - 1 : p.r + 1;
      if (pr < 0 || pr > 7) continue;
      for (const q of pawns) {
        if (q.r === pr && Math.abs(q.c - p.c) === 1) { score += sign * 8; break; }
      }
    }

    // 被兵保护的棋子更安全（尤其马/象，残局也有效）
    for (const pc of me) {
      if (pc.pt === 'p' || pc.pt === 'k') continue;
      const pr = pc.r + (col === 'w' ? -1 : 1);
      if (pr < 0 || pr > 7) continue;
      for (const dc of [-1, 1]) {
        const cc = pc.c + dc;
        if (cc < 0 || cc > 7) continue;
        const q = board[pr][cc];
        if (q && q.toLowerCase() === 'p' && (q === q.toUpperCase()) === (col === 'w')) { score += sign * 5; break; }
      }
    }

    // 机动性 + 车开放线 + 王后早出（前中局才计，残局价值低/方向反转）
    if (!endgame) {
      for (const pc of me) {
        if (pc.pt === 'n') score += sign * mobilityCount(board, pc.r, pc.c, 'n', col) * 6;
        else if (pc.pt === 'b') score += sign * mobilityCount(board, pc.r, pc.c, 'b', col) * 5;
        else if (pc.pt === 'r') {
          const own = pawnFile[col][pc.c], oppn = pawnFile[oppCol][pc.c];
          if (own === 0 && oppn === 0) score += sign * 30;  // 开放线
          else if (own === 0) score += sign * 15;           // 半开放线
          // 第七横线：白车 r=1 / 黑车 r=6，压住敌底兵（残局同样强力）
          if ((col === 'w' && pc.r === 1) || (col === 'b' && pc.r === 6)) score += sign * 25;
        } else if (pc.pt === 'q') {
          // 中局王后过早出动惩罚（前 3 线且局面尚完整）
          const rank = col === 'w' ? pc.r : 7 - pc.r;
          if (rank < 3 && totalMat > 5000) score -= sign * 25;
        }
      }
    }

    // 王：残局中心化 / 中局王安全
    let k = null;
    for (const x of me) if (x.pt === 'k') { k = x; break; }
    if (!k) continue;
    if (endgame) {
      // 残局：王中心化（逼杀关键）
      const kv = col === 'w' ? PST_K_END[k.r][k.c] : PST_K_END[7 - k.r][k.c];
      score += sign * kv;
    } else {
      // 中局王安全：王侧三列兵墙完整 + 王前有子保护
      for (let f = Math.max(0, k.c - 1); f <= Math.min(7, k.c + 1); f++) {
        const home = col === 'w' ? 6 : 1;
        const shielded = pawns.some(x => x.c === f && (col === 'w' ? x.r >= home - 1 : x.r <= home + 1));
        if (shielded) score += sign * 12;
      }
      const fr = k.r + (col === 'w' ? -1 : 1);
      if (fr >= 0 && fr < 8 && board[fr][k.c]) score += sign * 8; // 王正前方有子
    }
  }
  return score;
}

/* ---------- 走法排序：MVV-LVA 吃子 + 升变 + 杀手着法 + 历史表 ----------
 * 排序质量决定 α-β 剪枝效率：好的排序能把同样的时间搜得更深。
 * 杀手着法(killer)：每层上次剪枝最有效的 2 个非吃子着法；
 * 历史表(history)：全局限累积的剪枝着法评分，按 棋子+目标格 记录。 */
const KILLER_SLOTS = 2;
let killers = new Array(64); // ply -> [moveA, moveB]（引用同一 move 对象）
for (let i = 0; i < 64; i++) killers[i] = [];
let history = new Map();     // 'piece|r|c' -> 分数

function histKey(m) { return m.piece + '|' + m.to[0] + '|' + m.to[1]; }

function scoreMove(m, ply) {
  if (m.captured) {
    // MVV-LVA：被吃子价值 - 吃子价值，越大越优先
    return 10000 + PIECE_VALUE[m.captured.toLowerCase()] - PIECE_VALUE[m.piece.toLowerCase()];
  }
  if (m.promotion) return 9000;
  if (ply !== undefined && ply >= 0 && ply < 64) {
    const ks = killers[ply];
    if (ks.length) {
      for (let i = 0; i < ks.length; i++) {
        if (ks[i] === m) return 8000 - i; // 第一杀手优先
      }
    }
  }
  const h = history.get(histKey(m));
  return h || 0;
}

function orderMoves(moves, ply) {
  const sc = new Array(moves.length);
  for (let i = 0; i < moves.length; i++) sc[i] = scoreMove(moves[i], ply);
  // 插入排序（走法数通常不多，且部分有序时更快，避免 slice+sort 的开销）
  for (let i = 1; i < moves.length; i++) {
    const mv = moves[i], sv = sc[i];
    let j = i - 1;
    while (j >= 0 && sc[j] < sv) { moves[j + 1] = moves[j]; sc[j + 1] = sc[j]; j--; }
    moves[j + 1] = mv; sc[j + 1] = sv;
  }
  return moves;
}

function recordKiller(ply, m) {
  if (ply < 0 || ply >= 64 || m.captured || m.promotion) return;
  const ks = killers[ply];
  if (ks[0] !== m) {
    if (ks[0]) ks[1] = ks[0];
    ks[0] = m;
  }
}

function recordHistory(m, depth) {
  const key = histKey(m);
  const add = depth * depth;
  const nv = (history.get(key) || 0) + add;
  history.set(key, nv);
  if (history.size > 200000 || nv > 1e9) { // 内存/溢出保护：超限整体衰减
    for (const [k, v] of history) history.set(k, v >> 2);
  }
}

/* 空着剪枝前置条件：己方至少 2 个重子（非兵非王）——王兵残局禁用 */
function okNull(board, color) {
  let cnt = 0;
  const isW = color === 'w';
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const pt = p.toLowerCase();
      if (pt === 'p' || pt === 'k') continue;
      if ((p === p.toUpperCase()) === isW && ++cnt >= 2) return true;
    }
  return false;
}

/* ---------- 置换表 ---------- */
const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
let tt = new Map();
let USE_TT = true;   // 测试时可关闭，验证一致性
let QUESC = true;    // 测试时可关闭静态搜索

function clearTT() { tt = new Map(); }
function setFlags(u, q) { USE_TT = u; QUESC = q; }
function ttSize() { return tt.size; }

/* 时间管理：模块级截止时间戳。>0 时 negamax 递归内部也会检查，
 * 超时即中断当前层（make/undo 成对，安全），保证总耗时贴近预算。 */
let searchDeadline = 0;
let searchInterrupted = false;
let searchStop = false;   // 外部取消标志（worker 收到 cancel 消息时置位，搜索提前返回）

function stopSearch() { searchStop = true; }
function resetSearch() { searchStop = false; searchInterrupted = false; }
function searchStopped() { return searchStop; }

/* ---------- 静态搜索（quiescence）：只扩展吃子/升变，避免水平线效应 ----------
 * 只对吃子伪走法做合法性过滤（make/undo + 王安全检查），不再生成全部合法走法，
 * 显著降低叶子节点开销；【被将军】时扩展全部合法走法逃生，不漏杀。 */
function quiescence(board, alpha, beta, color, castling, enPassant, qdepth) {
  const k = ch.king(board, color);
  const inCheck = k && ch.attacked(board, k[0], k[1], color === 'w' ? 'b' : 'w');
  if (!inCheck) {
    const stand = color === 'w' ? evaluate(board) : -evaluate(board);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
  }
  if (qdepth >= 8) return alpha;

  if (inCheck) {
    // 被将军：必须扩展全部合法走法（否则可能误判无解）
    const legal = ch.legalIn(board, color, castling, enPassant);
    if (!legal.length) return -(ch.mate - qdepth); // 将死
    orderMoves(legal, 0);
    for (const m of legal) {
      ch.moveIn(board, m);
      const childColor = color === 'w' ? 'b' : 'w';
      const nCast = ch.castle(castling, m);
      const nEp = m.double ? ch.sq(m.from[0] + (color === 'w' ? -1 : 1), m.from[1]) : null;
      const val = -quiescence(board, -beta, -alpha, childColor, nCast, nEp, qdepth + 1);
      ch.undo(board, m);
      if (val >= beta) return beta;
      if (val > alpha) alpha = val;
    }
    return alpha;
  }

  const pseudo = ch.pseudo(board, color, castling, enPassant);
  const caps = [];
  for (const m of pseudo) {
    if (!(m.captured || m.enpassant || m.promotion)) continue;
    ch.moveIn(board, m);
    const k2 = ch.king(board, color);
    const legal = k2 && !ch.attacked(board, k2[0], k2[1], color === 'w' ? 'b' : 'w');
    ch.undo(board, m);
    if (legal) caps.push(m);
  }
  if (!caps.length) return alpha;
  orderMoves(caps, 0);

  for (const m of caps) {
    ch.moveIn(board, m);
    const childColor = color === 'w' ? 'b' : 'w';
    const nCast = ch.castle(castling, m);
    const nEp = m.double ? ch.sq(m.from[0] + (color === 'w' ? -1 : 1), m.from[1]) : null;
    const val = -quiescence(board, -beta, -alpha, childColor, nCast, nEp, qdepth + 1);
    ch.undo(board, m);
    if (val >= beta) return beta;
    if (val > alpha) alpha = val;
  }
  return alpha;
}

/* ---------- 主搜索：negamax + α-β + 置换表 + 空着剪枝（棋盘原地走/撤，零克隆） ---------- */
function negamax(board, depth, alpha, beta, color, castling, enPassant, ply, noStore) {
  const key = USE_TT ? ch.key(board, color, castling, enPassant) : null;
  if (USE_TT && !noStore) {
    const ent = tt.get(key);
    if (ent && ent.depth >= depth && depth > 0) {
      if (ent.flag === TT_EXACT) return ent.score;
      if (ent.flag === TT_LOWER && ent.score >= beta) return ent.score;
      if (ent.flag === TT_UPPER && ent.score <= alpha) return ent.score;
    }
  }

  const legal = ch.legalIn(board, color, castling, enPassant);
  if (legal.length === 0) {
    // 将死 / 逼和（值依赖 ply，不存表，避免污染）
    const k = ch.king(board, color);
    const inChk = k && ch.attacked(board, k[0], k[1], color === 'w' ? 'b' : 'w');
    return inChk ? -(ch.mate - ply) : 0;
  }
  if (depth <= 0) {
    // 叶子：静态搜索（受 alpha/beta 截断影响，不存表）
    return QUESC ? quiescence(board, alpha, beta, color, castling, enPassant, 0)
                 : (color === 'w' ? evaluate(board) : -evaluate(board));
  }

  // 空着剪枝（null move）：非将军 + 子力充足 + 深度足够 + 窗口有限时，
  // 假设对方连走两步仍赢不了 → 本局面也赢不了，直接剪枝（大幅提速）。
  // 注意：beta 必须有限——否则 null-window (-beta, -beta+1) 会变成 (-Inf, -Inf) 无效窗口。
  // fail-hard 返回 beta（边界值），避免 fail-soft 浮动下界污染父节点分数比较。
  if (depth >= 3 && !noStore && QUESC && beta < ch.mate) {
    const kk = ch.king(board, color);
    const inCheck = kk && ch.attacked(board, kk[0], kk[1], color === 'w' ? 'b' : 'w');
    if (!inCheck && okNull(board, color)) {
      const childColor = color === 'w' ? 'b' : 'w';
      const nullVal = -negamax(board, depth - 3, -beta, -beta + 1, childColor, castling, enPassant, ply + 1, true);
      if (nullVal >= beta) return beta;
    }
  }

  let best = -Infinity;
  const origAlpha = alpha;
  const moves = orderMoves(legal, ply);
  for (const m of moves) {
    if (searchStop || (searchDeadline && Date.now() > searchDeadline)) { searchInterrupted = true; break; }
    ch.moveIn(board, m);
    const childColor = color === 'w' ? 'b' : 'w';
    const nCast = ch.castle(castling, m);
    const nEp = m.double ? ch.sq(m.from[0] + (color === 'w' ? -1 : 1), m.from[1]) : null;
    const val = -negamax(board, depth - 1, -beta, -alpha, childColor, nCast, nEp, ply + 1);
    ch.undo(board, m);
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) {
      recordKiller(ply, m);
      recordHistory(m, depth);
      break; // 剪枝（该走法已在上方撤销）
    }
  }

  if (USE_TT && !noStore) {
    let flag;
    if (best <= origAlpha) flag = TT_UPPER;
    else if (best >= beta) flag = TT_LOWER;
    else flag = TT_EXACT;
    tt.set(key, { depth, score: best, flag });
    if (tt.size > 300000) clearTT(); // 内存保护
  }
  return best;
}

/* 选择最佳着法
 * board/castling/enPassant 为当前局面（轮到 color 走）
 * depth: 搜索深度；randomness: 0~1，越高越随机（用于难度）
 * recentKeys: { 局面key: 出现次数 }，用于避免造成三次重复
 * timeLimit: 毫秒。>0 时用迭代加深在时间预算内尽力加深（depth 为上限）
 * onProgress: 可选回调 (depth, maxDepth)，迭代加深每完成一层调用（进度显示用）
 * 返回 { move, score }
 */
/* ---------- 残局库：必胜残局的规则走法 ----------
 * 检测 KQK / KRK / KPK(有兵方) 等经典必胜残局,用规则替代深搜——
 * 深搜在子力稀少的残局经常"赢棋走丢",规则引擎能稳定赢下。
 *  - KQK/KRK:贪心"限制对方王活动空间 + 己方王逼近" → 逼到边线线性将杀
 *  - KPK:兵安全推进优先,王贴近引导;会被对方王吃的兵着法重罚 */
function endgameBook(board, color, castling, enPassant) {
  const me = color, opp = color === 'w' ? 'b' : 'w';
  const myK = ch.king(board, me), oppK = ch.king(board, opp);
  if (!myK || !oppK) return null;
  let myQ = null, myR = null, myP = null, oppCount = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board[r][c];
    if (!p) continue;
    const pt = p.toLowerCase();
    const isMine = (p === p.toUpperCase()) === (me === 'w');
    if (isMine) {
      if (pt === 'q') myQ = [r, c];
      else if (pt === 'r') myR = [r, c];
      else if (pt === 'p') myP = [r, c];
    } else oppCount++;
  }
  if (oppCount !== 1) return null; // 只处理对方只剩王的纯残局
  const legal = ch.legalIn(board, me, castling, enPassant);
  if (!legal.length) return null;

  if (myQ && !myR && !myP) return finishKXK(board, me, opp, legal, castling, enPassant);
  if (myR && !myQ && !myP) return finishKXK(board, me, opp, legal, castling, enPassant);
  if (myP && !myQ && !myR) return kpkMove(board, me, opp, myP, legal, castling, enPassant);
  return null;
}

/* KQK/KRK:王逼近阶段用贪心;己方王贴身(kd≤2)后,贪心的最后一步
 * 配合经常绕圈(黑王能吃到无保护的大子、将杀线需精确),切深搜找将杀。 */
function finishKXK(board, me, opp, legal, castling, enPassant) {
  const myK = ch.king(board, me), oppK = ch.king(board, opp);
  const kd = Math.max(Math.abs(myK[0] - oppK[0]), Math.abs(myK[1] - oppK[1]));
  if (kd > 2) return shrinkKing(board, me, opp, legal, castling, enPassant);
  let best = null, bestScore = -Infinity;
  for (const m of legal) {
    ch.moveIn(board, m);
    const childColor = me === 'w' ? 'b' : 'w';
    const nCast = ch.castle(castling, m);
    const nEp = m.double ? ch.sq(m.from[0] + (me === 'w' ? -1 : 1), m.from[1]) : null;
    let val;
    try { val = -negamax(board, 4, -Infinity, Infinity, childColor, nCast, nEp, 1, true); }
    catch (e) { val = -Infinity; }
    ch.undo(board, m);
    if (val > bestScore) { bestScore = val; best = m; }
  }
  return best || shrinkKing(board, me, opp, legal, castling, enPassant);
}

/* 贪心打分:每步走完对方王合法着法越少越好;大子(后/车)绝不送吃
 * (目标格在对方王 8 邻 → 重罚);己方王按距离梯度逼近(kd 越小越优先,
 * 且压过将军拉锯);将杀绝对优先、逼和重罚;大子正被对方王威胁时先救。 */
function shrinkKing(board, me, opp, legal, castling, enPassant) {
  const oppK = ch.king(board, opp);
  const inDanger = new Set();
  for (const m of legal) {
    const p = board[m.from[0]][m.from[1]];
    const pt = p.toLowerCase();
    if ((pt === 'q' || pt === 'r') && Math.abs(oppK[0] - m.from[0]) <= 1 && Math.abs(oppK[1] - m.from[1]) <= 1) {
      inDanger.add(m.from[0] * 8 + m.from[1]);
    }
  }
  let best = null, bestScore = Infinity;
  for (const m of legal) {
    ch.moveIn(board, m);
    const nk = ch.king(board, opp);
    if (!nk) { ch.undo(board, m); continue; } // 防御:吃王着法不应出现
    const oppLegal = ch.legalIn(board, opp, castling, enPassant);
    let s = oppLegal.length * 4;
    const t = m.to;
    if (Math.abs(nk[0] - t[0]) <= 1 && Math.abs(nk[1] - t[1]) <= 1) s += 400;
    if (oppLegal.length === 0) {
      if (ch.attacked(board, nk[0], nk[1], me)) s -= 200; // 将杀!绝对优先
      else s += 1000;                                     // 逼和重罚
    } else if (ch.attacked(board, nk[0], nk[1], me)) {
      s -= 30;                                            // 将军推进
    }
    if (m.piece.toLowerCase() === 'k') {
      const myK = ch.king(board, me);
      const kd = Math.max(Math.abs(myK[0] - nk[0]), Math.abs(myK[1] - nk[1]));
      if (kd > 1) s -= 45 - kd * 2; // 逼近导向:kd 越小越优,恒压过将军(-30)
      else s -= 5;                  // 已贴身:配合大子限制/将军
    }
    if (inDanger.has(m.from[0] * 8 + m.from[1])) s -= 60; // 大子被威胁 → 先救
    ch.undo(board, m);
    if (s < bestScore) { bestScore = s; best = m; }
  }
  return best;
}

/* 王兵残局:兵能安全推进就推进(升变最优先);兵被对方王堵住/威胁时,
 * 切深搜引导王逼退对方王(纯规则在关键格对弈时容易绕圈)。 */
function kpkMove(board, me, opp, myP, legal, castling, enPassant) {
  const oppK = ch.king(board, opp);
  const adv = me === 'w' ? -1 : 1;
  const pawnMoves = legal.filter(m => m.piece.toLowerCase() === 'p');
  const safePawn = pawnMoves.filter(m => {
    const t = m.to;
    return !(Math.abs(oppK[0] - t[0]) <= 1 && Math.abs(oppK[1] - t[1]) <= 1);
  });
  if (safePawn.length) {
    for (const m of safePawn) if (m.promotion) return m; // 升变最优先
    for (const m of safePawn) if (m.to[0] === myP[0] + adv) return m; // 单步推进
    return safePawn[0];
  }
  // 兵被堵/有危险:深搜选最佳(王引导逼退,评估含王中心化/兵推进)
  let best = null, bestScore = -Infinity;
  for (const m of legal) {
    ch.moveIn(board, m);
    const childColor = me === 'w' ? 'b' : 'w';
    const nCast = ch.castle(castling, m);
    const nEp = m.double ? ch.sq(m.from[0] + (me === 'w' ? -1 : 1), m.from[1]) : null;
    let val;
    try { val = -negamax(board, 4, -Infinity, Infinity, childColor, nCast, nEp, 1, true); }
    catch (e) { val = -Infinity; }
    ch.undo(board, m);
    if (val > bestScore) { bestScore = val; best = m; }
  }
  return best;
}

function chooseMove(board, color, depth, castling, enPassant, randomness, recentKeys, timeLimit, onProgress) {
  randomness = randomness || 0;
  recentKeys = recentKeys || null;
  timeLimit = timeLimit || 0;
  const legal0 = ch.legalIn(board, color, castling, enPassant);
  if (legal0.length === 0) return null;

  // 残局库：必胜残局用规则走法（不受难度/随机影响，稳定赢下）
  const eb = endgameBook(board, color, castling, enPassant);
  if (eb) return { move: eb, score: 0 };


  // 某着法走完后的局面 key（用于判断是否会造成重复）；原地走/撤求键
  const keyOf = m => {
    const childColor = color === 'w' ? 'b' : 'w';
    ch.moveIn(board, m);
    const k = ch.key(board, childColor, ch.castle(castling, m),
      m.double ? ch.sq(m.from[0] + (color === 'w' ? -1 : 1), m.from[1]) : null);
    ch.undo(board, m);
    return k;
  };
  const repCount = m => (recentKeys ? (recentKeys[keyOf(m)] || 0) : 0);

  // 低段位 AI：仍可能随手走一步（但尽量避开会造成重复局面的着法）
  if (randomness >= 0.85 && Math.random() < 0.6) {
    let pool = legal0;
    if (recentKeys) {
      const nr = legal0.filter(m => repCount(m) < 2);
      if (nr.length) pool = nr;
    }
    return { move: pool[Math.floor(Math.random() * pool.length)], score: 0 };
  }

  // 重复惩罚：1 次就大幅扣分（打破 2-循环 A→B→A→B），≥2 次几乎绝对禁止（避免三次重复）
  const REP1 = 500000;
  const REP2 = 1e9;

  // 单层搜索：d 为搜索深度，pvMove 为上层迭代的最佳着法（提到最前加速剪枝）
  // 采用 PVS：首个着法全窗口精确搜索，后续着法 null-window 快速验证，
  // 验证失败（>alpha）才全窗口重搜——避免把 α-β 边界值当成精确分导致选错着法。
  // 时间管理：模块级 searchDeadline 生效时层内超时即中断（用已搜索着法中的最佳）
  function searchLayer(d, pvMove) {
    let legal = orderMoves(legal0, 0);
    if (pvMove) {
      const idx = legal.indexOf(pvMove);
      if (idx > 0) { legal.splice(idx, 1); legal.unshift(pvMove); }
    }
    let best = -Infinity;
    let bestMoves = [];
    let alpha = -Infinity;
    let first = true;
    for (const m of legal) {
      if (searchStop || (searchDeadline && Date.now() > searchDeadline)) { searchInterrupted = true; break; }
      ch.moveIn(board, m);
      const childColor = color === 'w' ? 'b' : 'w';
      const nCast = ch.castle(castling, m);
      const nEp = m.double ? ch.sq(m.from[0] + (color === 'w' ? -1 : 1), m.from[1]) : null;
      let val, exact = false;
      if (first) {
        val = -negamax(board, d - 1, -Infinity, Infinity, childColor, nCast, nEp, 1);
        exact = true;
        first = false;
      } else {
        // null-window 验证：该着法分数是否超过当前 alpha？
        val = -negamax(board, d - 1, -alpha - 1, -alpha, childColor, nCast, nEp, 1);
        if (val > alpha) {
          // 验证失败（可能更好）→ 全窗口重搜取精确值
          val = -negamax(board, d - 1, -Infinity, -alpha - 1, childColor, nCast, nEp, 1);
          exact = true;
        }
      }
      ch.undo(board, m);
      const cnt = repCount(m);
      const adjusted = cnt >= 2 ? val - REP2 : (cnt >= 1 ? val - REP1 : val);
      // 只有精确值才参与同分收集；null-window 验证通过的边界值一律不更新
      if (adjusted > best) { best = adjusted; bestMoves = [m]; }
      else if (exact && adjusted === best) bestMoves.push(m);
      if (adjusted > alpha) alpha = adjusted;
    }
    let move;
    if (bestMoves.length === 0) {
      // 层内超时且还没搜到任何着法：退回上一层结果（迭代加深已保证存在）
      move = pvMove || legal0[Math.floor(Math.random() * legal0.length)];
    } else if (recentKeys && legal0.every(m => repCount(m) >= 2)) {
      // 所有着法都会造成重复（极罕见）：被迫挑重复次数最少的一步，避免立刻第三次重复
      move = legal0.slice().sort((a, b) => repCount(a) - repCount(b))[0];
    } else {
      move = bestMoves[Math.floor(Math.random() * bestMoves.length)];
    }
    return { move, score: best };
  }

  // 迭代加深：从 1 逐层加深到目标深度，用上一层最佳着法引导下一层搜索（更准且不更慢）。
  // 时间管理：模块级 searchDeadline 全局生效——任何一层/节点超时即中断，
  // 中断层结果丢弃，保留最后完整层；总耗时严格贴近预算。
  killers = new Array(64);
  for (let i = 0; i < 64; i++) killers[i] = [];
  history = new Map();
  const start = Date.now();
  const savedDeadline = searchDeadline;
  searchDeadline = timeLimit ? start + timeLimit : 0;
  searchInterrupted = false;
  let pvMove = null;
  let result = null;
  let lastFull = null;
  const maxD = Math.max(1, depth);
  for (let d = 1; d <= maxD; d++) {
    // 前 2 层必须完整跑（保证基础强度）；之后若预算所剩无几则不再开新层
    if (timeLimit && d > 2 && Date.now() - start > timeLimit * 0.8) break;
    searchInterrupted = false;
    result = searchLayer(d, pvMove);
    if (onProgress) onProgress(d, maxD);
    if (searchInterrupted || searchStop) break; // 超时中断 / 外部取消 → 丢弃本层，保留上一层结果
    lastFull = result;
    pvMove = result.move;
  }
  searchDeadline = savedDeadline;
  return lastFull || result;
}

// 难度滑条 1–10：数值越大越强（搜索越深/时间预算越多、随机失误越少）
// 8 档起进入时间管理模式：迭代加深在预算内尽力加深（上限 maxDepth），
// 配合杀手着法/历史表/空着剪枝，10 档实战强度远超旧版深度 4。
const DIFF_LEVEL_NAME = ['', '入门', '新手', '初级', '进阶', '普通', '熟练', '好手', '强手', '专家', '大师'];
function diffConfig(level) {
  level = Math.max(1, Math.min(10, Math.round(level || 5)));
  let depth, timeLimit;
  // 深度每两档上一级(1→2 也有深度差),同深度档用随机失误率拉开;
  // 9/10 档进入时间管理模式:迭代加深在预算内尽力加深(上限 depth)
  if (level === 1) { depth = 1; }
  else if (level <= 3) { depth = 2; }      // 2,3
  else if (level <= 5) { depth = 3; }      // 4,5
  else if (level <= 7) { depth = 4; }      // 6,7
  else if (level === 8) { depth = 5; }
  else if (level === 9) { timeLimit = 1500; depth = 5; }
  else { timeLimit = 2500; depth = 6; }
  const randomness = Math.max(0, Math.round((1.05 - level * 0.105) * 100) / 100); // 1→0.95 … 10→0
  return { depth, timeLimit, randomness, label: DIFF_LEVEL_NAME[level] };
}

/* ---------- 开局库：主流开局的前几手，AI 开局不再乱走 ---------- */
const OPENINGS = [
  // 开放性
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],                        // 西班牙开局
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'],                        // 意大利开局
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'],                 // 双马防御/意大利主线
  ['e4', 'e5', 'Nf3', 'Nc6', 'd4'],                         // 苏格兰开局
  ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3'],                        // 四马开局
  ['e4', 'e5', 'f4'],                                       // 王翼弃兵
  ['e4', 'e5', 'Nf3', 'Nf6'],                               // 俄罗斯防御
  // 半开放性
  ['e4', 'c5'],                                             // 西西里防御
  ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6'],   // 西西里·龙式
  ['e4', 'e6'],                                             // 法国防御
  ['e4', 'e6', 'd4', 'd5', 'e5'],                           // 法国·前进变例
  ['e4', 'c6'],                                             // 卡罗康防御
  ['e4', 'd5', 'exd5', 'Qxd5'],                             // 斯堪的纳维亚
  ['e4', 'Nf6'],                                            // 阿廖欣防御
  ['e4', 'g6'],                                             // 现代防御
  // 封闭性
  ['d4', 'd5'],                                             // 后兵开局
  ['d4', 'd5', 'c4'],                                       // 后翼弃兵
  ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5'],            // 正统防御
  ['d4', 'Nf6', 'c4', 'e6'],                                // 印度防御
  ['d4', 'Nf6', 'c4', 'g6'],                                // 王翼印度
  ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'],                  // 尼姆佐维奇防御
  ['d4', 'f5'],                                             // 荷兰防御
  // 侧翼
  ['c4'],                                                   // 英国式
  ['Nf3', 'd5', 'g3'],                                      // 列蒂开局
  ['g3'],                                                   // 王翼侧翼

  // 第二期扩展：主流开局的延伸主线（10 半手以内，bookMove 只覆盖前 10 手）
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7'],     // 西班牙·主线
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4'],     // 意大利·中心冲兵
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Bc5', 'c3', 'd6'],       // 意大利·乔科皮亚诺
  ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6', 'Bb5', 'Bb4', 'O-O', 'O-O'],    // 四马·对称
  ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nc3', 'Bb4'],   // 苏格兰·四马
  ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'],     // 西西里·纳道尔夫
  ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'e6'],     // 西西里·舍维宁根
  ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'e5'],    // 西西里·斯维什尼科夫
  ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Bb4', 'e5', 'c5', 'a3', 'Bxc3+'],       // 法兰西·维纳威尔
  ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6', 'e5', 'Nfd7', 'f4', 'c5'],        // 法兰西·斯捷潘
  ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5', 'Ng3', 'Bg6'],    // 卡罗康·主线
  ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'd4', 'Nf6', 'Nf3', 'c6'],    // 斯堪的纳维亚·主线
  ['e4', 'Nf6', 'e5', 'Nd5', 'd4', 'd6', 'Nf3', 'dxe5', 'Nxe5', 'Nc6'],    // 阿廖欣·四兵
  ['e4', 'g6', 'd4', 'Bg7', 'Nc3', 'd6', 'Nf3', 'Nf6', 'Be2', 'O-O'],      // 现代防御·主线
  ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'e6'],                     // 后翼弃兵·斯拉夫
  ['d4', 'd5', 'c4', 'dxc4', 'Nf3', 'Nf6', 'e3', 'e6', 'Bxc4', 'c5'],      // 后翼弃兵·接受
  ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O'],       // 王翼印度·古典
  ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O', 'Bd3', 'd5'],       // 尼姆佐维奇·主线
  ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6', 'g3', 'Bb7', 'Bg2', 'Be7'],       // 新印度·卡塔兰倾向
  ['d4', 'f5', 'g3', 'Nf6', 'Bg2', 'e6', 'Nf3', 'Be7', 'O-O', 'O-O'],      // 荷兰·列蒂式
  ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3', 'c5', 'c3', 'Nc6'],        // 伦敦体系
  ['d4', 'Nf6', 'Bf4', 'd5', 'e3', 'e6', 'Nf3', 'c5', 'c3', 'Nc6'],        // 伦敦体系·印度式
  ['c4', 'e5', 'Nc3', 'Nf6', 'Nf3', 'Nc6', 'g3', 'd5', 'cxd5', 'Nxd5'],    // 英国·四马对称
  ['c4', 'c5', 'Nf3', 'Nf6', 'd4', 'cxd4', 'Nxd4', 'e6', 'Nc3', 'Bb4'],    // 英国·对称变例
  ['e4', 'e5', 'f4', 'exf4', 'Nf3', 'g5', 'h4', 'g4', 'Ne5', 'Nf6'],       // 王翼弃兵·主变
  ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5', 'd6', 'Nf3', 'Nxe4', 'd4', 'd5'],     // 俄罗斯·主线
  ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O'],       // 正统防御·常规
  ['f4'],                                                   // 伯德开局
  ['b3'],                                                   // 尼姆佐维奇·拉尔森
  ['Nc3'],                                                  // 邓斯特开局
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    chooseMove, evaluate, negamax, quiescence, orderMoves,
    diffConfig, DIFF_LEVEL_NAME, PIECE_VALUE, OPENINGS,
    clearTT, setFlags, ttSize, endgameBook,
    stopSearch, resetSearch, searchStopped
  };
}
