/* ============================================================
 * rules.js —— 八球（黑八）规则引擎（纯逻辑，零依赖，可独立测试）
 * 状态：当前击球方 / 分组 / 开放球台 / 可打黑八 / 落袋顺序
 * game.js 负责把物理事件喂给引擎，并把引擎裁决应用到画面
 *
 * 犯规判定（标准八球）：
 *   白球落袋 / 未击中任何球 / 首碰目标错误 /
 *   合法首碰后无进球且无任何球碰库（issue #6）
 * 所有犯规 → 下一位玩家获得自由球（白球任意摆放，
 * 由 validatePlacement 校验落点合法性）
 * ============================================================ */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;

  class EightBallRules {
    constructor() {
      this.reset();
    }

    reset() {
      this.player = 1;                   // 当前击球方 1 | 2
      this.groups = { 1: null, 2: null };// 'solid' 全色 | 'stripe' 条纹 | null 待定
      this.open = true;                  // 开放球台（未分组）
      this.need8 = { 1: false, 2: false };
      this.pottedOrder = [];             // 本局对象球落袋顺序
    }

    /** id → 组别 */
    groupOf(id) {
      return id === 8 ? 'eight' : (id < 8 ? 'solid' : 'stripe');
    }

    /** 记录落袋（白球 id=0 不记） */
    notePot(id) {
      if (id !== 0) this.pottedOrder.push(id);
    }

    /** 依据桌面剩余球刷新“可打黑八”状态
     * @param isOnTable (id) => boolean 该球是否仍在桌上（含落袋动画中视为已下桌）
     */
    updateNeed8(isOnTable) {
      for (const p of [1, 2]) {
        const g = this.groups[p];
        this.need8[p] = !!g && ![1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]
          .some(id => this.groupOf(id) === g && isOnTable(id));
      }
    }

    /**
     * 自由球落点校验（issue #6）：不越界、不与活动球重叠、不落在袋口捕获区
     * @param x,z     待摆放的白球球心坐标
     * @param balls   Ball 数组（含白球自身，白球此刻应为 inactive）
     * @param dims    { LIMIT_X, LIMIT_Z, BALL_R, POCKETS } 物理常量，由调用方传入
     * @returns boolean 是否可以摆放在该位置
     */
    validatePlacement(x, z, balls, dims) {
      if (typeof x !== 'number' || !Number.isFinite(x)) return false;
      if (typeof z !== 'number' || !Number.isFinite(z)) return false;
      const { LIMIT_X, LIMIT_Z, BALL_R, POCKETS } = dims;
      if (Math.abs(x) > LIMIT_X || Math.abs(z) > LIMIT_Z) return false;   // 球心可达域
      for (const p of POCKETS) {                                          // 不落入袋口捕获区
        const dx = x - p.x, dz = z - p.z;
        if (dx * dx + dz * dz < (p.r + BALL_R) * (p.r + BALL_R)) return false;
      }
      for (const b of balls) {                                            // 不与活动球重叠
        if (!b || !b.active || b.sinking || b.id === 0) continue;
        const dx = x - b.pos.x, dz = z - b.pos.z;
        if (dx * dx + dz * dz < (BALL_R * 2) * (BALL_R * 2)) return false;
      }
      return true;
    }

    /**
     * 一杆结束后的裁决
     * @param ctx { potted:number[], cueFouled:boolean, firstContact:number|null,
     *              cushionAfterContact:boolean,       // 首碰之后任意球是否碰过库边
     *              shotOpen:boolean, shotNeed8:{1,2} }
     * @returns
     *   { type:'win', winner, reason }                      比赛结束
     *   { type:'turn', player, foul, foulReason, keepTurn,  轮换结果
     *     pottedOppOnly, assigned, respot8 }
     */
    resolve(ctx) {
      const me = this.player;
      const opp = 3 - me;
      const pottedObj = ctx.potted.filter(id => id !== 8);
      const potted8 = ctx.potted.includes(8);

      // ---- 犯规判定 ----
      let foul = null;
      if (ctx.cueFouled) foul = '白球落袋';
      else if (ctx.firstContact == null) foul = '未击中任何球';
      else if (ctx.shotOpen) {
        if (ctx.firstContact === 8) foul = '开放球台先碰黑八';
        else if (pottedObj.length === 0 && !ctx.cushionAfterContact) foul = '无进球且无球碰库';
      } else if (ctx.firstContact === 8) {
        if (!ctx.shotNeed8[me]) foul = '未清完本组先碰黑八';
        else if (pottedObj.length === 0 && !ctx.cushionAfterContact) foul = '无进球且无球碰库';
      } else if (this.groupOf(ctx.firstContact) !== this.groups[me]) {
        foul = '先碰到了对方的球';
      } else if (pottedObj.length === 0 && !ctx.cushionAfterContact) {
        foul = '无进球且无球碰库';
      }

      // ---- 黑八落袋 ----
      let respot8 = false;
      if (potted8) {
        if (ctx.shotOpen) {
          respot8 = true;               // 开放期进黑八：摆回置球点，比赛继续
        } else if (ctx.shotNeed8[me] && !foul) {
          return { type: 'win', winner: me, reason: null };
        } else {
          return { type: 'win', winner: opp, reason: foul ? '黑八犯规' : '提前打进黑八' };
        }
      }

      // ---- 分组（开放球台首个合法落袋定组）----
      let assigned = null;
      if (this.open && !foul && pottedObj.length > 0) {
        const g = this.groupOf(pottedObj[0]);
        this.groups[me] = g;
        this.groups[opp] = g === 'solid' ? 'stripe' : 'solid';
        this.open = false;
        assigned = g;
      }

      // ---- 轮换 ----
      if (foul) {
        this.player = opp;
        return { type: 'turn', player: opp, foul: true, foulReason: foul, keepTurn: false, pottedOppOnly: false, assigned, respot8 };
      }
      const myGrp = this.groups[me];
      const keepTurn = pottedObj.length > 0 &&
        pottedObj.some(id => this.open || this.groupOf(id) === myGrp);
      if (!keepTurn) this.player = opp;
      return {
        type: 'turn',
        player: this.player,
        foul: false,
        foulReason: null,
        keepTurn,
        pottedOppOnly: !keepTurn && pottedObj.length > 0,
        assigned,
        respot8,
      };
    }
  }

  /** 胜负原因枚举：protocol.js 依赖此白名单过滤跨用户文案（XSS 防线） */
  EightBallRules.WIN_REASONS = ['黑八犯规', '提前打进黑八'];

  root.EightBallRules = EightBallRules;
})();
