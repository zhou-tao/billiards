/* ============================================================
 * game.js —— 主程序
 * 场景与台球桌搭建 / 球体生成 / 瞄准出杆交互 / 摄像机 /
 * 规则结算与 HUD / 渲染主循环
 * ============================================================ */
(async function () {
  'use strict';

  const { BALL_R, TABLE_W, TABLE_H, POCKETS, LIMIT_X, LIMIT_Z, Ball, World, applyStrike } = PoolPhys;
  const HALF_W = TABLE_W / 2;
  const HALF_H = TABLE_H / 2;
  const MAX_SHOT_SPEED = 6.4;
  /** 自由球摆放校验所需的物理常量（传给 rules.validatePlacement） */
  const PHYS_DIMS = { LIMIT_X, LIMIT_Z, BALL_R, POCKETS };

  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ================= 渲染器 / 场景 / 相机 ================= */
  const canvas = $('scene');
  // ?lowgfx 低画质模式：供老机器/集显使用（1倍像素比 + 小阴影贴图）
  const LOWGFX = /[?&]lowgfx\b/.test(location.search);
  // ?noXXX 调试开关：隐藏场景部件帮助定位渲染问题（nolamp/norig/noboard/nostand）
  const HIDE = k => location.search.includes('no' + k);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOWGFX });
  renderer.setPixelRatio(LOWGFX ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  // ?magbg 调试：背景改纯品红，用于判断画面元素的前后层级
  const MAGBG = location.search.includes('magbg');
  const BGCOL = MAGBG ? 0xff00ff : 0x030409;
  scene.background = new THREE.Color(BGCOL);
  scene.fog = new THREE.Fog(BGCOL, 9, 26);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 80);

  /* ================= 灯光 ================= */
  // 赛场氛围：整体压暗，主要亮度集中在球桌正上方的无影灯组（见 buildTableLamp）
  scene.add(new THREE.AmbientLight(0x8090aa, 0.10));
  scene.add(new THREE.HemisphereLight(0xa9c2f0, 0x120d08, 0.14));

  // 保留一盏低强度暖光负责投影与球体明暗过渡，不再承担主照明
  const key = new THREE.DirectionalLight(0xffe8c8, 0.26);
  key.position.set(1.4, 3.4, 0.9);
  key.castShadow = true;
  key.shadow.mapSize.set(LOWGFX ? 1024 : 2048, LOWGFX ? 1024 : 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 10;
  key.shadow.camera.left = -2.2;
  key.shadow.camera.right = 2.2;
  key.shadow.camera.top = 1.8;
  key.shadow.camera.bottom = -1.8;
  key.shadow.bias = -0.0004;
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);

  /* ================= 开机分阶段加载 =================
   * loader.js 暴露 window.__BOOT：stage() 上报阶段文案与进度，
   * frame() 在每段重活之间让浏览器绘制一帧（加载层动画肉眼可见地推进）。
   * 若加载层缺失（如离线场景）则退化为同步直跑，不影响正常游戏。
   * ==================================================== */
  const BOOT = window.__BOOT || { ready: true, stage() {}, frame: () => Promise.resolve(), done() {} };
  BOOT.stage('初始化渲染引擎…', 8);
  await BOOT.frame();

  /* ================= 氛围：球桌顶灯 + 桁架聚光灯 + 看台小动物观众 ================= */
  const ARENA = { lights: [], bases: [], spots: [], rigs: [], phones: [], pulses: [], beams: [], rimMat: null };
  const RAIL_Y = 3.02;                        // 桁架横梁高度（顶灯吊杆挂点）
  let crowdExciteV = 0;                       // 进球欢呼激励值（随时间衰减）

  /** 径向渐变光斑贴图：灯具眩光与观众手机屏共用 */
  function makeGlowTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  }

  /** 光锥贴图：出光口最亮，向落点方向渐隐，模拟体积光衰减 */
  function makeBeamTexture() {
    const cv = document.createElement('canvas');
    cv.width = 16; cv.height = 128;
    const g = cv.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.40)');
    grad.addColorStop(0.75, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 16, 128);
    return new THREE.CanvasTexture(cv);
  }

  const glowTex = makeGlowTexture();
  const beamTex = makeBeamTexture();

  function buildArena() {
    // 1) 灯光桁架：让灯具“挂”在结构上而不是悬空；归入同一父节点便于俯视时整体隐藏
    const rigRoot = new THREE.Group();
    scene.add(rigRoot);
    ARENA.rig = rigRoot;
    const rigMat = new THREE.MeshStandardMaterial({ color: 0x151820, roughness: 0.65, metalness: 0.45 });
    const mkBar = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), rigMat);
      m.position.set(x, RAIL_Y, z);
      rigRoot.add(m);
    };
    mkBar(4.62, 0.05, 0, 0.75);        // 前横梁：挂两盏侧灯
    mkBar(4.62, 0.05, 0, -1.38);       // 后横梁：挂后排灯
    mkBar(0.05, 2.18, -2.285, -0.315); // 左右纵梁封口
    mkBar(0.05, 2.18, 2.285, -0.315);
    mkBar(4.57, 0.05, 0, 0);           // 中横梁：吊挂球桌无影灯组

    // 2) 桁架聚光灯：赛场氛围点缀（主照明已移交球桌顶灯组），吊索 + 金属灯体 + 光锥
    const spots = [
      { x: -1.85, y: 2.72, z: 0.75, tx: 0.1, tz: -0.1, col: 0xfff2dd, pen: 0.15, ang: 0.55 },
      { x: 1.85, y: 2.72, z: 0.75, tx: -0.1, tz: -0.1, col: 0xfff2dd, pen: 0.15, ang: 0.55 },
      // 后灯横向穿越赛场，镜头顺轴望去会把整个光锥叠成一片色板，故不渲染其光锥
      { x: 0, y: 2.90, z: -1.38, tx: 0, tz: 0.3, col: 0xcfe0ff, pen: 0.12, ang: 0.50, noBeam: true },
    ];
    const DOWN = new THREE.Vector3(0, -1, 0);
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x101319, roughness: 0.5, metalness: 0.6 });
    for (const d of spots) {
      if (HIDE('rig')) continue;
      const s = new THREE.SpotLight(d.col, d.pen, 9, d.ang, 0.55, 1.1);
      s.position.set(d.x, d.y, d.z);
      s.target.position.set(d.tx, 0, d.tz);
      scene.add(s);
      scene.add(s.target);
      ARENA.lights.push(s);
      ARENA.bases.push(d.pen);

      const dir = new THREE.Vector3(d.tx - d.x, -d.y, d.tz - d.z);
      const lenToTgt = dir.length();
      dir.normalize();

      // 吊索把灯具连到桁架
      const cableLen = Math.max(0.04, RAIL_Y - 0.03 - d.y);
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, cableLen, 6), rigMat);
      cable.position.set(d.x, d.y + cableLen / 2, d.z);
      rigRoot.add(cable);

      // 枢轴（负责每帧微摆）→ 灯头（初始指向瞄准点）
      const pivot = new THREE.Group();
      pivot.position.set(d.x, d.y, d.z);
      const head = new THREE.Group();
      head.quaternion.setFromUnitVectors(DOWN, dir);
      pivot.add(head);

      const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.058, 0.17, 14), shellMat);
      shell.position.y = -0.10;
      head.add(shell);
      const lens = new THREE.Mesh(
        new THREE.CircleGeometry(0.05, 16),
        new THREE.MeshBasicMaterial({ color: d.col, toneMapped: false })
      );
      lens.rotation.x = Math.PI / 2;   // 镜片面朝出光方向（-Y）
      lens.position.y = -0.185;
      head.add(lens);
      const glare = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: d.col, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
      }));
      glare.scale.setScalar(0.5);
      glare.position.y = -0.21;
      head.add(glare);

      if (!LOWGFX && !d.noBeam) {
        // 光束刻意短小：长锥在镜头顺轴看去时会叠成满屏色板
        const beamLen = Math.min(lenToTgt * 0.42, 1.05);
        const mkBeam = (radius, op) => {
          const geo = new THREE.ConeGeometry(radius, beamLen, 22, 1, true);
          geo.translate(0, -beamLen / 2, 0);   // 锥顶在灯口、开口朝下
          const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            map: beamTex, color: d.col, transparent: true, opacity: op,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
            toneMapped: false, fog: false,
          }));
          mesh.frustumCulled = false;
          return mesh;
        };
        for (const b of [mkBeam(0.30, 0.30), mkBeam(0.13, 0.50)]) {
          head.add(b);
          ARENA.beams.push(b);
        }
      }
      rigRoot.add(pivot);
      ARENA.spots.push({ pivot, tgt: s.target, dir, len: lenToTgt, base: pivot.position.clone(), ph: Math.random() * Math.PI * 2 });
    }

    // 3) 环绕 LED 广告围挡：分隔比赛区与观众区（参考职业赛场地布置）
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xb8c8ff, emissive: 0x8ea6ff, emissiveIntensity: 0.45, roughness: 0.4,
    });
    ARENA.rimMat = rimMat;
    function makeBoardTexture() {
      const cv = document.createElement('canvas');
      cv.width = 1024; cv.height = 96;
      const g = cv.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 1024, 0);
      grad.addColorStop(0, '#101c3a'); grad.addColorStop(0.5, '#231044'); grad.addColorStop(1, '#0d1530');
      g.fillStyle = grad; g.fillRect(0, 0, 1024, 96);
      g.globalAlpha = 0.22;
      for (let x = -96, i = 0; x < 1120; x += 64, i++) {
        g.fillStyle = i % 2 ? '#3f6cff' : '#ff4d6d';
        g.beginPath();
        g.moveTo(x, 96); g.lineTo(x + 32, 0); g.lineTo(x + 50, 0); g.lineTo(x + 18, 96);
        g.fill();
      }
      g.globalAlpha = 1;
      g.font = 'italic bold 42px Arial, "PingFang SC", "Microsoft YaHei", sans-serif';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(255,255,255,.94)';
      ['动感台球', '汪汪能源', '小鱼干·赞助', '猫薄荷杯 MINT'].forEach((w, i) => {
        g.fillText(w, i * 256 + 26, 52);
      });
      const tex = new THREE.CanvasTexture(cv);
      tex.wrapS = THREE.RepeatWrapping;
      tex.encoding = THREE.sRGBEncoding;
      return tex;
    }
    const boardTexBase = makeBoardTexture();
    function mkBoardWall(len, x, z, rotY) {
      if (HIDE('board')) return;
      const tex = boardTexBase.clone();
      tex.needsUpdate = true;
      tex.repeat.x = len / 2.6;
      const wall = new THREE.Group();
      const backing = new THREE.Mesh(
        new THREE.BoxGeometry(len, 0.30, 0.03),
        new THREE.MeshStandardMaterial({ color: 0x0a1020, roughness: 0.85 })
      );
      backing.position.y = 0.15;
      wall.add(backing);
      // 贴图以平面正面始终朝向场内，杜绝 Box 面片带来的文字镜像
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(len, 0.30),
        new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
      );
      face.rotation.y = Math.PI;
      face.position.set(0, 0.15, -0.018);
      wall.add(face);
      const rim = new THREE.Mesh(new THREE.BoxGeometry(len + 0.01, 0.018, 0.03), rimMat);
      rim.position.y = 0.31;
      wall.add(rim);
      wall.position.set(x, 0, z);
      wall.rotation.y = rotY;
      scene.add(wall);
    }
    const BOARD_LZ = 1.55, BOARD_SX = 2.12;   // 离球台外沿留出球员走道
    mkBoardWall(3.40, 0, BOARD_LZ, 0);
    mkBoardWall(3.40, 0, -BOARD_LZ, Math.PI);
    mkBoardWall(1.90, BOARD_SX, 0, Math.PI / 2);
    mkBoardWall(1.90, -BOARD_SX, 0, -Math.PI / 2);

    // 4) 看台：四面环形，距球桌更远、四层台阶更大规模
    const standMat = new THREE.MeshStandardMaterial({ color: 0x141a2b, roughness: 0.92, metalness: 0 });
    const stands = [];
    const ROWS = 4, SEATS = 12;
    function mkStand(x, z, rotY, width) {
      if (HIDE('stand')) return;
      const g = new THREE.Group();
      for (let r = 0; r < ROWS; r++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(width, 0.42, 0.74), standMat);
        step.position.set(0, -0.02 + r * 0.33, -0.44 + r * 0.37);
        step.receiveShadow = true;
        g.add(step);
      }
      g.position.set(x, 0, z);
      g.rotation.y = rotY;
      scene.add(g);
      stands.push({ g, width });
    }
    mkStand(0, 2.60, 0, 3.90);             // 长边两侧
    mkStand(0, -2.60, Math.PI, 3.90);
    mkStand(3.05, 0, Math.PI / 2, 3.00);   // 短边两侧
    mkStand(-3.05, 0, -Math.PI / 2, 3.00);

    // 5) 观众：小动物（小猫 / 小狗）坐姿低模，逐只配色、逐相位晃动欢呼
    const bodyGeo = new THREE.CapsuleGeometry(0.056, 0.085, 3, 10);
    const headGeo = new THREE.SphereGeometry(0.049, 10, 9);
    const earGeo = new THREE.ConeGeometry(0.021, 0.06, 4);
    const tailGeo = new THREE.CylinderGeometry(0.009, 0.015, 0.17, 6);
    tailGeo.translate(0, 0.085, 0);   // 尾巴以根部为轴，方便摆动
    const furPal = [0xe0913c, 0xdccfb8, 0x8e929c, 0x7a5433, 0x3a3f41, 0xcaa26b, 0xf0e6d4];
    const furMatB = new THREE.MeshStandardMaterial({ roughness: 0.96, emissive: 0x08090e });
    const furMatH = new THREE.MeshStandardMaterial({ roughness: 0.94, emissive: 0x0a0b10 });
    const _cv = new THREE.Color(), _white = new THREE.Color(1, 1, 1), _light = new THREE.Color();

    for (const st of stands) {
      const g = st.g, w = st.width;
      const animals = [];
      for (let r = 0; r < ROWS; r++) {
        for (let j = 0; j < SEATS; j++) {
          if (Math.random() > 0.93) continue;                  // 留几个空座更自然
          animals.push({
            x: (j - (SEATS - 1) / 2) * (w / SEATS) + (Math.random() - 0.5) * 0.06,
            y: 0.19 + r * 0.33,                                // 所坐台阶的顶面高度
            z: -0.44 + r * 0.37 + (Math.random() - 0.5) * 0.04,
            s: 0.82 + Math.random() * 0.30,                    // 高矮体型差
            dog: Math.random() < 0.42,                         // 0=小猫 1=小狗
            lean: (Math.random() - 0.5) * 0.26,
            ph: Math.random() * Math.PI * 2,
            ph2: Math.random() * Math.PI * 2,
            bob: 0.007 + Math.random() * 0.013,
          });
        }
      }
      const n = animals.length;
      const bodies = new THREE.InstancedMesh(bodyGeo, furMatB, n);
      const heads = new THREE.InstancedMesh(headGeo, furMatH, n);
      const ears = new THREE.InstancedMesh(earGeo, furMatH, n * 2);
      const tails = new THREE.InstancedMesh(tailGeo, furMatH, n);
      [bodies, heads, ears, tails].forEach(m => { m.frustumCulled = false; g.add(m); });
      for (let i = 0; i < n; i++) {
        const fur = _cv.setHex(furPal[(Math.random() * furPal.length) | 0]);
        _light.copy(fur).lerp(_white, 0.25);                   // 头部毛色略浅
        bodies.setColorAt(i, fur);
        heads.setColorAt(i, _light);
        ears.setColorAt(i * 2, _light);
        ears.setColorAt(i * 2 + 1, _light);
        tails.setColorAt(i, fur);
      }
      ARENA.rigs.push({ animals, bodies, heads, ears, tails });

      // 看台里的手机星光点（粉丝拍摄中）
      if (!LOWGFX) {
        for (let k = 0; k < 7 && k < n; k++) {
          const p = animals[(Math.random() * n) | 0];
          const sm = new THREE.SpriteMaterial({
            map: glowTex, color: Math.random() < 0.75 ? 0xcfe2ff : 0xffe3b0,
            transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
          });
          const spark = new THREE.Sprite(sm);
          spark.scale.setScalar(0.085);
          spark.position.set(p.x + (Math.random() - 0.5) * 0.15, p.y + 0.30 * p.s, p.z + 0.05);
          g.add(spark);
          ARENA.phones.push({ mat: sm, ph: Math.random() * Math.PI * 2, w: 1.4 + Math.random() * 2.2 });
        }
      }

      // 看台正前补一盏冷色微光，让小动物有轮廓受光，与球桌暖光形成对比
      if (!LOWGFX) {
        const fill = new THREE.PointLight(0x91a8ff, 0.10, 2.2, 2);
        fill.position.set(0, 1.55, -0.55);
        g.add(fill);
      }
    }
  }
  BOOT.stage('搭建赛场看台与灯光桁架…', 16);
  await BOOT.frame();
  buildArena();

  /** 球桌正上方无影灯组：经典绿色长罩 + 柔光面板 + 主照明光源，吊杆挂于桁架中横梁 */
  function buildTableLamp() {
    if (HIDE('lamp')) return;
    const Y = 1.58;                           // 灯罩中心高度
    const rigDark = new THREE.MeshStandardMaterial({ color: 0x151820, roughness: 0.65, metalness: 0.45 });
    // 壳体用不受光材质：聚光灯光源位于罩内，受光材质会被自己的灯光打亮
    const shadeMat = new THREE.MeshBasicMaterial({ color: 0x081209 });
    const glowCol = 0xffeecb;

    // 顶灯统一挂在一个父节点下：俯视模式整体隐藏，避免灯罩挡住台面
    const lampRoot = new THREE.Group();
    scene.add(lampRoot);
    ARENA.lamp = lampRoot;

    // 吊杆 ×2 → 桁架中横梁
    for (const sx of [-1, 1]) {
      const len = RAIL_Y - 0.025 - Y;
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, len, 8), rigDark);
      rod.position.set(sx * 0.86, Y + len / 2, 0);
      lampRoot.add(rod);
    }

    // 灯罩外壳（近黑绿哑光，弱化体积感）+ 暖白柔光出光面
    const grp = new THREE.Group();
    grp.position.y = Y;
    lampRoot.add(grp);
    grp.add(new THREE.Mesh(new THREE.BoxGeometry(2.56, 0.13, 0.36), shadeMat));
    if (!HIDE('panel')) {
      const diffuser = new THREE.Mesh(
        new THREE.BoxGeometry(2.46, 0.016, 0.32),
        new THREE.MeshBasicMaterial({ color: glowCol, toneMapped: false })
      );
      diffuser.position.y = -0.069;
      grp.add(diffuser);

      // 出光口四周的暖光细边条：任意角度都能看到灯体在发光
      const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false });
      for (const sz of [-1, 1]) {
        const edge = new THREE.Mesh(new THREE.BoxGeometry(2.57, 0.012, 0.014), edgeMat);
        edge.position.set(0, -0.069, sz * 0.182);
        grp.add(edge);
      }
      for (const sx of [-1, 1]) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.012, 0.364), edgeMat);
        cap.position.set(sx * 1.285, -0.069, 0);
        grp.add(cap);
      }
    }

    // 三颗高亮“灯管”亮芯贴片 + 眩光（低画质跳过眩光）
    for (const bx of [-0.78, 0, 0.78]) {
      if (HIDE('glow')) continue;
      const bulb = new THREE.Mesh(
        new THREE.CircleGeometry(0.075, 18),
        new THREE.MeshBasicMaterial({ color: 0xfff8e6, toneMapped: false })
      );
      bulb.rotation.x = Math.PI / 2;
      bulb.position.set(bx, -0.088, 0);
      grp.add(bulb);
      if (!LOWGFX) {
        const gl = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex, color: glowCol, transparent: true, opacity: 0.75,
          blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
        }));
        gl.scale.setScalar(0.72);
        gl.position.set(bx, -0.13, 0);
        grp.add(gl);
      }
    }

    // （顶灯不再使用体积光锥：开口向下的锥体在斜上方视角会铺满台面形成雾板）

    // 实际光源：两盏下照聚光（窄锥贴住球桌，不外溢照亮看台）+ 中央补光
    const addPulse = HIDE('lpl') ? () => {} : (l, base) => ARENA.pulses.push({ l, base });
    for (const sx of [-1, 1]) {
      if (HIDE('lpl')) break;
      const s = new THREE.SpotLight(0xffe7bf, 0.88, 4.2, 0.44, 0.60, 1.0);
      s.position.set(sx * 0.60, Y - 0.06, 0);
      s.target.position.set(sx * 0.60, 0, 0);
      scene.add(s);
      scene.add(s.target);
      addPulse(s, 0.88);
    }
    if (!HIDE('lpl')) {
      const mid = new THREE.PointLight(0xffdfae, 0.24, 2.2, 2.0);
      mid.position.set(0, Y - 0.10, 0);
      scene.add(mid);
      addPulse(mid, 0.24);
    }
  }
  BOOT.stage('悬挂球桌上空灯组…', 27);
  await BOOT.frame();
  buildTableLamp();

  /** 每帧氛围驱动：灯光呼吸 / 光锥微摆 / 小动物观众晃动欢呼（耳抖尾摇） */
  const _ae = new THREE.Euler(), _aq = new THREE.Quaternion(), _ae2 = new THREE.Euler(),
        _q2 = new THREE.Quaternion(),
        _ap = new THREE.Vector3(), _as = new THREE.Vector3(), _am = new THREE.Matrix4();
  function arenaTick(t, dt) {
    for (let i = 0; i < ARENA.lights.length; i++)
      ARENA.lights[i].intensity = ARENA.bases[i] * (0.86 + 0.14 * Math.sin(t * 1.9 + i * 2.2));

    // 球桌顶灯轻微呼吸闪烁
    for (const p of ARENA.pulses)
      p.l.intensity = p.base * (1 + 0.05 * Math.sin(t * 1.15 + p.base * 7));

    for (const sp of ARENA.spots) {
      sp.pivot.rotation.x = Math.sin(t * 0.8 + sp.ph) * 0.02;
      sp.pivot.rotation.z = Math.cos(t * 0.63 + sp.ph) * 0.02;
      sp.tgt.position.copy(sp.dir).applyEuler(sp.pivot.rotation).multiplyScalar(sp.len).add(sp.base);
    }

    crowdExciteV *= Math.exp(-1.25 * dt);
    const E = crowdExciteV;

    // 围挡 LED 灯带随欢呼增亮
    if (ARENA.rimMat)
      ARENA.rimMat.emissiveIntensity = 0.42 + 0.18 * (0.5 + 0.5 * Math.sin(t * 2.6)) + 0.8 * E;

    for (const rig of ARENA.rigs) {
      const A = rig.animals;
      for (let i = 0; i < A.length; i++) {
        const a = A[i];
        const dy = Math.sin(t * 3.1 + a.ph) * a.bob +                    // 常时轻晃
                   Math.max(0, Math.sin(t * 7.3 + a.ph)) * 0.055 * E;    // 欢呼时蹦跳

        // —— 身体（狗壮猫瘦）——
        _ae.set(a.lean + Math.sin(t * 2.2 + a.ph) * (0.03 + 0.10 * E), 0, 0);
        _aq.setFromEuler(_ae);
        _as.set(a.s, a.s * (a.dog ? 1.03 : 0.94), a.s * 1.06);
        _ap.set(a.x, a.y + 0.105 * a.s + dy, a.z);
        rig.bodies.setMatrixAt(i, _am.compose(_ap, _aq, _as));

        // —— 头（常时小点头，进球激动抬头）——
        _ae2.set(a.lean * 0.5 + Math.sin(t * 3.4 + a.ph2) * (0.05 + 0.22 * E), 0, 0);
        _q2.setFromEuler(_ae2);
        const hs = a.s * (a.dog ? 1.07 : 1.0);
        _as.set(hs, hs, hs * 1.08);
        _ap.set(a.x, a.y + 0.248 * a.s + dy, a.z - 0.010 * a.s);
        rig.heads.setMatrixAt(i, _am.compose(_ap, _q2, _as));

        // —— 耳朵（猫耳直立尖、兴奋抽动；狗耳短圆外耷）——
        for (let e = 0; e < 2; e++) {
          const side = e ? 1 : -1;
          const twitch = 1 + Math.sin(t * (6 + 9 * E) + a.ph2 + e * 2.1) * (0.10 + 0.28 * E);
          _ae2.set(
            a.dog ? 0.55 : -0.10 + Math.sin(t * 2.7 + a.ph) * 0.05,
            0,
            side * (a.dog ? 1.05 : 0.20)
          );
          _q2.setFromEuler(_ae2);
          _as.set(a.s * (a.dog ? 1.55 : 1.05), a.s * (a.dog ? 0.60 : 1.0) * twitch, a.s);
          _ap.set(a.x + side * 0.030 * a.s, a.y + 0.290 * a.s + dy, a.z - 0.008 * a.s);
          rig.ears.setMatrixAt(i * 2 + e, _am.compose(_ap, _q2, _as));
        }

        // —— 尾巴（猫尾斜上扬、狗尾后翘；欢呼加速摇摆）——
        _ae2.set(a.dog ? 1.15 : 0.45, 0, Math.sin(t * (2.2 + 9 * E) + a.ph2) * (0.18 + 0.5 * E));
        _q2.setFromEuler(_ae2);
        _as.setScalar(a.s * (a.dog ? 1.12 : 0.92));
        _ap.set(a.x, a.y + 0.015 + dy * 0.4, a.z + 0.074 * a.s);
        rig.tails.setMatrixAt(i, _am.compose(_ap, _q2, _as));
      }
      rig.bodies.instanceMatrix.needsUpdate = true;
      rig.heads.instanceMatrix.needsUpdate = true;
      rig.ears.instanceMatrix.needsUpdate = true;
      rig.tails.instanceMatrix.needsUpdate = true;
    }

    for (const f of ARENA.phones)
      f.mat.opacity = clamp(0.10 + 0.45 * (0.5 + 0.5 * Math.sin(t * f.w + f.ph)) ** 2 + 0.5 * E, 0, 1);
  }

  /** 进球时的观众激励：短暂欢腾弹跳 */
  function crowdExcite(v) { crowdExciteV = Math.min(1.6, crowdExciteV + v); }

/* ================= 特效系统接入 ================= */
  BOOT.stage('接入粒子特效…', 33);
  await BOOT.frame();
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

  BOOT.stage('铺设台呢 · 挖出袋口…', 38);
  await BOOT.frame();
  const table = new THREE.Group();
  scene.add(table);
  {
    const clothMat = new THREE.MeshStandardMaterial({ color: 0x0b7a42, roughness: 0.94, metalness: 0 });
    const cushMat = clothMat;   // 库边立面同台呢绿布（斯诺克传统包法）
    // 深红棕漆面木框（库边压条 / 围板），参照传统斯诺克球桌
    const woodMat = new THREE.MeshPhysicalMaterial({
      color: 0x5e1820, roughness: 0.26, metalness: 0.05,
      clearcoat: 0.9, clearcoatRoughness: 0.16,
    });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08b4f, roughness: 0.32, metalness: 0.85 });

    // 台呢（顶面正好在 y=0）
    // 台呢：整块厚板真实挖出 6 个袋口孔（洞下是导袋筒与球网）
    // 四角做圆角（与外框圆角同心内缩），避免直角从外框圆角处漏出
    const clothShape = new THREE.Shape();
    buildRoundedRect(clothShape, HALF_W + 0.115, HALF_H + 0.115, 0.13);
    for (const p of POCKETS) {
      const hp = new THREE.Path();
      hp.absarc(p.x, -p.z, p.r + 0.010, 0, Math.PI * 2, true);
      clothShape.holes.push(hp);
    }
    const clothGeo = new THREE.ExtrudeGeometry(clothShape, { depth: 0.02, bevelEnabled: false, curveSegments: 12 });
    clothGeo.rotateX(-Math.PI / 2);
    const cloth = new THREE.Mesh(clothGeo, clothMat);
    cloth.position.y = -0.02;          // 顶面正好在 y=0
    cloth.receiveShadow = true;
    table.add(cloth);

    // 库边：绿呢垫条（与台呢同色），6 段单层结构（无压条叠层）
    // 两端沿洞口同心圆弧收头（弧半径 = 洞口半径 + 间隙）：俯视下洞口开孔范围内无库边投影
    // 顶高 0.054 与外框面板顶面齐平；背面直接接到外框内缘（无缝）
    const CUSH_D = 0.05, CUSH_H = 0.054;
    const C_BITE = POCKETS[0].r + 0.016;      // 角袋侧贴合弧半径（洞口 0.076 + 6mm 间隙）
    const S_BITE = POCKETS[4].r + 0.016;      // 中袋侧贴合弧半径（洞口 0.068 + 6mm 间隙）

    /**
     * 生成一段贴洞库边截面（局部坐标：u 沿库边、v 法向；鼻线 v=noseC、背线 v=backC）
     * endA/endB：两端洞口 { u, v, R }（洞心局部坐标 + 贴合弧半径）
     * map(u, v) → [shapeX, shapeY]（shape.y = -world.z）
     */
    function railGeo(noseC, backC, endA, endB, map) {
      const pt = (u, v) => { const p = map(u, v); return { x: p[0], y: p[1] }; };
      const dir = Math.sign(endB.u - endA.u) || 1;
      // 求洞口贴合弧与鼻线002f背线的交点：交点必须落在段体一侧（A 端朝 +u、B 端朝 -u）
      const cutP = (p, lineC, sign) => {
        const dv = lineC - p.v;
        const du = sign * Math.sqrt(Math.max(0.0004, p.R * p.R - dv * dv));
        return { u: p.u + du, v: lineC };
      };
      const nA = cutP(endA, noseC, dir), nB = cutP(endB, noseC, -dir);
      const bB = cutP(endB, backC, -dir), bA = cutP(endA, backC, dir);
      const A0 = pt(nA.u, noseC), B0 = pt(nB.u, noseC);
      const B1 = pt(bB.u, backC), A1 = pt(bA.u, backC);
      const cA = pt(endA.u, endA.v), cB = pt(endB.u, endB.v);
      const s = new THREE.Shape();
      s.moveTo(A0.x, A0.y);
      s.lineTo(B0.x, B0.y);                                             // 鼻端（球接触面）
      {
        const c = cB, a1 = Math.atan2(B0.y - c.y, B0.x - c.x);
        let d = Math.atan2(B1.y - c.y, B1.x - c.x) - a1;
        while (d <= -Math.PI) d += 2 * Math.PI;
        while (d > Math.PI) d -= 2 * Math.PI;
        s.absarc(c.x, c.y, endB.R, a1, a1 + d, d < 0);                  // B 端沿洞口圆弧
      }
      s.lineTo(A1.x, A1.y);                                             // 背面
      {
        const c = cA, a1 = Math.atan2(A1.y - c.y, A1.x - c.x);
        let d = Math.atan2(A0.y - c.y, A0.x - c.x) - a1;
        while (d <= -Math.PI) d += 2 * Math.PI;
        while (d > Math.PI) d -= 2 * Math.PI;
        s.absarc(cA.x, cA.y, endA.R, a1, a1 + d, d < 0);                // A 端沿洞口圆弧
      }
      const g = new THREE.ExtrudeGeometry(s, { depth: CUSH_H, bevelEnabled: false, curveSegments: 12 });
      g.rotateX(-Math.PI / 2);                                          // shape.y = -world.z
      return g;
    }

    // 6 段库边：局部坐标系（u 沿库边、v 法向）与两端洞口
    // 背线取外框内缘线（HALF + CUSH_D + 0.0035），库边背面与外框内缘无缝衔接
    const segs = [];
    for (const sz of [1, -1]) {
      // 长库边（左右两半）：u = world x，v = world z
      // 映射固定为 shape = [u, -v]（rotateX 后 world.z = -shape.y），正负侧通用
      const mapL = (u, v) => [u, -v];
      segs.push({ sz, noseC: sz * HALF_H, backC: sz * (HALF_H + CUSH_D + 0.0035), map: mapL,
        A: { u: -Math.abs(POCKETS[0].x), v: sz * Math.abs(POCKETS[0].z), R: C_BITE },
        B: { u: -Math.abs(POCKETS[4].x), v: sz * Math.abs(POCKETS[4].z), R: S_BITE } });
      segs.push({ sz, noseC: sz * HALF_H, backC: sz * (HALF_H + CUSH_D + 0.0035), map: mapL,
        A: { u: Math.abs(POCKETS[4].x), v: sz * Math.abs(POCKETS[4].z), R: S_BITE },
        B: { u: Math.abs(POCKETS[0].x), v: sz * Math.abs(POCKETS[0].z), R: C_BITE } });
    }
    for (const sx of [1, -1]) {
      // 短库边：u = world z，v = world x（两端都是角袋）；映射固定为 shape = [v, -u]
      const mapS = (u, v) => [v, -u];
      segs.push({ sz: sx, noseC: sx * HALF_W, backC: sx * (HALF_W + CUSH_D + 0.0035), map: mapS,
        A: { u: -Math.abs(POCKETS[0].z), v: sx * Math.abs(POCKETS[0].x), R: C_BITE },
        B: { u: Math.abs(POCKETS[0].z), v: sx * Math.abs(POCKETS[0].x), R: C_BITE } });
    }
    for (const seg of segs) {
      const m = new THREE.Mesh(railGeo(seg.noseC, seg.backC, seg.A, seg.B, seg.map), cushMat);
      m.castShadow = m.receiveShadow = true;
      table.add(m);
    }

    // 台面外圈：一整块带圆角的环形面板（圆角矩形挖孔后挤出成型）
    const RAIL_T = 0.10;
    function buildRoundedRect(target, hx, hz, r) {
      target.moveTo(-hx + r, -hz);
      target.lineTo(hx - r, -hz);
      target.quadraticCurveTo(hx, -hz, hx, -hz + r);
      target.lineTo(hx, hz - r);
      target.quadraticCurveTo(hx, hz, hx - r, hz);
      target.lineTo(-hx + r, hz);
      target.quadraticCurveTo(-hx, hz, -hx, hz - r);
      target.lineTo(-hx, -hz + r);
      target.quadraticCurveTo(-hx, -hz, -hx + r, -hz);
    }
    const HX_OUT = HALF_W + CUSH_D + RAIL_T - 0.01;
    const HZ_OUT = HALF_H + CUSH_D + RAIL_T - 0.01;
    const frameShape = new THREE.Shape();
    buildRoundedRect(frameShape, HX_OUT, HZ_OUT, 0.15);
    // 内缘：沿圆角矩形行进，在每个袋口处绕出让位圆弧（红色外框为洞口让位）
    const holePath = new THREE.Path();
    const inHx = HALF_W + CUSH_D + 0.0035, inHz = HALF_H + CUSH_D + 0.0035, inRc = 0.088;
    const cBite = C_BITE + 0.004;              // 角袋让位半径：比库边贴合弧大 4mm，露出一圈红边
    const sBite = S_BITE + 0.004;              // 中袋让位半径
    const cPx = Math.abs(POCKETS[0].x), cPz = Math.abs(POCKETS[0].z);
    const sPz = Math.abs(POCKETS[4].z);
    const ang = (cx, cz, px, pz) => Math.atan2(pz - cz, px - cx);
    // 缺口与内缘直边的交点半宽/半高（运行时计算，随袋口偏移自适应）
    const cCutX = Math.sqrt(cBite * cBite - (inHz - cPz) ** 2);   // 角袋缺口在横边上的半宽
    const cCutY = Math.sqrt(cBite * cBite - (inHx - cPx) ** 2);   // 角袋缺口在竖边上的半高
    const sCut = Math.sqrt(sBite * sBite - (inHz - sPz) ** 2);    // 中袋缺口在横边上的半宽
    holePath.moveTo(-inHx + inRc, -inHz);
    // 底边 → 中袋缺口 → 右下角袋缺口
    holePath.lineTo(-sCut, -inHz);
    holePath.absarc(0, -sPz, sBite, ang(0, -sPz, -sCut, -inHz), ang(0, -sPz, sCut, -inHz), false);
    holePath.lineTo(cPx - cCutX, -inHz);
    holePath.absarc(cPx, -cPz, cBite, ang(cPx, -cPz, cPx - cCutX, -inHz), ang(cPx, -cPz, inHx, -cPz + cCutY), false);
    // 右边 → 右上角袋缺口
    holePath.lineTo(inHx, cPz - cCutY);
    holePath.absarc(cPx, cPz, cBite, ang(cPx, cPz, inHx, cPz - cCutY), ang(cPx, cPz, cPx - cCutX, inHz), false);
    // 顶边 → 中袋缺口 → 顶边
    holePath.lineTo(sCut, inHz);
    holePath.absarc(0, sPz, sBite, ang(0, sPz, sCut, inHz), ang(0, sPz, -sCut, inHz), false);
    holePath.lineTo(-(cPx - cCutX), inHz);
    // 左上角袋缺口 → 左边
    holePath.absarc(-cPx, cPz, cBite, ang(-cPx, cPz, -(cPx - cCutX), inHz), ang(-cPx, cPz, -inHx, cPz - cCutY), false);
    holePath.lineTo(-inHx, -(cPz - cCutY));
    // 左下角袋缺口 → 闭合回底边起点
    holePath.absarc(-cPx, -cPz, cBite, ang(-cPx, -cPz, -inHx, -(cPz - cCutY)), ang(-cPx, -cPz, -(cPx - cCutX), -inHz), false);
    frameShape.holes.push(holePath);
    // 外框加厚为实心框体：顶面 0.054 与库边齐平，一直延伸到台呢以下（-0.03），
    // 封住框体与绿色呢面之间的空隙，袋口缺口侧壁也随之封闭
    const PANEL_DEPTH = 0.084;
    const panelGeo = new THREE.ExtrudeGeometry(frameShape, {
      depth: PANEL_DEPTH, bevelEnabled: false,
      curveSegments: 14,
    });
    const panel = new THREE.Mesh(panelGeo, woodMat);
    panel.rotation.x = -Math.PI / 2;                   // 形状 XY 落到 XZ 平面，厚度向上
    panel.position.y = -0.03;                          // 顶面 = -0.03 + 0.084 = 0.054
    panel.receiveShadow = true;
    table.add(panel);

    // 内部支撑裙箱：收在圆角面板轮廓以内，任何视角都不可见，仅供桌腿衔接与遮底
    mkBox(TABLE_W - 0.1, 0.17, TABLE_H - 0.1, 0, -0.105, 0, woodMat);

    const legProfile = [
      [0.075, 0], [0.068, 0.02], [0.042, 0.07], [0.052, 0.17],
      [0.036, 0.30], [0.042, 0.40], [0.054, 0.50], [0.058, 0.555],
    ].map(p => new THREE.Vector2(p[0], p[1]));
    const legGeo = new THREE.LatheGeometry(legProfile, 18);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, brassMat);
      leg.position.set(sx * (HALF_W - 0.15), -0.718, sz * (HALF_H - 0.08));
      leg.castShadow = true;
      table.add(leg);
    }

    // 地面：赛场地毯（中心稍亮、四周沉入黑暗的暗角）
    const carpetCv = document.createElement('canvas');
    carpetCv.width = carpetCv.height = 512;
    {
      const c = carpetCv.getContext('2d');
      const g = c.createRadialGradient(256, 256, 60, 256, 256, 300);
      g.addColorStop(0, '#232c49');
      g.addColorStop(0.55, '#161d33');
      g.addColorStop(1, '#070a14');
      c.fillStyle = g;
      c.fillRect(0, 0, 512, 512);
      c.globalAlpha = 0.05;
      for (let i = 0; i < 512; i += 8) {   // 极淡的织物纹路
        c.fillStyle = i % 16 ? '#ffffff' : '#000000';
        c.fillRect(0, i, 512, 1);
        c.fillRect(i, 0, 1, 512);
      }
    }
    const carpetTex = new THREE.CanvasTexture(carpetCv);
    carpetTex.encoding = THREE.sRGBEncoding;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(34, 34),
      new THREE.MeshStandardMaterial({ map: carpetTex, color: 0xffffff, roughness: 0.97 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.72;
    floor.receiveShadow = true;
    scene.add(floor);

    // 袋口：只保留洞口本身（不加任何遮罩物）
    // 袋口：导袋筒 + 菱形网眼球网（洞口真实通透，无口环遮罩）
    // 筒壁双面渲染：斜角度观察时近侧筒壁也封住视线，袋内呈封闭暗井而非镂空
    const throatMat = new THREE.MeshStandardMaterial({ color: 0x0a0d13, roughness: 0.95, side: THREE.DoubleSide });
    const pitMat = new THREE.MeshBasicMaterial({ color: 0x04050a });
    const netMat = new THREE.LineBasicMaterial({ color: 0xb7a67f, transparent: true, opacity: 0.5 });
    for (const p of POCKETS) {
      const g = new THREE.Group();
      // 导袋筒内壁：顶沿压在台呢之下、口径与洞口齐平（避免筒沿露出呢面成虚线圈）
      const throat = new THREE.Mesh(
        new THREE.CylinderGeometry(p.r + 0.012, p.r * 0.62, 0.1, 24, 1, true), throatMat);
      throat.position.set(p.x, -0.071, p.z);
      // 筒底封口：与筒底同径的圆片贴在筒底，彻底封住袋底
      const pit = new THREE.Mesh(new THREE.CircleGeometry(p.r * 0.65, 24), pitMat);
      pit.rotation.x = -Math.PI / 2;
      pit.position.set(p.x, -0.118, p.z);
      // 球网：斜向菱形网眼 + 逐层收口环
      const R0 = p.r + 0.012, R1 = p.r * 0.52, Y0 = -0.012, Y1 = -0.088;
      const LEVELS = 4, STRANDS = 10;
      const ringR = i => R0 + (R1 - R0) * (i / LEVELS);
      const ringY = i => Y0 + (Y1 - Y0) * (i / LEVELS);
      const pts = [];
      for (let si = 0; si < STRANDS; si++) {
        const a0 = (si / STRANDS) * Math.PI * 2;
        for (let i = 0; i < LEVELS; i++) {
          const dA = (i % 2 === 0 ? -1 : 1) * Math.PI / STRANDS;
          pts.push(
            p.x + Math.cos(a0 + dA) * ringR(i), ringY(i), p.z + Math.sin(a0 + dA) * ringR(i),
            p.x + Math.cos(a0 - dA) * ringR(i + 1), ringY(i + 1), p.z + Math.sin(a0 - dA) * ringR(i + 1));
        }
      }
      for (let i = 0; i <= LEVELS; i++) {
        for (let k = 0; k < 24; k++) {
          const a1 = (k / 24) * Math.PI * 2, a2 = ((k + 1) / 24) * Math.PI * 2;
          pts.push(
            p.x + Math.cos(a1) * ringR(i), ringY(i), p.z + Math.sin(a1) * ringR(i),
            p.x + Math.cos(a2) * ringR(i), ringY(i), p.z + Math.sin(a2) * ringR(i));
        }
      }
      const netGeo = new THREE.BufferGeometry();
      netGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const net = new THREE.LineSegments(netGeo, netMat);
      g.add(throat, pit, net);
      table.add(g);
    }

    // 置球点与开球线标记
    const spotMat = new THREE.MeshBasicMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.5 });
    for (const sx of [-1, 1]) {
      const spot = new THREE.Mesh(new THREE.CircleGeometry(0.006, 16), spotMat);
      spot.rotation.x = -Math.PI / 2;
      spot.position.set(sx * HALF_W / 2, 0.0023, 0);
      table.add(spot);
    }

    // （真实球台围板上的钻石位标记在游戏比例下易被误认为杂点，已移除）
  }
  BOOT.stage('球桌完成 · 生成球体与物理世界…', 52);
  await BOOT.frame();

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
  let state = 'READY';              // READY | AIM | ROLL | OVER
  let score = 0, shots = 0, startTime = 0;
  let pottedThisShot = [];
  let cueFouled = false;
  let clearedPending = false;
  let arcadePotted = 0;             // 街机模式已落袋彩球数（清台判定用）
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
  let shotCushionAfterContact = false; // 首碰之后任意球是否碰过库边（"无碰库"犯规判定，issue #6）

  /* ---- 自由球（ball-in-hand，issue #6）---- */
  let ballInHandFor = 0;            // 0=无 | 1|2=该玩家可任意摆放白球
  let placingBallInHand = false;    // 本机正在摆放（鼠标/触屏选定落点）

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
      if (shotFirstContact !== null) shotCushionAfterContact = true;   // 首碰后的碰库记录（规则用）
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
        SFX.crowd(1);   // 观众为进球欢呼
        crowdExcite(1);
        pottedThisShot.push(e.ballId);
        rules.notePot(e.ballId);
        if (gameMode === 'arcade') {
          addScore(100);
          showToast('🎯 ' + e.ballId + ' 号球落袋 +100', 'good');
          addTrayBadge(e.ballId);
          // 计数判定而非检查场上 active/sinking：连续落袋时前一球还在播下沉动画，
          // 场面检查会漏判，导致清台后胜利界面不出现
          arcadePotted++;
          if (arcadePotted >= 15) {
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

  /* ================= 自由球摆放（issue #6） ================= */
  // 半透明白色 ghost：摆放模式跟随指针，绿色=合法落点，红色=非法
  const bihGhost = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x7cfc00, transparent: true, opacity: 0.45, depthWrite: false })
  );
  bihGhost.visible = false;
  scene.add(bihGhost);

  /** 犯规后进入自由球：pl 号玩家可把白球摆到任意合法位置 */
  function beginBallInHand(pl) {
    ballInHandFor = pl;
    cueBall.active = false;          // 白球离桌，等待摆放
    cueBall.sinking = false;
    cueBall.stop();
    if (cueBall.mesh) cueBall.mesh.visible = false;
    const mine = !netInGame() || netRole === (pl === 1 ? 'p1' : 'p2');
    placingBallInHand = mine && state !== 'OVER';
    bihGhost.visible = placingBallInHand;
    // ghost 初始停在开球线附近（若该处不合法，第一条指针消息会立刻更新）
    bihGhost.position.set(clamp(cueBall.pos.x, -LIMIT_X, LIMIT_X), BALL_R, clamp(cueBall.pos.z, -LIMIT_Z, LIMIT_Z));
    refreshBihGhostColor();
    if (placingBallInHand) showToast('🖐 自由球 · 移动选择位置，点击台面摆放白球', 'good');
    else showToast(pname(pl) + ' 获得自由球', '');
  }

  function refreshBihGhostColor() {
    bihGhost.material.color.setHex(
      rules.validatePlacement(bihGhost.position.x, bihGhost.position.z, world.balls, PHYS_DIMS)
        ? 0x7cfc00 : 0xff5252);
  }

  function updateBihGhost(cx, cy) {
    const p = tablePointFromClient(cx, cy);
    if (!p) return;
    bihGhost.position.set(clamp(p.x, -LIMIT_X, LIMIT_X), BALL_R, clamp(p.z, -LIMIT_Z, LIMIT_Z));
    refreshBihGhostColor();
  }

  /** 把白球放到指定位置并恢复可击打状态（网络同步由调用方负责） */
  function applyCuePlacement(x, z) {
    cueBall.active = true;
    cueBall.sinking = false;
    cueBall.stop();
    cueBall.pos.x = x;
    cueBall.pos.z = z;
    cueBall.vel.x = cueBall.vel.z = 0;
    if (cueBall.mesh) {
      cueBall.mesh.visible = true;
      cueBall.mesh.scale.set(1, 1, 1);
      cueBall.mesh.position.set(x, BALL_R, z);
    }
    cueBall.rp = { x, z };
    ballInHandFor = 0;
    placingBallInHand = false;
    bihGhost.visible = false;
  }

  /** 本机玩家确认摆放：本地校验后应用，并按角色上报/广播落点 */
  function confirmPlacement() {
    if (!placingBallInHand) return;
    const x = bihGhost.position.x, z = bihGhost.position.z;
    if (!rules.validatePlacement(x, z, world.balls, PHYS_DIMS)) {
      showToast('该位置不合法 · 避开球和袋口', 'bad');
      return;
    }
    applyCuePlacement(x, z);
    if (netInGame() && netRole === 'p1') {
      NET.send({ t: 'cuePlaced', x, z });        // 权威端广播权威落点
    } else if (netInGame() && netRole === 'p2') {
      NET.send({ t: 'placeCue', x, z });         // 交给房主校验并回广播
    }
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
    shotCushionAfterContact = false;
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
          t: 'authoritativeShot',
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
        NET.send({ t: 'shotRequest', angle: input.aimAngle, power: p, contact: input.contact });
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
    if (placingBallInHand) { updateBihGhost(e.clientX, e.clientY); return; }   // 自由球：先定位 ghost
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
    if (placingBallInHand) { updateBihGhost(e.clientX, e.clientY); return; }   // 自由球：ghost 跟随指针
    if (state === 'AIM' && myTurn() && !netWaiting) {
      if (input.charging) { moveCharge(e.clientX, e.clientY); return; }
      if (e.pointerType === 'mouse' && cueBall.active) updateAimFromClient(e.clientX, e.clientY);
    }
  });

  function endPointer() {
    if (input.orbiting) { input.orbiting = false; return; }
    if (placingBallInHand) { confirmPlacement(); return; }   // 自由球：抬起确认落点
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
      case 'Escape': closeSettings(); break;
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
          NET.send({ t: 'shotRequest', angle: input.aimAngle, power: input.power, contact: input.contact });
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
      // pitch 从正上方数起：0 = 桌面正上方垂直俯视（略偏一点避免 lookAt 退化）
      camGoal.pitch = 0.03;
      camGoal.radius = Math.max(camGoal.radius, 3.0);
    } else if (savedCam) {
      camGoal.yaw = savedCam.yaw;
      camGoal.pitch = savedCam.pitch;
      camGoal.radius = savedCam.radius;
    }
    // 俯视时移开头顶灯罩与桁架灯具，台面一览无遗（光源本身无形，保留照明）
    if (ARENA.lamp) ARENA.lamp.visible = !on;
    if (ARENA.rig) ARENA.rig.visible = !on;
    for (const b of ARENA.beams) b.visible = !on;   // 光锥壳体一并移开，俯视台面不被色板遮挡
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
    tray.classList.remove('hidden');   // 有球才展示已落袋托盘
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
      powerPct.textContent = p;
    }
  }

