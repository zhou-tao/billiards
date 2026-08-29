/* ============================================================
 * protocol.js —— 联机消息 schema 校验层（纯函数，零依赖）
 * 浏览器（window.Protocol）与 Node 服务端（module.exports）共用，
 * 服务端不信任客户端字段，客户端对收到的消息同样二次校验。
 *
 * 原则：
 *   - 所有字段只接受白名单结构，多余字段一律丢弃（防字段走私）
 *   - 数值必须为有限数且落在物理合理区间，NaN/Infinity 直接拒绝
 *   - 文案字段限制长度，胜负原因必须是引擎定义的枚举值
 *   - 校验失败返回 null，调用方丢弃整条消息
 *
 * 消息流向（issue #4 修复）：
 *   玩家2 只能发 shotRequest（出杆请求，无球面快照）
 *   房主(玩家1) 才能发 authoritativeShot（带球面快照的权威广播）
 *   服务端按 socket 真实角色决定谁可发哪类消息，旧 'shot' 类型
 *   会被服务端按角色重写为上述两类，兼容旧客户端过渡期。
 * ============================================================ */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.Protocol = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  /* ---- 桌面常量：与 physics.js 保持一致（服务端无 physics.js，这里独立一份） ---- */
  const BALL_R = 0.033;
  const TABLE_W = 2.30, TABLE_H = 1.15;
  const LIMIT_X = TABLE_W / 2 - BALL_R;
  const LIMIT_Z = TABLE_H / 2 - BALL_R;

  /* ---- 胜负原因枚举：与 rules.js 的 resolve() 返回值保持同步 ---- */
  const RULES = root.EightBallRules;
  const WIN_REASONS = (RULES && RULES.WIN_REASONS) || ['黑八犯规', '提前打进黑八'];
  function isWinReason(s) { return typeof s === 'string' && WIN_REASONS.includes(s); }

  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
  function inR(v, lo, hi) { return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi; }
  function clampN(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* ---- 母球击球点 {u 高低杆, h 左右塞}：可省略，省略按中心 ---- */
  function parseContact(c) {
    if (c === undefined || c === null) return { u: 0, h: 0 };
    if (typeof c !== 'object' || Array.isArray(c)) return null;
    if (!inR(c.u, -1, 1) || !inR(c.h, -1, 1)) return null;
    return { u: c.u, h: c.h };
  }

  function parseAimLike(d) {
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
    if (!inR(d.angle, -Math.PI * 4, Math.PI * 4)) return null;   // atan2 值域，留余量
    if (!inR(d.power, 0, 1)) return null;
    const contact = parseContact(d.contact);
    if (!contact) return null;
    return { angle: d.angle, power: d.power, contact };
  }

  /* ---- 球面快照：id 0-15，坐标在球心可达域内（留少量数值误差余量） ---- */
  const SLACK = 0.02;
  function parseBalls(list, allowEmpty) {
    if (!Array.isArray(list) || list.length > 16) return null;
    if (!allowEmpty && list.length < 1) return null;
    const out = [];
    for (const s of list) {
      if (typeof s !== 'object' || s === null || Array.isArray(s)) return null;
      if (!isInt(s.id) || s.id < 0 || s.id > 15) return null;
      if (!inR(s.x, -LIMIT_X - SLACK, LIMIT_X + SLACK)) return null;
      if (!inR(s.z, -LIMIT_Z - SLACK, LIMIT_Z + SLACK)) return null;
      const a = s.a ? 1 : 0, sg = s.s ? 1 : 0;
      if (s.a !== undefined && s.a !== 0 && s.a !== 1) return null;
      if (s.s !== undefined && s.s !== 0 && s.s !== 1) return null;
      if (!isInt(s.pi) || s.pi < -1 || s.pi > 5) return null;
      out.push({
        id: s.id,
        x: clampN(s.x, -LIMIT_X - SLACK, LIMIT_X + SLACK),
        z: clampN(s.z, -LIMIT_Z - SLACK, LIMIT_Z + SLACK),
        a, s: sg, pi: s.pi,
      });
    }
    return out;
  }

  /* t:'aim' —— 瞄准状态广播（双方玩家都可发） */
  function validateAim(d) { return parseAimLike(d); }

  /* t:'shotRequest' —— 玩家2 的出杆请求：绝不允许携带球面快照 */
  function validateShotRequest(d) { return parseAimLike(d); }

  /* t:'authoritativeShot' —— 房主权威出杆广播：必须带合法球面快照 */
  function validateAuthoritativeShot(d) {
    const base = parseAimLike(d);
    if (!base) return null;
    const balls = parseBalls(d.balls);
    if (!balls) return null;
    return Object.assign(base, { balls });
  }

  /* t:'settled' —— 一杆结算快照（房主发布） */
  function validateSettled(d) {
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
    const balls = d.balls === undefined ? [] : parseBalls(d.balls, true);
    if (!balls) return null;
    let rules = null;
    if (d.rules !== undefined) {
      const r = d.rules;
      if (typeof r !== 'object' || r === null || Array.isArray(r)) return null;
      const g = r.groups;
      if (typeof g !== 'object' || g === null || Array.isArray(g)) return null;
      for (const p of [1, 2]) {
        if (g[p] !== null && g[p] !== 'solid' && g[p] !== 'stripe') return null;
        if (typeof r.need8 !== 'object' || r.need8 === null || typeof r.need8[p] !== 'boolean') return null;
      }
      if (typeof r.open !== 'boolean') return null;
      if (!inR(r.player, 1, 2) || !isInt(r.player)) return null;
      if (!Array.isArray(r.potted) || r.potted.length > 15) return null;
      for (const id of r.potted) if (!isInt(id) || id < 1 || id > 15) return null;
      rules = {
        player: r.player,
        groups: { 1: g[1], 2: g[2] },
        open: r.open,
        need8: { 1: !!r.need8[1], 2: !!r.need8[2] },
        potted: r.potted.slice(0, 15),
      };
    }
    if (!isInt(d.score) || d.score < 0 || d.score > 1e7) return null;
    if (!isInt(d.shots) || d.shots < 0 || d.shots > 1e6) return null;
    let msgs = [];
    if (d.msgs !== undefined) {
      if (!Array.isArray(d.msgs) || d.msgs.length > 8) return null;
      msgs = [];
      for (const s of d.msgs) {
        if (typeof s !== 'string' || s.length > 200) return null;
        msgs.push(s);
      }
    }
    const over = !!d.over;
    let winner, reason = null, bih = 0;
    if (over) {
      if (!isInt(d.winner) || d.winner < 1 || d.winner > 2) return null;
      winner = d.winner;
      if (d.reason !== null && d.reason !== undefined) {
        if (!isWinReason(d.reason)) return null;      // 胜负原因只认枚举，XSS 文本直接拒收
        reason = d.reason;
      }
    } else if (d.bih !== undefined) {
      if (!isInt(d.bih) || d.bih < 0 || d.bih > 2) return null;
      bih = d.bih;
    }
    return { balls, rules, score: d.score, shots: d.shots, msgs, over, winner, reason, bih };
  }

  /* t:'placeCue'（玩家2） / t:'cuePlaced'（房主广播）—— 自由球落点 */
  function validatePlaceCue(d) {
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
    if (!inR(d.x, -LIMIT_X, LIMIT_X) || !inR(d.z, -LIMIT_Z, LIMIT_Z)) return null;
    return { x: d.x, z: d.z };
  }
  const validateCuePlaced = validatePlaceCue;

  return {
    BALL_R, LIMIT_X, LIMIT_Z, WIN_REASONS,
    isWinReason,
    validateAim,
    validateShotRequest,
    validateAuthoritativeShot,
    validateSettled,
    validatePlaceCue,
    validateCuePlaced,
  };
});
