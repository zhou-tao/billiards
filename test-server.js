/* 服务器联机测试：4 个客户端验证角色分配、消息路由、权限与掉线重置 */
const { WebSocket } = require('ws');

const URL = 'ws://localhost:8250';
let pass = 0, fail = 0;
function T(name, cond) { cond ? pass++ : (fail++, console.log('❌ FAIL: ' + name)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  const c = { name, msgs: [], closed: false };
  c.ws = new WebSocket(URL);
  c.ws.on('message', raw => c.msgs.push(JSON.parse(raw.toString())));
  c.ws.on('close', () => { c.closed = true; });
  c.wait = async (type, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const i = c.msgs.findIndex(m => m.t === type);
      if (i !== -1) return c.msgs.splice(i, 1)[0];
      await sleep(30);
    }
    return null;
  };
  c.send = o => c.ws.readyState === 1 && c.ws.send(JSON.stringify(o));
  return new Promise(res => c.ws.on('open', () => res(c)));
}

(async () => {
  // 1. 前两个连接 → p1 / p2，并触发 start
  const p1 = await client('A');
  const w1 = await p1.wait('welcome');
  T('1a 第一个连接是 p1', w1 && w1.role === 'p1' && w1.player === 1);
  T('1a2 welcome 携带昵称', typeof (w1 && w1.name) === 'string' && w1.name.length > 0);
  const p2 = await client('B');
  const w2 = await p2.wait('welcome');
  T('1b 第二个连接是 p2', w2 && w2.role === 'p2' && w2.player === 2);
  T('1b2 双方昵称互不相同', typeof (w2 && w2.name) === 'string' && w1.name !== w2.name);
  // roster 携带双方昵称
  const rosA = await p1.wait('roster');
  T('1c roster 携带双方昵称', rosA && rosA.p1 === w1.name && rosA.p2 === w2.name);
  const s1 = await p1.wait('start');
  T('1d 匹配成功广播 start', !!s1);

  // 2. 第三、四个连接 → 游客
  const g1 = await client('C');
  const w3 = await g1.wait('welcome');
  T('2a 第三个连接是游客', w3 && w3.role === 'spec' && w3.player === 0);
  const g2 = await client('D');
  const w4 = await g2.wait('welcome');
  T('2b 第四个连接是游客且人数=2', w4 && w4.role === 'spec' && w4.specs === 2);

  // 2c 昵称唯一性：新连接的昵称不与「当前在线者」重复（断开者的昵称可回收）
  {
    const live = new Set([w1.name, w2.name, w3.name, w4.name]);   // 当前在线四人
    let okU = true;
    for (let i = 0; i < 5; i++) {
      const c = await client('uniq' + i);
      const w = await c.wait('welcome');
      if (!w.name || live.has(w.name)) okU = false;   // 与在线者重复才违规
      // 该客户端保持在线直到本轮结束，模拟多人同时在线
    }
    T('2c 房间内昵称不重复', okU);
    for (const c of [g1, g2]) { /* 保持原连接 */ }
  }

  // 3. 消息路由：aim 从玩家广播给其他所有人
  p1.msgs.length = 0; g1.msgs.length = 0;
  p2.send({ t: 'aim', angle: 1.2 });
  const aimOnG1 = await g1.wait('aim');
  const aimOnP1 = await p1.wait('aim');
  T('3a p2 的 aim 到达观众', aimOnG1 && aimOnG1.angle === 1.2);
  T('3b p2 的 aim 到达 p1', aimOnP1 && aimOnP1.angle === 1.2);

  // 4. settled 只有房主能发：p2 发的应被丢弃
  p2.msgs.length = 0; g1.msgs.length = 0;
  p2.send({ t: 'settled', fake: true });
  await sleep(300);
  T('4a p2 无权发 settled', !g1.msgs.some(m => m.t === 'settled') && !p2.msgs.some(m => m.t === 'settled'));

  // 5. 房主 settled 广播给除自己外的所有人
  g1.msgs.length = 0;
  p1.send({ t: 'settled', balls: [], player: 2 });
  const sOnG1 = await g1.wait('settled');
  const sOnP2 = await p2.wait('settled');
  T('5a settled 到达游客', sOnG1 && sOnG1.player === 2);
  T('5b settled 到达 p2', !!sOnP2);

  // 6. restart 权限同 settled
  g1.msgs.length = 0;
  p2.send({ t: 'restart' });
  await sleep(200);
  T('6a p2 无权发 restart', !g1.msgs.some(m => m.t === 'restart'));
  p1.send({ t: 'restart' });
  T('6b 房主 restart 广播', !!(await g1.wait('restart')));

  // 7. 玩家掉线 → reset + 空位可被新人顶替为玩家
  p1.msgs.length = 0;
  p2.ws.close();
  const rst = await p1.wait('reset');
  T('7a 对手掉线收到 reset', !!rst);
  const ros = await p1.wait('roster');
  T('7b roster 显示剩余1人', ros && ros.filled === 1);
  const e = await client('E');
  const w5 = await e.wait('welcome');
  T('7c 新连接顶替成为 p2', w5 && w5.role === 'p2' && w5.player === 2);
  const s2 = await p1.wait('start');
  T('7d 再次匹配成功', !!s2);

  // 8. 房主掉线 → 全员 reset，房间回到等待
  g1.msgs.length = 0; e.msgs.length = 0;
  p1.ws.close();
  const rE = await e.wait('reset');
  const rG = await g1.wait('reset');
  T('8a/8b 房主掉线全员收 reset', !!rE && !!rG);
  const f = await client('F');
  const w6 = await f.wait('welcome');
  T('8c 新连接成为新任房主 p1', w6 && w6.role === 'p1');

  console.log(`\n服务器测试: ${pass} 通过 / ${fail} 失败`);
  [p1, p2, g1, g2, e, f].forEach(c => { try { c.ws.close(); } catch (_) {} });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });

