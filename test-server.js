/* ============================================================
 * test-server.js —— 服务器联机测试（node 直跑）
 * 覆盖：角色分配、消息路由、权限矩阵与恶意消息（issue #4/#5）、
 *       Origin 校验、畸形 URL、超大消息、频率限制（issue #5）
 * 运行：node test-server.js [ws://127.0.0.1:PORT]
 *       URL 省略时默认 ws://localhost:8250（需先启动 node server.js）
 *       由 test/run-all.js 调用时会在随机端口自动拉起服务器
 * ============================================================ */
const { WebSocket } = require('ws');
const http = require('http');

const DEFAULT_URL = process.argv[2] || process.env.WS_TEST_URL || 'ws://localhost:8250';
let BASE_URL = DEFAULT_URL;   // run(url) 可覆盖（由 run-all.js 传随机端口）
let pass = 0, fail = 0;
function T(name, cond, extra) { cond ? pass++ : (fail++, console.log('❌ FAIL: ' + name + (extra !== undefined ? '  got=' + extra : ''))); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 合法 settled 消息模板（通过服务端 schema 校验）
function settledMsg(over) {
  return {
    t: 'settled',
    balls: [],
    rules: { player: 2, groups: { 1: null, 2: null }, open: true, need8: { 1: false, 2: false }, potted: [] },
    score: 0, shots: 1, msgs: [], over: !!over,
  };
}
// 合法球面快照
const ballSnap = [{ id: 0, x: -0.5, z: 0, a: 1, s: 0, pi: -1 }, { id: 1, x: 0.5, z: 0, a: 1, s: 0, pi: -1 }];

function client(name, opts) {
  const c = { name, msgs: [], closed: false, closeCode: null };
  c.ws = new WebSocket(BASE_URL, opts);
  c.ws.on('message', raw => c.msgs.push(JSON.parse(raw.toString())));
  c.ws.on('close', (code) => { c.closed = true; c.closeCode = code; });
  c.ws.on('error', () => {});
  c.wait = async (type, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const i = c.msgs.findIndex(m => m.t === type);
      if (i !== -1) return c.msgs.splice(i, 1)[0];
      await sleep(30);
    }
    return null;
  };
  c.waitClose = async (timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout && !c.closed) await sleep(30);
    return c.closed;
  };
  c.send = o => c.ws.readyState === 1 && c.ws.send(JSON.stringify(o));
  return new Promise(res => c.ws.on('open', () => res(c)));
}

