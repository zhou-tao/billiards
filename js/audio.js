/* ============================================================
 * audio.js —— WebAudio 实时合成音效（零外部素材）
 * 球碰球脆响 / 库边闷响 / 落袋 / 出杆 / 犯规 / 胜利旋律
 * ============================================================ */
(function () {
  'use strict';

  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let muted = false;

  /** 首次用户交互时调用：创建 AudioContext 与噪声缓冲 */
  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      // 预生成白噪声缓冲
      const len = Math.floor(ctx.sampleRate * 0.25);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) {
      ctx = null;
    }
  }

  /** 指数包络 */
  function env(gainNode, t0, peak, dur) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t0 + 0.004);
    g.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  /** 噪声脉冲（经滤波） */
  function noise(t0, dur, filterType, freq, q, peak) {
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    env(g, t0, peak, dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  /** 扫频振荡音 */
  function tone(t0, dur, type, f0, f1, peak) {
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    const g = ctx.createGain();
    env(g, t0, peak, dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /** 球碰球：清脆的“嗒”，强度越大越响、音色越沉（带节流，开球时不炸耳） */
  let lastHitT = -1, lastCushionT = -1;
  function hitBall(i) {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    if (t - lastHitT < 0.03) return;
    lastHitT = t;
    const k = Math.min(1, i / 5);
    noise(t, 0.045, 'bandpass', 2800 + k * 900, 1.2, 0.10 + k * 0.30);
    tone(t, 0.05, 'triangle', 2300 - k * 600, 420, 0.05 + k * 0.16);
  }

  /** 撞库边：低频闷响（带节流） */
  function cushion(i) {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    if (t - lastCushionT < 0.06) return;
    lastCushionT = t;
    const k = Math.min(1, i / 4);
    tone(t, 0.09, 'sine', 190, 90, 0.05 + k * 0.16);
    noise(t, 0.06, 'lowpass', 500, 0.7, 0.04 + k * 0.10);
  }

  /** 落袋：碰撞杂音 + 下滑音 + 底部闷响 */
  function pocket() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    noise(t, 0.05, 'bandpass', 1500, 1, 0.16);
    tone(t + 0.03, 0.20, 'sine', 520, 150, 0.20);
    tone(t + 0.10, 0.12, 'sine', 90, 60, 0.16);
  }

  /** 出杆击打白球 */
  function cueStrike(p) {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    noise(t, 0.03, 'highpass', 1800, 0.8, 0.10 + p * 0.16);
    tone(t, 0.045, 'square', 1100, 750, 0.04 + p * 0.08);
  }

  /** 犯规：下滑双音 */
  function foul() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    tone(t, 0.28, 'sawtooth', 220, 105, 0.10);
    tone(t + 0.06, 0.25, 'sawtooth', 165, 82, 0.08);
  }

  /** 胜利：上行琶音 */
  function win() {
    if (!ctx || muted) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.50].forEach((f, idx) => {
      tone(t + idx * 0.13, 0.32, 'triangle', f, f, 0.16);
      tone(t + idx * 0.13, 0.32, 'sine', f * 2, f * 2, 0.05);
    });
  }

  window.SFX = {
    init, hitBall, cushion, pocket, cueStrike, foul, win,
    setMuted(m) { muted = m; },
    get muted() { return muted; },
  };
})();

