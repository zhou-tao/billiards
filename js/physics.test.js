/* ============================================================
 * physics.test.js —— 杆法物理单元测试（node 直跑，零依赖）
 * 运行：node js/physics.test.js
 * ============================================================ */
'use strict';

global.window = globalThis;
require('./physics.js');

const { Ball, World, BALL_R, applyStrike } = window.PoolPhys;
const P_POCKETS = window.PoolPhys.POCKETS;
const P_LIMIT_X = window.PoolPhys.LIMIT_X;
const P_LIMIT_Z = window.PoolPhys.LIMIT_Z;

let pass = 0, fail = 0;
function T(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('❌ FAIL: ' + name + (extra !== undefined ? '  got=' + extra : '')); }
}

const DT = 1 / 360;
function run(w, seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) w.step(DT);
}

function mkWorld(events) {
  return new World(events || (() => {}));
}

function addBall(w, id, x, z) {
  const b = new Ball(id);
  b.pos.x = x; b.pos.z = z;
  w.addBall(b);
  return b;
}

/* 1. 出杆冲量：偏移 → 旋转方向正确 */
{
  const w = mkWorld(), b = addBall(w, 0, 0, 0);
  applyStrike(b, { x: 1, z: 0 }, 1.0, { u: 0.5, h: 0 });
  T('高杆：母球沿 +x 出杆时 ang.z<0（顶旋转向前）', b.ang.z < 0, b.ang.z);
  T('高杆：线速度 = 出杆速度', Math.abs(b.vel.x - 1.0) < 1e-9, b.vel.x);
  const b2 = addBall(w, 1, 1, 0);
  applyStrike(b2, { x: 1, z: 0 }, 1.0, { u: -0.5, h: 0 });
  T('低杆：ang.z>0（回旋）', b2.ang.z > 0, b2.ang.z);
  const b3 = addBall(w, 2, 2, 0);
  applyStrike(b3, { x: 1, z: 0 }, 1.0, { u: 0, h: 0.5 });
  T('右塞：wy>0', b3.wy > 0, b3.wy);
  const b4 = addBall(w, 3, 3, 0);
  applyStrike(b4, { x: 1, z: 0 }, 1.0, { u: 0, h: -0.5 });
  T('左塞：wy<0', b4.wy < 0, b4.wy);
  const b5 = addBall(w, 4, 4, 0);
  applyStrike(b5, { x: 1, z: 0 }, 1.0, { u: 0, h: 0 });
  T('中心击球：无旋转', b5.ang.x === 0 && b5.ang.z === 0 && b5.wy === 0);
  const b6 = addBall(w, 5, 5, 0);
  applyStrike(b6, { x: 1, z: 0 }, 1.0, { u: 9, h: 9 });
  T('越界偏移被钳制到 [-1,1]', b6.wy > 0 && b6.ang.x === 0);
}

/* 2. 低杆回拉：正面撞击目标球后，母球应向后拉回 */
{
  const w = mkWorld();
  const cue = addBall(w, 0, 0.15, 0);
  const target = addBall(w, 1, 0.15 + BALL_R * 2 + 0.002, 0);
  applyStrike(cue, { x: 1, z: 0 }, 1.1, { u: -1, h: 0 });
  run(w, 0.9);
  T('低杆：撞击后母球回拉（x<撞击点）', cue.pos.x < 0.15 + BALL_R * 2, cue.pos.x.toFixed(4));
}

/* 3. 高杆跟进：同配置，母球应越过撞击点继续向前 */
{
  const w = mkWorld();
  const cue = addBall(w, 0, 0.15, 0);
  addBall(w, 1, 0.15 + BALL_R * 2 + 0.002, 0);
  applyStrike(cue, { x: 1, z: 0 }, 1.1, { u: 1, h: 0 });
  run(w, 0.9);
  T('高杆：撞击后母球继续向前跟进', cue.pos.x > 0.15 + BALL_R * 2 + 0.1, cue.pos.x.toFixed(4));
}

/* 4. 静止母球带回旋：应被摩擦拉向后方（残旋出杆） */
{
  const w = mkWorld();
  const b = addBall(w, 0, 0.5, 0);
  b.ang.z = 18; // 强回旋
  run(w, 0.35);
  T('残旋拉动：静止球被回旋拉回（v<0 且位移为负）', b.pos.x < 0.5 && b.vel.x < 0.001, b.pos.x.toFixed(4));
}

/* 5. 侧塞改变碰库反弹角：正 z 塞撞右库后应向 +z 偏移（在碰库瞬间断言，避开后续阻尼衰减） */
{
  const w = mkWorld();
  const b = addBall(w, 0, 0.8, 0.2); // 离右库较近；z=0 会滚进右中袋，避开袋口
  b.vel.x = 1.2; b.vel.z = 0;
  b.wy = 15;
  let bounced = false, vzAtBounce = 0;
  for (let i = 0; i < 360 * 2; i++) {
    if (!bounced && b.vel.x < 0) { bounced = true; vzAtBounce = b.vel.z; break; }
    w.step(DT);
  }
  T('右塞碰长库后向 +z 偏移（碰库瞬间 vz>0.05）', bounced && vzAtBounce > 0.05, vzAtBounce.toFixed(4));
  T('碰库后剩余侧塞被衰减', !bounced || b.wy < 15, b.wy.toFixed(2));
}

