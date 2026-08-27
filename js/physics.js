/* ============================================================
 * physics.js —— 轻量台球物理引擎
 * 球的运动积分 / 球-球弹性碰撞 / 库边反弹 / 袋口落袋判定
 * 纯数学运算（桌面平面 x-z），渲染与特效由 game.js / effects.js 处理
 * ============================================================ */
(function () {
  'use strict';

  const BALL_R = 0.033;              // 球半径 (m)
  const TABLE_W = 2.30;              // 库边内沿长边长度 (x)
  const TABLE_H = 1.15;              // 库边内沿短边宽度 (z)

  const RESTITUTION_BALL = 0.93;     // 球-球恢复系数
  const RESTITUTION_CUSHION = 0.76;  // 球-库边恢复系数
  const FRICTION_A = 0.55;           // 滚动摩擦减速度 m/s²
  const DAMPING = 0.30;              // 附加指数阻尼系数
  const STOP_SPEED = 0.015;          // 低于该速度视为停止
  /* ---- 杆法（母球击球点）参数：均可调手感 ---- */
  const SPIN_GAIN = 0.55;            // 击球点偏移 → 旋转量增益
  const SLIDE_FR = 0.8;              // 滑动摩擦减速度 m/s²（自旋与线速度互相转换）
  const STOP_SLIDE = 0.02;           // 接触点滑移速度低于该值视为纯滚动
  const BALL_TANGENT_MU = 0.10;      // 球-球接触切向摩擦系数（传递侧旋/throw）
  const CUSHION_SPIN_KEEP = 0.35;    // 碰库时侧塞转化为切向滚动的比例
  const CUSHION_SPIN_DAMP = 0.45;    // 碰库后剩余侧塞的衰减比例
  const WY_DAMP = 0.8;               // 垂直自旋（侧塞）随滚动自然衰减速率 1/s

  const LIMIT_X = TABLE_W / 2 - BALL_R;  // 球心可到达的边界
  const LIMIT_Z = TABLE_H / 2 - BALL_R;

  // 六个袋口：四角 + 两长边中点（r=捕获半径，mouth=库边不反弹区域）
  const POCKETS = [
    { x: -TABLE_W / 2, z: -TABLE_H / 2, r: 0.066, mouth: 0.150 },
    { x:  TABLE_W / 2, z: -TABLE_H / 2, r: 0.066, mouth: 0.150 },
    { x: -TABLE_W / 2, z:  TABLE_H / 2, r: 0.066, mouth: 0.150 },
    { x:  TABLE_W / 2, z:  TABLE_H / 2, r: 0.066, mouth: 0.150 },
    { x: 0, z: -TABLE_H / 2, r: 0.058, mouth: 0.110 },
    { x: 0, z:  TABLE_H / 2, r: 0.058, mouth: 0.110 },
  ];

  /** 是否处于某个袋口区域（此区域内库边不反弹，球可以滑入袋口） */
  function inPocketZone(x, z) {
    for (let i = 0; i < POCKETS.length; i++) {
      const p = POCKETS[i];
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < p.mouth * p.mouth) return true;
    }
    return false;
  }

  class Ball {
    constructor(id) {
      this.id = id;                 // 0 = 白球（母球）
      this.active = true;           // 在桌面上参与物理
      this.sinking = false;         // 正在播放落袋动画
      this.sinkT = 0;
      this.sinkPocket = null;
      this.pos = { x: 0, y: BALL_R, z: 0 };
      this.vel = { x: 0, y: 0, z: 0 };
      this.lastPos = { x: 0, y: BALL_R, z: 0 };
      // 旋转状态：ang=水平轴角速度（高/低杆），wy=垂直轴角速度（左/右塞）rad/s
      this.ang = { x: 0, z: 0 };
      this.wy = 0;
      this.mesh = null;             // 由渲染层挂载
    }
    get speed() { return Math.hypot(this.vel.x, this.vel.z); }
    stop() { this.vel.x = 0; this.vel.z = 0; this.ang.x = 0; this.ang.z = 0; this.wy = 0; }
  }

  class World {
    /**
     * @param {Function} onEvent 物理事件回调
     *   {type:'ball', intensity, x, z}        球-球碰撞（intensity=法向相对速度）
     *   {type:'cushion', intensity, x, z}     撞击库边
     *   {type:'pocket', ballId, x, z}         落袋
     */
    constructor(onEvent) {
      this.balls = [];
      this.onEvent = onEvent || function () {};
    }

    addBall(b) { this.balls.push(b); return b; }
    reset() { this.balls.length = 0; }

    /** 是否还有球在运动 */
    get moving() {
      for (const b of this.balls) if (b.active && b.speed > 0) return true;
      return false;
    }

    step(dt) {
      // 1. 积分 + 摩擦
      for (const b of this.balls) {
        if (!b.active) continue;
        b.lastPos.x = b.pos.x;
        b.lastPos.z = b.pos.z;
        const sp = b.speed;
                // 接触点滑移速度（含水平自旋）：滑动阶段由滑动摩擦驱动自旋与线速度互相转换
        const sbx = b.vel.x + b.ang.z * BALL_R;
        const sbz = b.vel.z - b.ang.x * BALL_R;
        const s = Math.hypot(sbx, sbz);
        if (s > 1e-9) {
          const k = Math.min(1, SLIDE_FR * dt / s);
          b.vel.x -= sbx * k;
          b.vel.z -= sbz * k;
          b.ang.x += (2.5 / BALL_R) * sbz * k;
          b.ang.z -= (2.5 / BALL_R) * sbx * k;
        }
        b.wy *= Math.max(0, 1 - WY_DAMP * dt);
        const sp2 = b.speed;
        if (sp2 > 0) {
          b.pos.x += b.vel.x * dt;
          b.pos.z += b.vel.z * dt;
          if (s <= STOP_SLIDE) {
            let ns = sp2 - FRICTION_A * dt;
            ns *= Math.max(0, 1 - DAMPING * dt);
            if (ns <= STOP_SPEED) { b.stop(); } else { const k2 = ns / sp2; b.vel.x *= k2; b.vel.z *= k2; }
          }
        } else if (s <= STOP_SLIDE) {
          b.stop();
        }
      }
// 2. 碰撞与约束
      this.collideBalls();
      this.collideCushions();
      this.checkPockets();
    }

    /** 球-球弹性碰撞（等质量）：交换法向速度分量并分离重叠 */
    collideBalls() {
      const bs = this.balls;
      const min = BALL_R * 2;
      for (let i = 0; i < bs.length; i++) {
        const a = bs[i];
        if (!a.active) continue;
        for (let j = i + 1; j < bs.length; j++) {
          const c = bs[j];
          if (!c.active) continue;
          const dx = c.pos.x - a.pos.x;
          const dz = c.pos.z - a.pos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 >= min * min || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d, nz = dz / d;
          // 位置修正：各退一半重叠量
          const push = (min - d) / 2;
          a.pos.x -= nx * push; a.pos.z -= nz * push;
          c.pos.x += nx * push; c.pos.z += nz * push;
          // 冲量：仅处理相互接近的情况
          const rvx = a.vel.x - c.vel.x;
          const rvz = a.vel.z - c.vel.z;
          const vn = rvx * nx + rvz * nz;
          if (vn <= 0) continue;
          const imp = (1 + RESTITUTION_BALL) * vn / 2;
          a.vel.x -= nx * imp; a.vel.z -= nz * imp;
          c.vel.x += nx * imp; c.vel.z += nz * imp;
          // 切向摩擦冲量：传递侧旋并带轻微 throw（幅度按库仑摩擦上限截断）
          const tx = -nz, tz = nx;
          const rvt = (a.vel.x - c.vel.x) * tx + (a.vel.z - c.vel.z) * tz;
          const cap = BALL_TANGENT_MU * ((1 + RESTITUTION_BALL) * vn / 2);
          const jt = Math.max(-cap, Math.min(cap, rvt / 2));
          a.vel.x -= tx * jt; a.vel.z -= tz * jt;
          c.vel.x += tx * jt; c.vel.z += tz * jt;
          const dw = (5 * jt) / (2 * BALL_R);
          a.wy += dw;
          c.wy -= dw;
          if (vn > 0.06) {           // 过滤静止接触的微弱抖动，避免特效/音效刷屏
            this.onEvent({
              type: 'ball',
              intensity: vn,
              aId: a.id,
              bId: c.id,             // 携带球 id，供规则层判定“首碰犯规”
              x: a.pos.x + nx * BALL_R,
              z: a.pos.z + nz * BALL_R,
            });
          }
        }
      }
    }

    /** 库边反弹（袋口区域除外） */
    collideCushions() {
      for (const b of this.balls) {
        if (!b.active) continue;
                // 袋口区域：不参与库边碰撞，改为与“袋口圆口”碰撞（擦过袋口时弹回台面，防止穿进桌框）
        let inPocket = false;
        for (const p of POCKETS) {
          const pdx = b.pos.x - p.x, pdz = b.pos.z - p.z;
          const pd2 = pdx * pdx + pdz * pdz;
          if (pd2 >= p.mouth * p.mouth) continue;
          inPocket = true;
          const pd = Math.sqrt(pd2);
          const rim = p.mouth - 1e-6;
          if (pd >= rim && pd > 1e-9) {
            const nx = pdx / pd, nz = pdz / pd;   // 袋心 → 球心（向外）
            b.pos.x -= nx * (pd - rim);
            b.pos.z -= nz * (pd - rim);
            const vn = b.vel.x * nx + b.vel.z * nz;
            if (vn > 0) {
              b.vel.x -= nx * (1 + RESTITUTION_CUSHION) * vn;
              b.vel.z -= nz * (1 + RESTITUTION_CUSHION) * vn;
              if (vn > 0.08) this.onEvent({ type: 'cushion', intensity: vn, x: b.pos.x, z: b.pos.z });
            }
          }
        }
        if (inPocket) continue;


        if (b.pos.x < -LIMIT_X) {
          b.pos.x = -LIMIT_X;
          if (b.vel.x < 0) this.bounce(b, 'x');
        } else if (b.pos.x > LIMIT_X) {
          b.pos.x = LIMIT_X;
          if (b.vel.x > 0) this.bounce(b, 'x');
        }
        if (b.pos.z < -LIMIT_Z) {
          b.pos.z = -LIMIT_Z;
          if (b.vel.z < 0) this.bounce(b, 'z');
        } else if (b.pos.z > LIMIT_Z) {
          b.pos.z = LIMIT_Z;
          if (b.vel.z > 0) this.bounce(b, 'z');
        }
      }
    }

    bounce(b, axis) {
      const v = axis === 'x' ? Math.abs(b.vel.x) : Math.abs(b.vel.z);
      if (axis === 'x') b.vel.x = -b.vel.x * RESTITUTION_CUSHION;
      else b.vel.z = -b.vel.z * RESTITUTION_CUSHION;
      // 侧塞：库边接触点滑移速度 → 切向滚动（改变反弹角）；剩余侧塞衰减
      const tang = axis === 'x' ? 'z' : 'x';
      b.vel[tang] += b.wy * BALL_R * CUSHION_SPIN_KEEP;
      b.wy *= (1 - CUSHION_SPIN_DAMP);
      if (v > 0.08) {
        this.onEvent({ type: 'cushion', intensity: v, x: b.pos.x, z: b.pos.z });
      }
    }

    /** 落袋检测（含飞出桌面的兜底处理） */
    checkPockets() {
      for (const b of this.balls) {
        if (!b.active) continue;
        let sunk = false;
        for (const p of POCKETS) {
          const dx = b.pos.x - p.x, dz = b.pos.z - p.z;
          if (dx * dx + dz * dz < p.r * p.r) {
            this.sink(b, p);
            sunk = true;
            break;
          }
        }
        if (sunk) continue;
        // 袋口区兜底：擦过袋口而越出台呢的活动球，压回台面（袋口牙），不落袋也不卡进桌框
        if (b.pos.x > LIMIT_X || b.pos.x < -LIMIT_X || b.pos.z > LIMIT_Z || b.pos.z < -LIMIT_Z) {
          if (b.pos.x > LIMIT_X) { if (b.vel.x > 0) b.vel.x = -b.vel.x * RESTITUTION_CUSHION; b.pos.x = LIMIT_X; }
          if (b.pos.x < -LIMIT_X) { if (b.vel.x < 0) b.vel.x = -b.vel.x * RESTITUTION_CUSHION; b.pos.x = -LIMIT_X; }
          if (b.pos.z > LIMIT_Z) { if (b.vel.z > 0) b.vel.z = -b.vel.z * RESTITUTION_CUSHION; b.pos.z = LIMIT_Z; }
          if (b.pos.z < -LIMIT_Z) { if (b.vel.z < 0) b.vel.z = -b.vel.z * RESTITUTION_CUSHION; b.pos.z = -LIMIT_Z; }
        }

        // 兜底：万一穿出边界过远，就近落袋，避免球飞丢
        if (Math.abs(b.pos.x) > TABLE_W / 2 + 0.09 || Math.abs(b.pos.z) > TABLE_H / 2 + 0.09) {
          let best = POCKETS[0], bd = Infinity;
          for (const p of POCKETS) {
            const d = (b.pos.x - p.x) ** 2 + (b.pos.z - p.z) ** 2;
            if (d < bd) { bd = d; best = p; }
          }
          this.sink(b, best);
        }
      }
    }

    sink(b, p) {
      b.active = false;
      b.sinking = true;
      b.sinkT = 0;
      b.sinkPocket = p;
      b.stop();
      this.onEvent({ type: 'pocket', ballId: b.id, x: p.x, z: p.z });
    }

    /**
     * 瞄准预测：白球从 cue 出发沿 (dx,dz)，返回第一次碰到的球或库边
     * @returns {{t:number, ball:Ball|null, gx:number, gz:number}}
     */
    predict(cue, dx, dz) {
      let bestT = Infinity;
      let hitBall = null;
      // 与其他球的首次碰撞（滑动圆 vs 圆）
      for (const b of this.balls) {
        if (!b.active || b === cue) continue;
        const ox = b.pos.x - cue.pos.x;
        const oz = b.pos.z - cue.pos.z;
        const proj = ox * dx + oz * dz;
        if (proj <= 0) continue;
        const per2 = ox * ox + oz * oz - proj * proj;
        const R2 = (BALL_R * 2) ** 2;
        if (per2 > R2) continue;
        const t = proj - Math.sqrt(R2 - per2);
        if (t > 0 && t < bestT) { bestT = t; hitBall = b; }
      }
      // 与库边的首次碰撞
      const wallX = dx > 1e-9 ? (LIMIT_X - cue.pos.x) / dx
                  : dx < -1e-9 ? (-LIMIT_X - cue.pos.x) / dx : Infinity;
      const wallZ = dz > 1e-9 ? (LIMIT_Z - cue.pos.z) / dz
                  : dz < -1e-9 ? (-LIMIT_Z - cue.pos.z) / dz : Infinity;
      const wallT = Math.min(wallX, wallZ);
      if (wallT > 0 && wallT < bestT) { bestT = wallT; hitBall = null; }
      if (bestT === Infinity) bestT = 3;
      return { t: bestT, ball: hitBall, gx: cue.pos.x + dx * bestT, gz: cue.pos.z + dz * bestT };
    }
  }

    /** 出杆：击球点偏移 u（上=高杆 +1 / 下=低杆 -1）、h（左塞 -1 / 右塞 +1）→ 线冲量 + 旋转冲量 */
  function applyStrike(b, dir, speed, contact) {
    const u = Math.max(-1, Math.min(1, contact && contact.u || 0));
    const h = Math.max(-1, Math.min(1, contact && contact.h || 0));
    const dx = dir.x, dz = dir.z;
    b.vel.x = dx * speed;
    b.vel.z = dz * speed;
    const base = SPIN_GAIN * 5 * speed / (2 * BALL_R);
    b.ang.x =  base * u * dz;
    b.ang.z = -base * u * dx;
    b.wy    =  base * h;
  }

window.PoolPhys = {
    BALL_R, TABLE_W, TABLE_H, POCKETS, LIMIT_X, LIMIT_Z,
    Ball, World, inPocketZone, applyStrike,
  };
})();

