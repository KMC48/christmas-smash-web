/* クリスマス粉砕！ ― 街の描画（Canvas 2D）
 *
 * 画像素材が無くても図形で街を描く。assets/ に素材を置くと自動で差し替わる：
 *   stage{n}_bg.jpg / stage{n}_bg_off.jpg … 街の背景（点灯 / 消灯）
 *   tree_on.png / tree_off.png / tree_broken.png … ツリー（点灯 / 消灯 / 崩壊後）
 *   couple_normal.png / couple_love.png / couple_shock.png … カップル
 *   couple2_normal.png …（同じく _love / _shock）… 別のカップル。couple3_… と増やせる。無ければ1組目の絵を使い回す
 *   comrades_back.png / comrades_cheer.png … 手前の同志たち（後ろ姿）
 *
 * 街は3つの区画（street=街の電飾、couple=フォトスポットとカップル、tree=ツリー）に分かれ、
 * それぞれ明るさ level（0=消灯、1=通常、1.7=キラキラ）を持つ。
 */
(function (root) {
  'use strict';
  const W = 540;
  const PALETTES = {
    warm: ['#FFC94D', '#FF6B3D', '#FFE9A8', '#7CE07C', '#FF4D5E'],
    pink: ['#FF7EB6', '#FFD1E6', '#FF4D7D', '#FFFFFF', '#C78BFF'],
    blue: ['#63D3FF', '#BDEBFF', '#FFFFFF', '#5C8DFF', '#A0F0FF'],
    gold: ['#FFD54D', '#FFF3C4', '#FFB13D', '#FFFFFF', '#FF6B6B'],
  };
  const LEAD_X = 452; // 拡声器を持つ総帥の位置（手前の列の右寄り）
  // 奥行き：背景素材は地面線（ツリー・カップルが立つ線）が上から78%、地平線が約53%。
  // 画面幅540に換算すると地面線から地平線まで約240。奥に立つものほど地平線に近く、小さく見える
  const HORIZON = 240;
  const COUPLE_H = 190;  // 地面線に立つカップルの絵の高さ（手前の同志たちと釣り合う人の大きさ）
  // カップルの立ち位置 [x, 地面線からの奥行き]。組数が増えると奥にも並ぶ
  // ツリーへ向かうV字に並べる：外側ほど手前で大きく、内側ほど奥。1組ずつ別の列に立たせ、重なっても顔と服が見えるようにする。
  // 7組目以降は後ろの列（前の列のすき間から頭がのぞく）。拡大表示で画面の端が切れるので x はおよそ 60〜480 に収める
  const COUPLE_SPOTS = [[72, 0], [468, 4], [150, 40], [392, 36], [218, 82], [324, 78], [112, 128], [430, 124], [184, 152], [360, 148]];
  const HEART = { x: 104, back: 24, k: 6 };  // ハートのフォトスポット（中心x・奥行き・大きさ）
  const TREE_BACK = 104; // ツリーは広場の奥に立つ（同じ奥行きの人の約3倍の高さになる）
  const TREE_TOP = 40;   // ツリーの星のてっぺん（画面座標）。上部の表示（HUD）は中央が空いているので、そこまで伸ばす
  const COATS = ['#C8A27A', '#2E3A5C', '#7A2E3E', '#B9B2A6', '#3E5B4A', '#D9CBB8', '#5A3E66', '#8C5A3C'];

  function rng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutBounce = (x) => {
    const n = 7.5625, d = 2.75;
    if (x < 1 / d) return n * x * x;
    if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
    if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
    return n * (x -= 2.625 / d) * x + 0.984375;
  };

  const glowCache = {};
  function glow(color) {
    if (glowCache[color]) return glowCache[color];
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.18, color);
    gr.addColorStop(0.45, color + '55');
    gr.addColorStop(1, color + '00');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return (glowCache[color] = c);
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = src;
    });
  }

  class Scene {
    constructor(canvas) {
      this.cv = canvas; this.g = canvas.getContext('2d');
      this.H = 960; this.scale = 1; this.dpr = 1;
      this.vb = 600; this.vbTarget = 600; this.t = 0;
      this.voice = 0; this.shake = 0; this.flashA = 0;
      this.particles = []; this.waves = []; this.waveT = 0;
      this.zones = { street: this._zone(), couple: this._zone(), tree: this._zone() };
      this.love = 1; this.loveTarget = 1; this.joy = 0; this.joyTimer = 0;
      this.collapse = 0; this.anims = []; this.star = null; this.focus = null; this.shockT = 0;
      this.img = {}; this.stageImg = {}; this.coupleSets = ['couple']; this.fitVb = 0;
      this.snow = Array.from({ length: 70 }, () => ({ x: Math.random() * W, y: Math.random() * 1200, r: 0.8 + Math.random() * 1.8, v: 18 + Math.random() * 30, p: Math.random() * 6 }));
      ['tree_on', 'tree_off', 'tree_broken', 'couple_normal', 'couple_love', 'couple_shock', 'comrades_back', 'comrades_cheer']
        .forEach((k) => loadImage(`assets/${k}.png`).then((im) => { if (im) this.img[k] = im; }));
      // 別のカップル（couple2_, couple3_, …）は置いてある分だけ読む
      const more = (n) => loadImage(`assets/couple${n}_normal.png`).then((im) => {
        if (!im) return;
        const k = 'couple' + n; this.img[k + '_normal'] = im; this.coupleSets.push(k);
        ['love', 'shock'].forEach((e) => loadImage(`assets/${k}_${e}.png`).then((m) => { if (m) this.img[k + '_' + e] = m; }));
        more(n + 1);
      });
      more(2);
    }
    _zone() { return { level: 1, target: 1, flick: 0 }; }

    resize(cssW, cssH) {
      this.dpr = Math.min(2, root.devicePixelRatio || 1);
      this.scale = cssW / W;
      this.H = cssH / this.scale;
      this.cv.width = Math.round(cssW * this.dpr);
      this.cv.height = Math.round(cssH * this.dpr);
      this.bldCache = null;
    }
    setViewBottom(vb, instant) { this.vbTarget = vb; if (instant) this.vb = vb; }

    // ---------------------------------------------------------- ステージ
    setStage(stage) {
      this.stage = stage;
      const r = rng(stage.seed);
      const pal = PALETTES[stage.light] || PALETTES.warm;
      const L = { pal, far: [], near: [], garlands: [], drapes: [], heart: [], tree: null, couples: [], stars: [], neon: [] };
      // 遠景のビル
      for (let x = -20; x < W + 20;) {
        const w = 38 + r() * 55, h = 170 + r() * 250;
        L.far.push({ x, w, h, wins: this._windows(r, w, h, 0.22) });
        x += w + 2 + r() * 8;
      }
      // 近景のビル（左右）
      const cluster = (x0, x1) => {
        for (let x = x0; x < x1;) {
          const w = 58 + r() * 46, h = 270 + r() * 250;
          const b = { x, w, h, wins: this._windows(r, w, h, 0.45) };
          L.near.push(b);
          if (r() < 0.7) L.neon.push({ x: x + 8 + r() * (w - 30), y: -h + 40 + r() * (h * 0.5), w: 14 + r() * 10, h: 50 + r() * 70, c: ['#FF4FA3', '#4FE3FF', '#FFE14F', '#9B6BFF'][Math.floor(r() * 4)], ph: r() * 6 });
          x += w + 1;
        }
      };
      cluster(-14, 160); cluster(382, W + 14);
      L.near.sort((a, b) => b.h - a.h);
      // 吊り下げの電飾（街）
      for (let i = 0; i < 3; i++) {
        const x0 = 150 + r() * 12, x1 = 390 - r() * 12, y0 = -(300 + i * 52), y1 = -(292 + i * 52 + r() * 20), sag = 32 + r() * 26;
        const n = 18 + Math.floor(r() * 5);
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          L.garlands.push({ x: lerp(x0, x1, t), y: lerp(y0, y1, t) + sag * 4 * t * (1 - t), c: pal[(k + i) % pal.length], ph: r() * 6 });
        }
      }
      // ビルの角から垂れる電飾
      for (const b of L.near.slice(0, 5)) {
        const ex = b.x < W / 2 ? b.x + b.w : b.x;
        for (let y = -b.h + 24; y < -24; y += 15) L.drapes.push({ x: ex, y, c: pal[Math.floor(r() * pal.length)], ph: r() * 6 });
      }
      // ハートのフォトスポット（左）。y は地面線からの高さ
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        const hx = 16 * Math.pow(Math.sin(a), 3), hy = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
        L.heart.push({ x: HEART.x + hx * HEART.k, y: -(hy + 17) * HEART.k - 10 - HEART.back, c: k % 3 ? '#FF6FAE' : '#FFFFFF', ph: r() * 6 });
      }
      // ツリー（高さ1の正規化座標。描くときに高さを掛ける）
      const tree = { tiers: [], bulbs: [], balls: [] };
      for (let i = 0; i < 4; i++) tree.tiers.push({ top: 0.06 + i * 0.19, bot: 0.38 + i * 0.19, hw: 0.17 + i * 0.075 });
      for (let s = 0; s < 6; s++) {
        const y = 0.16 + s * 0.13, hw = 0.12 + (y - 0.06) * 0.42;
        const n = 6 + s * 2;
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          tree.bulbs.push({ x: lerp(-hw, hw, t), y: y + 0.05 * Math.sin(Math.PI * t) + (s % 2 ? 0.02 : -0.01) * t, c: pal[(k + s) % pal.length], ph: r() * 6 });
        }
      }
      for (let k = 0; k < 14; k++) {
        const y = 0.2 + r() * 0.7, hw = (0.12 + (y - 0.06) * 0.42) * 0.85;
        tree.balls.push({ x: (r() * 2 - 1) * hw, y, c: r() < 0.5 ? '#C8283A' : '#E8B33C', s: 0.016 + r() * 0.01 });
      }
      L.tree = tree;
      // カップル（奥に立つほど小さく）。y は地面線からのずれ（負＝奥）、h は絵の高さ
      for (let i = 0; i < Math.min(stage.couples, COUPLE_SPOTS.length); i++) {
        const [x, back] = COUPLE_SPOTS[i], y = -back - r() * 6;
        L.couples.push({ x: x + (r() - 0.5) * 12, y, h: COUPLE_H * (HORIZON + y) / HORIZON * (0.96 + r() * 0.06), set: i + stage.id * 3, a: COATS[Math.floor(r() * COATS.length)], b: COATS[Math.floor(r() * COATS.length)], flip: i % 2 ? r() < 0.8 : r() < 0.2, ph: r() * 6 });
      }
      L.couples.sort((a, b) => a.y - b.y);
      for (let k = 0; k < 40; k++) L.stars.push({ x: r() * W, y: r(), s: r() });
      this.L = L;
      this.bldCache = null;
      this.reset(true);
      // 背景素材
      this.stageImg = {};
      const n = stage.id;
      loadImage(`assets/stage${n}_bg.jpg`).then((im) => { if (im && this.stage === stage) this.stageImg.on = im; });
      loadImage(`assets/stage${n}_bg_off.jpg`).then((im) => { if (im && this.stage === stage) this.stageImg.off = im; });
    }
    _windows(r, w, h, p) {
      const out = [], cols = Math.max(2, Math.floor((w - 10) / 12)), rows = Math.floor((h - 20) / 18);
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        if (r() < p) out.push({ x: 6 + i * 12, y: 12 + j * 18, c: ['#FFD98A', '#FFE7B8', '#9AD0FF', '#FFB3D1', '#FFC56E'][Math.floor(r() * 5)], a: 0.35 + r() * 0.6 });
      }
      return out;
    }

    // ---------------------------------------------------------- 演出の操作
    reset(instant) {
      for (const z of Object.values(this.zones)) { z.target = 1; z.flick = 0; if (instant) z.level = 1; }
      this.loveTarget = 1; if (instant) this.love = 1;
      this.collapse = 0; this.star = null; this.joy = 0; this.joyTimer = 0; this.shockT = 0;
      this.anims = []; if (instant) this.particles = [];
    }
    setFocus(key) { this.focus = key; }
    lightsOut(key, big) {
      const z = this.zones[key];
      z.target = 0; z.flick = 0.9;
      this._burstAt(key, big ? 50 : 26, 'spark');
      this.shake = Math.max(this.shake, big ? 0.6 : 0.3);
      if (key === 'couple') this.shockT = 3.5;
    }
    flicker(key) { this.zones[key].flick = 1.1; }
    sparkUp(key, amount) {
      const z = this.zones[key];
      z.target = Math.min(1.7, Math.max(1, z.target) + (amount || 0.35));
      this.loveTarget = Math.min(2, this.loveTarget + 0.3);
      this._burstAt(key, 30, 'star4');
    }
    sparkleAll() {
      for (const k of Object.keys(this.zones)) { this.zones[k].target = 1.7; this._burstAt(k, 26, 'star4'); }
      this.loveTarget = 2; this.joy = -1; this.joyTimer = 99;
    }
    celebrate() {
      this.joy = 1; this.joyTimer = 5;
      for (let i = 0; i < 90; i++) {
        this.particles.push({ type: 'paper', x: Math.random() * W, y: -20 - Math.random() * 300, vx: (Math.random() - 0.5) * 40, vy: 60 + Math.random() * 80,
          life: 5, max: 5, c: Math.random() < 0.5 ? '#FFD23F' : '#E0262E', s: 4 + Math.random() * 4, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 10 });
      }
    }
    allOut() { for (const k of Object.keys(this.zones)) if (this.zones[k].target > 0) this.lightsOut(k, true); }
    // ツリー崩壊：揺れる → 段が潰れる → 星が落ちる。着地で揺れと土ぼこり
    collapseTree() {
      return new Promise((resolve) => {
        const z = this.zones.tree; z.target = 0; z.flick = 0.6;
        this.anims.push({ t: 0, dur: 2.3, fn: (t) => {
          if (t < 0.7) { this.wobble = Math.sin(t * 30) * 0.025 * (t / 0.7); return; }
          this.wobble = 0;
          const u = clamp((t - 0.7) / 0.9, 0, 1);
          this.collapse = easeOutBounce(u);
          if (!this.star && t >= 0.7) {
            const th = this._treeH();
            this.star = { x: 270, y: -TREE_BACK - th * 1.0, vx: (Math.random() < 0.5 ? -1 : 1) * 90, vy: -140, rot: 0, vr: 7, landed: false };
          }
          if (!this.impacted && u > 0.36) {
            this.impacted = true; this.shake = 1;
            this._dust(270, -TREE_BACK, 50);
            root.CSSfx && root.CSSfx.crash();
          }
          if (t >= 2.3) resolve();
        }, done: () => { this.impacted = false; resolve(); } });
      });
    }
    flash(a) { this.flashA = Math.max(this.flashA, a || 0.8); }

    _zonePoints(key) {
      const L = this.L, th = this._treeH();
      if (key === 'street') return L.garlands.concat(L.drapes);
      if (key === 'couple') return L.heart;
      return L.tree.bulbs.map((b) => ({ x: 270 + b.x * th, y: -TREE_BACK - th + b.y * th }));
    }
    _burstAt(key, n, type) {
      const pts = this._zonePoints(key), gy = this._gy();
      for (let i = 0; i < n; i++) {
        const p = pts[Math.floor(Math.random() * pts.length)];
        if (!p) continue;
        const a = Math.random() * Math.PI * 2, sp = type === 'spark' ? 60 + Math.random() * 160 : 10 + Math.random() * 30;
        this.particles.push({ type, x: p.x, y: gy + p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (type === 'spark' ? 40 : 10),
          life: type === 'spark' ? 0.7 + Math.random() * 0.5 : 1.2 + Math.random(), max: 1.6, c: type === 'spark' ? '#FFF1B0' : '#FFFFFF', s: type === 'spark' ? 2 : 3 + Math.random() * 4 });
      }
    }
    _dust(x, y, n) {
      const gy = this._gy();
      for (let i = 0; i < n; i++) {
        const a = Math.PI + Math.random() * Math.PI, sp = 40 + Math.random() * 200;
        this.particles.push({ type: 'dust', x: x + (Math.random() - 0.5) * 120, y: gy + y - 4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6, life: 1 + Math.random(), max: 2, c: '#E9EEF8', s: 4 + Math.random() * 8 });
      }
      for (let i = 0; i < 16; i++) { // 飾りの玉が転がる
        this.particles.push({ type: 'shard', x: x + (Math.random() - 0.5) * 80, y: gy - 30 - Math.random() * 40, vx: (Math.random() - 0.5) * 260, vy: -120 - Math.random() * 160,
          life: 2.2, max: 2.2, c: Math.random() < 0.5 ? '#C8283A' : '#E8B33C', s: 3 + Math.random() * 3, bounce: true });
      }
    }

    // ---------------------------------------------------------- 更新
    update(dt) {
      this.t += dt;
      this.vb += (this.vbTarget - this.vb) * Math.min(1, dt * 6);
      for (const z of Object.values(this.zones)) {
        z.level += (z.target - z.level) * Math.min(1, dt * (z.flick > 0 ? 2.5 : 4));
        if (z.flick > 0) z.flick -= dt;
      }
      this.love += (this.loveTarget - this.love) * Math.min(1, dt * 2);
      if (this.joyTimer > 0) { this.joyTimer -= dt; if (this.joyTimer <= 0) this.joy = 0; }
      if (this.shockT > 0) this.shockT -= dt;
      this.shake = Math.max(0, this.shake - dt * 2.2);
      this.flashA = Math.max(0, this.flashA - dt * 2.5);
      for (const a of this.anims) { a.t += dt; a.fn(a.t); }
      this.anims = this.anims.filter((a) => a.t < a.dur);
      // 叫びの波紋
      this.waveT -= dt;
      if (this.voice > 0.08 && this.waveT <= 0) { this.waves.push({ r: 20, a: Math.min(1, this.voice * 1.3) }); this.waveT = 0.11 - this.voice * 0.05; }
      for (const w of this.waves) { w.r += dt * (260 + 300 * w.a); w.a -= dt * 0.9; }
      this.waves = this.waves.filter((w) => w.a > 0);
      // 星（ツリーのてっぺん）
      if (this.star && !this.star.landed) {
        const s = this.star; s.vy += 520 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt;
        const floor = -TREE_BACK - 6; // 崩れたツリーの横の地面に刺さる
        if (s.y > floor && s.vy > 0) { s.y = floor; s.landed = true; s.rot = 0.5; }
      }
      // 粒子
      const gy = this._gy();
      for (const p of this.particles) {
        p.life -= dt;
        if (p.type === 'paper') { p.x += (p.vx + Math.sin(this.t * 3 + p.rot) * 30) * dt; p.y += p.vy * dt; p.rot += p.vr * dt; continue; }
        if (p.type === 'spark' || p.type === 'shard') p.vy += 420 * dt;
        if (p.type === 'dust') { p.vx *= 1 - dt * 2; p.vy *= 1 - dt * 2; }
        if (p.type === 'star4') { p.vy -= 6 * dt; }
        if (p.type === 'heart') { p.vy = -26; p.x += Math.sin(this.t * 2 + p.s) * 10 * dt; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.bounce && p.y > gy + 10) { p.y = gy + 10; p.vy *= -0.35; p.vx *= 0.7; }
      }
      this.particles = this.particles.filter((p) => p.life > 0);
      // 失敗が続くとハートが湧く
      if (this.love > 1.15 && Math.random() < dt * 2.5 * (this.love - 1) * Math.min(5, this.L.couples.length)) {
        const c = this.L.couples[Math.floor(Math.random() * this.L.couples.length)];
        this.particles.push({ type: 'heart', x: c.x + (Math.random() - 0.5) * c.h * 0.2, y: gy + c.y - c.h * 0.98, vx: 0, vy: -26, life: 1.8, max: 1.8, s: Math.random() * 6, c: '#FF5FA2' });
      }
      for (const f of this.snow) { f.y += f.v * dt; f.x += Math.sin(this.t + f.p) * 8 * dt; if (f.y > this.H + 10) { f.y = -10; f.x = Math.random() * W; } }
    }

    // 地面（ツリー・カップルが立つ線）。同志たちの絵は横断幕で背が高いので、その奥に立たせる
    _gy() { return this.vb - (this.img.comrades_back ? 150 : 64); }
    zoom() { return Math.min(1.45, Math.max(1, this.vb / 640)); }
    // ツリーの高さ：プレイ中の画面（下に操作パネルがある状態）で、星が上部の表示のすぐ下に来る高さを1として
    // ステージごとの割合（data.js の tree）を掛ける。パネルの出し入れで大きさが変わらないよう、プレイ中の画面で決める
    _treeH() {
      const fv = this.fitVb || this.H * 0.68, z = clamp(fv / 640, 1, 1.45);
      const room = (fv - TREE_TOP) / z - (this.vb - this._gy()) - TREE_BACK - 30;
      return Math.max(200, room * (this.stage ? this.stage.tree : 0.85));
    }
    _bright(z, ph) {
      let b = z.level;
      if (z.flick > 0) b *= Math.random() < 0.45 ? 0.1 : 1;
      if (this.voice > 0.25 && Math.random() < this.voice * 0.18) b *= 0.25; // 叫んでいる間、電飾がちらつく
      if (b > 1) b = 1 + (b - 1) * (0.7 + 0.3 * Math.sin(this.t * 6 + ph));
      return b;
    }

    // ---------------------------------------------------------- 描画
    draw() {
      const g = this.g, s = this.scale * this.dpr;
      const sh = this.shake * 14;
      g.setTransform(s, 0, 0, s, (Math.random() - 0.5) * sh * s, (Math.random() - 0.5) * sh * s);
      if (!this.stage) { g.fillStyle = '#0B0D1A'; g.fillRect(0, 0, W, this.H); return; }
      const gy = this._gy();
      const light = (this.zones.street.level + this.zones.couple.level + this.zones.tree.level) / 3;
      this._sky(g, gy, light);
      // 縦長の画面では、街を足元基準で拡大して空きを埋める（手前の同志たちは拡大しない）
      const z = this.zoom();
      g.save();
      g.translate(270, this.vb); g.scale(z, z); g.translate(-270, -this.vb);
      if (this.stageImg.on) this._bgImage(g, gy);
      else this._city(g, gy);
      // 奥から順に：ツリーより奥のカップル → ツリー → ハート → 手前のカップル
      this._couples(g, gy, TREE_BACK, 1e9);
      this._tree(g, gy);
      this._couples(g, gy, HEART.back, TREE_BACK);
      this._heartSpot(g, gy);
      this._couples(g, gy, -1e9, HEART.back);
      this._ground(g, gy, light);
      this._particles(g, false);
      this._focus(g, gy);
      g.restore();
      this._waves(g);
      this._comrades(g);
      this._particles(g, true);
      for (const f of this.snow) { g.globalAlpha = 0.75; g.fillStyle = '#fff'; g.beginPath(); g.arc(f.x, f.y, f.r, 0, 6.283); g.fill(); }
      g.globalAlpha = 1;
      if (light < 0.4) { g.fillStyle = `rgba(2,3,12,${(0.4 - light) * 0.6})`; g.fillRect(0, 0, W, this.vb); }
      if (this.flashA > 0) { g.fillStyle = `rgba(255,255,255,${this.flashA})`; g.fillRect(0, 0, W, this.H); }
    }

    _sky(g, gy, light) {
      const [top, bot] = this.stage.sky;
      const gr = g.createLinearGradient(0, 0, 0, gy);
      gr.addColorStop(0, top); gr.addColorStop(1, bot);
      g.fillStyle = gr; g.fillRect(-20, -20, W + 40, this.H + 40);
      for (const st of this.L.stars) {
        const y = st.y * (gy - 380);
        if (y < 0) continue;
        g.globalAlpha = 0.25 + 0.5 * st.s * (0.6 + 0.4 * Math.sin(this.t * 2 + st.x));
        g.fillStyle = '#fff'; g.fillRect(st.x, y, 1.6, 1.6);
      }
      g.globalAlpha = 1;
      // 街明かりが空を照らす
      const glowA = 0.18 * Math.min(1.7, light);
      const rg = g.createRadialGradient(270, gy - 100, 20, 270, gy - 100, 420);
      rg.addColorStop(0, `rgba(255,170,90,${glowA})`); rg.addColorStop(1, 'rgba(255,170,90,0)');
      g.fillStyle = rg; g.fillRect(0, 0, W, gy + 60);
    }

    _bgImage(g, gy) {
      // 背景素材：1080×1920、地面は上から 78% の位置（素材制作依頼書の指定）
      const im = this.stageImg.on, sc = W / im.width, h = im.height * sc;
      const y = gy - h * 0.78;
      g.drawImage(im, 0, y, W, h);
      const off = 1 - clamp(this.zones.street.level, 0, 1);
      if (off > 0.01) {
        if (this.stageImg.off) { g.globalAlpha = off; g.drawImage(this.stageImg.off, 0, y, W, h); g.globalAlpha = 1; }
        else { g.fillStyle = `rgba(4,5,16,${off * 0.5})`; g.fillRect(0, y, W, h); }
      }
      const up = this.zones.street.level - 1;
      if (up > 0.02) { g.globalCompositeOperation = 'lighter'; g.fillStyle = `rgba(255,140,200,${up * 0.18})`; g.fillRect(0, y, W, h); g.globalCompositeOperation = 'source-over'; }
      if (y > 0) { const fg = g.createLinearGradient(0, y, 0, y + 90); fg.addColorStop(0, this.stage.sky[0]); fg.addColorStop(1, this.stage.sky[0] + '00'); g.fillStyle = fg; g.fillRect(0, y - 1, W, 91); }
    }

    _buildings() {
      // 建物は動かないので一度だけ描いておく
      if (this.bldCache) return this.bldCache;
      const k = this.scale * this.dpr, c = document.createElement('canvas'), Hh = 560;
      c.width = Math.ceil(W * k); c.height = Math.ceil(Hh * k);
      const g = c.getContext('2d'); g.scale(k, k);
      const base = Hh - 6;
      for (const b of this.L.far) {
        g.fillStyle = '#141A3C'; g.fillRect(b.x, base - b.h - 30, b.w, b.h + 30);
        for (const w of b.wins) { g.globalAlpha = w.a * 0.45; g.fillStyle = w.c; g.fillRect(b.x + w.x, base - b.h - 30 + w.y, 4, 6); }
        g.globalAlpha = 1;
      }
      for (const b of this.L.near) {
        const gr = g.createLinearGradient(b.x, 0, b.x + b.w, 0);
        gr.addColorStop(0, '#0C0F25'); gr.addColorStop(1, '#151A38');
        g.fillStyle = gr; g.fillRect(b.x, base - b.h, b.w, b.h);
        g.fillStyle = '#1E2448'; g.fillRect(b.x, base - b.h, b.w, 3);
        for (const w of b.wins) { g.globalAlpha = w.a; g.fillStyle = w.c; g.fillRect(b.x + w.x, base - b.h + w.y, 6, 9); }
        g.globalAlpha = 1;
      }
      return (this.bldCache = { c, Hh, base });
    }

    _city(g, gy) {
      const bc = this._buildings();
      g.drawImage(bc.c, 0, gy - bc.base, W, bc.Hh);
      // ネオン看板
      for (const n of this.L.neon) {
        const a = 0.75 + 0.25 * Math.sin(this.t * 3 + n.ph);
        g.globalAlpha = a; g.fillStyle = n.c; g.fillRect(n.x, gy + n.y, n.w, n.h);
        g.fillStyle = 'rgba(0,0,0,.35)';
        for (let yy = 6; yy < n.h - 6; yy += 12) g.fillRect(n.x + 3, gy + n.y + yy, n.w - 6, 7);
        g.globalAlpha = a * 0.35; g.drawImage(glow(n.c), n.x - n.w, gy + n.y - 10, n.w * 3, n.h + 20);
      }
      g.globalAlpha = 1;
      // 恋愛の広告（カップル区画と連動）
      const zc = this.zones.couple, on = clamp(zc.level, 0, 1.7);
      const bx = 60, by = gy - 438, bw = 110, bh = 70;
      g.fillStyle = '#1A1230'; g.fillRect(bx - 4, by - 4, bw + 8, bh + 8);
      g.fillStyle = on > 0.05 ? `rgba(255,95,162,${0.25 + 0.6 * Math.min(1, on)})` : '#221a2c'; g.fillRect(bx, by, bw, bh);
      g.fillStyle = on > 0.05 ? '#fff' : '#3b3346'; g.font = "bold 17px 'Noto Sans JP', sans-serif"; g.textAlign = 'center';
      g.fillText('聖夜は、', bx + bw / 2, by + 30); g.fillText('ふたりで。', bx + bw / 2, by + 54);
      if (on > 0.05) { g.globalAlpha = 0.4 * Math.min(1, on); g.drawImage(glow('#FF5FA2'), bx - 30, by - 30, bw + 60, bh + 60); g.globalAlpha = 1; }
      // 街の電飾
      const zs = this.zones.street;
      g.strokeStyle = 'rgba(20,20,30,.8)'; g.lineWidth = 1;
      this._bulbs(g, gy, this.L.garlands, zs, 3.2, 26);
      this._bulbs(g, gy, this.L.drapes, zs, 2.6, 20);
    }

    _bulbs(g, gy, list, z, r, gs, ox, oy, k) {
      ox = ox || 0; oy = oy == null ? gy : oy; k = k || 1;
      g.globalCompositeOperation = 'lighter';
      for (const b of list) {
        const br = this._bright(z, b.ph);
        if (br < 0.06) continue;
        const sz = gs * (0.7 + 0.5 * Math.min(1.7, br)) * (1 + 0.12 * Math.sin(this.t * 3 + b.ph));
        g.globalAlpha = Math.min(1, br * 0.9);
        g.drawImage(glow(b.c), ox + b.x * k - sz / 2, oy + b.y * k - sz / 2, sz, sz);
      }
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      for (const b of list) {
        const br = this._bright(z, b.ph);
        g.fillStyle = br < 0.06 ? '#3A3A44' : '#FFFFFF';
        g.beginPath(); g.arc(ox + b.x * k, oy + b.y * k, r * (br < 0.06 ? 0.8 : 0.55), 0, 6.283); g.fill();
      }
    }

    _heartSpot(g, gy) {
      // 台座とアーチの骨組み
      g.strokeStyle = '#2A2440'; g.lineWidth = 3;
      g.beginPath();
      this.L.heart.forEach((p, i) => (i ? g.lineTo(p.x, gy + p.y) : g.moveTo(p.x, gy + p.y)));
      g.closePath(); g.stroke();
      if (!this.stageImg.on) { const pw = 26 * HEART.k; g.fillStyle = '#24203A'; g.fillRect(HEART.x - pw / 2, gy - HEART.back - 10, pw, 10); }
      this._bulbs(g, gy, this.L.heart, this.zones.couple, 3.6, 30);
    }

    _tree(g, gy) {
      const th = this._treeH(), z = this.zones.tree, c = this.collapse, T = this.L.tree;
      gy -= TREE_BACK; // ツリーの根元
      g.save();
      g.translate(270, gy);
      g.rotate(this.wobble || 0);
      g.scale(1 + 0.22 * c, 1 - 0.64 * c);
      const imOn = this.img.tree_on, imOff = this.img.tree_off, imBroken = this.img.tree_broken;
      if (imOn) {
        const w = th * (imOn.width / imOn.height) * 1.05, h = th * 1.05;
        const lv = clamp(z.level, 0, 1);
        if (imBroken && c > 0.95) {
          g.restore(); g.save(); g.translate(270, gy);
          const bw = th * 1.2, bh = bw * (imBroken.height / imBroken.width);
          g.drawImage(imBroken, -bw / 2, -bh, bw, bh);
        } else {
          if (imOff && lv < 1) g.drawImage(imOff, -w / 2, -h, w, h);
          g.globalAlpha = imOff ? lv : 1; g.drawImage(imOn, -w / 2, -h, w, h); g.globalAlpha = 1;
          if (!imOff && lv < 1) { g.globalCompositeOperation = 'source-atop'; g.fillStyle = `rgba(5,8,18,${(1 - lv) * 0.6})`; g.fillRect(-w / 2, -h, w, h); g.globalCompositeOperation = 'source-over'; }
          if (z.level > 1.02) this._bulbs(g, 0, T.bulbs, z, 0, 18, 0, -th, th);
        }
      } else {
        // 幹
        g.fillStyle = '#3B2618'; g.fillRect(-th * 0.04, -th * 0.12, th * 0.08, th * 0.12);
        // 段
        for (let i = 0; i < T.tiers.length; i++) {
          const tr = T.tiers[i];
          const yt = -th + tr.top * th, yb = -th + tr.bot * th, hw = tr.hw * th;
          const gr = g.createLinearGradient(-hw, 0, hw, 0);
          gr.addColorStop(0, '#0B2E22'); gr.addColorStop(0.5, '#155C3D'); gr.addColorStop(1, '#0A281D');
          g.fillStyle = gr;
          g.beginPath(); g.moveTo(0, yt);
          const teeth = 7;
          for (let k = 0; k <= teeth; k++) { const x = lerp(hw, -hw, k / teeth); g.lineTo(x, yb + (k % 2 ? -th * 0.025 : 0)); }
          g.closePath(); g.fill();
        }
        for (const b of T.balls) { g.fillStyle = b.c; g.beginPath(); g.arc(b.x * th, -th + b.y * th, b.s * th, 0, 6.283); g.fill(); }
        // ガーランドの線
        g.strokeStyle = 'rgba(255,230,170,.25)'; g.lineWidth = 1;
        this._bulbs(g, 0, T.bulbs, z, 2.8 / Math.max(0.5, th / 200), 22, 0, -th, th);
      }
      // 星（崩壊前はてっぺん）
      if (!this.star && !(imOn && imBroken && c > 0.95)) this._star(g, 0, -th - 4, th * 0.07, z);
      g.restore();
      if (this.star) this._star(g, this.star.x, gy + this.star.y, th * 0.07, z, this.star.rot);
      // 足元の光
      const lv = clamp(z.level, 0, 1.7);
      if (lv > 0.05) {
        g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.35 * lv;
        g.drawImage(glow(this.L.pal[0]), 270 - th * 0.6, gy - th * 0.35, th * 1.2, th * 0.6);
        g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      }
    }
    _star(g, x, y, r, z, rot) {
      const br = clamp(this._bright(z, 1), 0, 1.7);
      g.save(); g.translate(x, y); g.rotate(rot || 0);
      if (br > 0.06) { g.globalCompositeOperation = 'lighter'; g.globalAlpha = Math.min(1, br); g.drawImage(glow('#FFE14F'), -r * 4, -r * 4, r * 8, r * 8); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; }
      g.fillStyle = br > 0.06 ? '#FFE14F' : '#6B6440';
      g.beginPath();
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      g.closePath(); g.fill();
      g.restore();
    }

    _couples(g, gy, minBack, maxBack) {
      const lv = clamp(this.zones.couple.level, 0, 1.7), love = this.love, shock = this.shockT > 0 ? Math.min(1, this.shockT) : 0;
      for (const c of this.L.couples) {
        if (-c.y <= minBack || -c.y > maxBack) continue;
        const x = c.x, y = gy + c.y;
        const k = c.h / 80, hk = k * 0.6; // 大きさの倍率（図形で描くときの基準 80）、頭上のハートの倍率
        const set = this.coupleSets[c.set % this.coupleSets.length];
        const st = shock ? 'shock' : love > 1.3 ? 'love' : 'normal';
        const sp = this.img[set + '_' + st] || this.img[set + '_normal'] || this.img['couple_' + st] || this.img.couple_normal;
        if (sp) {
          const h = c.h, w = h * (sp.width / sp.height);
          g.save(); g.translate(x, y); if (c.flip) g.scale(-1, 1);
          g.drawImage(sp, -w / 2, -h, w, h); g.restore();
        } else {
          const d = (Math.max(9, 24 - (love - 1) * 12) + shock * 22) * k;
          const tilt = Math.max(0, love - 1) * 0.12 - shock * 0.08;
          this._person(g, x - d / 2, y, c.h * 0.95, c.a, tilt, c.ph);
          this._person(g, x + d / 2, y, c.h * 0.88, c.b, -tilt, c.ph + 1);
        }
        const top = y - c.h * 0.98;
        if (shock) {
          g.fillStyle = '#fff'; g.font = `bold ${Math.round(18 * hk)}px 'Noto Sans JP', sans-serif`; g.textAlign = 'center';
          g.globalAlpha = shock; g.fillText('！？', x, top - 6 * hk - (1 - shock) * 10); g.globalAlpha = 1;
        } else if (lv > 0.05) {
          const n = love > 1.4 ? 2 : 1;
          for (let j = 0; j < n; j++) this._heart(g, x + (j - (n - 1) / 2) * 14 * hk, top - 12 * hk + Math.sin(this.t * 2 + c.ph + j) * 3, (6 + love * 2) * hk, Math.min(1, lv) * (0.6 + 0.2 * love));
        }
      }
    }
    _person(g, x, y, h, coat, tilt, ph) {
      g.save(); g.translate(x, y); g.rotate(tilt);
      const bob = Math.sin(this.t * 1.5 + ph) * 0.6;
      g.fillStyle = '#15131C'; g.fillRect(-h * 0.1, -h * 0.2, h * 0.08, h * 0.2); g.fillRect(h * 0.03, -h * 0.2, h * 0.08, h * 0.2);
      g.fillStyle = coat;
      g.beginPath(); g.moveTo(-h * 0.13, -h * 0.76 + bob); g.lineTo(h * 0.13, -h * 0.76 + bob); g.lineTo(h * 0.19, -h * 0.18); g.lineTo(-h * 0.19, -h * 0.18); g.closePath(); g.fill();
      g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, -h * 0.74 + bob, h * 0.19, h * 0.56);
      g.fillStyle = '#E9DCCB'; g.beginPath(); g.arc(0, -h * 0.86 + bob, h * 0.11, 0, 6.283); g.fill();
      g.fillStyle = '#2A1E1A'; g.beginPath(); g.arc(0, -h * 0.89 + bob, h * 0.115, Math.PI, 0); g.fill();
      g.restore();
    }
    _heart(g, x, y, s, a) {
      g.save(); g.globalAlpha = a; g.fillStyle = '#FF5FA2';
      g.beginPath(); g.moveTo(x, y + s * 0.9);
      g.bezierCurveTo(x - s * 1.4, y - s * 0.2, x - s * 0.6, y - s * 1.2, x, y - s * 0.4);
      g.bezierCurveTo(x + s * 0.6, y - s * 1.2, x + s * 1.4, y - s * 0.2, x, y + s * 0.9);
      g.fill(); g.restore();
    }

    _ground(g, gy, light) {
      if (this.stageImg.on) return; // 背景の絵に床が描かれている
      const gr = g.createLinearGradient(0, gy - 10, 0, this.vb + 40);
      gr.addColorStop(0, 'rgba(20,24,52,0)'); gr.addColorStop(0.15, '#161A36'); gr.addColorStop(1, '#0B0D1A');
      g.fillStyle = gr; g.fillRect(0, gy - 10, W, this.H - gy + 20);
      // 濡れた路面の反射
      g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.12 * Math.min(1.5, light);
      g.drawImage(glow(this.L.pal[0]), 40, gy + 6, 460, 50);
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }

    _focus(g, gy) {
      if (!this.focus) return;
      const th = this._treeH();
      let box;
      if (this.focus === 'couple') {
        // ハートと、その前に立つカップルを囲む
        let x0 = HEART.x - 17 * HEART.k, x1 = HEART.x + 17 * HEART.k, y0 = Math.min(...this.L.heart.map((p) => p.y)) - 12, y1 = 0;
        for (const c of this.L.couples) if (Math.abs(c.x - HEART.x) < 60) { x0 = Math.min(x0, c.x - c.h * 0.3); x1 = Math.max(x1, c.x + c.h * 0.3); y0 = Math.min(y0, c.y - c.h - 14); y1 = Math.max(y1, c.y); }
        // 街は中央を基準に拡大して描くので、画面の端からはみ出さないよう拡大前の座標で詰める
        const m = 270 - (270 - 10) / this.zoom();
        x0 = Math.max(m, x0); x1 = Math.min(W - m, x1);
        y1 = Math.min(y1, -24); // 足元は横断幕に隠れるので、その上で閉じる
        box = [x0, gy + y0, x1 - x0, y1 - y0];
      } else box = { street: [138, gy - 420, 264, 200], tree: [270 - th * 0.4, gy - TREE_BACK - th - 26, th * 0.8, th + 34] }[this.focus];
      if (!box) return;
      const [x, y, w, h] = box, k = 16, p = 0.5 + 0.5 * Math.sin(this.t * 5);
      g.strokeStyle = `rgba(255,210,63,${0.5 + 0.4 * p})`; g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x, y + k); g.lineTo(x, y); g.lineTo(x + k, y);
      g.moveTo(x + w - k, y); g.lineTo(x + w, y); g.lineTo(x + w, y + k);
      g.moveTo(x + w, y + h - k); g.lineTo(x + w, y + h); g.lineTo(x + w - k, y + h);
      g.moveTo(x + k, y + h); g.lineTo(x, y + h); g.lineTo(x, y + h - k);
      g.stroke();
    }

    _waves(g) {
      // 拡声器の口（右側の総帥）から、ツリーのある左上へ広がる
      const ox = LEAD_X - 62, oy = this.vb - 150;
      g.lineCap = 'round';
      for (const w of this.waves) {
        g.strokeStyle = `rgba(255,232,140,${clamp(w.a, 0, 1) * 0.55})`; g.lineWidth = 4;
        g.beginPath(); g.arc(ox, oy, w.r, -2.75, -1.25); g.stroke();
      }
    }

    _comrades(g) {
      const vb = this.vb, joy = this.joy, v = this.voice;
      const im = this.img[joy > 0 && this.img.comrades_cheer ? 'comrades_cheer' : 'comrades_back'];
      if (im) {
        const w = W, h = w * (im.height / im.width);
        const bob = -v * 6 * Math.abs(Math.sin(this.t * 12)) + (joy > 0 ? -Math.abs(Math.sin(this.t * 8)) * 8 : joy < 0 ? 10 : 0);
        g.drawImage(im, 0, vb - h + 40 + bob, w, h);
        return;
      }
      const sway = Math.sin(this.t * 1.3) * 0.03;
      // 黄色い横断幕（左上）
      g.save(); g.translate(26, vb - 360); g.rotate(sway * 0.6);
      g.fillStyle = '#4A3B2A'; g.fillRect(-4, 0, 6, 330);
      g.fillStyle = '#FFD23F'; g.fillRect(2, 8, 176, 92);
      g.fillStyle = '#111'; g.textAlign = 'center';
      g.font = "30px 'Dela Gothic One', sans-serif"; g.fillText('クリスマス', 90, 46);
      g.font = "34px 'Dela Gothic One', sans-serif"; g.fillText('粉砕！', 90, 88);
      g.restore();
      // 赤い縦の旗（右）
      g.save(); g.translate(504, vb - 380); g.rotate(-sway);
      g.fillStyle = '#4A3B2A'; g.fillRect(0, 0, 6, 360);
      g.fillStyle = '#D9252D'; g.fillRect(-58, 10, 58, 232);
      g.fillStyle = '#111'; g.font = "26px 'Dela Gothic One', sans-serif"; g.textAlign = 'center';
      '反恋愛至上戦線'.split('').forEach((ch, i) => g.fillText(ch, -29, 42 + i * 31));
      g.restore();
      // 同志たちの後ろ姿
      const people = [
        { x: 38, s: 1.0, c: '#2B2B2B', hat: '#3A3A44', scarf: '#B22C2C' }, { x: 110, s: 1.08, c: '#3C3B26', hat: null, scarf: '#777' },
        { x: 186, s: 0.95, c: '#1F2230', hat: '#5B5560', scarf: '#B22C2C' }, { x: 262, s: 1.04, c: '#2A2A33', hat: '#A89F94', scarf: '#CFC6B8', armband: true },
        { x: 338, s: 1.0, c: '#33302A', hat: null, scarf: '#B22C2C' }, { x: LEAD_X, s: 1.18, c: '#46462A', hat: null, scarf: '#C0312F', lead: true },
        { x: 524, s: 0.98, c: '#24242C', hat: '#3A3A44', scarf: '#777' },
      ];
      people.forEach((p, i) => {
        const bob = -v * 12 * Math.abs(Math.sin(this.t * 13 + i * 1.7)) + (joy > 0 ? -Math.abs(Math.sin(this.t * 9 + i)) * 10 : joy < 0 ? 12 : 0);
        const x = p.x, y = vb - 40 + bob, r = 26 * p.s;
        // 拳・拡声器（総帥は右側から、ツリーのある左上へ向けて叫ぶ）
        if (p.lead) {
          g.strokeStyle = p.c; g.lineWidth = 16 * p.s; g.lineCap = 'round';
          g.beginPath(); g.moveTo(x - 12, y + 6); g.lineTo(x - 26, y - 64); g.stroke();
          g.save(); g.translate(x - 30, y - 76); g.scale(-1, 1); g.rotate(-0.55);
          g.fillStyle = '#EDEDED'; g.beginPath(); g.moveTo(-8, 8); g.lineTo(-14, -24); g.lineTo(28, -40); g.lineTo(20, 6); g.closePath(); g.fill();
          g.fillStyle = '#D9252D'; g.fillRect(-10, -6, 9, 12);
          g.fillStyle = '#BDBDBD'; g.beginPath(); g.ellipse(25, -17, 6, 24, -0.35, 0, 6.283); g.fill();
          g.restore();
        } else if (joy > 0 && i % 2 === 0) {
          g.strokeStyle = p.c; g.lineWidth = 13 * p.s; g.lineCap = 'round';
          g.beginPath(); g.moveTo(x - 10, y + 4); g.lineTo(x - 18, y - 58); g.stroke();
          g.fillStyle = '#E9DCCB'; g.beginPath(); g.arc(x - 18, y - 64, 8 * p.s, 0, 6.283); g.fill();
        }
        g.fillStyle = p.c;
        g.beginPath(); g.ellipse(x, y + 46 * p.s, 46 * p.s, 40 * p.s, 0, Math.PI, 0); g.fill();
        g.fillRect(x - 46 * p.s, y + 46 * p.s - 1, 92 * p.s, 60);
        g.fillStyle = p.scarf; g.beginPath(); g.ellipse(x, y + 12 * p.s, 22 * p.s, 10 * p.s, 0, 0, 6.283); g.fill();
        g.fillStyle = '#1B1412'; g.beginPath(); g.arc(x, y - 6 * p.s, r * 0.82, 0, 6.283); g.fill();
        if (p.hat) { g.fillStyle = p.hat; g.beginPath(); g.arc(x, y - 10 * p.s, r * 0.86, Math.PI, 0); g.fill(); g.fillRect(x - r * 0.86, y - 12 * p.s, r * 1.72, 7 * p.s); }
        if (p.armband) { g.fillStyle = '#FFD23F'; g.fillRect(x + 30 * p.s, y + 30 * p.s, 14 * p.s, 22 * p.s); } // 新人隊員（あなた）の腕章
      });
    }

    _particles(g, front) {
      for (const p of this.particles) {
        const isFront = p.type === 'paper';
        if (isFront !== front) continue;
        const a = clamp(p.life / (p.max || 1), 0, 1);
        if (p.type === 'spark') { g.globalCompositeOperation = 'lighter'; g.globalAlpha = a; g.drawImage(glow('#FFE7A0'), p.x - 6, p.y - 6, 12, 12); g.globalCompositeOperation = 'source-over'; }
        else if (p.type === 'star4') {
          const s = p.s * (0.6 + 0.4 * Math.sin(this.t * 10 + p.x));
          g.globalAlpha = a; g.fillStyle = '#fff';
          g.beginPath(); g.moveTo(p.x, p.y - s * 2); g.lineTo(p.x + s * 0.4, p.y); g.lineTo(p.x, p.y + s * 2); g.lineTo(p.x - s * 0.4, p.y); g.closePath(); g.fill();
          g.beginPath(); g.moveTo(p.x - s * 2, p.y); g.lineTo(p.x, p.y + s * 0.4); g.lineTo(p.x + s * 2, p.y); g.lineTo(p.x, p.y - s * 0.4); g.closePath(); g.fill();
        } else if (p.type === 'dust') { g.globalAlpha = a * 0.5; g.fillStyle = p.c; g.beginPath(); g.arc(p.x, p.y, p.s * (1.6 - a), 0, 6.283); g.fill(); }
        else if (p.type === 'shard') { g.globalAlpha = a; g.fillStyle = p.c; g.beginPath(); g.arc(p.x, p.y, p.s, 0, 6.283); g.fill(); }
        else if (p.type === 'heart') { this._heart(g, p.x, p.y, 6, a * 0.9); }
        else if (p.type === 'paper') { g.save(); g.globalAlpha = Math.min(1, a * 2); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.c; g.fillRect(-p.s / 2, -p.s, p.s, p.s * 2); g.restore(); }
      }
      g.globalAlpha = 1;
    }
  }

  root.CSScene = Scene;
})(window);
