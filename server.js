/* ============================================================
 * server.js —— 动感台球 联机服务器
 * 同一端口：HTTP 静态托管页面 + WebSocket 房间匹配与消息中继
 *
 * 角色规则：
 *   第 1 个连接 → 玩家1（房主，权威模拟端）
 *   第 2 个连接 → 玩家2
 *   之后的所有连接 → 游客（仅观战）
 * 玩家中途离开 → 房间重置，重新等待匹配
 *
 * 安全防护（issue #3/#4/#5）：
 *   - HTTP：CSP / X-Content-Type-Options / frame-ancestors 响应头；
 *     非法 URL 编码返回 400 而不是崩溃；目录穿越加严
 *   - WebSocket：maxPayload 限幅、Origin 白名单、每 IP 连接数与
 *     观战总数上限、消息频率限制、ping/pong 心跳清理死连接、
 *     广播背压保护（bufferedAmount 超限跳过）
 *   - 消息按 socket 真实角色路由 + protocol.js 白名单 schema 校验：
 *     玩家2 只能发 shotRequest（出杆请求），带球面快照的
 *     authoritativeShot / settled / restart / cuePlaced 仅房主可发，
 *     伪造字段一律剥除或整条拒收，不信任任何客户端声明
 *
 * 启动：node server.js   然后两台电脑浏览器打开 http://<本机IP>:8250
 * 测试：module.exports 暴露 start(port)/stop()，可随机端口拉起
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

require('./js/rules.js');                       // 提供 WIN_REASONS 枚举
const Protocol = require('./js/protocol.js');   // 与客户端共用的消息白名单校验

const PORT = process.env.PORT || 8250;
const ROOT = __dirname;

/* ---------------- 可调安全参数 ---------------- */
const MAX_PAYLOAD = 16 * 1024;      // 单条 WebSocket 消息上限（出杆快照约 1.5KB）
const MAX_PER_IP = 16;              // 每 IP 并发连接数（同一局域网 NAT 出口按 1 个 IP 计）
const MAX_SPECTATORS = 64;          // 观战者总数上限
const RATE_PER_SEC = 20;            // 每连接 sustained 消息速率
const RATE_BURST = 40;              // 每连接突发额度（令牌桶容量）
const BAD_MSG_LIMIT = 30;           // 累计非法消息上限，超过即断开
const BUFFER_LIMIT = 128 * 1024;    // 单客户端发送缓冲上限（背压保护）
const HEARTBEAT_MS = 30 * 1000;     // 心跳间隔；两个周期无 pong 判定死连接

/* ---------------- HTTP 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 安全响应头：CSP 禁止内嵌iframe与外域脚本注入面（issue #3） */
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // 页面含内联诊断脚本，script-src 需保留 'unsafe-inline'；ws(s): 放行任意联机地址（js/config.js 可配）
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; " +
    "base-uri 'self'; frame-ancestors 'none'");
}

