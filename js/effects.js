/* ============================================================
 * effects.js —— 三维碰撞特效系统
 * 粒子火花 / 桌面冲击波光环 / 撞击闪光 / 镜头震动
 * ============================================================ */
(function () {
  'use strict';

  const MAX_P = 700;                       // 粒子池上限
  const RING_POOL = 10;

  let scene = null;
  let points = null, pGeo = null;
  let pPos = null, pCol = null;
  const pv = new Float32Array(MAX_P * 3);      // 粒子速度
  const plife = new Float32Array(MAX_P);       // 剩余寿命
  const pmax = new Float32Array(MAX_P);        // 总寿命
  const pbase = new Float32Array(MAX_P * 3);   // 基础颜色
  let cursor = 0;                              // 环形分配指针

  const rings = [];                            // 冲击波环对象池
  let impactLight = null;                      // 复用的撞击点光源
  let shakeAmp = 0;                            // 当前镜头震动幅度

  /** 初始化：创建粒子系统、冲击波环池、撞击点光源 */
  function init(sc) {
    scene = sc;

    // ---- 粒子（加色混合的点云）----
    pGeo = new THREE.BufferGeometry();
    pPos = new Float32Array(MAX_P * 3);
    pCol = new Float32Array(MAX_P * 3);
    for (let i = 0; i < MAX_P; i++) pPos[i * 3 + 1] = -10; // 藏到桌面下
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
    points = new THREE.Points(pGeo, new THREE.PointsMaterial({
      size: 0.016,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    }));
    points.frustumCulled = false;
    scene.add(points);

    // ---- 冲击波光环池 ----
    const ringGeo = new THREE.RingGeometry(0.75, 1, 40);
    for (let i = 0; i < RING_POOL; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xffcf7a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }));
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      rings.push({ mesh: m, t: 1, dur: 0.38, grow: 0.12 });
    }

    // ---- 撞击点光源 ----
    impactLight = new THREE.PointLight(0xffc46b, 0, 1.7, 2);
    scene.add(impactLight);
  }

  /** 在碰撞点喷射火花，intensity 越大越多越快 */
  function spawnSparks(x, y, z, intensity) {
    const n = Math.min(64, Math.floor(8 + intensity * 26));
    const speed = 0.35 + Math.min(intensity, 6) * 0.30;
    for (let k = 0; k < n; k++) {
      const i = cursor;
      cursor = (cursor + 1) % MAX_P;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.85);
      pv[i * 3]     = Math.cos(a) * s;
      pv[i * 3 + 1] = s * (0.4 + Math.random() * 0.9);
      pv[i * 3 + 2] = Math.sin(a) * s;
      pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
      plife[i] = pmax[i] = 0.25 + Math.random() * 0.45;
      if (Math.random() < 0.18) {          // 少量冷色碎片点缀
        pbase[i * 3] = 0.45; pbase[i * 3 + 1] = 0.85; pbase[i * 3 + 2] = 1.0;
      } else {                              // 主色调：炽热金白
        const hot = Math.random();
        pbase[i * 3]     = 1.0;
        pbase[i * 3 + 1] = 0.60 + hot * 0.32;
        pbase[i * 3 + 2] = 0.18 + hot * 0.28;
      }
    }
  }

  /** 桌面扩散的冲击波光环 */
  function spawnRing(x, z, power) {
    const r = rings.find(r => r.t >= 1) || rings[0];
    r.t = 0;
    r.grow = 0.06 + Math.min(power, 6) * 0.02;
    r.mesh.visible = true;
    r.mesh.position.set(x, 0.004, z);
  }

  /** 撞击点闪光（点光源脉冲） */
  function flash(x, y, z, intensity) {
    impactLight.intensity = Math.min(5, 1.1 + intensity * 1.1);
    impactLight.position.set(x, y + 0.07, z);
  }

  /** 增加镜头震动幅度 */
  function addShake(a) {
    shakeAmp = Math.min(0.05, shakeAmp + a);
  }

  /** 球-球碰撞统一特效入口 */
  function ballHit(e) {
    const I = e.intensity;
    spawnSparks(e.x, 0.045, e.z, I);
    if (I > 0.35) spawnRing(e.x, e.z, I);
    flash(e.x, 0.04, e.z, I);
    if (I > 1.6) addShake(Math.min(0.02, I * 0.002));
  }

  /** 每帧更新粒子、光环、光效衰减；返回当前震动偏移向量 */
  function update(dt, outVec3) {
    // 粒子积分
    for (let i = 0; i < MAX_P; i++) {
      if (plife[i] <= 0) continue;
      plife[i] -= dt;
      pv[i * 3 + 1] -= 3.5 * dt;           // 轻微重力
      pPos[i * 3]     += pv[i * 3]     * dt;
      pPos[i * 3 + 1] += pv[i * 3 + 1] * dt;
      pPos[i * 3 + 2] += pv[i * 3 + 2] * dt;
      if (pPos[i * 3 + 1] < 0.004) {       // 在台面上弹跳
        pPos[i * 3 + 1] = 0.004;
        pv[i * 3 + 1] *= -0.4;
        pv[i * 3] *= 0.8;
        pv[i * 3 + 2] *= 0.8;
      }
      const f = Math.max(0, plife[i] / pmax[i]);   // 加色混合下变黑=淡出
      pCol[i * 3]     = pbase[i * 3]     * f;
      pCol[i * 3 + 1] = pbase[i * 3 + 1] * f;
      pCol[i * 3 + 2] = pbase[i * 3 + 2] * f;
      if (plife[i] <= 0) {
        pCol[i * 3] = pCol[i * 3 + 1] = pCol[i * 3 + 2] = 0;
        pPos[i * 3 + 1] = -10;
      }
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;

    // 冲击波扩散
    for (const r of rings) {
      if (r.t >= 1) continue;
      r.t = Math.min(1, r.t + dt / r.dur);
      const s = 0.02 + r.t * r.grow;
      r.mesh.scale.set(s, s, s);
      r.mesh.material.opacity = (1 - r.t) * 0.85;
      if (r.t >= 1) r.mesh.visible = false;
    }

    // 光效与震动衰减
    impactLight.intensity *= Math.exp(-9 * dt);
    shakeAmp *= Math.exp(-5.5 * dt);

    if (outVec3) return shakeOffset(outVec3);
  }

  /** 当前帧的镜头随机抖动量 */
  function shakeOffset(out) {
    if (shakeAmp < 0.0006) return out.set(0, 0, 0);
    out.set(
      (Math.random() - 0.5),
      (Math.random() - 0.5) * 0.6,
      (Math.random() - 0.5)
    ).multiplyScalar(shakeAmp * 2);
    return out;
  }

  window.FX = { init, ballHit, spawnSparks, spawnRing, flash, addShake, update, shakeOffset };
})();