function toggleMute() {
    SFX.setMuted(!SFX.muted);
    $('btn-sound').textContent = SFX.muted ? '声音 关' : '声音 开';
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
      b.pos.x = clamp(s.x, -LIMIT_X, LIMIT_X);
      b.pos.z = clamp(s.z, -LIMIT_Z, LIMIT_Z);
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
      cushionAfterContact: shotCushionAfterContact,
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
      SFX.foul();
      msgs.push('⚠ ' + pname(me) + '犯规：' + act.foulReason);
      beginBallInHand(act.player);   // 所有犯规 → 下一位玩家自由球（不再回固定点，issue #6）
      msgs.push(pname(act.player) + ' 获得自由球');
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
        bih: ballInHandFor,
        over: false,
      });
    }
  }

  /** 安全渲染结算文案：全部用 textContent/创建节点，任何字符串都不会被解析为 HTML（issue #3） */
  function setVictoryStats(segments) {
    const el = $('v-stats');
    el.textContent = '';
    for (const seg of segments) {
      if (seg.br) { el.appendChild(document.createElement('br')); continue; }
      if (seg.b) {
        const b = document.createElement('b');
        b.textContent = seg.t;
        el.appendChild(b);
      } else {
        el.appendChild(document.createTextNode(seg.t));
      }
    }
  }

  /** 远端传来的胜负原因只认规则引擎枚举值，白名单之外一律丢弃（issue #3） */
  function safeWinReason(reason) {
    return (typeof Protocol !== 'undefined' && Protocol.isWinReason(reason)) ? reason : null;
  }

  function versusWin(winner, reason) {
    state = 'OVER';
        SFX.crowd(1.6);
SFX.win();
    FX.spawnRing(0, 0, 6);
    FX.spawnSparks(0, 0.06, 0, 6);
    FX.addShake(0.018);
    setTimeout(() => { if (state === 'OVER') FX.spawnSparks(0.5, 0.06, 0.3, 5); }, 260);
    setTimeout(() => { if (state === 'OVER') FX.spawnSparks(-0.5, 0.06, -0.3, 5); }, 520);
    $('v-title').textContent = '🏆 ' + pname(winner) + ' 获胜！';
    const tail = [
      { t: '共用 ' }, { t: String(shots), b: true }, { t: ' 杆 · 用时 ' },
      { t: fmtTime(Date.now() - startTime), b: true },
    ];
    setVictoryStats(reason ? [{ t: '胜负原因：' }, { t: reason, b: true }, { br: true }, ...tail] : tail);
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

  /** 观战/对手端展示对局结果：winner/reason 均来自网络，先过白名单再渲染 */
  function netShowWin(winner, reason) {
    state = 'OVER';
        SFX.crowd(1.6);
SFX.win();
    FX.spawnRing(0, 0, 6);
    FX.spawnSparks(0, 0.06, 0, 6);
    FX.addShake(0.018);
    const w = winner === 1 || winner === 2 ? winner : 1;
    const rs = safeWinReason(reason);
    $('v-title').textContent = '🏆 ' + pname(w) + ' 获胜！';
    const tail = [{ t: '共用 ' }, { t: String(shots), b: true }, { t: ' 杆' }];
    setVictoryStats(rs ? [{ t: '胜负原因：' }, { t: rs, b: true }, { br: true }, ...tail] : tail);
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
        SFX.crowd(1.6);
SFX.win();
    FX.spawnRing(0, 0, 6);
    FX.spawnSparks(0, 0.06, 0, 6);
    FX.addShake(0.018);
    setTimeout(() => { if (state === 'OVER') FX.spawnSparks(0.5, 0.06, 0.3, 5); }, 260);
    setTimeout(() => { if (state === 'OVER') FX.spawnSparks(-0.5, 0.06, -0.3, 5); }, 520);
    $('v-title').textContent = '🏆 清台成功！';
    setVictoryStats([
      { t: '最终得分 ' }, { t: String(score), b: true }, { t: ' · 共用 ' },
      { t: String(shots), b: true }, { t: ' 杆 · 用时 ' }, { t: fmtTime(Date.now() - startTime), b: true },
    ]);
    $('victory').classList.remove('hidden');
  }

  function restart() {
    for (const b of world.balls) if (b.mesh) scene.remove(b.mesh);
    world.reset();
    score = 0; shots = 0;
    startTime = Date.now();
    tray.innerHTML = '';
    tray.classList.add('hidden');   // 无进球时不展示已落袋托盘
    pottedThisShot = [];
    cueFouled = false;
    clearedPending = false;
    arcadePotted = 0;
    pendingShot = null;
    input.power = 0;
    input.charging = false;
    input.spaceCharging = false;
    shotFirstContact = null;
    shotCushionAfterContact = false;
    ballInHandFor = 0;
    placingBallInHand = false;
    bihGhost.visible = false;
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
      // 一次性场景图清点（?sceneinfo 触发，结果写进 errs 区读取）
      if (!window.__dumped && location.search.includes('sceneinfo')) {
        window.__dumped = 1;
        const kinds = {};
        scene.traverse(o => {
          const k = o.type + (o.geometry ? '|' + o.geometry.type : '') +
            (o.material && o.material.color ? '#' + o.material.color.getHexString() : '');
          kinds[k] = (kinds[k] || 0) + 1;
        });
        window.__errs.push('SCENE ' + JSON.stringify(kinds));
      }
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
    // 氛围动效：灯光呼吸 / 光锥微摆（与照射点联动）/ 观众晃动欢呼
    arenaTick(clock.getElapsedTime(), dt);
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
      const aimV = Protocol.validateAim(d);   // 白名单校验，非法数值不进入瞄准状态
      if (!aimV) return;
      remoteAim.angle = aimV.angle;
      remoteAim.power = aimV.power;
      remoteAim.contact = aimV.contact;
      remoteAim.t = window.__fc;
    });
    NET.on('shotRequest', d => {
      // 玩家2 的出杆请求（服务端已按 socket 角色重写类型，伪造的快照不会到达这里）：
      // 仅房主执行，且必须过回合校验（issue #4）
      const v = Protocol.validateShotRequest(d);
      if (!v || netRole !== 'p1') return;
      if (state !== 'AIM' || !cueBall.active || netWaiting || rules.player !== 2) {
        showToast('⚠ 忽略了对方的出杆指令（回合校验）', '');
        return;
      }
      shoot(v.power, v.angle, v.contact);
    });
    NET.on('authoritativeShot', d => {
      // 房主权威广播：对手与观众据此本地模拟（服务端+本地双重 schema 校验）
      const v = Protocol.validateAuthoritativeShot(d);
      if (!v || netRole === 'p1') return;
      restoreBalls(v.balls);
      shoot(v.power, v.angle, v.contact);
    });
    NET.on('placeCue', d => {
      // 玩家2 的自由球落点：权威端校验合法性后应用并广播
      const v = Protocol.validatePlaceCue(d);
      if (!v || netRole !== 'p1' || ballInHandFor !== 2) return;
      if (!rules.validatePlacement(v.x, v.z, world.balls, PHYS_DIMS)) return;
      applyCuePlacement(v.x, v.z);
      NET.send({ t: 'cuePlaced', x: v.x, z: v.z });
    });
    NET.on('cuePlaced', d => {
      // 权威落点广播：对手与观众同步（房主自己刚广播过，忽略回声）
      const v = Protocol.validateCuePlaced(d);
      if (!v || netRole === 'p1') return;
      applyCuePlacement(v.x, v.z);
    });
    NET.on('settled', d => {
      const v = Protocol.validateSettled(d);   // 全字段白名单校验，非法消息整条丢弃
      if (!v) return;
      pendingShot = null;                      // 权威结算到达即丢弃本地未完成的模拟，防止状态机卡在 ROLL
      restoreBalls(v.balls);
      if (v.rules) applyRulesSnap(v.rules);
      score = v.score;
      shots = v.shots;
      updateHUD();
      updateVersusHUD();
      if (v.msgs.length) showToast(v.msgs.join(' · '), '');   // textContent 渲染，与房主端一致
      if (v.over) netShowWin(v.winner, v.reason);
      else {
        state = 'AIM';
        if (v.bih) beginBallInHand(v.bih);     // 犯规后自由球
      }
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
    if (!BOOT.ready) return;   // 资源未就绪时忽略点击（加载层尚未放行）
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
    // ?reviewcam 调试观景机位：斜上方俯瞰整个赛场（验证灯光/看台布局用）
    if (new URLSearchParams(location.search).has('reviewcam')) {
      camGoal.yaw = Math.PI * 0.78;
      camGoal.pitch = 0.60;
      camGoal.radius = 4.7;
    }
  }
$('btn-arcade').addEventListener('click', () => startGame('arcade'));
$('btn-online').addEventListener('click', () => {
    if (!BOOT.ready) return;   // 资源未就绪时忽略点击（加载层尚未放行）
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

  /* 设置菜单折叠：点齿轮展开/收起；点菜单外或选中任意项后自动收起 */
  const settingsMenu = $('settings-menu');
  const settingsBtn = $('btn-settings');
  function openSettingsMenu(open) {
    settingsMenu.classList.toggle('hidden', !open);
    settingsBtn.classList.toggle('open', open);
    settingsBtn.setAttribute('aria-expanded', String(open));
  }
  function closeSettings() {
    openSettingsMenu(false);
  }
  settingsBtn.addEventListener('click', e => {
    e.stopPropagation();
    openSettingsMenu(settingsMenu.classList.contains('hidden'));
  });
  settingsMenu.addEventListener('click', () => closeSettings());
  document.addEventListener('click', e => {
    if (e.target.closest('#settings')) return;   // 菜单内部已自行处理
    closeSettings();
  });

  /* 退出游戏：单机/本地双人直接回主菜单；联机先断开，close 回调会复位 UI */
  function exitGame() {
    if (netInGame()) {
      NET.close();
      netRole = null;
      netWaiting = false;
      return;
    }
    document.body.classList.remove('mode-versus');
    gameMode = 'arcade';
    netWaiting = false;
    restart();
    $('victory').classList.add('hidden');
    $('overlay').classList.remove('hidden');
  }
  $('btn-exit').addEventListener('click', exitGame);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* 开机：分阶段执行，loader 实时显示进度；全部就绪后才放行主菜单 */
  BOOT.stage('装备球杆与瞄准引导线…', 60);
  await BOOT.frame();
  setupNet();
  buildCue();
  buildGuide();
  BOOT.stage('摆放球堆 · 白球就位…', 70);
  await BOOT.frame();
  restart();
  BOOT.stage('启动渲染循环…', 80);
  await BOOT.frame();
  animate();
  if (window.__DEBUG) window.__G = { scene, camera };   // 调试只读探针：场景图
  BOOT.stage('全部就绪', 92);
  await BOOT.frame();
  BOOT.done();                                        // 加载层淡出，主菜单可点
  // ?autostart 调试：跳过开始界面直接进入单人街机（等加载层淡出后再进入）
  if (window.__DEBUG && new URLSearchParams(location.search).has('autostart')) {
    setTimeout(() => startGame('arcade'), 800);
  }
})();

