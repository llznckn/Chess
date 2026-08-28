/* =========================================================================
 * ui.js — 界面、三种对战模式与新手提示
 * 依赖（全局）：
 *   chess.js — ChessGame、positionKey、makeMove、updateCastling、
 *              squareName、findKing、isSquareAttacked、colorOf
 *   ai.js    — chooseMove、evaluate、PIECE_VALUE、diffConfig、
 *              DIFF_LEVEL_NAME、OPENINGS、clearTT
 * 渲染性能：合法走法列表只生成一次，渲染与交互路径通过缓存复用。
 * ========================================================================= */
(function () {
  'use strict';

  const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const PIECE_TYPES = ['q', 'r', 'b', 'n', 'p'];

  /* ---------- 设置（带本地存储） ---------- */
  const DEFAULT_SETTINGS = {
    showLegalDots: true, highlightCaptures: true, highlightLastMove: true,
    highlightCheck: true, showCoordinates: true, showCaptured: true,
    showAdvantage: true, showMoveList: true, showPieceInfo: true, sound: true,
    showAnalysis: true, smoothMove: true, aiDelay: 1500, theme: 'classic'
  };
  const SETTINGS_KEY = 'chess-settings-v1';

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (e) {}
    return Object.assign({}, DEFAULT_SETTINGS);
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  const settings = loadSettings();
  if (typeof settings.aiDelay !== 'number') settings.aiDelay = DEFAULT_SETTINGS.aiDelay;
  if (typeof settings.smoothMove !== 'boolean') settings.smoothMove = true;
  if (!settings.theme || !['classic', 'dark', 'neon', 'royal'].includes(settings.theme)) settings.theme = 'classic';
  function applyTheme() { document.documentElement.setAttribute('data-theme', settings.theme); }

  /* ---------- 状态 ---------- */
  const game = new ChessGame();
  let mode = 'pvai';          // pvp | pvai | aivai
  let humanColor = 'w';
  let aiColor = 'b';
  let boardFlipped = false;
  let selected = null;        // [r,c]
  let hoverSquare = null;
  let hintMove = null;        // {from,to}
  let cursorPos = null;       // 键盘光标 [r,c]（方向键走子用）
  let aiThinking = false;
  let pendingPromo = null;
  let pendingPromoNoAnim = false; // 升变确认后是否跳过移动动画（拖拽升变时）
  let aiGen = 0;              // 用于取消 AI 循环
  let aivaiPaused = false;
  let menuShown = true;       // 当前是否处于菜单（返回菜单后 AI 不应再走子）
  let aiBusy = false;         // 斗蛐蛐单链锁：同一时刻只允许一个 AI 在决策/动画中
  let localResigned = null;   // 本地投降：'w'|'b'（谁认输），null=未认输
  let resignArmTimer = null;  // 投降二次确认的防误触计时器

  // 菜单选择状态
  const sel = { mode: 'pvai', submode: 'practice', color: 'w', diff: 5, diffW: 5, diffB: 5, clock: 0 };

  /* ---------- 合法走法缓存：局面未变时只生成一次，渲染/交互路径复用 ---------- */
  let legalCache = null;
  function cachedLegalMoves() {
    if (!legalCache) legalCache = game.legalMoves();
    return legalCache;
  }
  function invalidateLegalCache() { legalCache = null; }
  function cachedIsGameOver(ignoreRepeat) {
    if (cachedLegalMoves().length === 0) return true;
    if (!ignoreRepeat && game.isThreefoldRepetition()) return true;
    return game.isFiftyMoveRule() || game.isInsufficientMaterial();
  }
  function cachedIsCheckmate() { return cachedLegalMoves().length === 0 && game.inCheck(game.turn); }
  function cachedIsStalemate() { return cachedLegalMoves().length === 0 && !game.inCheck(game.turn); }

  /* ---------- DOM ---------- */
  const $ = id => document.getElementById(id);
  const boardEl = $('board');
  const statusEl = $('status');
  const turnTitle = $('turnTitle');
  const turnDot = $('turnDot');
  const modeLabel = $('modeLabel');
  const capWhiteEl = $('capWhite');
  const capBlackEl = $('capBlack');
  const advantageEl = $('advantage');
  const movelistEl = $('movelist');
  const capturedCard = $('capturedCard');
  const analysisCard = $('analysisCard');
  const anaFillW = $('anaFillW');
  const anaFillB = $('anaFillB');
  const anaPctW = $('anaPctW');
  const anaPctB = $('anaPctB');
  const anaAdv = $('anaAdv');
  const pieceInfoPopup = $('pieceInfoPopup');
  const settingsModal = $('settingsModal');
  const promoModal = $('promoModal');
  const promoChoices = $('promoChoices');
  const aivaiToggle = $('aivaiToggle');
  const resignBtn = $('resignBtn');
  const menuSelectEl = $('menuSelect');

  /* ---------- 音效（可选） ---------- */
  let audioCtx = null;
  // 浏览器自动播放策略：首次交互时解锁音频上下文
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  // 通用音色：正弦/三角波 + 起音/衰减包络
  function tone(freq, dur, type, vol, when, glideTo) {
    if (!settings.sound) return;
    try {
      unlockAudio();
      if (!audioCtx) return;
      const t0 = audioCtx.currentTime + (when || 0);
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.35, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + dur + 0.03);
    } catch (e) {}
  }
  // 木质感落子声：短噪声 + 带通滤波（模拟木头碰撞，无需外部音频文件）
  function thock(freq, dur, vol) {
    if (!settings.sound) return;
    try {
      unlockAudio();
      if (!audioCtx) return;
      const len = Math.max(1, Math.floor(audioCtx.sampleRate * dur));
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      const src = audioCtx.createBufferSource(); src.buffer = buf;
      const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = freq; bp.Q.value = 0.9;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(vol, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      src.connect(bp); bp.connect(g); g.connect(audioCtx.destination);
      src.start();
    } catch (e) {}
  }
  const sndMove = () => thock(1500, 0.05, 0.55);                                          // 走子：短促的木质「嗒」
  const sndCapture = () => { thock(850, 0.07, 0.6); setTimeout(() => thock(1500, 0.05, 0.4), 45); }; // 吃子：沉闷碰撞+回响
  const sndCheck = () => { tone(660, 0.09, 'sine', 0.4); setTimeout(() => tone(880, 0.12, 'sine', 0.4), 95); };        // 将军：警示双音
  const sndWin = () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.16, 'triangle', 0.4), i * 120)); // 胜利：上行琶音
  const sndLose = () => [392, 330, 262, 196].forEach((f, i) => setTimeout(() => tone(f, 0.18, 'sine', 0.38), i * 130));   // 落败：下行
  const sndDraw = () => { tone(440, 0.12, 'sine', 0.35); setTimeout(() => tone(440, 0.12, 'sine', 0.35), 160); };
  const sndHint = () => tone(880, 0.08, 'sine', 0.35);                    // 提示：清脆单音
  const sndStart = () => { tone(392, 0.1, 'triangle', 0.35); setTimeout(() => tone(523, 0.12, 'triangle', 0.35), 110); };

  let boardSquares = null; // [r][c] -> 已存在的格子元素（增量渲染复用）

  /* ---------- 渲染：棋盘 ---------- */
  function renderBoard() {
    const wrap = boardEl.parentElement;
    if (wrap) wrap.classList.remove('win-glow');
    const b = game.board;
    const lm = game.lastMove;
    const checkPos = (settings.highlightCheck && game.inCheck(game.turn)) ? findKing(b, game.turn) : null;
    // 只有选中「当前轮到方」的棋子时才显示走法提示；
    // 否则（如历史遗留的跨回合选中）一律为空，避免误导成“无子可走”。
    const selPiece = selected ? b[selected[0]][selected[1]] : null;
    const targets = selected && selPiece && colorOf(selPiece) === game.turn
      ? cachedLegalMoves().filter(m => m.from[0] === selected[0] && m.from[1] === selected[1])
      : [];
    const targetMap = new Map();
    targets.forEach(m => targetMap.set(m.to[0] + ',' + m.to[1], m));
    if (!boardSquares) { boardSquares = []; for (let i = 0; i < 8; i++) boardSquares[i] = []; }

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const dr = boardFlipped ? 7 - r : r;
        const dc = boardFlipped ? 7 - c : c;
        const isLight = (dr + dc) % 2 === 0;
        const cls = ['square', isLight ? 'light' : 'dark'];
        const isSel = selected && selected[0] === dr && selected[1] === dc;
        if (isSel) cls.push('sel');
        const isCursor = cursorPos && !isSel && cursorPos[0] === dr && cursorPos[1] === dc;
        if (isCursor) cls.push('cursor');
        const tkey = dr + ',' + dc;
        const tMove = targetMap.get(tkey);
        const isTarget = !!tMove;
        const isCapTarget = isTarget && (tMove.captured || tMove.enpassant);
        if (isCapTarget && (settings.highlightCaptures || settings.showLegalDots)) cls.push('cap-target');

        let inner = '';
        if (settings.showCoordinates) {
          const bottomRow = boardFlipped ? 0 : 7;
          const leftCol = boardFlipped ? 7 : 0;
          if (dr === bottomRow) inner += `<span class="coord file">${FILES[dc]}</span>`;
          if (dc === leftCol) inner += `<span class="coord rank">${8 - dr}</span>`;
        }
        if (lm && ((lm.from[0] === dr && lm.from[1] === dc) || (lm.to[0] === dr && lm.to[1] === dc)))
          inner += `<div class="hl hl-last"></div>`;
        if (checkPos && checkPos[0] === dr && checkPos[1] === dc)
          inner += `<div class="hl hl-check"></div>`;
        if (isSel) inner += `<div class="hl hl-sel"></div>`;
        if (hintMove && hintMove.from[0] === dr && hintMove.from[1] === dc)
          inner += `<div class="hl hl-hint-from"></div>`;
        if (hintMove && hintMove.to[0] === dr && hintMove.to[1] === dc)
          inner += `<div class="hl hl-hint-to"></div>`;

        const sq = b[dr][dc];
        if (sq) {
          const col = colorOf(sq);
          const kingCls = (checkPos && checkPos[0] === dr && checkPos[1] === dc) ? ' king-check' : '';
          inner += `<span class="piece ${col}${kingCls}">${GLYPH[sq.toLowerCase()]}</span>`;
        }
        if (isTarget && settings.showLegalDots) {
          inner += isCapTarget ? `<div class="legal cap"></div>` : `<div class="legal dot"></div>`;
        }

        // 增量更新：格子元素复用，class/innerHTML 仅在变化时才写入，避免每步重建整盘
        const sqEl = boardSquares[dr][dc];
        if (sqEl) {
          // 翻转棋盘后坐标属性会过期，必须同步（仅在变化时写入）
          if (sqEl.getAttribute('data-r') !== String(dr)) sqEl.setAttribute('data-r', dr);
          if (sqEl.getAttribute('data-c') !== String(dc)) sqEl.setAttribute('data-c', dc);
          const clsStr = cls.join(' ');
          if (sqEl.className !== clsStr) sqEl.className = clsStr;
          if (sqEl.innerHTML !== inner) sqEl.innerHTML = inner;
        } else {
          const el = document.createElement('div');
          el.className = cls.join(' ');
          el.setAttribute('data-r', dr);
          el.setAttribute('data-c', dc);
          el.innerHTML = inner;
          boardSquares[dr][dc] = el;
        }
        // 按当前循环顺序追加/移动节点，保证翻转后 DOM 顺序与显示位置一致
        boardEl.appendChild(boardSquares[dr][dc]);
      }
    }
  }

  /* ---------- 渲染：侧栏 ---------- */
  function getCaptured() {
    const INIT = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
    const on = { w: Object.assign({}, INIT), b: Object.assign({}, INIT) };
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const p = game.board[r][c];
        if (p) { const t = p.toLowerCase(); if (on[colorOf(p)][t] > 0) on[colorOf(p)][t]--; }
      }
    const whiteLost = [], blackLost = [];
    for (const t of PIECE_TYPES) {
      for (let i = 0; i < INIT[t] - on.w[t]; i++) whiteLost.push(t);
      for (let i = 0; i < INIT[t] - on.b[t]; i++) blackLost.push(t);
    }
    return { whiteLost, blackLost };
  }

  function materialTotal(color) {
    let s = 0;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const p = game.board[r][c];
        if (p && colorOf(p) === color) s += PIECE_VALUE[p.toLowerCase()];
      }
    return s;
  }

  function renderCaptured() {
    const cap = getCaptured();
    const glyphs = arr => arr.map(t => `<span class="cp w">${GLYPH[t]}</span>`).join('');
    capWhiteEl.innerHTML = settings.showCaptured ? glyphs(cap.whiteLost) : '';
    capBlackEl.innerHTML = settings.showCaptured ? glyphs(cap.blackLost) : '';
    if (settings.showAdvantage) {
      const adv = (materialTotal('w') - materialTotal('b')) / 100;
      if (Math.abs(adv) < 0.05) {
        advantageEl.textContent = '子力均衡';
        advantageEl.className = 'advantage';
      } else if (adv > 0) {
        advantageEl.textContent = `白方领先 +${adv.toFixed(1)}`;
        advantageEl.className = 'advantage w';
      } else {
        advantageEl.textContent = `黑方领先 +${(-adv).toFixed(1)}`;
        advantageEl.className = 'advantage b';
      }
      advantageEl.style.display = '';
    } else {
      advantageEl.style.display = 'none';
    }
    capturedCard.style.display = (settings.showCaptured || settings.showAdvantage) ? '' : 'none';
  }

  // 胜率模型：centipawn 分数 → 胜率（Lichess 近似公式）
  function winPctFromCp(cp) {
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }

  function renderAnalysis() {
    if (!analysisCard) return;
    analysisCard.style.display = settings.showAnalysis ? '' : 'none';
    if (!settings.showAnalysis) return;
    const over = cachedIsGameOver(mode === 'aivai');
    let wp = 50, bp = 50, advText = '';
    if (over && cachedIsCheckmate()) {
      // 将死：胜方 100%
      if (game.turn === 'w') { wp = 0; bp = 100; advText = '黑方获胜'; }
      else { wp = 100; bp = 0; advText = '白方获胜'; }
    } else if (over) {
      wp = 50; bp = 50; advText = '和棋';
    } else {
      const cp = evaluate(game.board); // 白方视角，单位 centipawn
      wp = winPctFromCp(cp);
      bp = 100 - wp;
      wp = Math.max(1, Math.min(99, wp));
      bp = 100 - wp;
      advText = (cp >= 0)
        ? '白方优势 +' + (cp / 100).toFixed(1)
        : '黑方优势 +' + (-cp / 100).toFixed(1);
      if (Math.abs(cp) < 20) advText = '子力均衡';
    }
    anaFillW.style.width = wp + '%';
    anaFillB.style.width = bp + '%';
    anaPctW.textContent = Math.round(wp) + '%';
    anaPctB.textContent = Math.round(bp) + '%';
    anaFillW.classList.toggle('win', wp >= 50);
    anaFillB.classList.toggle('win', bp >= 50);
    anaAdv.textContent = advText;
    anaAdv.className = 'ana-adv' + (wp > bp ? ' w' : (bp > wp ? ' b' : ''));
  }

  let movesRendered = -1; // 已渲染的记谱条数（增量追加用）

  function renderMoves() {
    if (!settings.showMoveList) { movelistEl.style.display = 'none'; return; }
    movelistEl.style.display = '';
    const log = game.moveLog;
    // 悔棋/新对局导致记录变短时，整体清空重来
    if (log.length < movesRendered) { movelistEl.innerHTML = ''; movesRendered = 0; }
    if (log.length === 0) {
      if (movelistEl.childNodes.length === 0) movelistEl.innerHTML = '<span class="num">—</span>';
      movesRendered = 0;
      return;
    }
    // 去掉旧占位符与旧高亮，只给最后一手标 cur
    const first = movelistEl.children[0];
    if (first && first.classList.contains('num') && first.textContent.trim() === '—') movelistEl.innerHTML = '';
    movelistEl.querySelectorAll('.mv.cur').forEach(el => el.classList.remove('cur'));
    for (let i = movesRendered; i < log.length; i++) {
      if (i % 2 === 0) {
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = (i / 2 + 1) + '.';
        movelistEl.appendChild(num);
      }
      const sp = document.createElement('span');
      sp.className = 'mv';
      sp.textContent = log[i];
      if (i === log.length - 1) sp.classList.add('cur');
      movelistEl.appendChild(sp);
    }
    movesRendered = log.length;
  }

  const PIECE_NAME_CN = {
    K: '王', Q: '后', R: '车', B: '象', N: '马', P: '兵',
    k: '王', q: '后', r: '车', b: '象', n: '马', p: '兵'
  };
  const COLOR_CN = { w: '白方', b: '黑方' };
  const MOVE_DESC_CN = {
    K: '横、直、斜 1 格',
    Q: '任意方向 1 至多格',
    R: '横或直 1 至多格',
    B: '斜向 1 至多格',
    N: '日字（先直一斜二）',
    P: '前进 1 格（首次可 2）/ 斜吃'
  };

  function piecePatternSVG(pt, color) {
    const N = 8, S = 17, pad = 3, cr = 3, cc = 3;
    const out = [];
    const ray = (dr, dc, max) => { for (let k = 1; k <= max; k++) out.push([cr + dr * k, cc + dc * k]); };
    if (pt === 'K') {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) out.push([cr + dr, cc + dc]);
    } else if (pt === 'N') {
      [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(d => out.push([cr + d[0], cc + d[1]]));
    } else if (pt === 'R') {
      [[1,0],[-1,0],[0,1],[0,-1]].forEach(d => ray(d[0], d[1], 7));
    } else if (pt === 'B') {
      [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(d => ray(d[0], d[1], 7));
    } else if (pt === 'Q') {
      [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].forEach(d => ray(d[0], d[1], 7));
    } else if (pt === 'P') {
      const f = color === 'w' ? -1 : 1;
      out.push([cr + f, cc]); out.push([cr + f * 2, cc]);
      out.push([cr + f, cc - 1]); out.push([cr + f, cc + 1]);
    }
    const W = N * S + pad * 2;
    let cells = '';
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const light = (r + c) % 2 === 0;
      cells += '<rect x="' + (pad + c*S) + '" y="' + (pad + r*S) + '" width="' + S + '" height="' + S + '" rx="2.5" fill="' + (light ? '#eaeef5' : '#c4cee0') + '"/>';
    }
    let hl = '';
    out.forEach(m => {
      const r = m[0], c = m[1];
      if (r < 0 || r >= N || c < 0 || c >= N) return;
      hl += '<circle cx="' + (pad + c*S + S/2) + '" cy="' + (pad + r*S + S/2) + '" r="' + (S*0.30) + '" fill="#4fb477" opacity="0.9"/>';
    });
    const gx = pad + cc*S + S/2, gy = pad + cr*S + S/2;
    const fill = color === 'w' ? '#ffffff' : '#2b2b2b';
    const stroke = color === 'w' ? '#3a3a3a' : '#e8e8e8';
    return '<svg width="' + W + '" height="' + W + '" viewBox="0 0 ' + W + ' ' + W + '" class="pi-pattern" role="img" aria-label="走法示意">'
      + cells + hl
      + '<text x="' + gx + '" y="' + gy + '" text-anchor="middle" dominant-baseline="central" font-size="' + (S*0.82) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="0.7">' + GLYPH[pt.toLowerCase()] + '</text></svg>';
  }

  function renderPieceInfo() {
    if (!settings.showPieceInfo) { pieceInfoPopup.classList.add('hidden'); return; }
    if (!hoverSquare) { pieceInfoPopup.classList.add('hidden'); return; }
    const [r, c] = hoverSquare;
    const p = game.board[r][c];
    if (!p) { pieceInfoPopup.classList.add('hidden'); return; }
    // 只显示己方棋子
    const isMine = (mode === 'pvai') ? (colorOf(p) === humanColor) : true;
    if (!isMine) { pieceInfoPopup.classList.add('hidden'); return; }

    const pt = p.toUpperCase();
    const ptLower = p.toLowerCase();
    const color = colorOf(p);
    const name = COLOR_CN[color] + PIECE_NAME_CN[pt];
    const pos = squareName(r, c);
    const moves = cachedLegalMoves().filter(m => m.from[0] === r && m.from[1] === c);
    const captures = moves.filter(m => m.captured || m.enpassant).length;
    const desc = MOVE_DESC_CN[pt];
    const inDanger = (game.turn === color) && (() => {
      const enemy = color === 'w' ? 'b' : 'w';
      return isSquareAttacked(game.board, r, c, enemy);
    })();

    const moveItems = moves.map(m => {
      const dest = squareName(m.to[0], m.to[1]);
      const isCap = m.captured || m.enpassant;
      const isPromo = m.promotion ? ' 升' + PIECE_NAME_CN[m.promotion.toUpperCase()] : '';
      const tag = m.castle === 'K' ? '王翼易位' : m.castle === 'Q' ? '后翼易位' : '';
      const cls = isCap ? 'pi-move cap' : 'pi-move';
      const text = m.castle ? tag : (dest + isPromo);
      return `<div class="${cls}" data-mv='${JSON.stringify({ r: m.to[0], c: m.to[1] })}'>${text}</div>`;
    }).join('') || '<div class="pi-empty">该棋子无可走步法</div>';

    pieceInfoPopup.innerHTML = `
      <div class="pi-head">
        <span class="pi-glyph ${color}">${GLYPH[ptLower]}</span>
        <div>
          <div class="pi-name">${name}</div>
          <div class="pi-pos">位置 ${pos} · ${inDanger ? '<span style="color:#b1402f">被牵制</span>' : '安全'}</div>
        </div>
      </div>
      <div class="pi-desc">${desc}</div>
      <div class="pi-pattern-wrap">
        <div class="pi-pattern-label">走法示意</div>
        ${piecePatternSVG(pt, color)}
      </div>
      <div class="pi-meta">
        <div>可走步法</div><strong>${moves.length} 步</strong>
      </div>
      <div class="pi-meta">
        <div>吃子步法</div><strong>${captures} 步</strong>
      </div>
      <div class="pi-moves">${moveItems}</div>
    `;
    // 关键：先移去 hidden 让浏览器算好 offsetWidth/Height，再定位（避免拿到 0 走兜底导致偏移）
    pieceInfoPopup.classList.remove('hidden');
    positionPieceInfoPopup(r, c);
  }

  function positionPieceInfoPopup(r, c) {
    const popW = pieceInfoPopup.offsetWidth || 230;
    const popH = pieceInfoPopup.offsetHeight || 140;
    const sqEl = boardEl.querySelector('[data-r="' + r + '"][data-c="' + c + '"]');
    if (!sqEl) return;
    const sr = sqEl.getBoundingClientRect();
    const wrapR = boardEl.parentElement.getBoundingClientRect();
    // 锚定在棋子旁边：默认放在棋子右侧，溢出棋盘则翻到左侧
    let left = sr.right - wrapR.left + 10;
    let top = sr.top - wrapR.top;
    if (left + popW > wrapR.width) left = sr.left - wrapR.left - popW - 10;
    if (top + popH > wrapR.height) top = wrapR.height - popH - 4;
    if (top < 0) top = 4;
    pieceInfoPopup.style.left = left + 'px';
    pieceInfoPopup.style.top = top + 'px';
  }

  // 仅当鼠标指针停留在某枚棋子上方时才显示信息卡（hover 驱动，浮窗不拦截点击）
  function setHover(sq) {
    const same = sq && hoverSquare && sq[0] === hoverSquare[0] && sq[1] === hoverSquare[1];
    if (sq === null && hoverSquare === null) return;
    if (same) return;
    hoverSquare = sq;
    renderPieceInfo();
  }
  boardEl.addEventListener('mousemove', e => {
    const sq = e.target.closest('.square');
    setHover(sq ? [+sq.dataset.r, +sq.dataset.c] : null);
  });
  boardEl.addEventListener('mouseleave', () => setHover(null));

  function renderPanel() {
    // 本地认输后：终局文案由 finishLocalResign 设置，这里不覆盖
    if (localResigned) {
      turnDot.className = 'turn-dot ' + (game.turn === 'w' ? 'w' : 'b');
      renderCaptured();
      renderAnalysis();
      renderMoves();
      return;
    }
    const over = cachedIsGameOver(mode === 'aivai'); // 斗蛐蛐不因重复局面判和
    const checkmate = cachedIsCheckmate();
    const stalemate = cachedIsStalemate();
    turnDot.className = 'turn-dot ' + (game.turn === 'w' ? 'w' : 'b');
    if (clockTimeout) {
      turnTitle.textContent = (clockTimeout === 'w' ? '白方超时' : '黑方超时') + '，' + (clockTimeout === 'w' ? '黑方' : '白方') + '获胜';
    } else if (over) {
      if (checkmate) turnTitle.textContent = (game.turn === 'w' ? '黑方胜利（将死）' : '白方胜利（将死）');
      else if (stalemate) turnTitle.textContent = '和棋（逼和）';
      else if (game.isThreefoldRepetition()) turnTitle.textContent = '和棋（重复局面）';
      else if (game.isFiftyMoveRule()) turnTitle.textContent = '和棋（50回合规则）';
      else if (game.isInsufficientMaterial()) turnTitle.textContent = '和棋（子力不足）';
      else turnTitle.textContent = '和棋';
    } else {
      turnTitle.textContent = game.turn === 'w' ? '白方走棋' : '黑方走棋';
    }
    if (mode === 'pvp') modeLabel.textContent = '本地双人';
    else if (mode === 'tactics') {
      modeLabel.textContent = tactics ? '战术训练 · 第 ' + (tactics.idx + 1) + '/' + tactics.total + ' 题' : '战术训练';
    }
    else if (mode === 'pvai') {
      modeLabel.textContent = (sel.submode === 'rating' ? '评分模式' : '练习模式') +
        ' · 你执' + (humanColor === 'w' ? '白' : '黑') +
        (sel.submode === 'rating' ? ' · 对手：' + diffConfig(sel.diff).label + ' AI' : '');
    }
    else {
      const lv = v => diffConfig(v).label;
      modeLabel.textContent = `AI 斗蛐蛐 · 白(${lv(sel.diffW)}) vs 黑(${lv(sel.diffB)})`;
    }
    statusEl.classList.toggle('alert', over || !!clockTimeout);
    if (mode === 'tactics' && tactics && tactics.current) {
      statusEl.textContent = '提示：' + tactics.current.hint;
    } else if (clockTimeout) statusEl.textContent = (clockTimeout === 'w' ? '白方' : '黑方') + ' 超时，' + (clockTimeout === 'w' ? '黑方' : '白方') + '获胜';
    else if (checkmate) statusEl.textContent = '将死！对局结束';
    else if (stalemate) statusEl.textContent = '逼和（无子可动且未被将军）';
    else if (game.isThreefoldRepetition()) statusEl.textContent = '重复局面三次，判和';
    else if (game.isFiftyMoveRule()) statusEl.textContent = '50 回合无吃子无兵动，判和';
    else if (game.isInsufficientMaterial()) statusEl.textContent = '子力不足以将死，判和';
    else if (aiThinking) {
      statusEl.textContent = aiProgress && aiProgress.depth > 0
        ? 'AI 思考中 · 正在搜索第 ' + aiProgress.depth + '/' + (aiProgress.maxDepth || '?') + ' 层'
        : 'AI 思考中…';
    }
    else if (!over && game.inCheck(game.turn)) statusEl.textContent = '将军！';
    else statusEl.textContent = '';
    renderCaptured();
    renderAnalysis();
    renderMoves();
  }

  function renderAll() { renderBoard(); renderPanel(); renderPieceInfo(); }

  /* ---------- 华丽特效 ---------- */
  function spawnEffects(move, cap, givesCheck) {
    const r = move.to[0], c = move.to[1];
    const sqEl = boardEl.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    if (!sqEl) return;
    const rip = document.createElement('div'); rip.className = 'ripple'; sqEl.appendChild(rip);
    setTimeout(() => rip.remove(), 650);
    const pc = sqEl.querySelector('.piece');
    if (pc) { pc.classList.add('land-piece'); setTimeout(() => pc.classList.remove('land-piece'), 300); }
    if (cap) {
      for (let i = 0; i < 14; i++) {
        const p = document.createElement('div'); p.className = 'particle';
        const ang = (Math.PI * 2 * i) / 14 + Math.random() * 0.5;
        const dist = 24 + Math.random() * 24;
        p.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'px');
        p.style.setProperty('--dy', (Math.sin(ang) * dist).toFixed(1) + 'px');
        p.style.background = i % 2 ? 'radial-gradient(circle,#fff,#e8c873)' : 'radial-gradient(circle,#ffd6d6,#b1402f)';
        sqEl.appendChild(p);
        setTimeout(() => p.remove(), 620);
      }
    }
    if (givesCheck) {
      const wrap = boardEl.parentElement;
      if (wrap) { wrap.classList.add('shake'); setTimeout(() => wrap.classList.remove('shake'), 520); }
    }
  }

  function celebrate() {
    const wrap = boardEl.parentElement;
    if (!wrap) return;
    wrap.classList.add('win-glow');
    for (let i = 0; i < 46; i++) {
      const c = document.createElement('div'); c.className = 'confetti';
      c.style.left = (Math.random() * 100).toFixed(1) + '%';
      c.style.background = `hsl(${Math.floor(Math.random() * 360)},82%,62%)`;
      c.style.setProperty('--dx', ((Math.random() * 2 - 1) * 120).toFixed(1) + 'px');
      c.style.setProperty('--dy', (130 + Math.random() * 130).toFixed(1) + 'px');
      c.style.animationDelay = (Math.random() * 0.5).toFixed(2) + 's';
      wrap.appendChild(c);
      setTimeout(() => c.remove(), 2400);
    }
  }

  function animateSlide(fromRect, toRect, glyph, color, onDone) {
    // fromRect/toRect 均为**格子**的视口矩形；幽灵棋子按真实棋子自然尺寸生成，
    // 起点居中在源格，落点与格子里居中的真实棋子重合。
    // 动画节奏：先向上抬升一小段（ease-out），再以「慢-快-慢」曲线滑向目标格。
    const ghost = document.createElement('div');
    ghost.className = 'piece anim-piece ' + color;
    ghost.textContent = glyph;
    document.body.appendChild(ghost);
    const gw = ghost.offsetWidth, gh = ghost.offsetHeight;
    ghost.style.left = (fromRect.left + (fromRect.width - gw) / 2) + 'px';
    ghost.style.top = (fromRect.top + (fromRect.height - gh) / 2) + 'px';
    const dx = toRect.left - fromRect.left;
    const dy = toRect.top - fromRect.top;
    const D = 620;
    const lift = Math.min(46, Math.max(20, gh * 0.55)); // 抬升高度
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      if (ghost.parentNode) ghost.remove();
      if (onDone) onDone();
    };
    if (typeof ghost.animate === 'function') {
      const anim = ghost.animate([
        { transform: 'translate(0,0) scale(1)', offset: 0, easing: 'cubic-bezier(0.33,0,0.4,1)' },
        { transform: 'translate(0,' + (-lift) + 'px) scale(1.07)', offset: 0.22, easing: 'cubic-bezier(0.45,0.05,0.35,1)' },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(1.07)', offset: 0.9, easing: 'cubic-bezier(0.45,0.05,0.35,1)' },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(1)', offset: 1 }
      ], { duration: D });
      anim.onfinish = finish;
      anim.oncancel = finish;
      setTimeout(finish, D + 200); // 兜底
    } else {
      // 降级方案：CSS transition 两段式（抬升 → 慢快慢滑行）
      ghost.style.transition = 'transform 220ms cubic-bezier(0.33,0,0.4,1)';
      void ghost.offsetWidth;
      ghost.style.transform = 'translate(0,' + (-lift) + 'px) scale(1.07)';
      setTimeout(() => {
        ghost.style.transition = 'transform ' + (D - 220) + 'ms cubic-bezier(0.45,0.05,0.35,1)';
        ghost.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        setTimeout(finish, D - 220 + 60);
      }, 250);
    }
  }

  /* ---------- 走子流程 ---------- */
  function doMove(move, onDone, noAnim) {
    const cap = !!move.captured || !!move.enpassant;
    const mover = game.turn;
    // 人机对局：玩家走子前记录引擎在此局面的最佳分数（用于逐着准确率，练习+评分都记）
    if (mode === 'pvai' && game.turn === humanColor) {
      try {
        const keys = getRecentKeyCounts();
        // depth 3 比 depth 2 准确得多（±20cp 抖动消失），开销也只多几十毫秒
        const br = chooseMove(game.board, humanColor, 3, game.castling, game.enPassant, 0, keys);
        qualityBest = (br && br.move) ? br.score : null;
      } catch (e) { qualityBest = null; }
    }
    // 动画前抓取起点/终点**格子**的屏幕位置（以格子为锚，避免棋子悬停/选中缩放导致的错位）
    const srcSqEl = boardEl.querySelector('[data-r="' + move.from[0] + '"][data-c="' + move.from[1] + '"]');
    const destSq = boardEl.querySelector('[data-r="' + move.to[0] + '"][data-c="' + move.to[1] + '"]');
    const srcRect = srcSqEl ? srcSqEl.getBoundingClientRect() : null;
    const destRect = destSq ? destSq.getBoundingClientRect() : null;
    const srcPieceEl = srcSqEl ? srcSqEl.querySelector('.piece') : null;
    const glyph = move.promotion ? GLYPH[move.promotion.toLowerCase()] : (srcPieceEl ? srcPieceEl.textContent : '');
    const color = srcPieceEl ? (srcPieceEl.classList.contains('w') ? 'w' : 'b') : (mover === 'w' ? 'w' : 'b');

    const san = game.apply(move);
    invalidateLegalCache();
    selected = null; hintMove = null;
    renderAll();
    renderPieceInfo();

    const ek = findKing(game.board, game.turn);
    const givesCheck = ek && isSquareAttacked(game.board, ek[0], ek[1], mover);

    const finishMove = () => {
      spawnEffects(move, cap, givesCheck);
      if (settings.sound) {
        if (cap) sndCapture(); else sndMove();
        if (givesCheck) setTimeout(sndCheck, 130);
      }
      // 记录这一步相对引擎最佳的损失（玩家视角）；练习模式进质量报告，评分模式进评分日志
      if (mode === 'pvai' && qualityBest !== null) {
        const after = (humanColor === 'w') ? evaluate(game.board) : -evaluate(game.board);
        const loss = Math.max(0, qualityBest - after);
        const acc = moveAccuracy(loss);
        moveQualityLog.push({ san, acc });
        if (sel.submode === 'rating') ratingLog.push(loss);
        qualityBest = null;
      }
      const over = cachedIsGameOver(mode === 'aivai'); // 斗蛐蛐不因重复局面判和
      saveGame(); // 每步落定后自动保存（可随时刷新/返回菜单继续）
      if (over) {
        stopClock(); // 终局停钟
        recordResult();
        if (settings.sound) { if (cachedIsCheckmate()) sndWin(); else sndDraw(); }
        if (cachedIsCheckmate()) celebrate();
        if (mode === 'pvai' && sel.submode === 'rating') setTimeout(showRating, 1100);
        else if (mode === 'pvai' && moveQualityLog.length) setTimeout(showQuality, 1000);
        if (onDone) onDone(over);
        return;
      }
      updateClockActive(); // 落定后切换走钟方（对方/AI 回合自动暂停）
      // 有回调（AI 单链）→ 只通知回调，由其决定下一步；否则按模式分派
      if (onDone) { onDone(over); return; }
      if (mode === 'pvai') maybeAIMove();
      else if (mode === 'aivai') stepAI();
    };

    const destPieceEl = boardEl.querySelector('[data-r="' + move.to[0] + '"][data-c="' + move.to[1] + '"] .piece');
    // 拖拽落子（noAnim）时棋子已跟手到位，直接落子不再播飞行/幽灵动画；点击走子保留动画
    if (!noAnim && srcRect && destRect && destPieceEl && settings.smoothMove) {
      // 提子：原棋子已随 renderAll 消失，目标格棋子先隐藏，由幽灵棋子代替飞行
      destPieceEl.classList.add('anim-hidden');
      animateSlide(srcRect, destRect, glyph, color, () => {
        // 到位：幽灵移除，原棋子替换回来
        destPieceEl.classList.remove('anim-hidden');
        finishMove();
      });
    } else {
      finishMove();
    }
  }

  /* ---------- 战术训练：一步杀/战术题练习 ---------- */
  let tactics = null; // { list, idx, current, step, solved, total }

  function startTactics() {
    const list = TACTICS.map((_, i) => i).sort(() => Math.random() - 0.5);
    tactics = { list, idx: 0, step: 0, solved: 0, total: TACTICS.length };
    mode = 'tactics'; // 不修改 sel.mode，返回菜单后保留原选择
    clearSave();
    stopClock();
    loadTacticsPuzzle();
    updateModeUI();
    hideMenu();
    renderAll();
  }

  function loadTacticsPuzzle() {
    const t = TACTICS[tactics.list[tactics.idx]];
    tactics.current = t;
    tactics.step = 0;
    game.reset();
    game.board = t.board.map(r => r.slice());
    game.turn = 'w';
    game.castling = { wK: false, wQ: false, bK: false, bQ: false };
    game.enPassant = null;
    selected = null; hintMove = null; cursorPos = [6, 4];
    invalidateLegalCache();
    clearTT();
    renderAll();
  }

  function nextTacticsPuzzle() {
    if (!tactics) return;
    tactics.idx++;
    if (tactics.idx >= tactics.total) {
      const pct = Math.round(tactics.solved / tactics.total * 100);
      toast('战术训练完成：答对 ' + tactics.solved + '/' + tactics.total + ' 题（' + pct + '%）');
      if (settings.sound) { if (pct >= 80) sndWin(); else if (pct >= 50) sndDraw(); else sndLose(); }
      tactics = null;
      setTimeout(showMenu, 1200);
      return;
    }
    loadTacticsPuzzle();
  }

  function tacticsClick(dr, dc) {
    if (!tactics || !tactics.current) return;
    const t = tactics.current;
    const sq = game.board[dr][dc];
    if (!selected) {
      if (sq && colorOf(sq) === game.turn) { selectAt(dr, dc); return; }
      return;
    }
    const moves = cachedLegalMoves().filter(m => m.from[0] === selected[0] && m.from[1] === selected[1]);
    const sol = t.solution[tactics.step] || null;
    const found = moves.find(m => m.to[0] === dr && m.to[1] === dc &&
      (m.promotion || null) === ((sol || {}).promotion || null));
    if (!found) {
      if (sq && colorOf(sq) === game.turn) { selectAt(dr, dc); return; }
      selected = null; renderBoard(); renderPieceInfo(); return;
    }
    const ok = sol && found.from[0] === sol.from[0] && found.from[1] === sol.from[1] &&
      found.to[0] === sol.to[0] && found.to[1] === sol.to[1] &&
      (found.promotion || null) === (sol.promotion || null);

    // ===== 两步杀(mate2):白1 匹配 → 黑方 AI 自动应招 → 玩家白2 自由将杀 =====
    if (t.type === 'mate2' && tactics.step === 0) {
      game.apply(found);
      invalidateLegalCache();
      selected = null;
      renderAll();
      if (!ok) { // 白1 走错
        if (settings.sound) sndLose();
        toast('不对，先想想第一步');
        game.undo(); invalidateLegalCache(); renderAll();
        return;
      }
      tactics.step = 1;
      toast('好棋！黑方要应招了…');
      setTimeout(() => {
        if (!tactics || !tactics.current || mode !== 'tactics') return;
        if (game.isGameOver()) {
          // 白1 直接把黑将死(理论上 mate2 题不会出现):提前判对
          if (game.isCheckmate()) { solveTacticsSuccess(); }
          return;
        }
        // 黑方 AI(depth 2)应招
        let mv = null;
        try { const r = chooseMove(game.board, game.turn, 2, game.castling, game.enPassant, 0, null); mv = r && r.move; } catch (e) {}
        if (!mv) { const legal = cachedLegalMoves(); if (legal.length) mv = legal[0]; }
        if (mv) { game.apply(mv); invalidateLegalCache(); selected = null; renderAll(); }
        toast('轮到你：走出将杀！');
      }, 650);
      return;
    }
    if (t.type === 'mate2' && tactics.step === 1) {
      game.apply(found);
      invalidateLegalCache();
      selected = null;
      renderAll();
      if (game.isCheckmate()) {
        solveTacticsSuccess();
      } else {
        // 没将杀 → 悔掉这一步,重试(保留黑方应招后的局面)
        if (settings.sound) sndLose();
        toast('还没将杀，再想想');
        game.undo(); invalidateLegalCache(); renderAll();
      }
      return;
    }

    game.apply(found);
    invalidateLegalCache();
    selected = null;
    renderAll();
    if (ok) {
      tactics.step++;
      if (tactics.step >= t.solution.length) {
        solveTacticsSuccess();
      } else {
        toast('好棋！继续…');
      }
    } else {
      if (settings.sound) sndLose();
      toast('不对，再想想');
      game.undo(); invalidateLegalCache(); renderAll();
    }
  }
  function solveTacticsSuccess() {
    tactics.solved++;
    if (settings.sound) sndWin();
    toast('✓ 正确！第 ' + (tactics.idx + 1) + '/' + tactics.total + ' 题');
    setTimeout(nextTacticsPuzzle, 900);
  }

  function onSquareClick(dr, dc, noAnim) {
    if (mode === 'tactics') { tacticsClick(dr, dc); return; }
    if (mode === 'aivai' || aiThinking || cachedIsGameOver() || replying || localResigned) return;
    const myColor = (mode === 'pvai') ? humanColor : game.turn;
    const myTurn = (mode === 'pvp') ? true : (game.turn === humanColor);
    const sq = game.board[dr][dc];
    const isMyPiece = sq && colorOf(sq) === myColor;

    if (selected) {
      // 试图走子
      if (myTurn) {
        const moves = cachedLegalMoves().filter(m =>
          m.from[0] === selected[0] && m.from[1] === selected[1] &&
          m.to[0] === dr && m.to[1] === dc);
        if (moves.length > 0) {
          const promo = moves.find(m => m.promotion);
          if (promo) { openPromo(moves, noAnim); return; }
          doMove(moves[0], null, noAnim);
          return;
        }
      }
      // 不能走到这里；如果是己方棋子且轮到己方，则切换选中
      if (isMyPiece && myTurn) { selectAt(dr, dc); return; }
      selected = null; renderBoard(); renderPieceInfo(); return;
    }
    // 未选中时：轮到己方点击己方棋子才选中并显示走法；
    // 对方回合点击己方棋子不选中（避免显示空白的“无走法”误导），明确提示等待。
    if (isMyPiece && myTurn) selectAt(dr, dc);
    else if (isMyPiece) toast('轮到对方走棋，请等待对方落子');
  }
  function selectAt(dr, dc) { selected = [dr, dc]; cursorPos = [dr, dc]; renderBoard(); renderPieceInfo(); }

  /* ---------- 升变弹窗 ---------- */
  function openPromo(moves, noAnim) {
    pendingPromo = moves;
    pendingPromoNoAnim = !!noAnim;
    const color = game.turn;
    const order = ['q', 'r', 'b', 'n'];
    promoChoices.innerHTML = order.map(t => `<div class="pc ${color}" data-p="${t}">${GLYPH[t]}</div>`).join('');
    promoModal.classList.remove('hidden');
  }
  promoChoices.addEventListener('click', e => {
    const pc = e.target.closest('.pc');
    if (!pc || !pendingPromo) return;
    const t = pc.dataset.p;
    const mv = pendingPromo.find(m => m.promotion === t);
    pendingPromo = null;
    promoModal.classList.add('hidden');
    if (mv) doMove(mv, null, pendingPromoNoAnim);
  });

  function getRecentKeyCounts() {
    const map = Object.create(null);
    for (let i = 0; i < game.positionHistory.length; i++) {
      const k = game.positionHistory[i];
      map[k] = (map[k] || 0) + 1;
    }
    return map;
  }

  /* ---------- 开局库：主流开局的前几手，AI 开局不再乱走 ---------- */
  function bookMove() {
    const log = game.moveLog; // SAN 数组
    if (log.length >= 10) return null; // 只负责前 5 个回合左右
    const depth = log.length;
    const candidates = [];
    for (const line of OPENINGS) {
      if (line.length > depth) {
        let match = true;
        for (let i = 0; i < depth; i++) if (line[i] !== log[i]) { match = false; break; }
        if (match) candidates.push(line[depth]);
      }
    }
    if (!candidates.length) return null;
    const san = candidates[Math.floor(Math.random() * candidates.length)];
    const legal = cachedLegalMoves();
    return legal.find(m => game.moveToSAN(m) === san) || null;
  }

  /* ---------- AI 后台计算（Web Worker） ----------
   * AI 搜索移到独立线程，界面在思考期间保持流畅；
   * Worker 不可用（旧浏览器/file:// 协议）时自动降级为同步计算。 */
  let aiWorker = null;
  const aiPending = new Map();
  let aiReqId = 0;
  let aiCancelFn = null;      // 取消当前 AI 任务（worker 可取消；同步降级时不可用）
  let aiCanceled = false;     // 本回合是否点过取消
  let aiProgress = null;      // { depth, maxDepth } AI 思考进度

  function initAIWorker() {
    try {
      if (typeof Worker !== 'undefined' && typeof window !== 'undefined' &&
          location.protocol !== 'file:' && location.protocol !== 'chrome-extension:') {
        aiWorker = new Worker('js/ai-worker.js');
        aiWorker.onmessage = e => {
          const d = e.data || {};
          if (d.type === 'progress') {
            // 迭代加深进度：更新状态栏「正在搜索第 N 层」
            if (aiProgress && d.id === aiProgress.id) {
              aiProgress.depth = d.depth;
              aiProgress.maxDepth = d.maxDepth || aiProgress.maxDepth;
              renderPanel();
            }
            return;
          }
          const p = aiPending.get(d.id);
          if (!p) return;
          aiPending.delete(d.id);
          if (d.ok) p.resolve(d.stopped ? null : d.res); // 被取消的搜索返回 null，UI 丢弃
          else p.reject(new Error(d.error || 'AI worker error'));
        };
        aiWorker.onerror = () => {
          // worker 崩溃 → 清空挂起请求并降级为同步
          try { if (aiWorker) aiWorker.terminate(); } catch (_) {}
          aiWorker = null;
          for (const p of aiPending.values()) p.reject(new Error('AI worker crashed'));
          aiPending.clear();
        };
      }
    } catch (e) { aiWorker = null; }
  }

  /** 调用 AI 选择走法；优先 worker，失败自动同步降级。timeLimit(ms)>0 时走时间管理模式。
   *  progressObj：可选 { id, depth, maxDepth }，worker 每层完成会回填 depth（进度显示用） */
  function askAI(board, color, depth, castling, enPassant, randomness, recentKeys, timeLimit, progressObj) {
    timeLimit = timeLimit || 0;
    return new Promise((resolve, reject) => {
      if (aiWorker) {
        const id = ++aiReqId;
        if (progressObj) progressObj.id = id; // 绑定：进度消息按此 id 匹配
        aiPending.set(id, { resolve, reject });
        aiCancelFn = () => { try { aiWorker.postMessage({ type: 'cancel', id }); } catch (_) {} };
        try {
          aiWorker.postMessage({ id, board, color, depth, castling, enPassant, randomness: randomness || 0, recentKeys: recentKeys || null, timeLimit });
        } catch (e) {
          aiPending.delete(id);
          try { if (aiWorker) aiWorker.terminate(); } catch (_) {}
          aiWorker = null;
          try { resolve(chooseMove(board, color, depth, castling, enPassant, randomness || 0, recentKeys || null, timeLimit)); }
          catch (e2) { reject(e2); }
        }
      } else {
        aiCancelFn = null;
        try { resolve(chooseMove(board, color, depth, castling, enPassant, randomness || 0, recentKeys || null, timeLimit)); }
        catch (e) { reject(e); }
      }
    });
  }

  /* 取消 AI 思考：丢弃本次搜索结果，回合交还玩家 */
  function onAiCancel() {
    if (!aiThinking) return;
    aiCanceled = true;
    if (aiCancelFn) aiCancelFn();
    else aiThinking = false; // 同步降级：直接结束思考状态（搜索已无法打断）
    aiProgress = null;
    updateAiCancelBtn();
    renderPanel();
  }

  function updateAiCancelBtn() {
    const btn = $('aiCancelBtn');
    if (!btn) return;
    btn.classList.toggle('hidden', !(aiThinking && mode === 'pvai'));
  }

  /* ---------- AI：人机 ---------- */
  function maybeAIMove() {
    if (mode !== 'pvai' || game.turn !== aiColor || game.isGameOver() || menuShown || localResigned) return;
    aiThinking = true;
    aiCanceled = false;
    const diff = diffConfig(sel.diff);
    aiProgress = { id: 0, depth: 0, maxDepth: diff.depth };
    updateAiCancelBtn();
    renderPanel();
    const delay = Math.max(1000, settings.aiDelay || 1000);
    setTimeout(async () => {
      if (mode !== 'pvai' || game.turn !== aiColor || game.isGameOver() || menuShown || localResigned) { aiThinking = false; aiProgress = null; updateAiCancelBtn(); renderPanel(); return; }
      const keys = getRecentKeyCounts();
      let res = null;
      const bm = bookMove(); // 开局阶段优先走开局库
      if (bm) res = { move: bm, score: 0 };
      if (!res) {
        try { res = await askAI(game.board, aiColor, diff.depth, game.castling, game.enPassant, diff.randomness, keys, diff.timeLimit, aiProgress); }
        catch (err) { console.error('AI 出错：', err); res = null; }
      }
      aiProgress = null;
      updateAiCancelBtn();
      // await 期间局面可能已变化，或用户点了取消
      if (mode !== 'pvai' || game.turn !== aiColor || game.isGameOver() || menuShown || aiCanceled) { aiThinking = false; renderPanel(); return; }
      aiThinking = false;
      if (res && res.move) doMove(res.move);
      else {
        const legal = game.legalMoves();
        if (legal.length) doMove(legal[0]);
        else renderPanel();
      }
    }, delay);
  }

  /* ---------- AI：斗蛐蛐 ---------- */
  function startAIVsAI() { aiGen++; aivaiPaused = false; aiBusy = false; updateAivaiToggle(); stepAI(); }
  function stopAIVsAI() { aiGen++; aiBusy = false; aiThinking = false; aiProgress = null; document.querySelectorAll('.anim-piece').forEach(g => g.remove()); }

  // 斗蛐蛐单链：两个 AI 共用一个链，同一时刻只有一个 AI 在决策/动画。
  // 一个 AI 落子（幽灵飞行+原棋子替换回来）完成后才解锁，并**从替换回来那一刻**开始计算下一次间隔。
  function stepAI() {
    const myGen = aiGen;
    if (mode !== 'aivai' || game.isGameOver(true) || aivaiPaused || aiBusy) return;
    aiBusy = true; // 上锁：另一个 AI 此时不允许决策
    const color = game.turn;
    const diffId = color === 'w' ? sel.diffW : sel.diffB;
    const diff = diffConfig(diffId);
    const keys = getRecentKeyCounts();
    aiThinking = true;
    aiProgress = { id: 0, depth: 0, maxDepth: diff.depth };
    renderPanel();
    (async () => {
      let res = null;
      // 开局阶段优先走开局库
      const bm = bookMove();
      if (bm) res = { move: bm, score: 0 };
      // 15% 随机出招（优先选「该局面未出现过的」着法），打破长循环
      if (!res && Math.random() < 0.15) {
        const legal = game.legalMoves();
        const nr = legal.filter(m => !keys[positionKey(makeMove(game.board, m), color === 'w' ? 'b' : 'w', updateCastling(game.castling, m), m.double ? squareName(m.from[0] + (color === 'w' ? -1 : 1), m.from[1]) : null)]);
        if (nr.length) res = { move: nr[Math.floor(Math.random() * nr.length)], score: 0 };
      }
      if (!res) {
        try { res = await askAI(game.board, color, diff.depth, game.castling, game.enPassant, diff.randomness, keys, diff.timeLimit, aiProgress); }
        catch (err) { console.error('AI 出错：', err); res = null; }
      }
      // await 期间可能被停止/暂停
      aiProgress = null;
      aiThinking = false;
      if (aiGen !== myGen || mode !== 'aivai' || game.isGameOver(true) || aivaiPaused) { aiBusy = false; renderPanel(); return; }
      const mv = (res && res.move) ? res.move : (game.legalMoves()[0] || null);
      if (!mv) { aiBusy = false; renderPanel(); return; }
      doMove(mv, over => {
        aiBusy = false; // 原棋子已替换回来，解锁
        if (aiGen !== myGen || mode !== 'aivai' || over || game.isGameOver(true) || aivaiPaused) return;
        // 从这里（替换回来之后）才开始计算落子间隔
        const delay = Math.max(1000, settings.aiDelay || 1000);
        setTimeout(() => {
          if (aiGen !== myGen || mode !== 'aivai' || aivaiPaused || game.isGameOver(true)) return;
          stepAI();
        }, delay);
      });
    })();
  }

  function updateAivaiToggle() { aivaiToggle.textContent = aivaiPaused ? '继续' : '暂停'; }

  /* ---------- 提示 ---------- */
  function explainHint(move) {
    // 生成“为什么这步好”的文字说明：吃子 / 升变 / 子力优势变化 / 是否将军
    const parts = [];
    if (move.captured) parts.push('吃掉对方的' + PIECE_NAME_CN[move.captured]);
    if (move.promotion) parts.push('升变为' + PIECE_NAME_CN[move.promotion.toUpperCase()]);
    const before = evaluate(game.board);
    const nb = makeMove(game.board, move);
    const after = evaluate(nb);
    const delta = (game.turn === 'w') ? (after - before) : (before - after);
    parts.push('局面优势变化 ' + (delta >= 0 ? '+' : '') + (delta / 100).toFixed(1));
    const opp = game.turn === 'w' ? 'b' : 'w';
    const oppK = findKing(nb, opp);
    if (oppK && isSquareAttacked(nb, oppK[0], oppK[1], game.turn)) parts.push('将军');
    return '建议走 ' + game.moveToSAN(move) + '：' + parts.join('，');
  }

  function onHint() {
    if (mode === 'aivai' || aiThinking || game.isGameOver() || replying || localResigned) return;
    if (mode === 'pvai' && game.turn !== humanColor) return;
    if (mode === 'pvai' && sel.submode === 'rating') return; // 评分模式无提示
    (async () => {
      let res = null;
      try { res = await askAI(game.board, game.turn, 5, game.castling, game.enPassant, 0, null, 700); }
      catch (err) { console.error('AI 提示出错：', err); return; }
      // await 期间局面可能变化
      if (mode === 'aivai' || aiThinking || game.isGameOver() || replying || localResigned) return;
      if (!res || !res.move) return;
      hintMove = { from: res.move.from, to: res.move.to };
      renderBoard();
      if (settings.sound) sndHint();
      if (mode === 'pvai' && sel.submode === 'practice') {
        const desc = explainHint(res.move);
        if (desc) { statusEl.textContent = desc; statusEl.classList.remove('alert'); }
      }
    })();
  }

  function onResign() {
    // 本地（pvp / pvai）：二次点击确认，防误触
    if (mode !== 'pvp' && mode !== 'pvai') return;
    if (localResigned || replying || menuShown) return;
    if (resignArmTimer) {
      // 已在确认状态，第二次点击 → 正式投降
      clearTimeout(resignArmTimer); resignArmTimer = null;
      resignBtn.textContent = '投降'; resignBtn.classList.remove('danger');
      finishLocalResign();
      return;
    }
    resignBtn.textContent = '确认投降？';
    resignBtn.classList.add('danger');
    resignArmTimer = setTimeout(() => {
      resignBtn.textContent = '投降';
      resignBtn.classList.remove('danger');
      resignArmTimer = null;
    }, 3000);
  }

  /* 本地投降：认输方输、对方胜；记录战绩、停钟、音效、终局文案 */
  function finishLocalResign() {
    if (mode !== 'pvp' && mode !== 'pvai') return;
    if (localResigned || cachedIsGameOver(mode === 'aivai')) return;
    const color = mode === 'pvp' ? game.turn : humanColor; // pvp=当前走棋方认输，pvai=玩家认输
    localResigned = color;
    stopClock();
    const winner = color === 'w' ? 'b' : 'w';
    recordResult(color);
    const wName = winner === 'w' ? '白方' : '黑方';
    const lName = color === 'w' ? '白方' : '黑方';
    if (mode === 'pvai') {
      const humanWon = winner === humanColor;
      turnTitle.textContent = humanWon ? '你获胜（对方认输）' : '你认输了';
      statusEl.textContent = humanWon ? 'AI 认输，你获胜！' : '你认输了，AI 获胜';
    } else {
      turnTitle.textContent = wName + '获胜（' + lName + '认输）';
      statusEl.textContent = lName + '认输，' + wName + '获胜';
    }
    statusEl.classList.add('alert');
    if (settings.sound) {
      if (mode === 'pvp') sndWin();
      else if (winner === humanColor) sndWin(); else sndLose();
    }
    selected = null; hintMove = null;
    renderPanel(); // 短路显示认输文案（不覆盖）
    clearSave(); // 认输即终局，不再提供“继续上局”
    // 评分模式：投降也是一局结束，照常弹出表现评分与段位评定；练习模式弹质量报告
    if (mode === 'pvai' && sel.submode === 'rating') setTimeout(showRating, 1100);
    else if (mode === 'pvai' && moveQualityLog.length) setTimeout(showQuality, 1000);
  }

  resignBtn.addEventListener('click', onResign);
  $('aiCancelBtn').addEventListener('click', onAiCancel);

  /* ---------- 评分模式：表现评分与段位评定 ---------- */
  let ratingLog = [];          // 评分模式：玩家每步的 centipawn 损失
  let moveQualityLog = [];     // 人机对局：玩家每步 { san, acc }（终局质量报告用）
  let qualityBest = null;      // 玩家走子前，引擎在相同局面的最佳分数（玩家视角）

  function moveAccuracy(loss) {
    // 把单步 centipawn 损失映射到 0-100 的准确率（Lichess 风格梯度，分布有区分度）
    if (loss === 0) return 100;     // 完美：走了引擎首选
    if (loss <= 15) return 96;      // 极佳
    if (loss <= 40) return 88;      // 好棋
    if (loss <= 80) return 75;      // 一般
    if (loss <= 150) return 60;     // 较软
    if (loss <= 300) return 42;     // 失误
    if (loss <= 600) return 25;     // 严重失误
    return 10;                       // 败招
  }

  function computeRating() {
    const me = humanColor, ai = aiColor;
    const resigned = !!localResigned;                    // 投降：视作终局且未获胜
    const over = resigned || game.isGameOver();
    const checkmate = !resigned && game.isCheckmate();
    const win = checkmate && game.turn !== me;           // 轮到对方却无棋可走 → 我方胜
    const matDiff = (materialTotal(me) - materialTotal(ai)) / 100; // 兵单位
    let score = 0;
    if (win) score += 58;
    else if (game.isStalemate()) score += 30;
    else if (over) score += 10;
    else score += 5;
    // 子力：赢棋子力领先加分；输棋子力亏损越多分越低（不仁慈，可打到极低分）
    if (win) score += Math.max(0, Math.min(22, matDiff * 2));
    else if (over) score += Math.max(-12, Math.min(0, matDiff * 1.5));
    // 胜局效率：40–90 步取胜加分，磨到 110+ 步只给少量加分
    const ply = game.moveLog.length;
    if (win) { if (ply >= 40 && ply <= 90) score += 8; else if (ply > 110) score += 2; }
    // 逐着准确率（与引擎最佳着对比），占最终分 40% 权重；下得差会把分拉得很低
    let acc = null;
    if (ratingLog.length) {
      acc = Math.round(ratingLog.reduce((s, l) => s + moveAccuracy(l), 0) / ratingLog.length);
      score = Math.round(score * 0.6 + acc * 0.4);
    }
    // 输得干净利落（大劣势被将死）→ 允许 0 分
    score = Math.round(Math.max(0, Math.min(100, score)));
    // 段位 0–10：score/10 取整，且不得超过所选 AI 段位；0 段 = 无段位（不对应任何 AI 难度）
    const rank = Math.min(sel.diff, Math.floor(score / 10));
    return { score, rank, win, over, acc };
  }

  function showRating() {
    const { score, rank, win, over, acc } = computeRating();
    const aiName = diffConfig(sel.diff).label;
    const rankName = rank === 0 ? '无段位' : DIFF_LEVEL_NAME[rank];
    const capped = rank === sel.diff && score / 10 >= sel.diff;
    // 记录评分战绩（历史 + 最佳）
    const rec = { score, rank, win, diff: sel.diff, date: new Date().toISOString().slice(0, 10) };
    stats.ratingHistory.unshift(rec);
    if (stats.ratingHistory.length > 20) stats.ratingHistory.length = 20;
    if (!stats.ratingBest || score > stats.ratingBest.score) stats.ratingBest = rec;
    saveStats();
    $('ratingBody').innerHTML = `
      <div class="rating-score">${score}</div>
      <div class="rating-score-sub">满分 100</div>
      <div class="rating-row"><span>对战结果</span><b>${win ? '获胜' : (localResigned ? '认输' : '未获胜')}（对手：${aiName} AI）</b></div>
      <div class="rating-row"><span>综合评分</span><b>${score} / 100</b></div>
      ${acc !== null ? `<div class="rating-row"><span>着法准确率</span><b>${acc}%</b></div>` : ''}
      <div class="rating-row"><span>评定段位</span><span class="rank-badge">${rankName}${rank > 0 ? ' · ' + rank + ' 段' : ''}</span></div>
      <div class="rating-tip">段位上限为你选择的 AI 段位（${aiName}）。${rank === 0 ? '表现还需努力，先赢下一盘吧。' : capped ? '已达到该 AI 段位上限，可以挑战更高段位了。' : '离更高段位还差一点，继续加油。'}</div>`;
    $('ratingModal').classList.remove('hidden');
    if (settings.sound) { if (score >= 80) sndWin(); else if (score >= 50) sndDraw(); else sndLose(); }
  }

  /* 练习模式终局报告：每步着法质量曲线（纯 CSS 条形图，零依赖） */
  function showQuality() {
    const log = moveQualityLog;
    if (!log.length) return;
    const avg = Math.round(log.reduce((s, x) => s + x.acc, 0) / log.length);
    // 最近 20 步（从第 2 步开始显示，第 1 步对局初期通常意义不大）
    const rows = log.slice(-20).map((x, i) => {
      const color = x.acc >= 90 ? '#2f7d57' : x.acc >= 75 ? '#4a9b6d' : x.acc >= 50 ? '#c9a24a' : x.acc >= 25 ? '#b1402f' : '#7a1f1f';
      const tag = x.acc === 100 ? '完美' : x.acc >= 90 ? '极佳' : x.acc >= 75 ? '好棋' : x.acc >= 50 ? '一般' : x.acc >= 25 ? '失误' : '败招';
      return `<div class="q-row">
        <span class="q-san">${x.san}</span>
        <div class="q-bar"><div class="q-fill" style="width:${Math.max(4, x.acc)}%;background:${color}"></div></div>
        <span class="q-acc" style="color:${color}">${x.acc}%</span>
        <span class="q-tag" style="color:${color}">${tag}</span>
      </div>`;
    }).join('');
    $('qualityBody').innerHTML = `
      <div class="q-head">平均准确率 <b>${avg}%</b> <span class="q-sub">（最近 ${Math.min(log.length, 20)} / ${log.length} 步）</span></div>
      <div class="q-list">${rows}</div>`;
    $('qualityModal').classList.remove('hidden');
    if (settings.sound) { if (avg >= 85) sndWin(); else if (avg >= 50) sndDraw(); else sndLose(); }
  }

  function updateModeUI() {
    const isPvai = mode === 'pvai';
    const isRating = isPvai && sel.submode === 'rating';
    const isTactics = mode === 'tactics';
    // 评分模式：无提示、无悔棋；战术训练：只保留走子与换题
    $('hint').style.display = (isPvai && !isRating) ? '' : 'none';
    $('undo').style.display = (isRating || isTactics) ? 'none' : '';
    $('replay').style.display = isTactics ? 'none' : '';
    // 投降按钮：用 hidden class 控制（.hidden 是 display:none !important，style.display 会被压制）
    resignBtn.classList.toggle('hidden', !(mode === 'pvp' || isPvai));
    resignBtn.textContent = '投降';
    aivaiToggle.classList.toggle('hidden', mode !== 'aivai');
    $('newGame').textContent = isTactics ? '换一题' : '新对局';
    updateAiCancelBtn();
  }

  /* ---------- 棋钟（限时模式） ---------- */
  let clockOn = false;       // 本局是否启用棋钟
  let clockLeft = { w: 0, b: 0 }; // 双方剩余秒数
  let clockTimer = null;     // interval 句柄
  let clockActive = null;    // 当前走钟方 'w'|'b'，null=暂停
  let clockTimeout = null;   // 超时方 'w'|'b'，null=无
  function fmtClock(s) {
    s = Math.max(0, Math.ceil(s));
    const m = Math.floor(s / 60), ss = s % 60;
    return m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + String(ss).padStart(2, '0')
                   : m + ':' + String(ss).padStart(2, '0');
  }
  function updateClockBar() {
    if (!clockOn) { $('clockBar').classList.add('hidden'); return; }
    $('clockBar').classList.remove('hidden');
    $('clockW').textContent = fmtClock(clockLeft.w);
    $('clockB').textContent = fmtClock(clockLeft.b);
    $('clockCellW').classList.toggle('active', clockActive === 'w');
    $('clockCellB').classList.toggle('active', clockActive === 'b');
    $('clockW').classList.toggle('low', clockLeft.w <= 30);
    $('clockB').classList.toggle('low', clockLeft.b <= 30);
  }
  function stopClock() { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }
  function startClock(minutes) {
    stopClock();
    clockOn = !!minutes && minutes > 0;
    clockTimeout = null;
    if (!clockOn) { $('clockBar').classList.add('hidden'); clockActive = null; return; }
    clockLeft = { w: minutes * 60, b: minutes * 60 };
    clockActive = null;
    updateClockActive();
    clockTimer = setInterval(tickClock, 1000);
  }
  function resumeClock() { // 回放等场景暂停后恢复（不回拨时间）
    if (!clockOn || clockTimeout) return;
    clockTimer = setInterval(tickClock, 1000);
    updateClockActive();
  }
  function updateClockActive() {
    if (!clockOn || clockTimeout) { clockActive = null; updateClockBar(); return; }
    if (cachedIsGameOver(mode === 'aivai')) { clockActive = null; }
    else if (mode === 'pvai') clockActive = (game.turn === humanColor) ? game.turn : null; // AI 回合玩家钟暂停
    else if (mode === 'pvp') clockActive = game.turn;
    else clockActive = null; // 斗蛐蛐无棋钟
    updateClockBar();
  }
  function tickClock() {
    if (!clockOn || clockTimeout || clockActive === null) return;
    clockLeft[clockActive]--;
    if (clockLeft[clockActive] <= 0) { clockLeft[clockActive] = 0; updateClockBar(); onClockTimeout(clockActive); }
    else updateClockBar();
  }
  function onClockTimeout(color) {
    stopClock();
    clockTimeout = color;
    clockActive = null; // 停钟方后不再有任何一方走钟
    const winner = color === 'w' ? 'b' : 'w';
    statusEl.textContent = (color === 'w' ? '白方' : '黑方') + '超时，' + (winner === 'w' ? '白方' : '黑方') + '获胜';
    turnTitle.textContent = (color === 'w' ? '白方' : '黑方') + '超时判负';
    if (settings.sound) { if (winner === 'w') sndWin(); else sndLose(); }
    const msg = (mode === 'pvp')
      ? (winner === 'w' ? '白方获胜' : '黑方获胜') + '（' + (color === 'w' ? '白方' : '黑方') + '超时）'
      : (winner === humanColor ? '胜利！' : '超时落败') + '（对方时间用完）';
    toast(msg);
    recordResult();
    if (mode === 'pvai' && sel.submode === 'rating') setTimeout(showRating, 900);
  }

  /* ---------- 战绩统计 ---------- */
  const STATS_KEY = 'chess-stats-v1';
  function freshStats() { return { games: 0, wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, ratingBest: null, ratingHistory: [], history: [] }; }
  function loadStats() {
    try {
      const r = localStorage.getItem(STATS_KEY);
      if (r) {
        const s = Object.assign(freshStats(), JSON.parse(r));
        if (!Array.isArray(s.history)) s.history = [];
        return s;
      }
    } catch (e) {}
    return freshStats();
  }
  let stats = loadStats();
  function saveStats() { try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {} }
  function recordResult(resignColor) {
    if (mode === 'aivai') return; // 观赏局不计战绩
    let winner = null;
    if (resignColor) {
      winner = resignColor === 'w' ? 'b' : 'w'; // 认输方输，对方胜
    } else {
      const over = game.isGameOver(mode === 'aivai') || !!clockTimeout;
      if (!over) return;
      if (game.isCheckmate()) winner = game.turn === 'w' ? 'b' : 'w';
      else if (clockTimeout) winner = clockTimeout === 'w' ? 'b' : 'w';
    }
    stats.games++;
    let res = 'draw';
    if (winner) {
      res = (mode === 'pvp') ? (winner === 'w' ? 'win' : 'loss') : (winner === humanColor ? 'win' : 'loss');
    }
    if (res === 'win') { stats.wins++; stats.streak++; if (stats.streak > stats.bestStreak) stats.bestStreak = stats.streak; }
    else if (res === 'loss') { stats.losses++; stats.streak = 0; }
    else stats.draws++;
    // 逐局历史（战绩趋势图用；保留最近 200 局）
    stats.history.push({ t: Date.now(), res, mode });
    if (stats.history.length > 200) stats.history = stats.history.slice(-200);
    saveStats();
  }
  function renderStats() {
    const winRate = stats.games ? Math.round(stats.wins / stats.games * 100) : 0;
    let html = '<div class="stats-grid">'
      + '<div class="stat-cell"><b>' + stats.games + '</b><span>总对局</span></div>'
      + '<div class="stat-cell"><b>' + winRate + '%</b><span>胜率</span></div>'
      + '<div class="stat-cell"><b>' + stats.wins + '</b><span>胜</span></div>'
      + '<div class="stat-cell"><b>' + stats.draws + '</b><span>和</span></div>'
      + '<div class="stat-cell"><b>' + stats.losses + '</b><span>负</span></div>'
      + '<div class="stat-cell"><b>' + stats.streak + '</b><span>当前连胜</span></div>'
      + '<div class="stat-cell"><b>' + stats.bestStreak + '</b><span>最佳连胜</span></div>'
      + '</div>';
    const hist = stats.history || [];
    if (hist.length) {
      const recent = hist.slice(-20);
      const recentWins = recent.filter(x => x.res === 'win').length;
      const recRate = recent.length ? Math.round(recentWins / recent.length * 100) : 0;
      html += '<div class="stats-recent-head">最近 ' + recent.length + ' 局 · 胜率 ' + recRate + '%（左旧右新）</div>'
        + '<div class="stats-strip">';
      recent.forEach(h => {
        const cls = h.res === 'win' ? 's-win' : h.res === 'loss' ? 's-lose' : 's-draw';
        html += '<i class="' + cls + '" title="' + (h.res === 'win' ? '胜' : h.res === 'loss' ? '负' : '和') + '"></i>';
      });
      html += '</div>'
        + '<div class="stats-dist">'
        + '<i class="d-win" style="width:' + (stats.games ? Math.round(stats.wins / stats.games * 100) : 0) + '%"></i>'
        + '<i class="d-draw" style="width:' + (stats.games ? Math.round(stats.draws / stats.games * 100) : 0) + '%"></i>'
        + '<i class="d-lose" style="width:' + (stats.games ? Math.max(0, 100 - Math.round(stats.wins / stats.games * 100) - Math.round(stats.draws / stats.games * 100)) : 0) + '%"></i>'
        + '</div>';
    }
    if (stats.ratingBest) {
      const rb = stats.ratingBest;
      const rn = rb.rank === 0 ? '无段位' : DIFF_LEVEL_NAME[rb.rank];
      html += '<div class="stats-best"><span>评分最佳</span><b>' + rb.score + ' 分</b><span class="rank-badge">' + rn + (rb.rank > 0 ? ' · ' + rb.rank + ' 段' : '') + '</span><span class="stats-date">' + rb.date + '</span></div>';
    }
    if (stats.ratingHistory.length) {
      html += '<div class="stats-history">最近评分记录</div>';
      stats.ratingHistory.slice(0, 8).forEach(r => {
        const rn = r.rank === 0 ? '无段位' : DIFF_LEVEL_NAME[r.rank];
        html += '<div class="stats-row"><span class="stats-date">' + r.date + '</span><span class="rank-badge sm">' + rn + '</span><b>' + r.score + ' 分</b><span class="' + (r.win ? 'st-win' : 'st-lose') + '">' + (r.win ? '胜' : '未胜') + '</span><span>' + diffConfig(r.diff).label + '</span></div>';
      });
    }
    $('statsBody').innerHTML = html || '<p class="stats-empty">还没有对局记录，去下一盘吧！</p>';
  }
  $('statsBtn').addEventListener('click', () => { renderStats(); $('statsModal').classList.remove('hidden'); });
  $('statsModal').addEventListener('click', e => { if (e.target === $('statsModal')) $('statsModal').classList.add('hidden'); });
  $('resetStats').addEventListener('click', () => {
    if (!confirm('确定清空全部战绩与评分记录吗？此操作不可恢复。')) return;
    stats = freshStats(); saveStats(); renderStats(); toast('战绩已清空');
  });

  /* ---------- Toast 轻提示 ---------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 1600);
  }

  /* ---------- PGN / FEN 导出 ---------- */
  function resultTag() {
    const over = cachedIsGameOver(mode === 'aivai');
    if (!over) return '*';
    if (cachedIsCheckmate()) return game.turn === 'w' ? '0-1' : '1-0';
    return '1/2-1/2';
  }
  function buildPGNText() {
    const rows = [];
    const log = game.moveLog;
    for (let i = 0; i < log.length; i += 2) {
      rows.push((i / 2 + 1) + '. ' + log[i] + (log[i + 1] ? ' ' + log[i + 1] : ''));
    }
    const who = (side) => {
      if (mode === 'pvp') return side === 'w' ? 'Player1' : 'Player2';
      if (mode === 'aivai') return side === 'w' ? 'AI-W (' + diffConfig(sel.diffW).label + ')' : 'AI-B (' + diffConfig(sel.diffB).label + ')';
      if (mode === 'tactics') return 'Tactics Trainer';
      return humanColor === side ? 'Player' : 'AI (' + diffConfig(sel.diff).label + ')';
    };
    const evt = mode === 'pvp' ? 'Local Game'
      : mode === 'aivai' ? 'AI vs AI'
      : mode === 'tactics' ? 'Tactics Training'
      : (sel.submode === 'rating' ? 'Rating Game' : 'Practice Game');
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    return [
      '[Event "' + evt + '"]', '[Site "WorkBuddy Chess"]',
      '[Date "' + date + '"]', '[Round "1"]',
      '[White "' + who('w') + '"]', '[Black "' + who('b') + '"]',
      '[Result "' + resultTag() + '"]', '',
      rows.join(' ') + (log.length ? ' ' : '') + resultTag()
    ].join('\n');
  }
  function exportPGN() {
    copyText(buildPGNText(), 'PGN 已复制');
  }
  function downloadPGN() {
    const pgn = buildPGNText();
    const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chess-' + new Date().toISOString().slice(0, 10) + '.pgn';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    toast('PGN 已下载');
  }
  function exportFEN() {
    let fen = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let c = 0; c < 8; c++) {
        const p = game.board[r][c];
        if (p) { if (empty) { fen += empty; empty = 0; } fen += p; }
        else empty++;
      }
      if (empty) fen += empty;
      if (r < 7) fen += '/';
    }
    let cw = '';
    if (game.castling.wK) cw += 'K';
    if (game.castling.wQ) cw += 'Q';
    if (game.castling.bK) cw += 'k';
    if (game.castling.bQ) cw += 'q';
    fen += ' ' + game.turn + ' ' + (cw || '-') + ' ' + (game.enPassant || '-') + ' ' + game.halfmove + ' ' + game.fullmove;
    copyText(fen, 'FEN 已复制');
  }
  function copyText(txt, tip) {
    const done = () => toast(tip || '已复制');
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) { toast('复制失败，请手动复制'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, fallback);
    } else fallback();
  }

  /* ---------- 对局自动保存（刷新后可从菜单继续） ---------- */
  const SAVE_KEY = 'chess-save-v1';
  function saveGame() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        mode: mode, submode: sel.submode, humanColor: humanColor, aiColor: aiColor,
        boardFlipped: boardFlipped, diff: sel.diff, diffW: sel.diffW, diffB: sel.diffB,
        clock: sel.clock, clockLeft: clockLeft,
        moves: game.moves
      }));
      updateContinueBtn();
    } catch (e) {}
  }
  function clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
    updateContinueBtn();
  }
  function updateContinueBtn() {
    const btn = $('continueBtn');
    if (!btn) return;
    let has = false;
    try { has = !!localStorage.getItem(SAVE_KEY); } catch (e) {}
    btn.classList.toggle('hidden', !has);
  }
  function continueGame() {
    let save = null;
    try { save = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) {}
    if (!save || !Array.isArray(save.moves) || save.moves.length === 0) { toast('没有可继续的对局'); return; }
    if (resignArmTimer) { clearTimeout(resignArmTimer); resignArmTimer = null; }
    localResigned = null;
    resignBtn.textContent = '投降';
    resignBtn.classList.remove('danger');
    mode = save.mode || 'pvai';
    sel.mode = mode;
    sel.submode = save.submode || 'practice';
    sel.color = save.humanColor || 'w';
    sel.diff = save.diff || 5;
    sel.diffW = save.diffW || 5;
    sel.diffB = save.diffB || 5;
    sel.clock = save.clock || 0; // 恢复时制（修复：旧存档不丢棋钟配置）
    if (mode === 'pvai') {
      humanColor = save.humanColor || 'w';
      aiColor = save.aiColor || (humanColor === 'w' ? 'b' : 'w');
      boardFlipped = !!save.boardFlipped;
    } else {
      boardFlipped = false;
    }
    game.reset();
    startClock(+sel.clock); // 按存档时制启动棋钟
    for (const m of save.moves) {
      try { game.apply(m); } catch (e) { break; } // 异常着法直接截断
    }
    // 恢复剩余时间（若存档带 clockLeft 且启用棋钟）
    if (sel.clock && save.clockLeft) {
      clockLeft.w = (save.clockLeft.w != null) ? save.clockLeft.w : sel.clock * 60;
      clockLeft.b = (save.clockLeft.b != null) ? save.clockLeft.b : sel.clock * 60;
      updateClockBar();
      updateClockActive();
    }
    selected = null; hintMove = null; cursorPos = [6, 4]; aiThinking = false; aivaiPaused = false; aiBusy = false;
    invalidateLegalCache();
    clearTT();
    updateModeUI();
    hideMenu();
    renderAll();
    if (settings.sound) sndStart();
    if (mode === 'aivai' && !game.isGameOver(true)) startAIVsAI();
    else if (mode === 'pvai' && game.turn === aiColor && !game.isGameOver()) maybeAIMove();
  }

  /* ---------- 对局回放 ---------- */
  let replying = false;
  let replayAt = 0;
  let replayMoves = []; // 回放会话的完整着法记录（独立于 game.moves，防止被截断）
  let replayTimer = null;   // 自动播放定时器
  let replayPlaying = false;
  function stopReplayTimer() {
    if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
    replayPlaying = false;
    const b = $('replayPlay');
    if (b) b.textContent = '播放';
  }
  function enterReplay() {
    if (game.moves.length === 0) { toast('还没有可回放的着法'); return; }
    stopAIVsAI();
    stopClock(); // 回放期间冻结棋钟
    stopReplayTimer();
    replying = true;
    replayMoves = game.moves.slice();
    const max = replayMoves.length;
    $('replaySlider').max = max;
    replayAt = max;
    $('replaySlider').value = max;
    updateReplayInfo();
    $('replayModal').classList.remove('hidden');
  }
  function updateReplayInfo() {
    $('replayInfo').textContent = '第 ' + replayAt + ' / ' + replayMoves.length + ' 步';
  }
  function goReplay(n) {
    const max = replayMoves.length;
    n = Math.max(0, Math.min(max, n));
    replayAt = n;
    game.restoreToPly(replayMoves, n);
    invalidateLegalCache();
    selected = null; hintMove = null;
    $('replaySlider').value = n;
    updateReplayInfo();
    renderAll();
    if (replayPlaying && n >= max) stopReplayTimer(); // 播完自动停
  }
  function toggleReplayPlay() {
    if (!replying) return;
    if (replayPlaying) { stopReplayTimer(); return; }
    if (replayAt >= replayMoves.length) goReplay(0); // 播完/在最末 → 从头播
    const speed = +($('replaySpeed').value || 800);
    replayPlaying = true;
    $('replayPlay').textContent = '暂停';
    replayTimer = setInterval(() => {
      if (!replying) { stopReplayTimer(); return; }
      if (replayAt >= replayMoves.length) { stopReplayTimer(); return; }
      goReplay(replayAt + 1);
    }, speed);
  }
  function onReplaySpeed() {
    if (!replying || !replayPlaying) return;
    if (replayTimer) clearInterval(replayTimer); // 换速重建定时器
    const speed = +($('replaySpeed').value || 800);
    replayTimer = setInterval(() => {
      if (!replying) { stopReplayTimer(); return; }
      if (replayAt >= replayMoves.length) { stopReplayTimer(); return; }
      goReplay(replayAt + 1);
    }, speed);
  }
  function exitReplay() {
    if (!replying) return;
    stopReplayTimer();
    replying = false;
    $('replayModal').classList.add('hidden');
    // 关键：回放只是观看——退出时把棋盘恢复到最新一手，绝不把对局历史留在中间步
    game.restoreToPly(replayMoves, replayMoves.length);
    invalidateLegalCache();
    selected = null; hintMove = null;
    renderAll();
    resumeClock(); // 退出回放恢复棋钟（时间不回拨）
    if (mode === 'aivai' && !game.isGameOver(true) && !aivaiPaused) startAIVsAI();
    else if (mode === 'pvai' && game.turn === aiColor && !game.isGameOver()) maybeAIMove();
  }

  /* ---------- 新对局 / 悔棋 ---------- */
  function newGame() {
    if (replying) exitReplay();
    stopAIVsAI();
    if (resignArmTimer) { clearTimeout(resignArmTimer); resignArmTimer = null; }
    localResigned = null;
    resignBtn.textContent = '投降';
    resignBtn.classList.remove('danger');
    clearSave(); // 新对局：清除上一局存档
    if (mode === 'pvai') { ratingLog = []; moveQualityLog = []; qualityBest = null; }
    if (mode === 'pvai') {
      humanColor = sel.color;
      aiColor = humanColor === 'w' ? 'b' : 'w';
      boardFlipped = (humanColor === 'b');
    }
    game.reset();
    startClock(+sel.clock); // 按菜单时制启动棋钟
    selected = null; hintMove = null; cursorPos = [6, 4]; aiThinking = false; aivaiPaused = false; aiBusy = false;
    invalidateLegalCache();
    clearTT(); // 新对局清空置换表
    updateModeUI();
    renderAll();
    if (mode === 'aivai') startAIVsAI();
    else if (mode === 'pvai' && game.turn === aiColor) maybeAIMove();
  }

  function onUndo() {
    if (replying || localResigned) return;
    stopAIVsAI();
    const n = (mode === 'pvai') ? 2 : 1;
    for (let i = 0; i < n; i++) if (!game.undo()) break;
    selected = null; hintMove = null; aiThinking = false;
    invalidateLegalCache();
    renderAll();
    saveGame();
    updateClockActive(); // 悔棋后按当前轮到方继续走钟（时间不回拨）
  }

  /* ---------- 菜单显示/隐藏 ---------- */
  function showMenu() {
    const menu = $('menu'), app = $('app');
    stopAIVsAI();
    stopClock(); // 回菜单停钟
    document.querySelectorAll('.anim-piece').forEach(g => g.remove()); // 清掉飞行中的幽灵棋子
    if (resignArmTimer) { clearTimeout(resignArmTimer); resignArmTimer = null; }
    localResigned = null;
    cursorPos = null;
    tactics = null;
    resignBtn.textContent = '投降';
    resignBtn.classList.remove('danger');
    menuShown = true;
    app.classList.add('hidden');
    menu.classList.remove('hidden', 'fade-out');
    menu.style.transition = 'opacity 0.34s ease, transform 0.34s cubic-bezier(0.2,0.7,0.25,1)';
    menu.style.opacity = '0';
    menu.style.transform = 'scale(0.96)';
    void menu.offsetWidth;
    requestAnimationFrame(() => {
      menu.style.opacity = '';
      menu.style.transform = '';
    });
  }
  function hideMenu() {
    const menu = $('menu'), app = $('app');
    menuShown = false;
    menu.style.transition = '';
    menu.classList.add('fade-out');
    setTimeout(() => {
      menu.classList.add('hidden');
      menu.classList.remove('fade-out');
      app.classList.remove('hidden');
    }, 360);
  }

  /* ---------- 菜单交互 ---------- */
  function setupSeg(containerId, attr, key) {
    const c = $(containerId);
    c.addEventListener('click', e => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      c.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      sel[key] = b.dataset[attr];
      if (key === 'mode' || key === 'submode') updateMenuVisibility();
    });
  }
  function updateMenuVisibility() {
    const isPvai = sel.mode === 'pvai';
    $('grpColor').classList.toggle('hidden', !isPvai);
    $('grpSubmode').classList.toggle('hidden', !isPvai);
    $('grpDiff').classList.toggle('hidden', !isPvai);
    $('grpDiffAI').classList.toggle('hidden', sel.mode !== 'aivai');
    $('grpClock').classList.toggle('hidden', sel.mode === 'aivai');
    // 难度滑条标签随子模式切换：练习=AI 难度，评分=选择 AI 段位
    // 关键：只改文本节点和 #diffVal 的内容，绝不用 innerHTML 重建——否则 setupDiffRange 拿到的
    // #diffVal 引用会变成游离节点，导致拖滑条时数值不刷新（要切走切回才会重新显示）。
    const diffLabel = $('diffLabel');
    if (diffLabel) {
      diffLabel.firstChild.nodeValue = (sel.submode === 'rating' ? '选择 AI 段位' : 'AI 难度') + ' ';
      const dv = $('diffVal');
      if (dv) dv.textContent = sel.diff;
    }
    const note = $('ratingNote');
    if (note) note.classList.toggle('hidden', sel.submode !== 'rating');
  }
  setupSeg('menuMode', 'mode', 'mode');
  setupSeg('menuColor', 'color', 'color');
  setupSeg('menuSubmode', 'submode', 'submode');
  setupSeg('menuClock', 'clock', 'clock');
  function setupDiffRange(id, key) {
    const r = $(id), v = $(id.replace('menuDiff', 'diff') + 'Val');
    r.addEventListener('input', () => {
      sel[key] = +r.value;
      v.textContent = r.value;
    });
  }
  setupDiffRange('menuDiff', 'diff');
  setupDiffRange('menuDiffW', 'diffW');
  setupDiffRange('menuDiffB', 'diffB');
  updateMenuVisibility();

  $('startBtn').addEventListener('click', () => {
    mode = sel.mode;
    if (resignArmTimer) { clearTimeout(resignArmTimer); resignArmTimer = null; }
    localResigned = null;
    resignBtn.textContent = '投降';
    resignBtn.classList.remove('danger');
    clearSave(); // 新对局：清除上一局存档
    if (mode === 'pvai') { ratingLog = []; moveQualityLog = []; qualityBest = null; }
    if (mode === 'pvai') {
      humanColor = sel.color;
      aiColor = humanColor === 'w' ? 'b' : 'w';
      boardFlipped = (humanColor === 'b');
    } else {
      boardFlipped = false;
    }
    game.reset();
    startClock(+sel.clock); // 按菜单时制启动棋钟
    selected = null; hintMove = null; cursorPos = [6, 4]; aiThinking = false; aivaiPaused = false; aiBusy = false;
    invalidateLegalCache();
    clearTT(); // 新对局清空置换表
    updateModeUI();
    hideMenu();
    renderAll();
    if (settings.sound) sndStart();
    if (mode === 'aivai') startAIVsAI();
    else if (mode === 'pvai' && game.turn === aiColor) maybeAIMove();
  });

  /* ---------- 设置弹窗 ---------- */
  function syncSettingsUI() {
    document.querySelectorAll('[data-setting]').forEach(inp => { inp.checked = !!settings[inp.dataset.setting]; });
    const r = $('aiDelayRange'), v = $('aiDelayVal');
    if (r) { r.value = settings.aiDelay; v.textContent = settings.aiDelay; }
    document.querySelectorAll('#themeSeg .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === settings.theme);
    });
  }
  document.querySelectorAll('[data-setting]').forEach(inp => {
    inp.addEventListener('change', () => { settings[inp.dataset.setting] = inp.checked; saveSettings(); renderAll(); });
  });
  document.querySelectorAll('#themeSeg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.theme = btn.dataset.theme;
      applyTheme(); saveSettings(); syncSettingsUI();
    });
  });
  $('aiDelayRange').addEventListener('input', e => {
    settings.aiDelay = +e.target.value;
    $('aiDelayVal').textContent = settings.aiDelay;
    saveSettings();
  });
  $('resetSettings').addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS); applyTheme(); saveSettings(); syncSettingsUI(); renderAll();
  });
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));
  });
  settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });
  promoModal.addEventListener('click', e => { if (e.target === promoModal) promoModal.classList.add('hidden'); });
  $('ratingModal').addEventListener('click', e => { if (e.target === $('ratingModal')) $('ratingModal').classList.add('hidden'); });

  /* ---------- 控件绑定 ---------- */
  $('newGame').addEventListener('click', () => {
    if (mode === 'tactics') { nextTacticsPuzzle(); return; }
    newGame();
  });
  $('tacticsBtn').addEventListener('click', startTactics);
  $('continueBtn').addEventListener('click', continueGame);
  $('undo').addEventListener('click', onUndo);
  $('hint').addEventListener('click', onHint);
  $('flip').addEventListener('click', () => { boardFlipped = !boardFlipped; renderBoard(); });
  $('replay').addEventListener('click', enterReplay);
  $('replayClose').addEventListener('click', exitReplay);
  $('replayCloseX').addEventListener('click', exitReplay);
  $('replayStart').addEventListener('click', () => goReplay(0));
  $('replayPlay').addEventListener('click', toggleReplayPlay);
  $('replaySpeed').addEventListener('change', onReplaySpeed);
  $('replayPrev').addEventListener('click', () => goReplay(replayAt - 1));
  $('replayNext').addEventListener('click', () => goReplay(replayAt + 1));
  $('replaySlider').addEventListener('input', e => goReplay(+e.target.value));
  $('replayModal').addEventListener('click', e => { if (e.target === $('replayModal')) exitReplay(); });
  $('btnPgn').addEventListener('click', exportPGN);
  $('btnPgnDl').addEventListener('click', downloadPGN);
  $('btnFen').addEventListener('click', exportFEN);
  $('backMenu').addEventListener('click', () => {
    if (replying) { replying = false; $('replayModal').classList.add('hidden'); }
    stopAIVsAI(); showMenu();
  });  aivaiToggle.addEventListener('click', () => {
    aivaiPaused = !aivaiPaused; updateAivaiToggle();
    // 恢复时：若当前没有 AI 在决策/动画中，立即接上单链；若在动画中，等其完成后由回调自动续链
    if (!aivaiPaused && !game.isGameOver(true) && !aiBusy) stepAI();
  });
  $('settings').addEventListener('click', () => { syncSettingsUI(); settingsModal.classList.remove('hidden'); });

  /* ---------- 走子交互：点击 + 拖拽（pointer events，支持触摸） ---------- */
  let dragState = null;     // { r, c, x, y, active, ghost, pieceEl }
  let suppressClick = false; // 拖拽落子后吞掉随之而来的 click

  /* ---------- 键盘走子：方向键移光标、回车/空格走子、退格悔棋、Esc 取消 ---------- */
  function moveCursor(dr, dc) {
    if (!cursorPos) cursorPos = [6, 4];
    const nr = cursorPos[0] + dr, nc = cursorPos[1] + dc;
    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) return;
    cursorPos = [nr, nc];
    renderBoard(); renderPieceInfo(); // 保留 selected：选中后移动光标，合法走点提示不消失
  }
  function onKeyDown(e) {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // 输入框聚焦时不抢键盘
    if (menuShown || mode === 'aivai' || localResigned) return;
    if (replying) { if (e.key === 'Escape') exitReplay(); return; }
    const key = e.key;
    if (key.startsWith('Arrow')) {
      e.preventDefault();
      const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];
      // 棋盘翻转时方向视觉反转
      moveCursor(boardFlipped ? -d[0] : d[0], boardFlipped ? -d[1] : d[1]);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      e.preventDefault();
      if (!cursorPos) cursorPos = [6, 4];
      if (aiThinking || cachedIsGameOver()) return;
      // 已选中且光标在原格：取消选中（符合"再点一次"的直觉；快捷走可用方向键+回车两步）
      if (selected && cursorPos[0] === selected[0] && cursorPos[1] === selected[1]) {
        selected = null; hintMove = null; renderBoard(); renderPieceInfo();
        return;
      }
      onSquareClick(cursorPos[0], cursorPos[1], true); // 复用点击逻辑：选中/走子
      if (selected) cursorPos = [selected[0], selected[1]]; // 选中后光标跟随，回车即走子
      return;
    }
    if (key === 'Backspace' || key === 'Delete') {
      e.preventDefault();
      if (selected) { selected = null; hintMove = null; renderBoard(); renderPieceInfo(); }
      else if (!aiThinking && !cachedIsGameOver()) onUndo();
      return;
    }
    if (key === 'Escape') {
      if (selected) { selected = null; hintMove = null; renderBoard(); renderPieceInfo(); }
      return;
    }
  }
  document.addEventListener('keydown', onKeyDown);

  boardEl.addEventListener('pointerdown', e => {
    if (mode === 'aivai' || mode === 'tactics' || aiThinking || game.isGameOver() || replying || localResigned) return;
    const sq = e.target.closest('.square');
    if (!sq) return;
    const r = +sq.dataset.r, c = +sq.dataset.c;
    const p = game.board[r][c];
    if (!p) return;
    const myColor = (mode === 'pvai') ? humanColor : game.turn;
    if (colorOf(p) !== myColor) return;
    const myTurn = (mode === 'pvp') ? true : (game.turn === humanColor);
    if (!myTurn) return; // 对方回合只允许点击查看
    dragState = { r, c, x: e.clientX, y: e.clientY, active: false, ghost: null, pieceEl: sq.querySelector('.piece') };
  });

  boardEl.addEventListener('pointermove', e => {
    if (!dragState) return;
    if (!dragState.active) {
      // 移动超过阈值才进入拖拽模式（否则视为点击）
      if (Math.hypot(e.clientX - dragState.x, e.clientY - dragState.y) > 6) {
        dragState.active = true;
        setHover(null); // 拖拽期间隐藏信息卡
        selectAt(dragState.r, dragState.c); // 高亮源格与合法目标
        const pe = dragState.pieceEl;
        if (pe) {
          const g = document.createElement('div');
          g.className = 'piece drag-ghost ' + (pe.classList.contains('w') ? 'w' : 'b');
          g.textContent = pe.textContent;
          document.body.appendChild(g);
          const rect = pe.getBoundingClientRect();
          g.style.width = rect.width + 'px';
          g.style.height = rect.height + 'px';
          dragState.ghost = g;
          dragState.hw = rect.width / 2;
          dragState.hh = rect.height / 2;
          pe.classList.add('drag-source-hidden');
          moveDragGhost(e.clientX, e.clientY);
        }
      }
    } else {
      moveDragGhost(e.clientX, e.clientY);
    }
  });

  function moveDragGhost(x, y) {
    if (!dragState || !dragState.ghost) return;
    dragState.ghost.style.left = (x - dragState.hw) + 'px';
    dragState.ghost.style.top = (y - dragState.hh) + 'px';
  }

  function endDrag(e) {
    if (!dragState) return;
    const state = dragState;
    const wasActive = state.active;
    dragState = null;
    if (state.ghost) {
      state.ghost.remove();
      if (state.pieceEl) state.pieceEl.classList.remove('drag-source-hidden');
    }
    if (!wasActive) return; // 未进入拖拽，交给 click 走子
    suppressClick = true;   // 吞掉松手触发的 click
    if (replying || mode === 'aivai' || game.isGameOver()) { selected = null; renderBoard(); renderPieceInfo(); return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const sq = el && el.closest('.square');
    if (sq) onSquareClick(+sq.dataset.r, +sq.dataset.c, true); // 拖拽落子：跳过移动动画
    else { selected = null; renderBoard(); renderPieceInfo(); } // 拖出棋盘 → 取消
  }
  boardEl.addEventListener('pointerup', endDrag);
  boardEl.addEventListener('pointercancel', e => endDrag(e));
  // 拖出棋盘外松手也要清理（幽灵残留防护）
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', e => endDrag(e));

  boardEl.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    const sq = e.target.closest('.square');
    if (!sq) return;
    onSquareClick(+sq.dataset.r, +sq.dataset.c);
  });

  /* ---------- 启动 ---------- */
  applyTheme();
  initAIWorker(); // AI 后台线程（失败自动降级为同步）
  updateContinueBtn();
  showMenu();
})();
