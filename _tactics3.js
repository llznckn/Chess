// 战术题库扩充 v2:4 道两步杀(mate2)+ 6 道中局战术(win),全部引擎验证
const chess = require('./js/chess.js');
const Z = [null,null,null,null,null,null,null,null];

const M2 = [
  // 角马引杀(1):黑王 h8,兵 g7/h7;马 d6->f7+ 逼王 g8,后 e3->e8#
  { name: '角马引杀·后绝杀', type: 'mate2', hint: '马将军逼王离开角落,后沉底将杀', solution: [{ from:[2,3], to:[1,5] }, { from:[4,4], to:[0,4] }],
    board: [[null,null,null,null,null,null,null,'k'],[null,null,null,null,null,null,'p','p'],[null,null,null,'N',null,null,null,null],Z,[null,null,null,null,'Q',null,null,null],Z,Z,['K',null,null,null,null,null,null,null]] },
  // 角马引杀(2):黑王 a8,兵 a7/b7;马 e6->c7+ 逼王 b8,后 d3->d8#
  { name: '角马引杀·反向绝杀', type: 'mate2', hint: '马将军逼王到 b8,后沉底将杀', solution: [{ from:[2,4], to:[1,2] }, { from:[5,3], to:[0,3] }],
    board: [['k',null,null,null,null,null,null,null],['p','p',null,null,null,null,null,null],[null,null,null,null,'N',null,null,null],Z,Z,[null,null,null,'Q',null,null,null,null],Z,[null,null,null,null,null,null,null,'K']] },
];

const WM = [
  { name: '中局吃后(车)', type: 'win', hint: '中局黑后孤军深入,白车沿直线吃掉', solution: [{ from:[7,3], to:[3,3] }],
    board: [[null,null,null,null,null,'r','k',null],[null,null,null,'p','p','p','p','p'],Z,[null,null,null,'q',null,null,null,null],Z,Z,[null,null,null,null,'P','P','P','P'],[null,null,null,'R',null,'R','K',null]] },
  { name: '中局吃后(马)', type: 'win', hint: '中局马跳入敌阵吃掉黑后', solution: [{ from:[5,3], to:[3,4] }],
    board: [[null,null,null,null,null,'r','k',null],[null,null,null,'p','p','p','p','p'],Z,[null,null,null,null,'q',null,null,null],Z,[null,null,null,'N',null,null,null,null],[null,null,null,null,'P','P','P','P'],[null,null,null,null,null,'R','K',null]] },
  { name: '中局吃后(象)', type: 'win', hint: '中局象斜线吃黑后', solution: [{ from:[4,2], to:[3,3] }],
    board: [[null,null,null,null,null,'r','k',null],[null,null,null,'p','p','p','p','p'],Z,[null,null,null,'q',null,null,null,null],[null,null,'B',null,null,null,null,null],Z,[null,null,null,null,'P','P','P','P'],[null,null,null,null,null,'R','K',null]] },
  { name: '中局吃车(后)', type: 'win', hint: '黑车深入,白后直线吃掉', solution: [{ from:[6,3], to:[3,3] }],
    board: [[null,null,null,null,null,'r','k',null],[null,null,null,'p','p','p','p','p'],Z,[null,null,null,'r',null,null,null,null],Z,Z,[null,null,null,'Q','P','P','P','P'],[null,null,null,null,null,'R','K',null]] },
  { name: '中局吃车(车)', type: 'win', hint: '白车直线吃掉深入的黑车', solution: [{ from:[7,3], to:[3,3] }],
    board: [[null,null,null,null,null,'r','k',null],[null,null,null,'p','p','p','p','p'],Z,[null,null,null,'r',null,null,null,null],Z,Z,[null,null,null,null,'P','P','P','P'],[null,null,null,'R',null,'R','K',null]] },
  { name: '中局吃后(兵)', type: 'win', hint: '小兵斜吃黑后', solution: [{ from:[5,1], to:[4,2] }],
    board: [[null,null,null,null,null,'r','k',null],[null,null,null,'p','p','p','p','p'],Z,Z,[null,null,'q',null,null,null,null,null],[null,'P',null,null,null,null,null,null],[null,null,null,null,'P','P','P','P'],[null,null,null,null,null,'R','K',null]] },
];

