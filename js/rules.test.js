/* ============================================================
 * rules.test.js —— 八球规则引擎单元测试（node 直跑，零依赖）
 * 运行：node js/rules.test.js
 * 覆盖 issue #6：碰库犯规、自由球落点校验，以及既有八球裁决回归
 * ============================================================ */
'use strict';

global.window = globalThis;
require('./rules.js');
require('./physics.js');          // 提供桌面常量（LIMIT_X/Z、POCKETS、BALL_R）

const Rules = globalThis.EightBallRules;
const { LIMIT_X, LIMIT_Z, BALL_R, POCKETS, Ball } = globalThis.PoolPhys;
const DIMS = { LIMIT_X, LIMIT_Z, BALL_R, POCKETS };

let pass = 0, fail = 0;
function T(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('❌ FAIL: ' + name + (extra !== undefined ? '  got=' + extra : '')); }
}

function mk() { const r = new Rules(); return r; }
/** 开放球台、双方未分组、轮到 p1 的默认上下文 */
function ctx(over) {
  return Object.assign({
    potted: [], cueFouled: false, firstContact: 1,
    cushionAfterContact: true, shotOpen: true, shotNeed8: { 1: false, 2: false },
  }, over);
}

/* 1. 碰库犯规（issue #6 核心） */
{
  const r = mk();
  let a = r.resolve(ctx({ potted: [], cushionAfterContact: false }));
  T('无进球且无碰库 → 犯规', a.type === 'turn' && a.foul && a.foulReason === '无进球且无球碰库');
  T('犯规后轮换并触发自由球语义', a.player === 2 && a.keepTurn === false);

  a = r.resolve(ctx({ potted: [], cushionAfterContact: true }));
  T('无进球但碰库 → 不犯规', a.type === 'turn' && !a.foul);

  a = r.resolve(ctx({ potted: [3], cushionAfterContact: false }));
  T('有进球无碰库 → 不犯规且保持击球', a.type === 'turn' && !a.foul && a.keepTurn);

  a = r.resolve(ctx({ potted: [], cushionAfterContact: false, firstContact: null }));
  T('未击中任何球优先判罚', a.foulReason === '未击中任何球');
}

/* 2. 分组后的碰库犯规与首碰犯规优先级 */
{
  const r = mk();
  r.resolve(ctx({ potted: [1] }));             // p1 打进全色定组，继续击球
  T('开放台合法进球定组', r.groups[1] === 'solid' && !r.open);
  r.resolve(ctx({ potted: [], firstContact: 2, shotOpen: false }));   // p1 空杆（碰库）→ 轮 p2

  let a = r.resolve(ctx({
    potted: [], firstContact: 2, cushionAfterContact: false, shotOpen: false,
  }));                                          // p2（条纹）先碰对方全色
  T('先碰对方球优先于碰库犯规', a.foulReason === '先碰到了对方的球');   // 轮回 p1

  a = r.resolve(ctx({
    potted: [], firstContact: 2, cushionAfterContact: false, shotOpen: false,
  }));                                          // p1（全色）合法首碰但无进球无碰库
  T('合法首碰后无进球无碰库 → 犯规', a.foul && a.foulReason === '无进球且无球碰库');   // 轮回 p2

  a = r.resolve(ctx({
    potted: [1], firstContact: 9, cushionAfterContact: false, shotOpen: false,
  }));                                          // p2 首碰己方条纹、把对方全色撞进袋
  T('有进球时不判碰库犯规（轮换）', !a.foul && a.player === 1 && a.pottedOppOnly);
}

/* 3. 黑八场景回归 */
{
  const r = mk();
  r.resolve(ctx({ potted: [1] }));                                       // 定组 solid，继续
  r.resolve(ctx({ potted: [2, 3], firstContact: 2, shotOpen: false }));  // 继续
  r.resolve(ctx({ potted: [4, 5], firstContact: 4, shotOpen: false }));
  r.resolve(ctx({ potted: [6, 7], firstContact: 6, shotOpen: false }));
  r.updateNeed8(() => false);                                            // 台面已无全色
  T('清完本组后 need8 置位', r.need8[1] === true);

  let a = r.resolve(ctx({ potted: [8], firstContact: 8, shotOpen: false, shotNeed8: { 1: true, 2: false } }));
  T('合法打进黑八获胜', a.type === 'win' && a.winner === 1 && a.reason === null);

  const r2 = mk();
  a = r2.resolve(ctx({ potted: [8], firstContact: 1, shotOpen: true }));
  T('开放台进黑八摆回继续', a.type === 'turn' && a.respot8 === true);

  const r3 = mk();
  r3.resolve(ctx({ potted: [1] }));
  a = r3.resolve(ctx({ potted: [8], firstContact: 2, shotOpen: false, shotNeed8: { 1: false, 2: false } }));
  T('提前打进黑八判负', a.type === 'win' && a.winner === 2 && a.reason === '提前打进黑八');

  const r4 = mk();
  r4.resolve(ctx({ potted: [1] }));
  a = r4.resolve(ctx({ potted: [8], cueFouled: true, firstContact: 2, shotOpen: false }));
  T('黑八犯规判负', a.type === 'win' && a.winner === 2 && a.reason === '黑八犯规');
}

