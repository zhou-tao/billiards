/* ============================================================
 * server.js —— 极速台球 3D 联机服务器
 * 同一端口：HTTP 静态托管页面 + WebSocket 房间匹配与消息中继
 *
 * 角色规则：
 *   第 1 个连接 → 玩家1（房主，权威模拟端）
 *   第 2 个连接 → 玩家2
 *   之后的所有连接 → 游客（仅观战）
 * 玩家中途离开 → 房间重置，重新等待匹配
 *
 * 启动：node server.js   然后两台电脑浏览器打开 http://<本机IP>:8250
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8250;
const ROOT = __dirname;

/* ---------------- HTTP 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, path.normalize(urlPath));
  // 防目录穿越
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- WebSocket 房间 ---------------- */
const wss = new WebSocketServer({ server });

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
  players: [null, null],      // [socket, socket] null 为空位
  spectators: new Set(),
  playing: false,
};

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

function broadcast(obj, except) {
  const raw = JSON.stringify(obj);
  for (const ws of [...room.players, ...room.spectators]) {
    if (ws && ws !== except && ws.readyState === 1) ws.send(raw);
  }
}

wss.on('connection', (ws) => {
  let role = 'spec';
  let slot = -1;

  // 角色分配：先到先得两个玩家位，其余为游客；并分配房间内唯一的搞笑昵称
  const free = room.players.indexOf(null);
  if (free !== -1) {
    slot = free;
    role = slot === 0 ? 'p1' : 'p2';
    room.players[slot] = ws;
  } else {
    room.spectators.add(ws);
  }
  const name = pickName();
  ws._name = name;

  send(ws, {
    t: 'welcome',
    role,
    name,
    player: slot + 1,          // 1 或 2；游客为 0
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
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'aim':            // 瞄准状态广播（玩家→其他人），供对手与观众查看
      case 'shot':           // 出杆指令/初始状态（房主权威广播）
        if (slot !== -1) broadcast(m, ws);
        break;
      case 'settled':        // 一杆结算快照：只有房主（玩家1）有权发布
      case 'restart':        // 重开一局：只有房主有权发起
        if (slot === 0) broadcast(m, ws);
        break;
      default:
        break;               // 其余类型不转发
    }
  });

  ws.on('close', () => {
    const wasPlayer = slot !== -1;
    if (wasPlayer) room.players[slot] = null;
    else room.spectators.delete(ws);
    console.log(`[-] 断开：${name} 在线=${room.players.filter(Boolean).length + room.spectators.size}`);
    if (wasPlayer) {
      // 玩家离开：房间重置，回到等待匹配
      room.playing = false;
      broadcast({ t: 'reset' });
    }
    broadcast(rosterMsg());
  });
});

/* ---------------- 启动 ---------------- */
server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  console.log('========================================');
  console.log('  🎱 极速台球 3D 联机服务器已启动');
  console.log(`  本机访问:   http://localhost:${PORT}/`);
  for (const ip of ips) console.log(`  局域网访问: http://${ip}:${PORT}/`);
  console.log('  前两名连接者为玩家，之后连接自动进入观战');
  console.log('========================================');
});