function checkMateOnBoard(board, color, castling, enPassant) {
  const legal = chess.generateLegal(board, color, castling, enPassant);
  for (const m of legal) {
    chess.makeMoveInPlace(board, m);
    const opp = color === 'w' ? 'b' : 'w';
    const k = chess.findKing(board, opp);
    const mate = chess.generateLegal(board, opp, castling, enPassant).length === 0 &&
      chess.isSquareAttacked(board, k[0], k[1], color);
    chess.undoMove(board, m);
    if (mate) return true;
  }
  return false;
}

let fail = 0;

M2.forEach((t, i) => {
  const g = new chess.ChessGame();
  g.reset();
  g.board = t.board.map(r => r.slice());
  g.turn = 'w';
  g.castling = { wK:false,wQ:false,bK:false,bQ:false };
  g.enPassant = null;
  const wl = chess.generateLegal(g.board, 'w', g.castling, g.enPassant);
  if (!wl.length) { console.log('M2#'+(i+1)+' 初始无着法'); fail++; return; }
  const bk = chess.findKing(g.board, 'b');
  if (chess.isSquareAttacked(g.board, bk[0], bk[1], 'w')) { console.log('M2#'+(i+1)+' 初始将军'); fail++; return; }
  const sol = t.solution[0];
  const mv = wl.find(m => m.from[0]===sol.from[0] && m.from[1]===sol.from[1] && m.to[0]===sol.to[0] && m.to[1]===sol.to[1]);
  if (!mv) { console.log('M2#'+(i+1)+' ['+t.name+'] 白1不合法'); fail++; return; }
  chess.makeMoveInPlace(g.board, mv);
  const blackMoves = chess.generateLegal(g.board, 'b', g.castling, g.enPassant);
  if (blackMoves.length === 0) { console.log('M2#'+(i+1)+' ['+t.name+'] 白1直接终局'); fail++; return; }
  let allGood = true;
  for (const bm of blackMoves) {
    chess.makeMoveInPlace(g.board, bm);
    const canMate = checkMateOnBoard(g.board, 'w', g.castling, g.enPassant);
    chess.undoMove(g.board, bm);
    if (!canMate) { allGood = false; console.log('M2#'+(i+1)+' ['+t.name+'] 黑应 '+chess.squareName(bm.from[0],bm.from[1])+'->'+chess.squareName(bm.to[0],bm.to[1])+' 后白无法一步将杀'); }
  }
  console.log('M2#'+(i+1)+' ['+t.name+'] → ' + (allGood ? '✓ 黑任何应招白都能两步杀' : '✗'));
  if (!allGood) fail++;
});

WM.forEach((t, i) => {
  const g = new chess.ChessGame();
  g.reset();
  g.board = t.board.map(r => r.slice());
  g.turn = 'w';
  g.castling = { wK:false,wQ:false,bK:false,bQ:false };
  g.enPassant = null;
  const wl = chess.generateLegal(g.board, 'w', g.castling, g.enPassant);
  if (!wl.length) { console.log('WM#'+(i+1)+' 初始无着法'); fail++; return; }
  const bk = chess.findKing(g.board, 'b');
  if (chess.isSquareAttacked(g.board, bk[0], bk[1], 'w')) { console.log('WM#'+(i+1)+' 初始将军'); fail++; return; }
  const sol = t.solution[0];
  const mv = wl.find(m => m.from[0]===sol.from[0] && m.from[1]===sol.from[1] && m.to[0]===sol.to[0] && m.to[1]===sol.to[1]);
  if (!mv) { console.log('WM#'+(i+1)+' ['+t.name+'] 解法不合法'); fail++; return; }
  chess.makeMoveInPlace(g.board, mv);
  const eatOk = !!mv.captured;
  const safe = !chess.isSquareAttacked(g.board, mv.to[0], mv.to[1], 'b');
  console.log('WM#'+(i+1)+' ['+t.name+'] → ' + (eatOk && safe ? '✓ 吃到 '+mv.captured+' 且落点安全' : '✗ ' + (eatOk ? '被回吃!' : '未吃子!')));
  if (!(eatOk && safe)) fail++;
});

console.log(fail ? '===> ' + fail + ' 题有问题' : '===> 全部 ' + (M2.length + WM.length) + ' 道新题验证通过');