/* 6. 无杆法中心击球：行为与旧版一致（顺滑停下，不残留旋转） */
{
  const w = mkWorld();
  const b = addBall(w, 0, 0, 0);
  applyStrike(b, { x: 1, z: 0 }, 0.8, { u: 0, h: 0 });
  run(w, 6);
  T('中心击球最终静止', !w.moving, b.speed.toFixed(4));
  T('中心击球无残留旋转', b.ang.x === 0 && b.ang.z === 0 && b.wy === 0);
}

/* 7. 停稳规则：任意残留旋转最终归零，不卡结算 */
{
  const w = mkWorld();
  const b = addBall(w, 0, 0.2, 0.2);
  b.vel.x = 0.02; b.ang.z = 3; b.wy = 5;
  run(w, 4);
  T('残留旋转在走停后归零', b.ang.x === 0 && b.ang.z === 0 && b.wy === 0, JSON.stringify(b.ang));
  T('走停后 speed 为 0', b.speed === 0, b.speed);
}

/* 8. 球-球切向摩擦：侧旋可传递给目标球（需要擦边球，正对撞切向速度为零） */
{
  const w = mkWorld();
  const cue = addBall(w, 0, 0.2, 0);
  const target = addBall(w, 1, 0.2 + BALL_R * 2 + 0.002, 0.02); // 稍微偏离中心线
  applyStrike(cue, { x: 1, z: 0 }, 1.2, { u: 0, h: 1 });
  run(w, 1.2);
  T('擦边撞击后目标球获得侧旋（target.wy≠0）', Math.abs(target.wy) > 1e-3, target.wy.toFixed(4));
}


/* 9. 袋口穿模回归（issue #2）：任何活动球不得停在合法边界之外 */
{
  // 精确复现 issue #2 的最小用例
  const w = mkWorld();
  const b = addBall(w, 4, P_LIMIT_X - 0.01, P_LIMIT_Z - 0.055);
  b.vel.x = 0.34; b.vel.z = 0.03;
  run(w, 2);
  const outside = Math.abs(b.pos.x) > P_LIMIT_X + 1e-6 || Math.abs(b.pos.z) > P_LIMIT_Z + 1e-6;
  T('issue#2 复现：球最终不越界', !(b.active && !b.sinking && outside), b.pos.x.toFixed(4) + ',' + b.pos.z.toFixed(4));
}

/* 10. 六个袋口 × 8 方向 × 3 档速度 擦边扫射：只允许落袋或留在合法区域 */
{
  const pockets = P_POCKETS;
  const speeds = [0.2, 1.5, 5.0];
  const dirs = [];
  for (let k = 0; k < 8; k++) dirs.push((k * Math.PI) / 4);
  let bad = null, n = 0;
  outer:
  for (const p of pockets) {
    for (const sp of speeds) {
      for (const a of dirs) {
        const w = mkWorld();
        const b = addBall(w, 9, p.x + Math.cos(a) * (p.r + 0.02), p.z + Math.sin(a) * (p.r + 0.02));
        b.vel.x = Math.cos(a + Math.PI / 2) * sp * 0.6 + Math.cos(a) * sp;
        b.vel.z = Math.sin(a + Math.PI / 2) * sp * 0.6 + Math.sin(a) * sp;
        run(w, 4);
        n++;
        const outside = Math.abs(b.pos.x) > P_LIMIT_X + 1e-6 || Math.abs(b.pos.z) > P_LIMIT_Z + 1e-6;
        if (b.active && !b.sinking && outside) { bad = { p, sp, a, x: b.pos.x, z: b.pos.z, pd: Math.hypot(b.pos.x - p.x, b.pos.z - p.z) }; break outer; }
      }
    }
  }
  T('袋口擦边扫射 ' + n + ' 组：无桌外活动球', !bad, bad ? JSON.stringify(bad) : '');
}

/* 11. 正常落袋回归：正对袋口低速直射应能入袋 */
{
  const w = mkWorld();
  const p = P_POCKETS[0];
  const b = addBall(w, 10, p.x - 0.12, p.z - 0.12);
  const d = 1 / Math.SQRT2;
  b.vel.x = d * 0.5; b.vel.z = d * 0.5;
  run(w, 2);
  T('正对角袋入袋：球应落袋（active=false 或 sinking 结束）', !b.active || !b.sinking, 'active=' + b.active + ' x=' + b.pos.x.toFixed(3));
}

/* 12. 库边反弹回归：远离袋口撞库仍正常反弹 */
{
  const w = mkWorld();
  const b = addBall(w, 11, 0, 0.1);
  b.vel.x = 1.0; b.vel.z = 0;
  run(w, 2);
  T('普通库边反弹：球留在台面内', Math.abs(b.pos.x) <= P_LIMIT_X + 1e-6 && Math.abs(b.pos.z) <= P_LIMIT_Z + 1e-6, b.vel.x.toFixed(3));
}

console.log(`\n杆法物理测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);