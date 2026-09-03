/* ============================================================
 * loader.js —— 全屏加载层
 * 1) 台球开球动画：白球撞散 15 球三角球堆（纯 CSS 循环）
 * 2) 进度驱动：window.__BOOT 供 game.js 分阶段上报真实进度
 * 3) 安全兜底：无论成败，最迟 12s 强制放行主菜单
 *
 * 本脚本必须最先执行（不 defer），让动画在重型脚本解析前就绪
 * ============================================================ */
(function () {
  'use strict';

  const loader = document.getElementById('loader');
  if (!loader) return;

  const stageText = document.getElementById('ld-stage-text');
  const pctEl = document.getElementById('ld-pct');
  const fill = document.getElementById('ld-fill');
  const marker = document.getElementById('ld-marker');
  const rack = document.getElementById('ld-rack');

  /* ---------- 1) 球堆：15 球三角阵（尖端朝左），每球带散开向量 ---------- */
  const BALL = 22;                       // 球直径 px，与 CSS 一致
  const STEP_X = Math.round(BALL * 0.866);   // 行距 = sin60° × 球径（相邻行相切）
  const STEP_Y = BALL;                   // 行内球心距（相切）
  // 斯诺克/八球标准配色：1-7 全色球 → 8 黑八 → 9-15 花色球（带白底 + 彩色条）
  const COLORS = [, '#f3c623', '#2f6fe0', '#e23b32', '#7a3bd6', '#ef7e1c', '#1e9e4e', '#9c2b4a',
    '#181c26', '#f3c623', '#2f6fe0', '#e23b32', '#7a3bd6', '#ef7e1c', '#1e9e4e', '#9c2b4a'];

  let n = 0;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c <= r; c++) {
      n++;
      const hx = r * STEP_X;                                 // 行：往右推进
      const hy = Math.round(c * STEP_Y - r * STEP_Y / 2);    // 列：整行居中
      // 散开方向：大致朝右扇形扩散，带一点随机抖动，观感更像真实开球
      const ang = Math.atan2(hy + (Math.random() - 0.5) * 10, 30 + (Math.random() - 0.5) * 14);
      const dist = 110 + Math.random() * 60;
      const ex = Math.round(hx + Math.cos(ang) * dist);
      const ey = Math.round(hy + Math.sin(ang) * dist);

      const b = document.createElement('i');
      b.className = 'ld-ball' + (n > 8 ? ' stripe' : '') + (n === 8 ? ' eight' : '');
      if (n === 8) b.textContent = '8';
      b.style.setProperty('--c', COLORS[n]);
      b.style.setProperty('--hx', hx + 'px');
      b.style.setProperty('--hy', hy + 'px');
      b.style.setProperty('--ex', ex + 'px');
      b.style.setProperty('--ey', ey + 'px');
      rack.appendChild(b);
    }
  }

  /* ---------- 2) 进度：真实进度 + 平滑爬升兜底 ---------- */
  let real = 0;        // game.js 上报的真实进度
  let shown = 0;       // 当前显示的进度（平滑过渡）
  let finished = false;
  const CAP = 82;      // 无真实上报时最多爬到 82%，杜绝“假完成”

  function render(v) {
    const p = Math.min(100, Math.max(0, v));
    fill.style.width = p + '%';
    marker.style.left = p + '%';
    pctEl.textContent = Math.round(p) + '%';
  }

  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const target = finished ? 100 : Math.min(CAP, real + 14);
    shown += (target - shown) * Math.min(1, dt * 2.2);
    render(shown);
    if (!finished || shown < 99.5) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  render(0);

  /** 收尾：白球滑满 100% → 缩入袋口 → 加载层淡出移除 */
  function finish() {
    if (finished) return;
    finished = true;
    window.__BOOT.ready = true;                    // 主菜单即刻可点
    setTimeout(() => {
      marker.classList.add('in');                  // 白球落袋
      loader.classList.add('done');                // 淡出（pointer-events 同步解除）
      loader.style.pointerEvents = 'none';
    }, 260);
    setTimeout(() => loader.remove(), 1000);
  }

  window.__BOOT = {
    ready: false,
    /** 阶段上报：更新文案与进度（进度只进不退） */
    stage(text, v) {
      if (text) stageText.textContent = text;
      if (v != null) real = Math.max(real, v);
    },
    /** 让调用方把大块构建拆成小段：每段之间至少绘制一帧，进度可见地推进 */
    frame() {
      return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    },
    done: finish,
  };

  // 安全兜底：加载异常/卡死也不允许主菜单被永久锁死
  setTimeout(finish, 12000);
})();