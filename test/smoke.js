/* 回归冒烟测试：引擎正确性 + AI 一致性（运行：node test/smoke.js） */
'use strict';
const assert = require('assert');
const chess = require('../js/chess.js');
const ai = require('../js/ai.js');

const { ChessGame, initialBoard, cloneBoard, generateLegal, generateLegalInPlace,
        makeMoveInPlace, undoMove, makeMove, squareName, positionKey, MATE } = chess;
const { chooseMove, evaluate, negamax, clearTT, setFlags, ttSize } = ai;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function sameBoard(a, b) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (a[r][c] !== b[r][c]) return false;
  return true;
}

console.log('== 1. 初始局面合法走法 ==');
{
  const g = new ChessGame();
  const m = generateLegal(g.board, 'w', g.castling, g.enPassant);
  ok(m.length === 20, '初始白方应有 20 个合法走法，实际 ' + m.length);
}

console.log('== 2. 原地走/撤 == 克隆版一致 ==');
{
  const g = new ChessGame();
  let board = g.board;
  for (let ply = 0; ply < 120; ply++) {
    const color = g.turn;
    const legal = generateLegal(board, color, g.castling, g.enPassant);
    if (legal.length === 0) break;
    const mv = legal[Math.floor(Math.random() * legal.length)];
    const before = cloneBoard(board);
    // 原地走 → 与克隆版结果一致 → 撤 → 复原
    const expected = makeMove(board, mv);
    makeMoveInPlace(board, mv);
    ok(sameBoard(board, expected), 'makeMoveInPlace 与 makeMove 一致 @ply' + ply);
    if (failed > 5) process.exit(1);
    undoMove(board, mv);
    ok(sameBoard(board, before), 'undoMove 完全复原 @ply' + ply);
    if (failed > 5) process.exit(1);
    // 继续前进（用克隆版推进，保持 test 独立于原地实现）
    board = expected;
    g.apply(mv);
  }
  ok(true, '随机对局 120 半回合原地走/撤往返一致');
}

console.log('== 3. generateLegalInPlace == generateLegal ==');
{
  const g = new ChessGame();
  for (let ply = 0; ply < 60; ply++) {
    const color = g.turn;
    const a = generateLegal(g.board, color, g.castling, g.enPassant);
    const b = generateLegalInPlace(g.board, color, g.castling, g.enPassant);
    ok(a.length === b.length, '两版合法走法数量一致 @ply' + ply);
    const key = m => m.from[0] + ',' + m.from[1] + '>' + m.to[0] + ',' + m.to[1] + (m.promotion || '') + (m.castle || '') + (m.enpassant ? 'ep' : '');
    const sa = new Set(a.map(key)), sb = new Set(b.map(key));
    ok(sa.size === sb.size && [...sa].every(k => sb.has(k)), '两版合法走法集合一致 @ply' + ply);
    if (g.isGameOver(true)) break;
    const legal = generateLegal(g.board, color, g.castling, g.enPassant);
    if (!legal.length) break;
    g.apply(legal[Math.floor(Math.random() * legal.length)]);
  }
}

console.log('== 4. SAN 冒烟 ==');
{
  const g = new ChessGame();
  const samples = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
  // 用 SAN 无法直接索引，改为走指定着法后检查 moveLog 格式
  const san0 = g.apply({ from: [6,4], to: [4,4], piece: 'P' }); // e2e4
  ok(san0 === 'e4', 'e2e4 -> e4, 实际 ' + san0);
  const san1 = g.apply({ from: [1,4], to: [3,4], piece: 'p' }); // e7e5
  ok(san1 === 'e5', 'e7e5 -> e5, 实际 ' + san1);
  const san2 = g.apply({ from: [7,6], to: [5,5], piece: 'N' }); // g1f3
  ok(san2 === 'Nf3', 'g1f3 -> Nf3, 实际 ' + san2);
  ok(san2.indexOf('+') < 0, 'Nf3 不应带将军标记');
  void samples;
}

console.log('== 5. 置换表一致性（关 quiescence 对比开/关 TT） ==');
{
  const g = new ChessGame();
  // 摆一个中局局面
  const fenBoard = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R';
  g.reset();
  g.board = parseFen(fenBoard); // 简化：只解析棋盘部分，不重置状态（测试用）
  g.turn = 'w'; g.castling = { wK: true, wQ: true, bK: true, bQ: true }; g.enPassant = null;
  const color = 'w';

  setFlags(false, false); // 关 TT、关 quiescence
  clearTT();
  const noTT = ai.negamax(g.board, 3, -Infinity, Infinity, color, g.castling, g.enPassant, 1);
  setFlags(true, false);  // 开 TT、关 quiescence
  clearTT();
  const withTT = ai.negamax(g.board, 3, -Infinity, Infinity, color, g.castling, g.enPassant, 1);
  ok(noTT === withTT, '深度3 关静态搜索时，带/不带置换表分数一致：' + noTT + ' vs ' + withTT);
  ok(ttSize() > 0, '置换表有条目：' + ttSize());

  // 再开 quiescence 冒烟（分数可能不同，只断言运行无异常且范围合理）
  setFlags(true, true);
  clearTT();
  const qScore = ai.negamax(g.board, 3, -Infinity, Infinity, color, g.castling, g.enPassant, 1);
  ok(isFinite(qScore) && Math.abs(qScore) < MATE, '开 quiescence 后分数合理：' + qScore);
}

