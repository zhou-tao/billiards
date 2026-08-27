/* ============================================================
 * audio.js —— WebAudio 实时合成音效（零外部素材）
 * 球碰球脆响 / 库边闷响 / 落袋 / 出杆 / 犯规 / 胜利旋律 /
 * 进球与胜利的赛场欢呼（人声声浪 + 掌声 + 口哨，柔和不刺耳）
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

  /* ---- 进球欢呼：低中频“呜哇”声浪慢起慢落 + 零散掌声 + 一记口哨。
   * 刻意避开高频嘶嘶感：宽 Q 带通、整体低通柔化、慢包络，强度参数控制热烈程度 ---- */
  let lastCrowdT = -1;

  /**
   * @param {number} [intensity=1] 热烈程度：进球 1，清台/获胜 1.6
   */
  function crowd(intensity) {
    if (!ctx || muted) return;
    const K = Math.max(0.6, Math.min(2, intensity || 1));
    const t = ctx.currentTime;
    if (t - lastCrowdT < 1.3) return;   // 一杆内连续落袋只欢呼一次
    lastCrowdT = t;

    // 总线：整体慢起慢落 + 低通去掉毛刺
    const DUR = 1.7 + 0.5 * K;
    const bus = ctx.createGain();
    const softener = ctx.createBiquadFilter();
    softener.type = 'lowpass';
    softener.frequency.value = 2400;
    softener.Q.value = 0.4;
    bus.connect(softener);
    softener.connect(master);
    const bg = bus.gain;
    bg.setValueAtTime(0.0001, t);
    bg.linearRampToValueAtTime(0.55 + 0.25 * K, t + 0.28);       // 缓慢涌起
    bg.linearRampToValueAtTime(0.40 + 0.18 * K, t + DUR * 0.55); // 维持略有回落
    bg.linearRampToValueAtTime(0.0001, t + DUR);                 // 自然消散

    // 人声层：带通噪声环回播放，中心频率缓漂 + 音量呼吸波动，像远处人群齐声
    const voiceSpec = [
      { f: 250, drift: -45, q: 0.7, peak: 0.34, wob: 2.4, pan: -0.35 },
      { f: 360, drift: -60, q: 0.8, peak: 0.27, wob: 3.0, pan: 0.30 },
      { f: 500, drift: -70, q: 0.9, peak: 0.21, wob: 2.2, pan: 0.00 },
      { f: 700, drift: -110, q: 1.0, peak: 0.13, wob: 3.4, pan: -0.20 },
      { f: 880, drift: -130, q: 1.1, peak: 0.08, wob: 2.8, pan: 0.40 },
    ];
    for (let i = 0; i < voiceSpec.length; i++) {
      if (i >= 3 && Math.random() > 0.35 + 0.3 * K) continue;   // 强度低时略去高频层
      const v = voiceSpec[i];
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      src.playbackRate.value = 0.85 + Math.random() * 0.3;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(v.f, t);
      f.frequency.linearRampToValueAtTime(v.f + v.drift, t + DUR * 0.85);
      f.Q.value = v.q;
      const g = ctx.createGain();
      g.gain.value = v.peak * (0.8 + 0.4 * Math.random());
      const lfo = ctx.createOscillator();                       // 声浪起伏
      lfo.frequency.value = v.wob;
      const lg = ctx.createGain();
      lg.gain.value = g.gain.value * 0.45;
      lfo.connect(lg);
      lg.connect(g.gain);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) pan.pan.value = v.pan;
      src.connect(f);
      f.connect(g);
      g.connect(pan || bus);
      if (pan) pan.connect(bus);
      src.start(t);
      src.stop(t + DUR + 0.15);
      lfo.start(t);
      lfo.stop(t + DUR + 0.15);
    }

    // 掌声：随机时刻的高频短促拍击，错落分布
    const claps = Math.round(16 + 14 * K);
    for (let i = 0; i < claps; i++) {
      const ct = t + 0.12 + Math.random() * (DUR * 0.78);
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.playbackRate.value = 0.9 + Math.random() * 0.35;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1900 + Math.random() * 1400;
      f.Q.value = 1.6;
      const g = ctx.createGain();
      const cp = (0.10 + Math.random() * 0.12) * (0.7 + 0.3 * K);
      g.gain.setValueAtTime(0.0001, ct);
      g.gain.exponentialRampToValueAtTime(cp, ct + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, ct + 0.07);
      src.connect(f);
      f.connect(g);
      g.connect(bus);
      src.start(ct);
      src.stop(ct + 0.1);
    }

    // 一记上扬口哨点缀（音量极轻）
    tone(t + 0.22, 0.5, 'sine', 850, 1500, 0.016 + 0.01 * K);
    tone(t + 0.30, 0.42, 'sine', 1250, 1700, 0.010 + 0.008 * K);
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
    init, hitBall, cushion, pocket, cueStrike, foul, win, crowd,
    setMuted(m) { muted = m; },
    get muted() { return muted; },
  };
})();
