/* クリスマス粉砕！ ― 譜面ガイド
 * お手本の声は聞かせない代わりに、お手本から作った「強弱の山（棒）」と「抑揚（白い線）」を見せる。
 * 叫び始めると、カーソルがお手本の速さで進み、コールの文字が区切りごとに光る（カラオケ式）。
 * 採点後は、あなたの強弱と抑揚（黄色）を、お手本と同じ長さにそろえて重ねる。
 */
(function (root) {
  'use strict';
  const GW = 500, GH = 104, PAD = 12, BASE = 92, TOPY = 14;
  const ST_RANGE = 8; // ±8 半音を縦いっぱいに

  class Guide {
    constructor(canvas, textEl) {
      this.cv = canvas; this.g = canvas.getContext('2d'); this.textEl = textEl;
      this.guide = null; this.live = []; this.player = null; this.cursor = -1; this.chunkTimes = [];
    }
    resize() {
      const r = this.cv.getBoundingClientRect(), dpr = Math.min(2, root.devicePixelRatio || 1);
      this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr);
      this.k = (r.width * dpr) / GW; this.ky = (r.height * dpr) / GH;
      this.draw();
    }
    // コールの文字（区切りごとの span）と、区切りの時刻を用意する
    setCall(call, guide) {
      this.call = call; this.guide = guide; this.live = []; this.player = null; this.cursor = -1;
      const dur = guide ? guide.dur : call.sec;
      let bounds = guide && guide.bounds;
      if (!bounds) {
        // 区切りが取れないときは文字数で按分
        const lens = call.chunks.map((c) => c.length), sum = lens.reduce((a, b) => a + b, 0);
        bounds = []; let acc = 0;
        for (let i = 0; i < lens.length - 1; i++) { acc += lens[i]; bounds.push(acc / sum); }
      }
      this.chunkTimes = [0, ...bounds.map((b) => b * dur), dur];
      this.dur = dur;
      this.textEl.innerHTML = '';
      call.chunks.forEach((c) => { const s = document.createElement('span'); s.className = 'ck on'; s.textContent = c; this.textEl.appendChild(s); });
      this.textEl.classList.toggle('long', call.text.length > 13);
      this.draw();
    }
    // ライブ：叫び始めてからの経過秒と、そのときの音量（0〜1）
    pushLive(t, v) { this.live.push([t, v]); }
    setCursor(t) {
      this.cursor = t;
      const spans = this.textEl.children;
      for (let i = 0; i < spans.length; i++) {
        const a = this.chunkTimes[i], b = this.chunkTimes[i + 1];
        spans[i].className = 'ck' + (t < 0 ? ' on' : t >= b ? ' on' : t >= a ? ' on now' : '');
      }
      this.draw();
    }
    resetText() { for (const s of this.textEl.children) s.className = 'ck on'; }
    setPlayer(feat) { this.player = feat && feat.valid ? feat : null; this.live = []; this.cursor = -1; this.resetText(); this.draw(); }

    _x(t) { const span = this.dur * 1.25; return PAD + ((GW - PAD * 2) * t) / span; }
    _y(st) { return BASE - 8 - ((st + ST_RANGE) / (ST_RANGE * 2)) * (BASE - TOPY - 14); }

    draw() {
      const g = this.g;
      if (!this.k) return;
      g.setTransform(this.k, 0, 0, this.ky, 0, 0);
      g.clearRect(0, 0, GW, GH);
      // 区切り
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.setLineDash([3, 4]); g.lineWidth = 1;
      for (const t of this.chunkTimes) { const x = this._x(t); g.beginPath(); g.moveTo(x, TOPY - 6); g.lineTo(x, BASE + 4); g.stroke(); }
      g.setLineDash([]);
      g.strokeStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(PAD, BASE); g.lineTo(GW - PAD, BASE); g.stroke();
      const G = this.guide;
      if (G) {
        // お手本の強弱（棒）
        const n = G.env.length, step = Math.max(1, Math.round(n / 90));
        g.fillStyle = 'rgba(224,38,46,.55)';
        for (let i = 0; i < n; i += step) {
          let v = 0; for (let j = i; j < Math.min(n, i + step); j++) v = Math.max(v, G.env[j]);
          const x = this._x((i / n) * G.dur), w = Math.max(1.5, this._x(((i + step) / n) * G.dur) - x - 1);
          const h = v * (BASE - TOPY - 6);
          g.fillRect(x, BASE - h, w, h);
        }
        // お手本の抑揚（白い線）
        this._line(g, G.st, G.dur, '#FFFFFF', 2.4);
      }
      // あなた（採点後）
      if (this.player && G) {
        const P = this.player, n = P.env.length;
        g.fillStyle = 'rgba(255,210,63,.45)';
        const step = Math.max(1, Math.round(n / 90));
        for (let i = 0; i < n; i += step) {
          let v = 0; for (let j = i; j < Math.min(n, i + step); j++) v = Math.max(v, P.env[j]);
          const x = this._x((i / n) * G.dur), h = v * (BASE - TOPY - 6);
          g.fillRect(x + 1, BASE - h, 2, h);
        }
        const st = new Float32Array(n);
        for (let i = 0; i < n; i++) st[i] = P.voiced[i] ? P.st[i] : NaN;
        this._line(g, st, G.dur, '#FFD23F', 2);
      }
      // あなた（ライブ）
      if (this.live.length) {
        g.fillStyle = 'rgba(255,210,63,.8)';
        for (const [t, v] of this.live) { const x = this._x(t), h = v * (BASE - TOPY - 6); g.fillRect(x, BASE - h, 2, h); }
      }
      // カーソル
      if (this.cursor >= 0) {
        const x = this._x(this.cursor);
        g.fillStyle = '#FFD23F'; g.fillRect(x - 1.5, TOPY - 8, 3, BASE - TOPY + 12);
      }
      if (!G) { g.fillStyle = 'rgba(255,255,255,.5)'; g.font = "13px 'Noto Sans JP', sans-serif"; g.textAlign = 'center'; g.fillText('お手本を読み込み中…', GW / 2, GH / 2); }
    }
    _line(g, st, dur, color, w) {
      const n = st.length;
      g.strokeStyle = color; g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const v = st[i];
        if (Number.isNaN(v)) { pen = false; continue; }
        const x = this._x((i / n) * dur), y = this._y(Math.max(-ST_RANGE, Math.min(ST_RANGE, v)));
        if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
      }
      g.stroke();
    }
  }

  root.CSGuide = Guide;
})(window);
