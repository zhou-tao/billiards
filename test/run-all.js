/* ============================================================
 * run-all.js —— 统一测试入口：一条命令跑完全部测试（issue #7）
 *   npm test
 * 1. 物理杆法测试（js/physics.test.js）
 * 2. 八球规则测试（js/rules.test.js）
 * 3. 消息协议测试（js/protocol.test.js）
 * 4. 服务器联机测试（test-server.js）：随机端口自动拉起、测完即关，
 *    不残留端口或后台进程
 * 任何一个测试失败 → 整体退出码非 0（CI 门禁）
 * ============================================================ */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = false;

for (const t of ['js/physics.test.js', 'js/rules.test.js', 'js/protocol.test.js']) {
  console.log(`\n======== ${t} ========`);
  const r = spawnSync(process.execPath, [path.join(ROOT, t)], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}

if (!failed) {
  console.log('\n======== test-server.js（随机端口） ========');
  const serverMod = require(path.join(ROOT, 'server.js'));
  const testServer = require(path.join(ROOT, 'test-server.js'));
  (async () => {
    await serverMod.start(0, '127.0.0.1');       // 端口 0 = 由系统分配空闲端口
    const port = serverMod.server.address().port;
    try {
      const failCount = await testServer.run('ws://127.0.0.1:' + port);
      if (failCount > 0) failed = true;
    } finally {
      await serverMod.stop();                    // 测完关闭，不残留监听与进程
    }
    console.log(`\n（服务器测试端口 ${port} 已释放）`);
    if (failed) process.exit(1);
  })().catch(e => { console.error('服务器测试异常:', e); process.exit(1); });
} else {
  process.exit(1);
}
