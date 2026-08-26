/* ============================================================
 * rules.js —— 八球（黑八）规则引擎（纯逻辑，零依赖，可独立测试）
 * 状态：当前击球方 / 分组 / 开放球台 / 可打黑八 / 落袋顺序
 * game.js 负责把物理事件喂给引擎，并把引擎裁决应用到画面
 * ============================================================ */
(function () {
  'use strict';

  class EightBallRules {
    constructor() {
      this.reset();
    }

    reset() {
      this.player = 1;                   // 当前击球方 1 | 2
      this.groups = { 1: null, 2: null };// 'solid' 全色 | 'stripe' 条纹 | null 待定
      this.open = true;                  // 开放球台（未分组）
      this.need8 = { 1: false, 2: false };
      this.pottedOrder = [];             // 本局对象球落袋顺序
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
     * 一杆结束后的裁决
     * @param ctx { potted:number[], cueFouled:boolean, firstContact:number|null,
     *              shotOpen:boolean, shotNeed8:{1,2} }
     * @returns
     *   { type:'win', winner, reason }                      比赛结束
     *   { type:'turn', player, foul, foulReason, keepTurn,  轮换结果
     *     pottedOppOnly, assigned, respot8 }
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
      } else if (ctx.firstContact === 8) {
        if (!ctx.shotNeed8[me]) foul = '未清完本组先碰黑八';
      } else if (this.groupOf(ctx.firstContact) !== this.groups[me]) {
        foul = '先碰到了对方的球';
      }

      // ---- 黑八落袋 ----
      let respot8 = false;
      if (potted8) {
        if (ctx.shotOpen) {
          respot8 = true;               // 开放期进黑八：摆回置球点，比赛继续
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

  window.EightBallRules = EightBallRules;
})();