async function run(url) {
  BASE_URL = url || DEFAULT_URL;
  const V = !!process.env.TEST_VERBOSE;
  const step = s => { if (V) console.log('  -- ' + s); };
  // 1. 前两个连接 → p1 / p2，并触发 start
  step('1 角色分配');
  const p1 = await client('A');
  const w1 = await p1.wait('welcome');
  T('1a 第一个连接是 p1', w1 && w1.role === 'p1' && w1.player === 1);
  T('1a2 welcome 携带昵称', typeof (w1 && w1.name) === 'string' && w1.name.length > 0);
  const p2 = await client('B');
  const w2 = await p2.wait('welcome');
  T('1b 第二个连接是 p2', w2 && w2.role === 'p2' && w2.player === 2);
  T('1b2 双方昵称互不相同', typeof (w2 && w2.name) === 'string' && w1.name !== w2.name);
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
  {
    const live = new Set([w1.name, w2.name, w3.name, w4.name]);
    let okU = true;
    for (let i = 0; i < 5; i++) {
      const c = await client('uniq' + i);
      const w = await c.wait('welcome');
      if (!w.name || live.has(w.name)) okU = false;
    }
    T('2c 房间内昵称不重复', okU);
  }

  // 3. 消息路由：aim（带合法 power）广播给其他所有人
  p1.msgs.length = 0; g1.msgs.length = 0;
  p2.send({ t: 'aim', angle: 1.2, power: 0.5 });
  const aimOnG1 = await g1.wait('aim');
  const aimOnP1 = await p1.wait('aim');
  T('3a p2 的 aim 到达观众', aimOnG1 && aimOnG1.angle === 1.2);
  T('3b p2 的 aim 到达 p1', aimOnP1 && aimOnP1.angle === 1.2);
  T('3c aim 多余字段被剥除', aimOnG1 && !('hack' in aimOnG1));

  // 4. settled/restart 只有房主能发：p2 发的应被丢弃（含 schema 非法样例）
  p2.msgs.length = 0; g1.msgs.length = 0;
  p2.send({ t: 'settled', fake: true });
  p2.send(settledMsg(false));
  p2.send({ t: 'settled', ...settledMsg(true), over: true, winner: 1, reason: '<img src=x onerror=alert(1)>' });
  p2.send({ t: 'restart' });
  await sleep(300);
  T('4a p2 无权发 settled（含合法 schema 的 p2 settled 也被拒）', !g1.msgs.some(m => m.t === 'settled'));
  T('4b p2 无权发 restart', !g1.msgs.some(m => m.t === 'restart'));

  // 5. 房主 settled 广播：schema 校验 + 字段剥除
  g1.msgs.length = 0;
  p1.send({ ...settledMsg(false), hack: '<script>x</script>', evil: 1 });
  const sOnG1 = await g1.wait('settled');
  const sOnP2 = await p2.wait('settled');
  T('5a 合法 settled 到达游客', !!sOnG1 && sOnG1.rules && sOnG1.rules.player === 2);
  T('5b settled 到达 p2', !!sOnP2);
  T('5c settled 多余字段被剥除', sOnG1 && !('hack' in sOnG1) && !('evil' in sOnG1));

  // 5d 非法 settled（缺 score、XSS reason、非法分组）被整条拒收
  g1.msgs.length = 0;
  p1.send({ t: 'settled', balls: [] });                                  // 缺 score/shots
  p1.send({ ...settledMsg(true), over: true, winner: 1, reason: '<img>' }); // XSS reason
  p1.send({ ...settledMsg(false), rules: { ...settledMsg(false).rules, groups: { 1: 'x', 2: null } } });
  p1.send({ ...settledMsg(false), score: 1.5 });                         // 非整数
  await sleep(300);
  T('5d 非法 settled 不广播', !g1.msgs.some(m => m.t === 'settled'));

  // 6. restart 权限
  g1.msgs.length = 0;
  p1.send({ t: 'restart' });
  T('6b 房主 restart 广播', !!(await g1.wait('restart')));

  // 7. 出杆消息按角色重写（issue #4 核心）
  g1.msgs.length = 0; p1.msgs.length = 0;
  p2.send({ t: 'shot', angle: 0.4, power: 0.7, contact: { u: 0, h: 0 } });          // p2 裸出杆 → shotRequest
  const reqOnP1 = await p1.wait('shotRequest');
  T('7a p2 的 shot 被重写为 shotRequest', !!reqOnP1 && reqOnP1.power === 0.7);
  T('7b shotRequest 不含球面快照', reqOnP1 && !('balls' in reqOnP1));
  p2.send({ t: 'shot', angle: 0.4, power: 0.7, balls: ballSnap });                  // p2 伪造快照 → 剥除后仍是请求
  const req2OnP1 = await p1.wait('shotRequest');
  T('7c p2 伪造的 balls 被剥除', !!req2OnP1 && !('balls' in req2OnP1));
  p2.send({ t: 'authoritativeShot', angle: 0, power: 1, balls: ballSnap });         // p2 冒充权威 → 拒收
  await sleep(300);
  T('7d p2 无法发送 authoritativeShot', !g1.msgs.some(m => m.t === 'authoritativeShot') && !p1.msgs.some(m => m.t === 'authoritativeShot'));
  p1.send({ t: 'shot', angle: 0.1, power: 0.9, balls: ballSnap });                  // 房主 shot → 重写为 authoritativeShot
  const authOnG1 = await g1.wait('authoritativeShot');
  T('7e p1 的 shot 被重写为 authoritativeShot', !!authOnG1 && Array.isArray(authOnG1.balls) && authOnG1.balls.length === 2);
  g1.msgs.length = 0;
  p1.send({ t: 'shotRequest', angle: 0, power: 0.5 });                              // 房主不能发请求类型
  p2.send({ t: 'shotRequest', angle: 0, power: 99 });                               // 非法力度拒收
  await sleep(300);
  T('7f 非法/越权的 shotRequest 不广播', !g1.msgs.some(m => m.t === 'shotRequest'));

  // 8. 自由球消息路由（issue #6 联机同步）
  g1.msgs.length = 0;
  p2.send({ t: 'placeCue', x: 0.1, z: -0.1 });
  const pcOnP1 = await p1.wait('placeCue');
  T('8a p2 的 placeCue 到达房主', !!pcOnP1 && pcOnP1.x === 0.1);
  T('8b placeCue 到达观众', !!(await g1.wait('placeCue')));
  p1.send({ t: 'cuePlaced', x: 0.12, z: -0.12 });
  T('8c 房主 cuePlaced 广播', !!(await g1.wait('cuePlaced')));
  g1.msgs.length = 0;
  g2.send({ t: 'placeCue', x: 0, z: 0 });        // 观战者无权发
  g2.send({ t: 'cuePlaced', x: 0, z: 0 });
  await sleep(250);
  T('8d 观战者不能发送自由球消息', !g1.msgs.some(m => m.t === 'placeCue' || m.t === 'cuePlaced'));

  // 9. 未知消息类型不转发
  g1.msgs.length = 0;
  p2.send({ t: 'evil', payload: 'x' });
  await sleep(250);
  T('9 未知消息类型不转发', !g1.msgs.some(m => m.t === 'evil'));

  // 10. 玩家掉线 → reset + 空位可被新人顶替为玩家
  p1.msgs.length = 0;
  p2.ws.close();
  const rst = await p1.wait('reset');
  T('10a 对手掉线收到 reset', !!rst);
  const ros = await p1.wait('roster');
  T('10b roster 显示剩余1人', ros && ros.filled === 1);
  const e = await client('E');
  const w5 = await e.wait('welcome');
  T('10c 新连接顶替成为 p2', w5 && w5.role === 'p2' && w5.player === 2);
  T('10d 再次匹配成功', !!(await p1.wait('start')));

  // 11. 房主掉线 → 全员 reset
  g1.msgs.length = 0; e.msgs.length = 0;
  p1.ws.close();
  const rE = await e.wait('reset');
  const rG = await g1.wait('reset');
  T('11a/11b 房主掉线全员收 reset', !!rE && !!rG);
  const f = await client('F');
  const w6 = await f.wait('welcome');
  T('11c 新连接成为新任房主 p1', w6 && w6.role === 'p1');

  // ===== issue #5：传输层防护 =====
  // 12. Origin 白名单：跨站浏览器来源被拒，同源放行
  {
    const evil = new WebSocket(BASE_URL, { headers: { Origin: 'https://evil.example' } });
    let evilRejected = false;
    evil.on('error', () => { evilRejected = true; });
    evil.on('open', () => { evil.close(); });
    await sleep(500);
    T('12a 非允许 Origin 无法建立 WebSocket', evilRejected);

    // 浏览器同源 Origin 永远是 http(s) 协议，此处显式转换（ws: 的 URL.origin 仍为 ws:）
    const httpOrigin = BASE_URL.replace(/^ws/, 'http');
    const sameOrigin = new WebSocket(BASE_URL, { headers: { Origin: httpOrigin } });
    let sameOk = false;
    sameOrigin.on('open', () => { sameOk = true; sameOrigin.close(); });
    sameOrigin.on('error', () => {});
    await sleep(500);
    T('12b 同源 Origin 正常连接', sameOk);
  }

  // 13. 畸形 URL 编码返回 400 且服务进程存活
  {
    const bad = await new Promise((resolve) => {
      http.get(BASE_URL.replace(/^ws/, 'http') + '/%zz', res => { res.resume(); resolve(res.statusCode); })
        .on('error', () => resolve('error'));
    });
    T('13a 畸形 URL 编码返回 400', bad === 400, bad);
    const ok = await new Promise((resolve) => {
      http.get(BASE_URL.replace(/^ws/, 'http') + '/', res => {
        const csp = res.headers['content-security-policy'] || '';
        const nosniff = res.headers['x-content-type-options'] || '';
        res.resume();
        resolve({ code: res.statusCode, csp, nosniff });
      }).on('error', () => resolve('error'));
    });
    T('13b 首页正常 200', ok.code === 200, ok);
    T('13c 带 CSP 响应头', typeof ok === 'object' && /frame-ancestors/.test(ok.csp), ok.csp);
    T('13d 带 X-Content-Type-Options', typeof ok === 'object' && ok.nosniff === 'nosniff');
    T('13e 服务进程仍存活', !!(await client('alive')));
  }

  // 14. 超大消息 → 断开
  {
    const big = await client('big');
    big.ws.send('x'.repeat(20 * 1024));
    T('14 超大消息触发断开', await big.waitClose());
  }

  // 15. 高频消息 → 频率限制断开
  {
    const spam = await client('spam');
    for (let i = 0; i < 120; i++) {
      try { spam.ws.send(JSON.stringify({ t: 'aim', angle: 0.01 * i, power: 0.1 })); } catch (e) { break; }
    }
    T('15 高频消息触发断开', await spam.waitClose());
  }

  console.log(`\n服务器测试: ${pass} 通过 / ${fail} 失败`);
  [p1, p2, g1, g2, e, f].forEach(c => { try { c.ws.close(); } catch (_) {} });
  return fail;
}

if (require.main === module) {
  run().then(f => process.exit(f ? 1 : 0)).catch(e => { console.error('测试异常:', e); process.exit(1); });
}
module.exports = { run };
