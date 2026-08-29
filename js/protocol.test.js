/* ============================================================
 * protocol.test.js —— 联机消息 schema 校验层单元测试（node 直跑，零依赖）
 * 运行：node js/protocol.test.js
 * 覆盖 issue #3/#4/#5 的核心防线：白名单字段、数值范围、
 * 胜负原因枚举、玩家2 伪造快照拒绝、XSS 文案拒收
 * ============================================================ */
'use strict';

require('./rules.js');                 // protocol 优先读取 EightBallRules.WIN_REASONS
const P = require('./protocol.js');

let pass = 0, fail = 0;
function T(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('❌ FAIL: ' + name + (extra !== undefined ? '  got=' + extra : '')); }
}

/* 1. validateAim：合法消息 + 白名单剥除 + 非法拒绝 */
{
  const v = P.validateAim({ t: 'aim', angle: 1.2, power: 0.5, contact: { u: 0.4, h: -0.3 }, hack: '<img>' });
  T('aim 合法字段通过', !!v && v.angle === 1.2 && v.power === 0.5 && v.contact.u === 0.4 && v.contact.h === -0.3);
  T('aim 多余字段被剥除', v && !('hack' in v) && !('t' in v));
  T('aim 省略 contact 按中心处理', !!(P.validateAim({ angle: 0, power: 0 }) && P.validateAim({ angle: 0, power: 0 }).contact.u === 0));
  T('aim 缺 power 拒绝', P.validateAim({ angle: 1 }) === null);
  T('aim power>1 拒绝', P.validateAim({ angle: 1, power: 1.5 }) === null);
  T('aim power 负数拒绝', P.validateAim({ angle: 1, power: -0.1 }) === null);
  T('aim NaN/Infinity 拒绝', P.validateAim({ angle: NaN, power: 0.5 }) === null && P.validateAim({ angle: Infinity, power: 0.5 }) === null);
  T('aim 非对象拒绝', P.validateAim('x') === null && P.validateAim(null) === null && P.validateAim([1]) === null);
  T('aim contact 越界拒绝', P.validateAim({ angle: 0, power: 0, contact: { u: 2, h: 0 } }) === null);
}

/* 2. validateShotRequest：绝不允许携带球面快照（issue #4） */
{
  const v = P.validateShotRequest({ angle: 0.3, power: 0.8, contact: { u: 0, h: 0 } });
  T('shotRequest 合法通过', !!v && !('balls' in v));
  T('shotRequest 类型本身不校验 balls（由服务端角色路由保证）', typeof P.validateShotRequest === 'function');
}

/* 3. validateAuthoritativeShot：球面快照严格校验 */
{
  const good = P.validateAuthoritativeShot({
    angle: 0, power: 1, contact: { u: 0, h: 0 },
    balls: [{ id: 0, x: -0.5, z: 0, a: 1, s: 0, pi: -1 }, { id: 8, x: 0.5, z: 0.2, a: 0, s: 1, pi: 2 }],
  });
  T('authoritativeShot 合法快照通过', !!good && good.balls.length === 2 && good.balls[1].s === 1);
  T('authoritativeShot 缺 balls 拒绝', P.validateAuthoritativeShot({ angle: 0, power: 1 }) === null);
  T('authoritativeShot 球数超 16 拒绝', P.validateAuthoritativeShot({
    angle: 0, power: 1, balls: Array.from({ length: 17 }, (_, i) => ({ id: i % 16, x: 0, z: 0, pi: -1 })),
  }) === null);
  T('authoritativeShot 非法球 id 拒绝', P.validateAuthoritativeShot({
    angle: 0, power: 1, balls: [{ id: 99, x: 0, z: 0, pi: -1 }],
  }) === null);
  T('authoritativeShot 越界坐标拒绝', P.validateAuthoritativeShot({
    angle: 0, power: 1, balls: [{ id: 0, x: 99, z: 0, pi: -1 }],
  }) === null);
  T('authoritativeShot NaN 坐标拒绝', P.validateAuthoritativeShot({
    angle: 0, power: 1, balls: [{ id: 0, x: NaN, z: 0, pi: -1 }],
  }) === null);
  T('authoritativeShot 非法袋口索引拒绝', P.validateAuthoritativeShot({
    angle: 0, power: 1, balls: [{ id: 0, x: 0, z: 0, pi: 9 }],
  }) === null);
  T('authoritativeShot 越界坐标被钳制', (() => {
    const v = P.validateAuthoritativeShot({
      angle: 0, power: 1, balls: [{ id: 0, x: P.LIMIT_X + 0.01, z: 0, pi: -1 }],
    });
    return !!v && v.balls[0].x === P.LIMIT_X + 0.01;
  })());
}

/* 4. validateSettled：胜负原因枚举（issue #3 XSS 防线） */
{
  const base = {
    balls: [], score: 0, shots: 1, msgs: [], over: false,
    rules: { player: 1, groups: { 1: 'solid', 2: 'stripe' }, open: false, need8: { 1: false, 2: true }, potted: [1, 2] },
  };
  T('settled 合法通过', !!P.validateSettled(base));
  T('settled 缺 score 拒绝', P.validateSettled({ ...base, score: undefined }) === null);
  T('settled score 非整数拒绝', P.validateSettled({ ...base, score: 1.5 }) === null);
  T('settled 非法分组拒绝', P.validateSettled({
    ...base, rules: { ...base.rules, groups: { 1: 'hack', 2: null } },
  }) === null);
  T('settled 非法 player 拒绝', P.validateSettled({
    ...base, rules: { ...base.rules, player: 5 },
  }) === null);
  T('settled msgs 超长拒绝', P.validateSettled({ ...base, msgs: ['x'.repeat(201)] }) === null);
  T('settled msgs 非字符串拒绝', P.validateSettled({ ...base, msgs: [42] }) === null);

  T('settled over 合法原因通过', !!P.validateSettled({ ...base, over: true, winner: 1, reason: '黑八犯规' }));
  T('settled over XSS 原因拒绝', P.validateSettled({
    ...base, over: true, winner: 1, reason: '<img src=x onerror=alert(1)>',
  }) === null);
  T('settled over 非法 winner 拒绝', P.validateSettled({
    ...base, over: true, winner: 3, reason: null,
  }) === null);
  T('settled over 缺 winner 拒绝', P.validateSettled({ ...base, over: true }) === null);
  T('settled bih 合法通过', (() => {
    const v = P.validateSettled({ ...base, bih: 2 });
    return !!v && v.bih === 2;
  })());
  T('settled bih 非法拒绝', P.validateSettled({ ...base, bih: 9 }) === null);
}

/* 5. validatePlaceCue / validateCuePlaced：落点范围 */
{
  T('placeCue 合法通过', !!P.validatePlaceCue({ x: 0.1, z: -0.2 }));
  T('placeCue 越界拒绝', P.validatePlaceCue({ x: P.LIMIT_X + 0.1, z: 0 }) === null);
  T('placeCue NaN 拒绝', P.validatePlaceCue({ x: NaN, z: 0 }) === null);
  T('cuePlaced 与 placeCue 同规则', P.validateCuePlaced({ x: 99, z: 0 }) === null);
}

/* 6. WIN_REASONS 与 rules.js 同步 */
{
  T('WIN_REASONS 来自 rules.js', Array.isArray(P.WIN_REASONS) && P.WIN_REASONS.includes('黑八犯规'));
  T('isWinReason 枚举内通过', P.isWinReason('提前打进黑八'));
  T('isWinReason 任意文本拒绝', !P.isWinReason('<script>alert(1)</script>') && !P.isWinReason(''));
}

/* 7. 回归：正常对局消息样例全通过（防误杀） */
{
  const sample = {
    t: 'settled',
    balls: Array.from({ length: 16 }, (_, i) => ({ id: i, x: 0.1 * i - 0.8, z: 0.03 * i - 0.2, a: i % 2, s: 0, pi: -1 })),
    rules: { player: 2, groups: { 1: null, 2: null }, open: true, need8: { 1: false, 2: false }, potted: [] },
    score: 0, shots: 3, msgs: ['⚠ 玩家1犯规：白球落袋', '玩家2 获得自由球'], over: false, bih: 2,
  };
  const v = P.validateSettled(sample);
  T('完整真实 settled 样例通过', !!v && v.balls.length === 16 && v.msgs.length === 2 && v.bih === 2);
}

console.log(`\n消息协议测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