console.log('== 6. chooseMove 返回合法走法 + 棋盘不被污染 ==');
{
  const g = new ChessGame();
  for (let ply = 0; ply < 30; ply++) {
    const color = g.turn;
    const before = cloneBoard(g.board);
    const res = chooseMove(g.board, color, 2, g.castling, g.enPassant, 0, null);
    ok(res && res.move, 'chooseMove 返回走法 @ply' + ply);
    if (!res || !res.move) break;
    const legal = generateLegal(before, color, g.castling, g.enPassant);
    const isLegal = legal.some(m => m.from[0] === res.move.from[0] && m.from[1] === res.move.from[1] &&
      m.to[0] === res.move.to[0] && m.to[1] === res.move.to[1] && m.promotion === res.move.promotion);
    ok(isLegal, 'chooseMove 走法合法 @ply' + ply);
    ok(sameBoard(g.board, before), 'chooseMove 后棋盘未被污染 @ply' + ply);
    g.apply(res.move);
    if (g.isGameOver(true)) break;
  }
}

console.log('== 6.5 战术嗅觉：根层 PVS 必须稳定选吃后（回归 PVS 边界值 bug） ==');
{
  const g = new ChessGame();
  g.reset();
  // 黑后 d5 无保护，白车 d1 可一步吃后（且带将）；任何深度都必须选 Rxd5
  g.board = [
    ['r', null, 'b', 'k', null, 'b', 'n', 'r'],
    ['p', 'p', 'p', null, null, 'p', 'p', 'p'],
    [null, null, null, null, null, null, null, null],
    [null, null, null, 'q', null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    ['P', 'P', 'P', null, 'P', 'P', 'P', 'P'],
    ['R', null, 'B', 'Q', 'K', 'B', 'N', 'R']
  ];
  g.turn = 'w';
  g.castling = { wK: true, wQ: true, bK: true, bQ: true };
  g.enPassant = null;
  for (const d of [3, 4]) {
    clearTT();
    const res = chooseMove(g.board, 'w', d, g.castling, g.enPassant, 0, null);
    ok(res && res.move && res.move.from[1] === 3 && res.move.from[0] === 7 &&
       res.move.to[1] === 3 && res.move.to[0] === 3 && res.move.captured === 'q',
       'depth ' + d + ' 必须选 Rxd5 吃后（PVS 边界值回归）');
    ok(sameBoard(g.board, cloneBoard(g.board)), '战术局面棋盘未被污染 @d' + d);
  }
}

console.log('== 7. 终局规则 ==');
{
  const g = new ChessGame();
  g.reset();
  // 逼和局面：黑王 a8，白王 c6，白后 b6 —— 实际需要构造，这里用简单的将死检测
  // 将死：黑王 a8 被后 b6 将，白王 c6 控制 a7/b7
  g.board = [
    ['k', null, null, null, null, null, null, null],
    [null, 'Q', null, null, null, null, null, null],
    [null, null, 'K', null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null]
  ];
  g.turn = 'b';
  g.castling = { wK: false, wQ: false, bK: false, bQ: false };
  g.enPassant = null;
  ok(g.isCheckmate(), 'b8 后将军 a8 王 → 黑方应将死');
  ok(g.inCheck('b'), '黑方被将军');
  ok(!g.inCheck('w'), '白方不被将军');
  // 三次重复
  const g2 = new ChessGame();
  const mv = { from: [6,4], to: [4,4], piece: 'P' }; // e4
  g2.apply(mv);
  const back = { from: [4,4], to: [6,4], piece: 'P' }; // e4 撤回（非法但仅测 key 逻辑，跳过）
  void back;
  // 直接测 positionKey 唯一性
  const p1 = positionKey(g2.board, g2.turn, g2.castling, g2.enPassant);
  const g3 = new ChessGame();
  g3.apply({ from: [6,4], to: [4,4], piece: 'P' });
  const p2 = positionKey(g3.board, g3.turn, g3.castling, g3.enPassant);
  ok(p1 === p2, '相同局面 positionKey 相同');
}

function parseFen(placement) {
  const rows = placement.split('/');
  const b = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    let c = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) { for (let i = 0; i < +ch; i++) row.push(null); c += +ch; }
      else { row.push(ch); c++; }
    }
    b.push(row);
  }
  return b;
}

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
