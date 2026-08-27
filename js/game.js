/* ============================================================
 * game.js —— 主程序
 * 场景与台球桌搭建 / 球体生成 / 瞄准出杆交互 / 摄像机 /
 * 规则结算与 HUD / 渲染主循环
 * ============================================================ */
(function () {
  'use strict';

  const { BALL_R, TABLE_W, TABLE_H, POCKETS, Ball, World, applyStrike } = PoolPhys;
  const HALF_W = TABLE_W / 2;
  const HALF_H = TABLE_H / 2;
  const MAX_SHOT_SPEED = 6.4;

  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ================= 渲染器 / 场景 / 相机 ================= */
  const canvas = $('scene');
  // ?lowgfx 低画质模式：供老机器/集显使用（1倍像素比 + 小阴影贴图）
  const LOWGFX = /[?&]lowgfx\b/.test(location.search);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOWGFX });
  renderer.setPixelRatio(LOWGFX ? 1 : Math.min(window.devicePixelRatio, 2));  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e15);
  scene.fog = new THREE.Fog(0x0b0e15, 7, 16);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 60);

  /* ================= 灯光 ================= */
  scene.add(new THREE.AmbientLight(0x8892aa, 0.55));
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1410, 0.5));

  const key = new THREE.DirectionalLight(0xfff1dc, 1.05);
  key.position.set(1.6, 3.2, 1.1);
  key.castShadow = true;
  key.shadow.mapSize.set(LOWGFX ? 1024 : 2048, LOWGFX ? 1024 : 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 8;
  key.shadow.camera.left = -2.2;
  key.shadow.camera.right = 2.2;
  key.shadow.camera.top = 1.8;
  key.shadow.camera.bottom = -1.8;
  key.shadow.bias = -0.0004;
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);

  const lampA = new THREE.PointLight(0xffe2b0, 0.5, 7, 2);
  lampA.position.set(-0.7, 1.5, 0);
  scene.add(lampA);
  const lampB = new THREE.PointLight(0xffe2b0, 0.5, 7, 2);
  lampB.position.set(0.7, 1.5, 0);
  scene.add(lampB);

  /* ================= 特效系统接入 ================= */
  FX.init(scene);

  /* ================= 台球桌 ================= */
  function mkBox(w, h, d, x, y, z, mat, parent) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    (parent || table).add(m);
    return m;
  }

  const table = new THREE.Group();
  scene.add(table);
  {
    const clothMat = new THREE.MeshStandardMaterial({ color: 0x0e7a44, roughness: 0.94, metalness: 0 });
    const cushMat = new THREE.MeshStandardMaterial({ color: 0x0a5c33, roughness: 0.9 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a2f1d, roughness: 0.55, metalness: 0.05 });

    // 台呢（顶面正好在 y=0）
    const cloth = mkBox(TABLE_W + 0.14, 0.02, TABLE_H + 0.14, 0, -0.01, 0, clothMat);
    cloth.castShadow = false;

    // 库边：6 段，袋口处留缺
    const CUSH_D = 0.05, CUSH_H = 0.045;
    const cornerGap = 0.105, sideGap = 0.078;
    const lx0 = -HALF_W + cornerGap, lx1 = -sideGap, lx2 = sideGap, lx3 = HALF_W - cornerGap;
    function cushionSeg(len, cx, cz, alongX) {
      const g = alongX
        ? new THREE.BoxGeometry(len, CUSH_H, CUSH_D)
        : new THREE.BoxGeometry(CUSH_D, CUSH_H, len);
      const m = new THREE.Mesh(g, cushMat);
      m.position.set(cx, CUSH_H / 2, cz);
      m.castShadow = m.receiveShadow = true;
      table.add(m);
    }
    for (const s of [-1, 1]) {
      const cz = s * (HALF_H + CUSH_D / 2);
      cushionSeg(lx1 - lx0, (lx0 + lx1) / 2, cz, true);
      cushionSeg(lx3 - lx2, (lx2 + lx3) / 2, cz, true);
      cushionSeg(TABLE_H - 2 * cornerGap, s * (HALF_W + CUSH_D / 2), 0, false);
    }

    // 木质围板
    const RAIL_T = 0.10, RAIL_H = 0.055;
    const railY = RAIL_H / 2 - 0.004;
    const rz = HALF_H + CUSH_D + RAIL_T / 2;
    const rx = HALF_W + CUSH_D + RAIL_T / 2;
    mkBox(TABLE_W + 2 * CUSH_D + 2 * RAIL_T, RAIL_H, RAIL_T, 0, railY, rz, woodMat);
    mkBox(TABLE_W + 2 * CUSH_D + 2 * RAIL_T, RAIL_H, RAIL_T, 0, railY, -rz, woodMat);
    mkBox(RAIL_T, RAIL_H, TABLE_H + 2 * CUSH_D, rx, railY, 0, woodMat);
    mkBox(RAIL_T, RAIL_H, TABLE_H + 2 * CUSH_D, -rx, railY, 0, woodMat);

    // 桌裙与桌腿
    mkBox(TABLE_W + 0.52, 0.17, TABLE_H + 0.52, 0, -0.105, 0, woodMat);
    const legGeo = new THREE.CylinderGeometry(0.052, 0.062, 0.56, 12);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, woodMat);
      leg.position.set(sx * (HALF_W - 0.12), -0.44, sz * (HALF_H - 0.06));
      leg.castShadow = true;
      table.add(leg);
    }

    // 地面
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: 0x12151d, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.72;
    floor.receiveShadow = true;
    scene.add(floor);

    // 袋口（黑洞 + 皮质环）
    const holeMat = new THREE.MeshBasicMaterial({ color: 0x04050a });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x24160e, roughness: 0.6 });
    for (const p of POCKETS) {
      const hole = new THREE.Mesh(new THREE.CircleGeometry(p.r + 0.012, 32), holeMat);
      hole.rotation.x = -Math.PI / 2;
      hole.position.set(p.x, 0.0022, p.z);
      table.add(hole);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(p.r + 0.012, 0.007, 10, 32), rimMat);
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(p.x, 0.003, p.z);
      rim.castShadow = true;
      table.add(rim);
    }

    // 置球点与开球线标记
    const spotMat = new THREE.MeshBasicMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.5 });
    for (const sx of [-1, 1]) {
      const spot = new THREE.Mesh(new THREE.CircleGeometry(0.006, 16), spotMat);
      spot.rotation.x = -Math.PI / 2;
      spot.position.set(sx * HALF_W / 2, 0.0023, 0);
      table.add(spot);
    }

    // 围板上的星点标记（钻石位）
    const sightMat = new THREE.MeshBasicMaterial({ color: 0xd8cba8 });
    const sightGeo = new THREE.CircleGeometry(0.005, 12);
    function sight(x, z) {
      const m = new THREE.Mesh(sightGeo, sightMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, RAIL_H + 0.001, z);
      table.add(m);
    }
    for (const f of [-0.75, -0.5, -0.25, 0.25, 0.5, 0.75]) {
      sight(f * HALF_W, rz);
      sight(f * HALF_W, -rz);
    }
    for (const f of [-0.5, 0.5]) {
      sight(rx, f * HALF_H);
      sight(-rx, f * HALF_H);
    }
  }

  /* ================= 球体生成 ================= */
  const BALL_COLORS = {
    1: 0xffb300, 2: 0x1565c0, 3: 0xd32f2f, 4: 0x6a1b9a,
    5: 0xef6c00, 6: 0x2e7d32, 7: 0x8d2f23, 8: 0x181818,
  };

  function makeBallTexture(id) {
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 512;
    const c = cv.getContext('2d');
    const WHITE = '#f7f3ea';
    if (id === 0) {                       // 白球（带两个红点便于观察旋转）
      c.fillStyle = WHITE; c.fillRect(0, 0, 1024, 512);
      c.fillStyle = '#d8452e';
      for (const cx of [256, 768]) {
        c.beginPath(); c.arc(cx, 256, 10, 0, 7); c.fill();
      }
    } else {
      const col = '#' + BALL_COLORS[id > 8 ? id - 8 : id].toString(16).padStart(6, '0');
      if (id > 8) {                       // 花色球：白底色带
        c.fillStyle = WHITE; c.fillRect(0, 0, 1024, 512);
        c.fillStyle = col; c.fillRect(0, 512 * 0.30, 1024, 512 * 0.40);
      } else {                            // 全色球
        c.fillStyle = col; c.fillRect(0, 0, 1024, 512);
      }
      for (const cx of [256, 768]) {      // 数字圈
        c.fillStyle = WHITE;
        c.beginPath(); c.arc(cx, 256, 86, 0, Math.PI * 2); c.fill();
        c.lineWidth = 7; c.strokeStyle = '#222';
        c.beginPath(); c.arc(cx, 256, 86, 0, Math.PI * 2); c.stroke();
        c.fillStyle = '#1a1a1a';
        c.font = 'bold 118px Arial';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(id), cx, 262);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  const ballGeo = new THREE.SphereGeometry(BALL_R, 48, 32);
  const ballMatCache = {};
  function makeBallMesh(id) {
    if (!ballMatCache[id]) {
      ballMatCache[id] = new THREE.MeshPhysicalMaterial({
        map: makeBallTexture(id),
        roughness: 0.16,
        metalness: 0,
        clearcoat: 0.7,
        clearcoatRoughness: 0.22,
      });
    }
    const m = new THREE.Mesh(ballGeo, ballMatCache[id]);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  /* ================= 物理世界与规则状态 ================= */
  let state = 'READY';              // READY | AIM | ROLL | OVER
  let score = 0, shots = 0, startTime = 0;
  let pottedThisShot = [];
  let cueFouled = false;
  let clearedPending = false;
  let cueBall = null;

  /* ---- 双人对战（八球规则）状态：裁决逻辑在 rules.js ---- */
  let gameMode = 'arcade';          // 'arcade' 单人街机 | 'versus' 本地双人对战
  const rules = new EightBallRules();
  const groupOf = id => id === 8 ? 'eight' : (id < 8 ? 'solid' : 'stripe');
  const isBallOnTable = id => {
    const b = world.balls.find(x => x.id === id);
    return !!b && (b.active || b.sinking);
  };
  let shotFirstContact = null;      // 本杆白球首个碰到的球 id
  let shotOpen = true;              // 出杆瞬间的球台开放状态
  let shotNeed8 = { 1: false, 2: false };

  /* ---- 联机（versus-net）状态 ---- */
  const NET = new NetClient();
  let netRole = null;               // 'p1'(房主/权威端) | 'p2' | 'spec' | null=未联机
  let netWaiting = false;           // 联机模式但尚未匹配成功（单机模式必须为 false，否则无法出杆）
  let lastAimSend = -99;            // 瞄准广播节流（帧计数）
  let lastSentAngle = NaN, lastSentPower = -1;
  const remoteAim = { angle: 0, power: 0, t: -999, contact: { u: 0, h: 0 } };

  /* ---- 搞笑昵称 ---- */
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
  function pickLocalName(exclude) {
    const avail = NAME_POOL.filter(n => !exclude.includes(n));
    return (avail.length ? avail : NAME_POOL)[Math.floor(Math.random() * (avail.length || NAME_POOL.length))];
  }
  let myName = '';                          // 联机时服务器分配的名字
  const netNames = { 1: '', 2: '' };        // 联机双方名字
  const localNames = { 1: null, 2: null };  // 本地双人随机名字

  const netInGame = () => gameMode === 'versus-net';
  /** 是否为权威模拟端（单机模式或房主） */
  const isAuthority = () => !netInGame() || netRole === 'p1';
  /** 轮到本机玩家出手 */
  const myTurn = () => !netInGame() ||
    (netRole === 'p1' && rules.player === 1) ||
    (netRole === 'p2' && rules.player === 2);
  const canActNow = () => state === 'AIM' && cueBall.active && myTurn() && !netWaiting;

  /** 某击球方的显示名：联机用服务器分配名，本地双人用随机名 */
  function pname(p) {
    if (netInGame()) return netNames[p] || ('玩家' + p);
    if (gameMode === 'versus') return localNames[p] || ('玩家' + p);
    return '玩家' + p;
  }

  /** 当前应显示的瞄准来源（本机输入 或 联机对手/观战的远端瞄准） */
  function displayAim() {
    if (!netInGame() || canActNow()) {
      return { angle: input.aimAngle, power: input.power, contact: input.contact, mine: true };
    }
    if (window.__fc - remoteAim.t < 150) {       // 约 2.5 秒内收到过远端瞄准
      return { angle: remoteAim.angle, power: remoteAim.power, contact: remoteAim.contact, mine: false };
    }
    return null;
  }

  const world = new World(onPhysicsEvent);

  function onPhysicsEvent(e) {
    if (e.type === 'ball') {
      // 记录白球本杆首碰（八球规则犯规判定用）
      if (shotFirstContact === null) {
        if (e.aId === 0) shotFirstContact = e.bId;
        else if (e.bId === 0) shotFirstContact = e.aId;
      }
      FX.ballHit(e);
      SFX.hitBall(e.intensity);
    } else if (e.type === 'cushion') {
      FX.spawnSparks(e.x, 0.03, e.z, e.intensity * 0.5);
      if (e.intensity > 0.5) FX.flash(e.x, 0.03, e.z, e.intensity * 0.5);
      SFX.cushion(e.intensity);
    } else if (e.type === 'pocket') {
      FX.spawnRing(e.x, e.z, 3);
      FX.flash(e.x, 0.05, e.z, 2.5);
      FX.addShake(0.010);
      SFX.pocket();
      if (e.ballId === 0) {
        cueFouled = true;
        if (isAuthority()) showToast('💥 白球落袋！', 'bad');
      } else {
        pottedThisShot.push(e.ballId);
        rules.notePot(e.ballId);
        if (gameMode === 'arcade') {
          addScore(100);
          showToast('🎯 ' + e.ballId + ' 号球落袋 +100', 'good');
          addTrayBadge(e.ballId);
          if (!world.balls.some(b => b.id !== 0 && (b.active || b.sinking))) {
            clearedPending = true;
          }
          updateHUD();
        } else if (isAuthority()) {
          rules.updateNeed8(isBallOnTable);
          updateVersusHUD();
          updateHUD();
        }
      }
    }
  }

  // 标准三角阵型：8 号居中，底角一花一色
  const RACK_ROWS = [
    [1],
    [2, 9],
    [3, 8, 10],
    [4, 13, 11, 14],
    [12, 15, 6, 5, 7],
  ];

  function attachMesh(b) {
    const m = makeBallMesh(b.id);
    m.position.set(b.pos.x, BALL_R, b.pos.z);
    b.mesh = m;
    b.rp = { x: b.pos.x, z: b.pos.z };
    scene.add(m);
  }

  function rackBalls() {
    const footX = HALF_W / 2;
    const rowDX = BALL_R * 2 * 0.87;
    for (let r = 0; r < RACK_ROWS.length; r++) {
      for (let k = 0; k < RACK_ROWS[r].length; k++) {
        const b = world.addBall(new Ball(RACK_ROWS[r][k]));
        b.pos.x = footX + r * rowDX + (Math.random() - 0.5) * 0.0006;
        b.pos.z = (k - r / 2) * (BALL_R * 2 + 0.0008) + (Math.random() - 0.5) * 0.0006;
        attachMesh(b);
      }
    }
  }

  function spawnCueBall() {
    cueBall = world.addBall(new Ball(0));
    cueBall.pos.x = -HALF_W / 2;
    cueBall.pos.z = 0;
    attachMesh(cueBall);
  }

  function findFreeSpot(x, z, exclude) {
    const ex = exclude || cueBall;
    const others = world.balls.filter(b => b !== ex && b.active);
    for (let ring = 0; ring < 40; ring++) {
      const rad = ring * BALL_R * 2.2;
      const tries = ring === 0 ? 1 : 10;
      for (let i = 0; i < tries; i++) {
        const a = (i / tries) * Math.PI * 2;
        const tx = clamp(x + Math.cos(a) * rad, -PoolPhys.LIMIT_X + 0.01, PoolPhys.LIMIT_X - 0.01);
        const tz = clamp(z + Math.sin(a) * rad, -PoolPhys.LIMIT_Z + 0.01, PoolPhys.LIMIT_Z - 0.01);
        if (others.every(o => (o.pos.x - tx) ** 2 + (o.pos.z - tz) ** 2 > (BALL_R * 2.2) ** 2)) {
          return { x: tx, z: tz };
        }
      }
    }
    return { x, z };
  }

  function respawnCue() {
    const spot = findFreeSpot(-HALF_W / 2, 0);
    cueBall.active = true;
    cueBall.sinking = false;
    cueBall.stop();
    cueBall.pos.x = spot.x;
    cueBall.pos.z = spot.z;
    cueBall.vel.x = cueBall.vel.z = 0;
    cueBall.mesh.visible = true;
    cueBall.mesh.scale.set(1, 1, 1);
    cueBall.mesh.position.set(spot.x, BALL_R, spot.z);
    cueBall.rp = { x: spot.x, z: spot.z };
  }

  /* ================= 出杆动画 ================= */
  let pendingShot = null;   // { dir:{x,z}, speed, power, startPull, applied }
  let strikeT = 0;

  function currentPull() {
    return 0.05 + input.power * 0.34;
  }

  function shoot(power, angleOverride, contact) {
    if (angleOverride !== undefined) input.aimAngle = angleOverride;   // 远端出杆时对齐方向
    const dir = { x: Math.cos(input.aimAngle), z: Math.sin(input.aimAngle) };
    pendingShot = {
      dir,
      speed: MAX_SHOT_SPEED * (0.14 + 0.86 * power),
      power,
      startPull: currentPull(),
      contact: contact || input.contact,   // 击球点：远端出杆用消息携带
      applied: false,
    };
    strikeT = 0;
    shots++;
    shotFirstContact = null;
    if (gameMode === 'versus') {
      shotOpen = rules.open;
      shotNeed8 = { 1: rules.need8[1], 2: rules.need8[2] };
    }
    updateHUD();
    SFX.cueStrike(power);
    input.power = 0;
  }

  function updateStrike(dt) {
    if (!pendingShot) return;
    strikeT += dt;
    const t = Math.min(1, strikeT / 0.07);
    // 杆头快速前推
    cue.stick.position.x = -(BALL_R + 0.015 + pendingShot.startPull * (1 - t) - 0.005 * t);
    if (t >= 1 && !pendingShot.applied) {
      const preBalls = isAuthority() ? serializeBalls() : null;   // 冲量施加前的球面快照
      pendingShot.applied = true;
      applyStrike(cueBall, pendingShot.dir, pendingShot.speed, pendingShot.contact);
      state = 'ROLL';
      pottedThisShot = [];
      cueFouled = false;
      clearedPending = false;
      FX.addShake(0.003 + pendingShot.power * 0.007);
      if (preBalls) {
        NET.send({
          t: 'shot',
          balls: preBalls,
          angle: input.aimAngle,
          power: pendingShot.power,
          contact: pendingShot.contact,
        });
      }
      pendingShot = null;
    }
  }

  /* ================= 球杆模型 ================= */
  const cue = { group: new THREE.Group(), inner: new THREE.Group(), stick: new THREE.Group() };
  function buildCue() {
    const maple = new THREE.MeshStandardMaterial({ color: 0xb98a4a, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2c1a10, roughness: 0.5 });
    const L1 = 0.95, L2 = 0.47;

    // 前节（杆头在局部原点，杆身向 -X 延伸）
    const shaftGeo = new THREE.CylinderGeometry(0.007, 0.010, L1, 16);
    shaftGeo.rotateZ(-Math.PI / 2);
    shaftGeo.translate(-L1 / 2, 0, 0);
    const shaft = new THREE.Mesh(shaftGeo, maple);

    // 后把
    const buttGeo = new THREE.CylinderGeometry(0.010, 0.0135, L2, 16);
    buttGeo.rotateZ(-Math.PI / 2);
    buttGeo.translate(-L1 - L2 / 2, 0, 0);
    const butt = new THREE.Mesh(buttGeo, dark);

    // 先角 + 皮头
    const ferGeo = new THREE.CylinderGeometry(0.0072, 0.0072, 0.014, 12);
    ferGeo.rotateZ(-Math.PI / 2);
    ferGeo.translate(-0.007, 0, 0);
    const ferrule = new THREE.Mesh(ferGeo, new THREE.MeshStandardMaterial({ color: 0xf0ead8, roughness: 0.4 }));
    const tipGeo = new THREE.CylinderGeometry(0.0068, 0.007, 0.008, 12);
    tipGeo.rotateZ(-Math.PI / 2);
    tipGeo.translate(-0.004, 0, 0);
    const tip = new THREE.Mesh(tipGeo, new THREE.MeshStandardMaterial({ color: 0x2e6db4, roughness: 0.7 }));

    [shaft, butt, ferrule, tip].forEach(m => { m.castShadow = true; cue.stick.add(m); });

    cue.inner.add(cue.stick);
    cue.inner.rotation.z = -0.07;           // 抬高杆尾
    cue.inner.position.y = BALL_R + 0.012;
    cue.group.add(cue.inner);
    cue.group.visible = false;
    scene.add(cue.group);
  }

  function updateCuePose() {
    const da = displayAim();
    const show = (state === 'AIM') && cueBall.active && !!da;
    cue.group.visible = show;
    if (!show) return;
    const pull = 0.05 + (da.mine ? input.power : da.power) * 0.34;   // 远端蓄力也可见
    cue.group.position.set(cueBall.pos.x, 0, cueBall.pos.z);
    cue.group.rotation.y = -da.angle;
    cue.stick.position.x = -(BALL_R + 0.015 + pull);
  }

  /* ================= 瞄准辅助线 ================= */
  const guide = {};
  const _v1 = new THREE.Vector3();
  function buildGuide() {
    guide.group = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(32 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    guide.lineGeo = geo;
    guide.line = new THREE.Line(geo, new THREE.LineDashedMaterial({
      color: 0xffffff, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: 0.65,
    }));
    guide.line.frustumCulled = false;

    guide.ghost = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false })
    );

    guide.arrowObj = new THREE.ArrowHelper(_v1.set(1, 0, 0).clone(), new THREE.Vector3(), 0.28, 0xffd54f, 0.06, 0.032);
    guide.arrowCue = new THREE.ArrowHelper(_v1.set(1, 0, 0).clone(), new THREE.Vector3(), 0.16, 0x4fc3f7, 0.05, 0.026);

    guide.group.add(guide.line, guide.ghost, guide.arrowObj, guide.arrowCue);
    guide.group.visible = false;
    scene.add(guide.group);
  }

  function updateGuide() {
    const da = displayAim();
    const show = state === 'AIM' && cueBall.active && !!da;
    guide.group.visible = show;
    if (!show) return;

    const dx = Math.cos(da.angle), dz = Math.sin(da.angle);
    const hit = world.predict(cueBall, dx, dz);

    const attr = guide.lineGeo.attributes.position;
    const sx = cueBall.pos.x + dx * BALL_R, sz = cueBall.pos.z + dz * BALL_R;
    for (let i = 0; i < 32; i++) {
      const t = i / 31;
      attr.setXYZ(i, sx + (hit.gx - sx) * t, BALL_R, sz + (hit.gz - sz) * t);
    }
    attr.needsUpdate = true;
    guide.line.computeLineDistances();

    guide.ghost.position.set(hit.gx, BALL_R, hit.gz);
    guide.ghost.visible = !!hit.ball;
    guide.arrowObj.visible = guide.arrowCue.visible = false;

    if (hit.ball) {
      const ox = hit.ball.pos.x - hit.gx, oz = hit.ball.pos.z - hit.gz;
      const ol = Math.hypot(ox, oz) || 1;
      const nx = ox / ol, nz = oz / ol;
      guide.arrowObj.position.set(hit.ball.pos.x, BALL_R, hit.ball.pos.z);
      guide.arrowObj.setDirection(_v1.set(nx, 0, nz));
      guide.arrowObj.setLength(clamp(0.18 + ol * 0.5, 0.15, 0.34), 0.06, 0.032);
      guide.arrowObj.visible = true;

      const dot = dx * nx + dz * nz;
      const tx = dx - dot * nx, tz = dz - dot * nz;
      const tl = Math.hypot(tx, tz);
      if (tl > 0.08) {
        guide.arrowCue.position.set(hit.gx, BALL_R, hit.gz);
        guide.arrowCue.setDirection(_v1.set(tx / tl, 0, tz / tl));
        guide.arrowCue.setLength(0.16, 0.045, 0.026);
        guide.arrowCue.visible = true;
      }
    }
  }

  /* ================= 输入交互 ================= */
  const input = {
    aimAngle: 0,                 // 出杆方向角（atan2 风格，x-z 平面）
    charging: false,
    chargeStart: { x: 0, y: 0 },
    backScreen: { x: 0, y: 1 },
    power: 0,
    orbiting: false,
    lastX: 0, lastY: 0,
    spaceCharging: false,
    spaceDir: 1,
    contact: { u: 0, h: 0 },   // 母球击球点：u 高/低杆(+上/-下)，h 左/右塞(-左/+右), -1..1
  };

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const planeHit = new THREE.Vector3();

  function tablePointFromClient(cx, cy) {
    ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(groundPlane, planeHit) ? planeHit : null;
  }

  function updateAimFromClient(cx, cy) {
    const p = tablePointFromClient(cx, cy);
    if (!p) return;
    const dx = p.x - cueBall.pos.x, dz = p.z - cueBall.pos.z;
    if (dx * dx + dz * dz < 0.0016) return;
    input.aimAngle = Math.atan2(dz, dx);
  }

  function worldToScreen(x, y, z) {
    _v1.set(x, y, z).project(camera);
    return { x: (_v1.x * 0.5 + 0.5) * window.innerWidth, y: (-_v1.y * 0.5 + 0.5) * window.innerHeight };
  }

  function beginCharge(sx, sy) {
    input.charging = true;
    input.power = 0;
    input.chargeStart = { x: sx, y: sy };
    // 计算“屏幕后方”方向：白球 与 其前方一点 的屏幕坐标差
    const a = worldToScreen(cueBall.pos.x, BALL_R, cueBall.pos.z);
    const fx = cueBall.pos.x + Math.cos(input.aimAngle) * 0.5;
    const fz = cueBall.pos.z + Math.sin(input.aimAngle) * 0.5;
    const b = worldToScreen(fx, BALL_R, fz);
    let bx = a.x - b.x, by = a.y - b.y;
    let l = Math.hypot(bx, by);
    if (l < 30) {
      // 瞄准方向与摄像机视线几乎重合时，屏幕投影退化：以“屏幕下方”为后方兜底
      bx = 0; by = 1; l = 1;
    }
    input.backScreen = { x: bx / l, y: by / l };
    if (window.__DEBUG) window.__shotDbg = 'begin p=' + power2(sx, sy) + ' ball=(' +
      cueBall.pos.x.toFixed(2) + ',' + cueBall.pos.z.toFixed(2) + ') a=(' +
      a.x.toFixed(0) + ',' + a.y.toFixed(0) + ') b=(' + b.x.toFixed(0) + ',' + b.y.toFixed(0) +
      ') back=(' + input.backScreen.x.toFixed(2) + ',' + input.backScreen.y.toFixed(2) + ')';
    showToast('向后拖拽蓄力，松开出杆 ↑', '');
  }

  function power2(x, y) { return '(' + x + ',' + y + ')'; }

  function moveCharge(sx, sy) {
    const dx = sx - input.chargeStart.x, dy = sy - input.chargeStart.y;
    const backDot = dx * input.backScreen.x + dy * input.backScreen.y;
    input.power = clamp(backDot / 230, 0, 1);
    if (window.__DEBUG) window.__shotDbg = 'move d=(' + dx + ',' + dy + ') backDot=' + backDot.toFixed(1) + ' power=' + input.power.toFixed(3);
  }

  function releaseCharge() {
    input.charging = false;
    const p = input.power;
    if (window.__DEBUG) window.__shotDbg = 'release power=' + p.toFixed(3) + ' state=' + state;
    if (p > 0.02 && canActNow()) {
      if (netInGame() && netRole === 'p2') {
        // 玩家2：把出杆指令发给房主，由房主权威模拟后回播
        NET.send({ t: 'aim', angle: input.aimAngle, power: p, contact: input.contact });
        NET.send({ t: 'shot', angle: input.aimAngle, power: p, contact: input.contact });
      } else {
        shoot(p);
      }
    }
    input.power = 0;
  }

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('pointerdown', e => {
    // 右键/中键旋转视角：任何状态（含观战）都允许
    if (e.button === 2 || e.button === 1) {
      if (input.charging) return;
      input.orbiting = true;
      input.lastX = e.clientX; input.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    if (!canActNow()) return;
    if (e.pointerType === 'touch') updateAimFromClient(e.clientX, e.clientY);
    beginCharge(e.clientX, e.clientY);
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', e => {
    if (input.orbiting) {
      camGoal.yaw -= (e.clientX - input.lastX) * 0.005;
      camGoal.pitch = clamp(camGoal.pitch + (e.clientY - input.lastY) * 0.004, 0.22, 1.53);
      input.lastX = e.clientX; input.lastY = e.clientY;
      return;
    }
    if (state === 'AIM' && myTurn() && !netWaiting) {
      if (input.charging) { moveCharge(e.clientX, e.clientY); return; }
      if (e.pointerType === 'mouse' && cueBall.active) updateAimFromClient(e.clientX, e.clientY);
    }
  });

  function endPointer() {
    if (input.orbiting) { input.orbiting = false; return; }
    if (input.charging) releaseCharge();
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  /* ---- 母球击球点选择器 ---- */
  const contactBall = $('contact-ball'), contactDot = $('contact-dot'), contactTag = $('contact-tag');
  let contactDrag = false;

  function updateContactUI() {
    const da = displayAim();
    const c = (da && !da.mine && da.contact) ? da.contact : input.contact;
    const R = (contactBall.clientWidth || 88) / 2;
    const r = Math.max(1, R - 8);
    contactDot.style.left = (R + c.h * r - 9) + 'px';
    contactDot.style.top = (R - c.u * r - 9) + 'px';
    const tag = [];
    if (c.u > 0.15) tag.push('高杆'); else if (c.u < -0.15) tag.push('低杆');
    if (c.h > 0.15) tag.push('右塞'); else if (c.h < -0.15) tag.push('左塞');
    contactTag.textContent = tag.length ? tag.join(' · ') : '中心';
  }

  function setContactFromPointer(e) {
    const rect = contactBall.getBoundingClientRect();
    const R = rect.width / 2;
    let h = (e.clientX - rect.left - R) / R;
    let u = (R - (e.clientY - rect.top)) / R;
    const len = Math.hypot(h, u);
    if (len > 1) { h /= len; u /= len; }
    input.contact = { u: clamp(u, -1, 1), h: clamp(h, -1, 1) };
    updateContactUI();
  }

  function resetContact() {
    input.contact = { u: 0, h: 0 };
    updateContactUI();
  }

  contactBall.addEventListener('pointerdown', e => {
    if (!canActNow()) return;
    e.preventDefault();
    contactDrag = true;
    try { contactBall.setPointerCapture(e.pointerId); } catch (err) {}
    setContactFromPointer(e);
  });
  contactBall.addEventListener('pointermove', e => { if (contactDrag) setContactFromPointer(e); });
  const endContactDrag = () => {
    if (!contactDrag) return;
    contactDrag = false;
    // 松手位置靠近圆心 = 一键回中
    if (Math.hypot(input.contact.u, input.contact.h) < 0.16) resetContact();
  };
  contactBall.addEventListener('pointerup', endContactDrag);
  contactBall.addEventListener('pointercancel', endContactDrag);
  updateContactUI();

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    camGoal.radius = clamp(camGoal.radius * (e.deltaY > 0 ? 1.08 : 0.93), 1.0, 5.5);
  }, { passive: false });

  window.addEventListener('keydown', e => {
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (!e.repeat && canActNow() && !input.charging) {
          input.spaceCharging = true;
          input.spaceDir = 1;
          input.power = 0;
        }
        break;
      case 'KeyV': setTopView(!topMode); break;
      case 'KeyM': toggleMute(); break;
      case 'KeyR':
        if (state !== 'READY') requestRestart();
        break;
            case 'KeyW':
        if (canActNow()) { input.contact.u = clamp(input.contact.u + 0.08, -1, 1); updateContactUI(); }
      break;
      case 'KeyS':
        if (canActNow()) { input.contact.u = clamp(input.contact.u - 0.08, -1, 1); updateContactUI(); }
      break;
      case 'KeyA':
        if (canActNow()) { input.contact.h = clamp(input.contact.h - 0.08, -1, 1); updateContactUI(); }
      break;
      case 'KeyD':
        if (canActNow()) { input.contact.h = clamp(input.contact.h + 0.08, -1, 1); updateContactUI(); }
      break;
case 'ArrowLeft':
        if (canActNow()) input.aimAngle -= 0.012;
        break;
      case 'ArrowRight':
        if (canActNow()) input.aimAngle += 0.012;
        break;
    }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'Space' && input.spaceCharging) {
      input.spaceCharging = false;
      if (input.power > 0.02 && canActNow()) {
        if (netInGame() && netRole === 'p2') {
          NET.send({ t: 'aim', angle: input.aimAngle, power: input.power, contact: input.contact });
          NET.send({ t: 'shot', angle: input.aimAngle, power: input.power, contact: input.contact });
        } else {
          shoot(input.power);
        }
      }
      input.power = 0;
    }
  });

  /* ================= 摄像机 ================= */
  const camCur = { yaw: Math.PI, pitch: 0.95, radius: 2.45 };
  const camGoal = { yaw: Math.PI, pitch: 0.95, radius: 2.45 };
  let topMode = false;
  let savedCam = null;
  const shakeVec = new THREE.Vector3();

  function setTopView(on) {
    if (on === topMode) return;
    topMode = on;
    if (on) {
      savedCam = { yaw: camGoal.yaw, pitch: camGoal.pitch, radius: camGoal.radius };
      camGoal.pitch = 1.545;
      camGoal.radius = Math.max(camGoal.radius, 3.0);
    } else if (savedCam) {
      camGoal.yaw = savedCam.yaw;
      camGoal.pitch = savedCam.pitch;
      camGoal.radius = savedCam.radius;
    }
    $('btn-top').style.background = on ? 'rgba(40,220,140,.35)' : '';
  }

  function updateCamera(dt) {
    const k = 1 - Math.exp(-10 * dt);
    camCur.yaw += (camGoal.yaw - camCur.yaw) * k;
    camCur.pitch += (camGoal.pitch - camCur.pitch) * k;
    camCur.radius += (camGoal.radius - camCur.radius) * k;

    camera.position.set(
      Math.sin(camCur.pitch) * Math.cos(camCur.yaw) * camCur.radius,
      Math.cos(camCur.pitch) * camCur.radius,
      Math.sin(camCur.pitch) * Math.sin(camCur.yaw) * camCur.radius
    );
    camera.position.add(FX.shakeOffset(shakeVec));
    camera.lookAt(0, 0.02, 0);
  }

  /* ================= HUD / 提示 ================= */
  const elScore = $('score'), elShots = $('shots'), elRemain = $('remain');
  const tray = $('potted-tray'), toast = $('toast');
  const powerFill = $('power-fill'), powerPct = $('power-pct');

  function updateHUD() {
    elScore.textContent = String(score);
    elShots.textContent = String(shots);
    elRemain.textContent = String(world.balls.filter(b => b.id !== 0 && (b.active || b.sinking)).length);
  }

  function addScore(d) {
    score = Math.max(0, score + d);
    elScore.textContent = score;
  }

  function makeBadge(id) {
    const s = document.createElement('span');
    s.className = 'badge';
    const colHex = '#' + BALL_COLORS[id > 8 ? id - 8 : id].toString(16).padStart(6, '0');
    if (id > 8) {
      // 花色球：白底 + 中间横向色带，模拟真实条纹
      s.classList.add('stripe');
      s.style.background = 'linear-gradient(to bottom, #f7f3ea 0%, #f7f3ea 25%, ' +
        colHex + ' 25%, ' + colHex + ' 75%, #f7f3ea 75%, #f7f3ea 100%)';
    } else {
      // 全色球 / 黑八：纯色
      s.style.background = colHex;
    }
    if (id === 8) s.style.color = '#eee';
    s.textContent = id;
    return s;
  }

  function addTrayBadge(id) {
    tray.appendChild(makeBadge(id));
  }

  let toastTimer = null;
  function showToast(text, kind) {
    toast.textContent = text;
    toast.className = 'show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = ''; }, 1700);
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function updatePowerUI() {
    const da = displayAim();
    const src = (da && !da.mine) ? da.power : input.power;   // 联机时显示正在出杆一方的力度
    const p = Math.round(src * 100);
    if (powerFill.dataset.v !== String(p)) {
      powerFill.dataset.v = String(p);
      powerFill.style.width = p + '%';
      powerPct.textContent = p + '%';
    }
  }

  function toggleMute() {
    SFX.setMuted(!SFX.muted);
    $('btn-sound').textContent = SFX.muted ? '🔇' : '🔊';
  }

  function hideOverlays() {
    $('overlay').classList.add('hidden');
    $('victory').classList.add('hidden');
  }

  /* ================= 规则流程 ================= */
  function anySinking() {
    return world.balls.some(b => b.sinking);
  }

  let quietFrames = 0;
  function checkSettle() {
    if (!isAuthority()) return;      // 联机时由房主统一结算并广播
    if (world.moving || anySinking() || pendingShot) { quietFrames = 0; return; }
    // 需连续 0.4s 全桌静止才结算，避免开球瞬间的短暂停顿误判
    if (++quietFrames < 24) return;
    quietFrames = 0;
    resolveShot();
  }

  function resolveShot() {
    if (gameMode === 'versus' || gameMode === 'versus-net') { resolveShotVersus(); return; }

    const n = pottedThisShot.length;
    if (clearedPending) {
      if (cueFouled) addScore(-100);
      victory();
      return;
    }
    if (cueFouled) {
      addScore(-100);
      SFX.foul();
      respawnCue();
      showToast('💥 白球落袋 · 罚 100 分', 'bad');
    } else if (n > 1) {
      const bonus = (n - 1) * 50;
      addScore(bonus);
      showToast('🔥 ' + n + ' 连击！奖励 +' + bonus, 'good');
    } else if (n === 0) {
      showToast('再试一杆！', '');
    }
        resetContact();
state = 'AIM';
    updateHUD();
  }

  /* ================= 联机同步：快照序列化 ================= */
  function serializeBalls() {
    return world.balls.map(b => ({
      id: b.id,
      x: +b.pos.x.toFixed(5),
      z: +b.pos.z.toFixed(5),
      a: b.active ? 1 : 0,
      s: b.sinking ? 1 : 0,
      pi: b.sinkPocket ? POCKETS.indexOf(b.sinkPocket) : -1,
    }));
  }

  function restoreBalls(list) {
    for (const s of list) {
      const b = world.balls.find(x => x.id === s.id);
      if (!b) continue;
      b.active = !!s.a;
      b.sinking = !!s.s;
      b.stop();
      b.pos.x = s.x;
      b.pos.z = s.z;
      b.vel.x = b.vel.z = 0;
      b.sinkT = 0;
      b.sinkPocket = s.pi >= 0 ? POCKETS[s.pi] : null;
      if (b.mesh) {
        b.mesh.visible = b.active || b.sinking;
        if (b.active) b.mesh.scale.set(1, 1, 1);
        b.mesh.position.set(s.x, BALL_R, s.z);
      }
      b.rp = { x: s.x, z: s.z };
    }
  }

  function snapshotRules() {
    return {
      player: rules.player,
      groups: { 1: rules.groups[1], 2: rules.groups[2] },
      open: rules.open,
      need8: { 1: rules.need8[1], 2: rules.need8[2] },
      potted: [...rules.pottedOrder],
    };
  }

  function applyRulesSnap(r) {
    rules.player = r.player;
    rules.groups = { 1: r.groups[1], 2: r.groups[2] };
    rules.open = r.open;
    rules.need8 = { 1: r.need8[1], 2: r.need8[2] };
    rules.pottedOrder = [...(r.potted || [])];
  }

  /* ================= 双人对战：八球规则 ================= */
  function groupName(g, need8) {
    if (!g) return '待定';
    if (need8) return g === 'solid' ? '全色 ✓ 打黑八' : '条纹 ✓ 打黑八';
    return g === 'solid' ? '全色 1-7' : '条纹 9-15';
  }

  /** 黑八重新摆回置球点（开放球台阶段进黑八时使用） */
  function respotEight() {
    const eight = world.balls.find(b => b.id === 8);
    if (!eight) return;
    const spot = findFreeSpot(HALF_W / 2, 0, eight);
    eight.active = true;
    eight.sinking = false;
    eight.stop();
    eight.pos.x = spot.x;
    eight.pos.z = spot.z;
    eight.mesh.visible = true;
    eight.mesh.scale.set(1, 1, 1);
    eight.mesh.position.set(spot.x, BALL_R, spot.z);
    eight.rp = { x: spot.x, z: spot.z };
  }

  function resolveShotVersus() {
    const me = rules.player;
    const act = rules.resolve({
      potted: pottedThisShot,
      cueFouled,
      firstContact: shotFirstContact,
      shotOpen,
      shotNeed8,
    });

    if (act.type === 'win') {
      versusWin(act.winner, act.reason);
      return;
    }

    // 汇总本杆提示信息
    const msgs = [];
    if (act.respot8) {
      respotEight();
      msgs.push('黑八提前落袋，重新摆回');
    }
    if (act.assigned) {
      msgs.push('分组：' + pname(1) + '打' + (rules.groups[1] === 'solid' ? '全色' : '条纹') +
        ' / ' + pname(2) + '打' + (rules.groups[2] === 'solid' ? '全色' : '条纹'));
    }
    if (act.foul) {
      if (cueFouled) respawnCue();
      SFX.foul();
      msgs.push('⚠ ' + pname(me) + '犯规：' + act.foulReason);
    } else if (act.keepTurn) {
      msgs.push('漂亮！' + pname(act.player) + '继续击球');
    } else if (act.pottedOppOnly) {
      msgs.push(pname(me) + '进了对方的球 · 轮到' + pname(act.player));
    } else {
      msgs.push('未进球 · 轮到' + pname(act.player));
    }
    showToast(msgs.join(' · '), act.foul ? 'bad' : (act.keepTurn ? 'good' : ''));
        resetContact();
state = 'AIM';
    updateVersusHUD();
    updateHUD();   // 落袋动画结束后刷新剩余数
    window.__settleN = (window.__settleN || 0) + 1;   // 结算探针

    // 房主把权威结算快照广播给对手与观众
    if (netInGame() && netRole === 'p1') {
      NET.send({
        t: 'settled',
        balls: serializeBalls(),
        rules: snapshotRules(),
        score, shots,
        msgs,
        over: false,
      });
    }
  }

  function versusWin(winner, reason) {
    state = 'OVER';
    SFX.win();
    FX.spawnRing(0, 0, 6);
    FX.spawnSparks(0, 0.06, 0, 6);
    FX.addShake(0.018);
    setTimeout(() => { if (state === 'OVER') FX.spawnSparks(0.5, 0.06, 0.3, 5); }, 260);
    setTimeout(() => { if (state === 'OVER') FX.spawnSparks(-0.5, 0.06, -0.3, 5); }, 520);
    $('v-title').textContent = '🏆 ' + pname(winner) + ' 获胜！';
    $('v-stats').innerHTML =
      (reason ? '胜负原因：<b>' + reason + '</b><br>' : '') +
      '共用 <b>' + shots + '</b> 杆 · 用时 <b>' + fmtTime(Date.now() - startTime) + '</b>';
    $('victory').classList.remove('hidden');
    if (netInGame() && netRole === 'p1') {
      NET.send({
        t: 'settled',
        over: true, winner, reason,
        balls: serializeBalls(),
        rules: snapshotRules(),
        score, shots,
        msgs: [],
      });
    }
  }

  /** 观战/对手端展示对局结果 */
  function netShowWin(winner, reason) {
    state = 'OVER';
    SFX.win();
    FX.spawnRing(0, 0, 6);
    FX.spawnSparks(0, 0.06, 0, 6);
    FX.addShake(0.018);
    $('v-title').textContent = '🏆 ' + pname(winner) + ' 获胜！';
    $('v-stats').innerHTML =
      (reason ? '胜负原因：<b>' + reason + '</b><br>' : '') +
      '共用 <b>' + shots + '</b> 杆';
    $('victory').classList.remove('hidden');
  }

  function updateVersusHUD() {
    if (gameMode !== 'versus' && gameMode !== 'versus-net') return;
    $('vn1').textContent = pname(1);
    $('vn2').textContent = pname(2);
    $('vg1').textContent = groupName(rules.groups[1], rules.need8[1]);
    $('vg2').textContent = groupName(rules.groups[2], rules.need8[2]);
    $('vp1').classList.toggle('active', rules.player === 1 && state !== 'OVER');
    $('vp2').classList.toggle('active', rules.player === 2 && state !== 'OVER');
    const t1 = $('vt1'), t2 = $('vt2');
    t1.innerHTML = '';
    t2.innerHTML = '';
    if (!rules.open) {
      for (const id of rules.pottedOrder) {
        if (id === 8) continue;
        const owner = groupOf(id) === rules.groups[1] ? 1 : 2;
        (owner === 1 ? t1 : t2).appendChild(makeBadge(id));
      }
    }
  }

  function victory() {
    state = 'OVER';
    SFX.win();
    FX.spawnRing(0, 0, 6);
    FX.spawnSparks(0, 0.06, 0, 6);
    FX.addShake(0.018);
    setTimeout(() => { if (state === 'OVER') FX.spawnSparks(0.5, 0.06, 0.3, 5); }, 260);
    setTimeout(() => { if (state === 'OVER') FX.spawnSparks(-0.5, 0.06, -0.3, 5); }, 520);
    $('v-title').textContent = '🏆 清台成功！';
    $('v-stats').innerHTML =
      '最终得分 <b>' + score + '</b> · 共用 <b>' + shots + '</b> 杆 · 用时 <b>' +
      fmtTime(Date.now() - startTime) + '</b>';
    $('victory').classList.remove('hidden');
  }

  function restart() {
    for (const b of world.balls) if (b.mesh) scene.remove(b.mesh);
    world.reset();
    score = 0; shots = 0;
    startTime = Date.now();
    tray.innerHTML = '';
    pottedThisShot = [];
    cueFouled = false;
    clearedPending = false;
    pendingShot = null;
    input.power = 0;
    input.charging = false;
    input.spaceCharging = false;
    shotFirstContact = null;
    rules.reset();
    state = 'AIM';
    rackBalls();
    spawnCueBall();
    updateHUD();
    updateVersusHUD();
    resetContact();
  }

  /* ================= 同步网格（滚动旋转 / 落袋动画） ================= */
  const UP = new THREE.Vector3(0, 1, 0);
  const rollAxis = new THREE.Vector3();
  const rollQ = new THREE.Quaternion();

  function syncMeshes(dt) {
    for (const b of world.balls) {
      if (!b.mesh) continue;
      if (b.sinking) {
        // 落袋动画：滑向袋心并下沉缩小
        b.sinkT += dt;
        const p = b.sinkPocket;
        const t = Math.min(1, b.sinkT / 0.5);
        b.pos.x += (p.x - b.pos.x) * Math.min(1, dt * 10);
        b.pos.z += (p.z - b.pos.z) * Math.min(1, dt * 10);
        b.mesh.position.set(b.pos.x, BALL_R * (1 - t) - t * t * 0.09, b.pos.z);
        const sc = Math.max(0.25, 1 - t * 0.75);
        b.mesh.scale.set(sc, sc, sc);
        rollAxis.set(0, 0, -1);
        rollQ.setFromAxisAngle(rollAxis, dt * 6);
        b.mesh.quaternion.premultiply(rollQ);
        if (t >= 1) {
          b.sinking = false;
          b.mesh.visible = false;
        }
        continue;
      }
      if (!b.active) continue;
      b.mesh.position.set(b.pos.x, b.pos.y, b.pos.z);
      // 依据位移做真实滚动
      const dx = b.pos.x - b.rp.x, dz = b.pos.z - b.rp.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-6) {
        rollAxis.set(dz / dist, 0, -dx / dist);
        rollQ.setFromAxisAngle(rollAxis, dist / BALL_R);
        b.mesh.quaternion.premultiply(rollQ);
      }
      b.rp.x = b.pos.x;
      b.rp.z = b.pos.z;
    }
  }

  /* ================= 主循环 ================= */
  const clock = new THREE.Clock();
  const PHYS_DT = 1 / 360;
  let acc = 0;

  function animate() {
    requestAnimationFrame(animate);
    window.__fc = (window.__fc || 0) + 1;   // 帧计数（诊断用）
    window.__gs = state;                    // 当前游戏状态（诊断/测试探针）
    window.__vs = (gameMode === 'versus' || gameMode === 'versus-net') ? rules.player : 0;  // 当前击球方（测试探针）
    window.__role = netRole || '-';         // 联机角色（测试探针）
    if (window.__DEBUG) window.__cue = { x: cueBall.pos.x, z: cueBall.pos.z };   // 杆法验证探针
    if (window.__DEBUG) { window.__autoSeen = input.autoShot; }
    if (window.__DEBUG && input.autoShot !== undefined && canActNow() &&
        $('overlay').classList.contains('hidden') && $('lobby').classList.contains('hidden')) {
      if (window.__autoU !== undefined) input.contact.u = window.__autoU;
      if (window.__autoH !== undefined) input.contact.h = window.__autoH;
      updateContactUI();
      window.__autoFired = (window.__autoFired || 0) + 1;
      const _p = input.autoShot; input.autoShot = undefined;
      shoot(Math.max(0, Math.min(1, _p)));
    }
    if (window.__DEBUG) window.__auto = { shot: input.autoShot, can: canActNow(), u: input.contact.u, state: state };

                // __DEBUG 自动化：出杆钩子 + URL 参数自动出杆（仅调试模式）
        if (window.__DEBUG) {
          window.__fireShot = power => {
            if (!canActNow()) return false;
            shoot(Math.max(0, Math.min(1, power)));
            return true;
          };
          // URL 自动出杆只解析一次：?shot=<0..1>（力度）&u=<击球点纵向 负=低杆 正=高杆>&h=<横向 负=左塞 正=右塞>
                    window.__autoParsed = (window.__autoParsed || 0) + 1;   // 计数探针
if (!window.__autoDone) {
            window.__autoDone = true;
            const _q = new URLSearchParams(location.search);
            const _ap = parseFloat(_q.get('shot'));
            if (!isNaN(_ap)) {
              const au = _q.get('u'), ah = _q.get('h');
              if (au !== null && au !== '') window.__autoU = clamp(parseFloat(au), -1, 1);
              if (ah !== null && ah !== '') window.__autoH = clamp(parseFloat(ah), -1, 1);
              input.autoShot = _ap;
              updateContactUI();
            }
          }
        }
if (window.__DEBUG && (window.__fc & 15) === 0) {
      const dbg = document.getElementById('dbg');
      dbg.classList.remove('hidden');
      let sinkN = 0;
      for (const b of world.balls) if (b.sinking) sinkN++;
      dbg.textContent = 'fc=' + window.__fc + ' errs=' + (window.__errs.join(' | ') || 'none') +
        ' st=' + state + '/' + gameMode + ' turn=' + rules.player + ' open=' + rules.open +
        ' mv=' + world.moving + ' sink=' + sinkN +
        ' sk=' + world.balls.filter(b => b.sinking).map(b => b.id + ':' + b.sinkT.toFixed(2)).join(',') +
        ' pts=' + pottedThisShot.length +
        ' role=' + (netRole || '-') + ' wait=' + netWaiting +
        ' shot={' + (window.__shotDbg || '-') + '}';
    }
    const dt = Math.min(clock.getDelta(), 0.05);

    // 固定步长物理积分
    acc += dt;
    let guard = 0;
    while (acc >= PHYS_DT && guard++ < 40) {
      world.step(PHYS_DT);
      acc -= PHYS_DT;
    }

    // 空格蓄力：力度往复
    if (input.spaceCharging) {
      input.power += input.spaceDir * 1.35 * dt;
      if (input.power >= 1) { input.power = 1; input.spaceDir = -1; }
      if (input.power <= 0) { input.power = 0; input.spaceDir = 1; }
    }

    // 联机：本机瞄准状态节流广播（对手与观战者可见其辅助线），仅在变化时发送
    if (netInGame() && myTurn() && state === 'AIM' && !netWaiting &&
        window.__fc - lastAimSend > 10 && cueBall.active) {
      const changed = input.aimAngle !== lastSentAngle || input.power !== lastSentPower;
      if (changed || window.__fc - lastAimSend > 60) {   // 静止时降频心跳，保持远端辅助线不过期
        lastAimSend = window.__fc;
        lastSentAngle = input.aimAngle;
        lastSentPower = input.power;
        NET.send({ t: 'aim', angle: input.aimAngle, power: input.power });
      }
    }

    syncMeshes(dt);
    FX.update(dt);
    updateStrike(dt);
    updateGuide();
    updateCuePose();
    updateCamera(dt);
    updatePowerUI();
    renderer.render(scene, camera);

    if (state === 'ROLL') checkSettle();
  }

  /* ================= 联机：大厅与消息处理 ================= */
  const lobbyEl = () => $('lobby');

  function showLobby(on) { lobbyEl().classList.toggle('hidden', !on); }
  function lobbyStatus(txt) { $('lobby-status').textContent = txt; }

  function lobbyRoster(d) {
    netNames[1] = d.p1 || netNames[1];
    netNames[2] = d.p2 || netNames[2];
    $('lobby-info').textContent = '房间内 ' + d.filled + '/2 位玩家 · 观战 ' + d.specs + ' 人' +
      (d.p1 && d.p2 ? '（' + d.p1 + ' VS ' + d.p2 + '）' : '');
  }

  function netBadge() {
    const el = $('net-badge');
    if (!netInGame()) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    if (netRole === 'spec') el.textContent = '👀 观战中';
    else if (netWaiting) el.textContent = '🟠 「' + (myName || '…') + '」匹配中…';
    else el.textContent = '🟢 联机对局 · 「' + (myName || '?') + '」（你）';
  }

  /** 收到 start：双方重建棋盘并进入对局 */
  function startNetMatch() {
    netWaiting = false;
    gameMode = 'versus-net';
    document.body.classList.add('mode-versus');
    restart();
    startTime = Date.now();
    hideOverlays();
    showLobby(false);
    showToast(netRole === 'p1'
      ? '对手「' + pname(2) + '」已加入！你先开球'
      : '已匹配！对方「' + pname(1) + '」先开球', 'good');
    netBadge();
  }

  function setupNet() {
    NET.on('welcome', d => {
      netRole = d.role;
      myName = d.name || '';
      if (d.role === 'p1') netNames[1] = myName;
      if (d.role === 'p2') netNames[2] = myName;
      netBadge();
      lobbyRoster({ filled: d.player > 0 ? 1 : 0, specs: d.specs, p1: netNames[1] || null, p2: netNames[2] || null });
      lobbyStatus(d.role === 'spec'
        ? '👀 当前已有两名玩家在对局，你将以观战视角观看'
        : d.role === 'p1'
          ? '你是「' + myName + '」（房主）· 把页面地址发给对手即可匹配'
          : '你是「' + myName + '」· 正在等待匹配…');
      showLobby(true);
    });
    NET.on('roster', d => lobbyRoster(d));
    NET.on('start', () => startNetMatch());
    NET.on('reset', () => {
      netWaiting = true;
      restart();
      hideOverlays();
      showLobby(true);
      lobbyStatus('对手已离开 · 等待新对手加入…');
      netBadge();
    });    NET.on('aim', d => {
      remoteAim.angle = d.angle || 0;
      remoteAim.power = d.power || 0;
      remoteAim.contact = d.contact || remoteAim.contact;
      remoteAim.t = window.__fc;
    });
    NET.on('shot', d => {
      // 无球面快照的裸指令是玩家2发给房主的出杆请求，仅房主执行；
      // 带快照的是房主权威广播，对手与观众都据此本地模拟
      if (!d.balls) {
        if (netRole !== 'p1') return;
        // 权威端回合校验：只接受轮到玩家2且局面就绪时的出杆指令
        if (state !== 'AIM' || !cueBall.active || netWaiting || rules.player !== 2) {
          showToast('⚠ 忽略了对方的出杆指令（回合校验）', '');
          return;
        }
      }
      restoreBalls(d.balls || []);
      shoot(d.power, d.angle, d.contact);
    });
    NET.on('settled', d => {
      restoreBalls(d.balls || []);
      if (d.rules) applyRulesSnap(d.rules);
      score = d.score | 0;
      shots = d.shots | 0;
      updateHUD();
      updateVersusHUD();
      const msgs = d.msgs || [];
      if (msgs.length) showToast(msgs.join(' · '), '');   // 与房主端提示保持一致
      if (d.over) netShowWin(d.winner, d.reason);
      else state = 'AIM';
      resetContact();
    });
    NET.on('restart', () => {
      restart();
      state = 'AIM';
      hideOverlays();
      showToast('新的一局开始！「' + pname(1) + '」先手', 'good');
    });
    NET.on('close', () => {
      if (netInGame()) {
        netRole = null;
        netWaiting = true;
        document.body.classList.remove('mode-versus');
        showLobby(false);
        $('overlay').classList.remove('hidden');
        showToast('与服务器断开连接', 'bad');
        netBadge();
      }
    });
NET.on('error', msg => {
      lobbyStatus('⚠ ' + msg);
    });
    NET.on('reconnect', d => {
      // 免费实例冷启动：首次连接失败后自动重试，大厅提示唤醒进度
      lobbyStatus('🟡 服务器唤醒中…（第 ' + d.attempt + ' 次重连，免费实例首次约需 1 分钟）');
    });
  }

  function requestRestart() {
    if (netInGame()) {
      if (netRole === 'p1' && isAuthority()) {
        restart();
        hideOverlays();
        NET.send({ t: 'restart' });
        showToast('已重新开局', '');
      } else {
        showToast('只有房主可以重新开局', '');
      }
    } else {
      restart();
      hideOverlays();
      showToast('已重新开局', '');
    }
  }

  /* ================= 按钮 / 启动 ================= */
  function startGame(mode) {
    gameMode = mode;
    netWaiting = false; // 进入单机/本地模式时解除联机等待阻塞
    SFX.init();
    if (mode === 'versus') {
      // 本地双人：随机分配两个不重复的搞笑昵称
      localNames[1] = pickLocalName([]);
      localNames[2] = pickLocalName([localNames[1]]);
    }
    restart();
    hideOverlays();
    startTime = Date.now();
    document.body.classList.toggle('mode-versus', mode === 'versus');
const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    showToast(mode === 'versus'
      ? '双人对战 · 「' + localNames[1] + '」先开球！'
      : coarse ? '开球！点按瞄准 · 向后拖拽蓄力，松开出杆 🎯' : '开球！把彩球打进袋里 🎯', 'good');
  }
$('btn-arcade').addEventListener('click', () => startGame('arcade'));
$('btn-online').addEventListener('click', () => {
    SFX.init();
    gameMode = 'versus-net';
    netWaiting = true;
    document.body.classList.add('mode-versus');
    restart();                       // 大厅背后摆好一桌球作为预览
    hideOverlays();
    showLobby(true);
    lobbyStatus('连接服务器中…');
    $('lobby-info').textContent = '';
    netBadge();
    if (!NET.connect()) {
      // connect() 内部会触发 error 回调更新大厅文案
    }
  });
  $('btn-leave').addEventListener('click', () => NET.close());
  $('btn-again').addEventListener('click', () => requestRestart());
  $('btn-restart').addEventListener('click', () => requestRestart());
  $('btn-top').addEventListener('click', () => setTopView(!topMode));
  $('btn-sound').addEventListener('click', toggleMute);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* 开机 */
  setupNet();
  buildCue();
  buildGuide();
  restart();
  animate();
})();