/* 4. WIN_REASONS 枚举与 resolve 实际返回同步（protocol 白名单的依据） */
{
  const r = mk();
  const seen = [];
  let probe = new Rules();
  probe.resolve(ctx({ potted: [1] }));
  // 收集所有可能出现的 win reason
  const scenarios = [
    () => { const x = mk(); x.resolve(ctx({ potted: [1] })); return x.resolve(ctx({ potted: [8], firstContact: 2, shotOpen: false })); },
    () => { const x = mk(); return x.resolve(ctx({ potted: [8], cueFouled: true, firstContact: 2, shotOpen: false })); },
  ];
  for (const s of scenarios) {
    const a = s();
    if (a.type === 'win' && a.reason) seen.push(a.reason);
  }
  T('win reason 全部在白名单内', seen.every(x => Rules.WIN_REASONS.includes(x)), JSON.stringify(seen));
}

/* 5. 自由球落点校验 validatePlacement（issue #6） */
{
  function ball(id, x, z, active = true) {
    const b = new Ball(id);
    b.pos.x = x; b.pos.z = z; b.active = active;
    return b;
  }
  const corner = POCKETS[0];
  const r = mk();

  T('台面中心合法', r.validatePlacement(0, 0, [], DIMS) === true);
  T('负坐标不误判', r.validatePlacement(-0.3, -0.2, [], DIMS) === true);
  T('越界（x 超出球心可达域）非法', r.validatePlacement(LIMIT_X + 0.01, 0, [], DIMS) === false);
  T('越界（z 超出）非法', r.validatePlacement(0, -(LIMIT_Z + 0.01), [], DIMS) === false);
  T('NaN 非法', r.validatePlacement(NaN, 0, [], DIMS) === false && r.validatePlacement(0, Infinity, [], DIMS) === false);

  T('袋口捕获区内非法', r.validatePlacement(corner.x + 0.01, corner.z + 0.01, [], DIMS) === false);
  T('袋口稍外合法', r.validatePlacement(corner.x + BALL_R * 3, corner.z + BALL_R * 3, [], DIMS) === true);

  T('与活动球重叠非法', r.validatePlacement(0.3, 0, [ball(1, 0.3 + BALL_R, 0)], DIMS) === false);
  T('紧贴活动球（恰好 2R）非法', r.validatePlacement(0.3, 0, [ball(1, 0.3 + BALL_R * 2 - 0.0005, 0)], DIMS) === false);
  T('离活动球一个球径以上合法', r.validatePlacement(0.3, 0, [ball(1, 0.3 + BALL_R * 2 + 0.01, 0)], DIMS) === true);
  T('与已落袋球重叠无妨', r.validatePlacement(0.3, 0, [ball(1, 0.3, 0, false)], DIMS) === true);

  // 与白球（id 0）重叠无妨：白球本身就是要摆的球，此刻 inactive
  T('白球自身位置可复用', r.validatePlacement(-0.5, 0, [ball(0, -0.5, 0, false)], DIMS) === true);

  // 开球线附近（白球常回位置）合法
  T('开球线位置合法', r.validatePlacement(-LIMIT_X / 2, 0, [], DIMS) === true);
}

/* 6. 犯规 → 自由球语义完整性：每次犯规都轮换到对手 */
{
  const r = mk();
  const a = r.resolve(ctx({ potted: [], cushionAfterContact: false }));   // p1 犯规
  T('犯规后 player 切到对手', a.foul === true && a.player === 2);
  const b = r.resolve(ctx({ potted: [], cushionAfterContact: false, firstContact: 1 }));   // p2 再犯
  T('再次犯规继续轮换回 p1', b.foul === true && b.player === 1);
}

console.log(`\n八球规则测试: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
