/* =========================================================================
 * ai-worker.js — AI 后台计算线程（Web Worker）
 * 把 negamax 搜索移到后台，界面在 AI 思考时保持流畅。
 * 依赖 chess.js / ai.js（同目录，通过 importScripts 加载为全局脚本）。
 * 消息协议：
 *   任务    { id, board, color, depth, castling, enPassant, randomness, recentKeys, timeLimit }
 *   取消    { type:'cancel', id }            → 置停止标志，搜索提前返回
 *   进度    ← { type:'progress', id, depth, maxDepth }（迭代加深每层完成）
 *   响应    ← { id, ok:true, res:{move,score}, stopped } | { id, ok:false, error }
 * ========================================================================= */
'use strict';

importScripts('chess.js', 'ai.js');

self.onmessage = function (e) {
  const d = e.data || {};
  const id = d.id;
  if (d.type === 'cancel') { stopSearch(); return; }
  resetSearch();
  try {
    const res = chooseMove(
      d.board, d.color, d.depth,
      d.castling, d.enPassant,
      d.randomness || 0,
      d.recentKeys || null,
      d.timeLimit || 0,
      (depth, maxDepth) => { self.postMessage({ type: 'progress', id, depth, maxDepth }); }
    );
    self.postMessage({ id, ok: true, res: res || null, stopped: searchStopped() });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