const server = http.createServer((req, res) => {
  securityHeaders(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  let urlPath;
  try {
    // 非法 % 编码会抛 URIError：捕获并返回 400，不能让进程退出（issue #5）
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (!urlPath || urlPath.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  // 防目录穿越：必须落在仓库目录内部
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- WebSocket 房间 ---------------- */

/** Origin 白名单：同源（与 Host 头一致，覆盖局域网 IP 直连）+ 环境变量额外来源 */
const EXTRA_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://zhou-tao.github.io')
    .split(',').map(s => s.trim()).filter(Boolean)
);

function originAllowed(origin, req) {
  if (!origin) return true;                 // 非浏览器客户端（如测试/脚本）不带 Origin
  let u;
  try { u = new URL(origin); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (req.headers.host && u.host === req.headers.host) return true;   // 同源（含局域网 IP）
  return EXTRA_ORIGINS.has(origin);
}

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD,                  // 超大消息直接断开（issue #5）
  verifyClient: (info, cb) => {
    const origin = info.origin || (info.req.headers && info.req.headers.origin) || '';
    if (!originAllowed(origin, info.req)) {
      secLog(`拒绝跨站 Origin 连接: ${origin}`);
      cb(false, 403, 'Origin Not Allowed');
      return;
    }
    cb(true);
  },
});

// 搞笑昵称池：连接时随机分配（房间内不重复）
const NAME_POOL = [
  '哈基米', '汪汪队', '干饭魂', '躺平仙人', '摸鱼大王',
  '奶龙', '皮蛋', '小煤球', '汤圆不甜', '包子脸',
  '丸子头', '咕噜咕噜', '麻薯团子', '炫饭橘', '卷王小卷',
  '鸽子精', '夜宵刺客', '可乐加冰', '薯条司令', '白球猎人',
  '袋口守门员', '打铁小匠', '迷路八号球', '巧粉画家', '低杆小王子',
  '擦边大师', '一杆没谱', '台呢上的风', '光速认输', '稳如老狗',
  '手感冰凉', '热身勿扰', '隔壁老王', '楼下大爷', '三号桌钉子户',
  '出杆全靠悟', '架杆手抖', '瞄十分钟', '母球收藏家', '彩球搬运工',
  '反向狙击手', '快乐咸鱼', '今天不想输', '提桶跑路',
];

function pickName() {
  const used = new Set();
  for (const w of [...room.players, ...room.spectators]) {
    if (w && w._name) used.add(w._name);
  }
  const avail = NAME_POOL.filter(n => !used.has(n));
  const pool = avail.length ? avail : NAME_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

const room = {
  players: [null, null],      // [socket, socket] null 为空位
  spectators: new Set(),
  playing: false,
};

/* ---- 连接计数 / 安全日志 ---- */
const ipCount = new Map();
let _lastSecLog = 0, _secLogCount = 0;
/** 安全事件限频日志：同秒内最多 1 条，且每分钟最多 10 条 */
function secLog(msg) {
  const now = Date.now();
  if (now - _lastSecLog < 6000 && _secLogCount >= 10) return;
  if (now - _lastSecLog >= 6000) _secLogCount = 0;
  _lastSecLog = now;
  _secLogCount++;
  console.log('[安全] ' + msg);
}

/* ---- 消息频率：令牌桶 ---- */
function allowRate(ws) {
  const now = Date.now();
  if (!ws._rate) ws._rate = { tokens: RATE_BURST, last: now };
  const r = ws._rate;
  r.tokens = Math.min(RATE_BURST, r.tokens + ((now - r.last) / 1000) * RATE_PER_SEC);
  r.last = now;
  if (r.tokens < 1) return false;
  r.tokens -= 1;
  return true;
}

function badMsg(ws, why) {
  ws._bad = (ws._bad || 0) + 1;
  if (ws._bad <= 3) secLog(`非法消息(${why}) from ${ws._ip || '?'} 累计=${ws._bad}`);
  if (ws._bad > BAD_MSG_LIMIT) { try { ws.close(1002, 'bad message'); } catch (e) {} }
}

function rosterMsg() {
  return {
    t: 'roster',
    filled: room.players.filter(Boolean).length,
    specs: room.spectators.size,
    playing: room.playing,
    p1: (room.players[0] && room.players[0]._name) || null,
    p2: (room.players[1] && room.players[1]._name) || null,
  };
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

/** 广播：背压保护——发送缓冲超限的慢客户端本轮跳过，防止内存积压（issue #5） */
function broadcast(obj, except) {
  const raw = JSON.stringify(obj);
  for (const ws of [...room.players, ...room.spectators]) {
    if (ws && ws !== except && ws.readyState === 1 && ws.bufferedAmount <= BUFFER_LIMIT) {
      ws.send(raw);
    }
  }
}

wss.on('connection', (ws, req) => {
  let role = 'spec';
  let slot = -1;

  ws._ip = (req && req.socket && req.socket.remoteAddress) || '?';
  const n = ipCount.get(ws._ip) || 0;
  if (n >= MAX_PER_IP) {
    secLog(`超过单 IP 连接上限(${MAX_PER_IP})：${ws._ip}`);
    try { ws.close(1013, 'too many connections'); } catch (e) {}
    return;
  }
  ipCount.set(ws._ip, n + 1);
  ws._ipCounted = true;

  // 角色分配：先到先得两个玩家位，其余为游客；并分配房间内唯一的搞笑昵称
  const free = room.players.indexOf(null);
  if (free !== -1) {
    slot = free;
    role = slot === 0 ? 'p1' : 'p2';
    room.players[slot] = ws;
  } else if (room.spectators.size >= MAX_SPECTATORS) {
    secLog(`观战人数超过上限(${MAX_SPECTATORS})：${ws._ip}`);
    try { ws.close(1013, 'room full'); } catch (e) {}
    releaseSlot(ws);
    return;
  } else {
    room.spectators.add(ws);
  }
  const name = pickName();
  ws._name = name;
  ws._slot = slot;

  send(ws, {
    t: 'welcome',
    role,
    name,
    player: slot + 1,          // 1 或 2；游客为 0
    specs: room.spectators.size,
    playing: room.playing,
  });
  broadcast(rosterMsg(), ws);
  console.log(`[+] 连接：${name}（${role}${slot >= 0 ? '·玩家' + (slot + 1) : '·观战'}） 在线=${room.players.filter(Boolean).length + room.spectators.size}`);

  // 两名玩家齐了 → 开局
  if (room.players[0] && room.players[1] && !room.playing) {
    room.playing = true;
    broadcast({ t: 'start' });
    broadcast(rosterMsg());
    console.log('[★] 匹配成功，开始对局');
  }

  ws.on('message', (raw) => {
    if (ws.readyState !== 1) return;
    if (!allowRate(ws)) {
      secLog(`消息频率超限，断开：${ws._name || '?'}`);
      try { ws.close(1008, 'rate limit'); } catch (e) {}
      return;
    }
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') {
      badMsg(ws, 'shape'); return;
    }

    switch (m.t) {
      case 'aim': {            // 瞄准状态广播：双方玩家都可发，字段按 schema 白名单剥除
        const v = Protocol.validateAim(m);
        if (!v) { badMsg(ws, 'aim'); break; }
        if (slot !== -1) broadcast({ t: 'aim', angle: v.angle, power: v.power, contact: v.contact }, ws);
        break;
      }
      case 'shot': {           // 旧版兼容：按 socket 真实角色重写类型（issue #4 的关键——不信任客户端自带类型）
        if (slot === 0) {
          const v = Protocol.validateAuthoritativeShot(m);
          if (!v) { badMsg(ws, 'shot(p1)'); break; }
          broadcast({ t: 'authoritativeShot', balls: v.balls, angle: v.angle, power: v.power, contact: v.contact }, ws);
        } else if (slot === 1) {
          const v = Protocol.validateShotRequest(m);
          if (!v) { badMsg(ws, 'shot(p2)'); break; }
          broadcast({ t: 'shotRequest', angle: v.angle, power: v.power, contact: v.contact }, ws);
        } else {
          badMsg(ws, 'shot(spec)');
        }
        break;
      }
      case 'shotRequest': {    // 出杆请求：仅玩家2
        if (slot !== 1) { badMsg(ws, 'shotRequest-role'); break; }
        const v = Protocol.validateShotRequest(m);
        if (!v) { badMsg(ws, 'shotRequest'); break; }
        broadcast({ t: 'shotRequest', angle: v.angle, power: v.power, contact: v.contact }, ws);
        break;
      }
      case 'authoritativeShot': {  // 权威出杆快照：仅房主
        if (slot !== 0) { badMsg(ws, 'authShot-role'); break; }
        const v = Protocol.validateAuthoritativeShot(m);
        if (!v) { badMsg(ws, 'authShot'); break; }
        broadcast({ t: 'authoritativeShot', balls: v.balls, angle: v.angle, power: v.power, contact: v.contact }, ws);
        break;
      }
      case 'settled': {        // 一杆结算快照：只有房主（玩家1）有权发布
        if (slot !== 0) { badMsg(ws, 'settled-role'); break; }
        const v = Protocol.validateSettled(m);
        if (!v) { badMsg(ws, 'settled'); break; }
        broadcast({ t: 'settled', ...v }, ws);
        break;
      }
      case 'restart': {        // 重开一局：只有房主有权发起
        if (slot !== 0) { badMsg(ws, 'restart-role'); break; }
        broadcast({ t: 'restart' }, ws);
        break;
      }
      case 'placeCue': {       // 自由球落点上报：仅玩家2
        if (slot !== 1) { badMsg(ws, 'placeCue-role'); break; }
        const v = Protocol.validatePlaceCue(m);
        if (!v) { badMsg(ws, 'placeCue'); break; }
        broadcast({ t: 'placeCue', x: v.x, z: v.z }, ws);
        break;
      }
      case 'cuePlaced': {      // 自由球权威落点广播：仅房主
        if (slot !== 0) { badMsg(ws, 'cuePlaced-role'); break; }
        const v = Protocol.validateCuePlaced(m);
        if (!v) { badMsg(ws, 'cuePlaced'); break; }
        broadcast({ t: 'cuePlaced', x: v.x, z: v.z }, ws);
        break;
      }
      default:
        badMsg(ws, 'unknown:' + m.t.slice(0, 24));
        break;                 // 其余类型不转发
    }
  });

  ws.on('close', () => {
    releaseSlot(ws);
    const wasPlayer = slot !== -1;
    console.log(`[-] 断开：${name} 在线=${room.players.filter(Boolean).length + room.spectators.size}`);
    if (wasPlayer) {
      // 玩家离开：房间重置，回到等待匹配
      room.playing = false;
      broadcast({ t: 'reset' });
    }
    broadcast(rosterMsg());
  });

  ws.on('error', () => { /* close 会随后触发 */ });
});

/** 释放连接占用的房间位与 IP 计数 */
function releaseSlot(ws) {
  if (ws._ipCounted) {
    ws._ipCounted = false;
    const n = (ipCount.get(ws._ip) || 1) - 1;
    if (n <= 0) ipCount.delete(ws._ip); else ipCount.set(ws._ip, n);
  }
  const i = room.players.indexOf(ws);
  if (i !== -1) room.players[i] = null;
  room.spectators.delete(ws);
}

/* ---- 心跳：清理无响应死连接，释放玩家位（issue #5） ---- */
wss.on('connection', (ws) => {
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
});
let heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) { try { ws.terminate(); } catch (e) {} continue; }
    ws._alive = false;
    try { ws.ping(); } catch (e) {}
  }
}, HEARTBEAT_MS);

/* ---------------- 启动 / 停止（供测试复用） ---------------- */
function start(port, host) {
  if (server.listening) return Promise.resolve(server);
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListen); reject(e); };
    const onListen = () => { server.off('error', onError); resolve(server); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, host || '0.0.0.0');
  });
}

function stop() {
  clearInterval(heartbeatTimer);
  for (const ws of wss.clients) {
    try { ws.terminate(); } catch (e) {}
  }
  room.players = [null, null];
  room.spectators.clear();
  room.playing = false;
  ipCount.clear();
  return new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
  });
}

module.exports = { server, wss, room, start, stop };

if (require.main === module) {
  start(PORT).then(() => {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list) {
        if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
      }
    }
    console.log('========================================');
    console.log('  🎱 动感台球 联机服务器已启动');
    console.log(`  本机访问:   http://localhost:${PORT}/`);
    for (const ip of ips) console.log(`  局域网访问: http://${ip}:${PORT}/`);
    console.log('  前两名连接者为玩家，之后连接自动进入观战');
    console.log('========================================');
  }).catch((e) => {
    console.error('服务器启动失败:', e.message);
    process.exit(1);
  });
}
