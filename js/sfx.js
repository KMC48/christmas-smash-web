/* クリスマス粉砕！ ― 効果音と BGM（Web Audio で合成。音声ファイルは使わない）
 * 叫んでいる間は鳴らさない（マイクに入って採点を乱すため）。
 */
(function (root) {
  'use strict';
  const Au = root.CSAudio;
  const ctx = () => Au.ctx;
  let noiseBuf = null;

  function noise() {
    const c = ctx();
    if (!noiseBuf || noiseBuf.sampleRate !== c.sampleRate) {
      noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }
  function gainEnv(t, a, peak, d, dest) {
    const g = ctx().createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    g.connect(dest);
    return g;
  }
  function osc(type, f, t, dur, dest) {
    const o = ctx().createOscillator();
    o.type = type; o.frequency.setValueAtTime(f, t);
    o.connect(dest); o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  function noiseSrc(t, dur, dest, filter) {
    const c = ctx(), s = c.createBufferSource();
    s.buffer = noise(); s.loop = true;
    let node = s;
    if (filter) {
      const f = c.createBiquadFilter();
      f.type = filter.type; f.frequency.setValueAtTime(filter.f, t); if (filter.q) f.Q.value = filter.q;
      if (filter.to) f.frequency.exponentialRampToValueAtTime(filter.to, t + dur);
      s.connect(f); node = f;
    }
    node.connect(dest);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
    return s;
  }
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const ready = () => ctx() && ctx().state === 'running';

  const SFX = {
    tap() {
      if (!ready()) return; const t = ctx().currentTime;
      osc('triangle', 660, t, 0.06, gainEnv(t, 0.005, 0.15, 0.06, Au.bus.se));
    },
    beep(high) {
      if (!ready()) return; const t = ctx().currentTime;
      osc('sine', high ? 1320 : 880, t, 0.09, gainEnv(t, 0.005, 0.12, 0.09, Au.bus.se));
    },
    tick() {
      if (!ready()) return; const t = ctx().currentTime;
      osc('square', 1800 + Math.random() * 300, t, 0.02, gainEnv(t, 0.002, 0.04, 0.02, Au.bus.se));
    },
    stamp() {
      if (!ready()) return; const t = ctx().currentTime;
      const o = osc('sine', 140, t, 0.25, gainEnv(t, 0.005, 0.6, 0.25, Au.bus.se));
      o.frequency.exponentialRampToValueAtTime(50, t + 0.2);
      noiseSrc(t, 0.08, gainEnv(t, 0.002, 0.25, 0.08, Au.bus.se), { type: 'lowpass', f: 3000 });
    },
    // 電飾が消える：ジジッという放電音と、ブレーカーが落ちる音
    zap() {
      if (!ready()) return; const t = ctx().currentTime;
      const g = gainEnv(t, 0.01, 0.22, 0.45, Au.bus.se);
      osc('sawtooth', 120, t, 0.45, g);
      osc('square', 61, t, 0.45, g);
      for (let i = 0; i < 6; i++) {
        const tt = t + Math.random() * 0.35;
        noiseSrc(tt, 0.03, gainEnv(tt, 0.001, 0.3, 0.03, Au.bus.se), { type: 'highpass', f: 2500 });
      }
      const t2 = t + 0.45;
      const o = osc('sine', 110, t2, 0.3, gainEnv(t2, 0.003, 0.7, 0.3, Au.bus.se));
      o.frequency.exponentialRampToValueAtTime(38, t2 + 0.25);
    },
    // 失敗でキラキラが増える
    sparkle() {
      if (!ready()) return; const t = ctx().currentTime;
      const notes = [84, 88, 91, 96, 100, 103];
      notes.forEach((n, i) => {
        const tt = t + i * 0.06 + Math.random() * 0.03;
        osc('sine', midi(n), tt, 0.5, gainEnv(tt, 0.004, 0.08, 0.5, Au.bus.se));
        osc('sine', midi(n) * 2.76, tt, 0.25, gainEnv(tt, 0.002, 0.02, 0.25, Au.bus.se));
      });
    },
    // ツリー崩壊
    crash() {
      if (!ready()) return; const t = ctx().currentTime;
      noiseSrc(t, 1.4, gainEnv(t, 0.01, 0.55, 1.4, Au.bus.se), { type: 'lowpass', f: 5000, to: 200 });
      const o = osc('sine', 70, t, 0.6, gainEnv(t, 0.005, 0.9, 0.6, Au.bus.se));
      o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
      for (let i = 0; i < 9; i++) { // 飾りが散らばる
        const tt = t + 0.1 + Math.random() * 0.9;
        osc('sine', 1500 + Math.random() * 2500, tt, 0.25, gainEnv(tt, 0.002, 0.05, 0.25, Au.bus.se));
      }
    },
    // 同志たちのシュプレヒコール（「おー！」の合成。母音 o の共鳴を2つ通す）
    chant(times) {
      if (!ready()) return; const c = ctx(), t0 = c.currentTime;
      const shouts = times || [0, 0.55, 1.1, 1.8];
      for (const st of shouts) {
        for (let v = 0; v < 9; v++) {
          const t = t0 + st + Math.random() * 0.06;
          const dur = 0.42 + Math.random() * 0.1;
          const g = gainEnv(t, 0.05, 0.05, dur, Au.bus.se);
          const f1 = c.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 520; f1.Q.value = 4; f1.connect(g);
          const f2 = c.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 880; f2.Q.value = 5; f2.connect(g);
          const o = c.createOscillator(); o.type = 'sawtooth';
          const base = 120 + Math.random() * 90;
          o.frequency.setValueAtTime(base * 1.08, t); o.frequency.linearRampToValueAtTime(base, t + dur);
          o.connect(f1); o.connect(f2); o.start(t); o.stop(t + dur + 0.05);
        }
        noiseSrc(t0 + st, 0.4, gainEnv(t0 + st, 0.03, 0.05, 0.4, Au.bus.se), { type: 'bandpass', f: 1200, q: 1 });
      }
    },
    // 失敗：ワワワワーン
    fail() {
      if (!ready()) return; const c = ctx(), t = c.currentTime;
      [55, 54, 53, 52].forEach((n, i) => {
        const tt = t + i * 0.32, dur = i === 3 ? 0.9 : 0.3;
        const g = gainEnv(tt, 0.02, 0.18, dur, Au.bus.se);
        const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6;
        f.frequency.setValueAtTime(400, tt); f.frequency.linearRampToValueAtTime(1400, tt + 0.12); f.frequency.linearRampToValueAtTime(500, tt + dur);
        f.connect(g);
        const o = osc('sawtooth', midi(n), tt, dur, f);
        if (i === 3) { const l = c.createOscillator(), lg = c.createGain(); l.frequency.value = 6; lg.gain.value = 5; l.connect(lg); lg.connect(o.frequency); l.start(tt); l.stop(tt + dur); }
      });
    },
    fanfare() {
      if (!ready()) return; const t = ctx().currentTime;
      [60, 64, 67, 72].forEach((n, i) => {
        const tt = t + i * 0.12, d = i === 3 ? 0.9 : 0.14;
        osc('square', midi(n), tt, d, gainEnv(tt, 0.005, 0.07, d, Au.bus.se));
        osc('triangle', midi(n - 12), tt, d, gainEnv(tt, 0.005, 0.1, d, Au.bus.se));
      });
      [64, 67].forEach((n) => osc('square', midi(n), t + 0.36, 0.9, gainEnv(t + 0.36, 0.005, 0.05, 0.9, Au.bus.se)));
    },
  };

  // ------------------------------------------------------------------ BGM
  // 8分音符を1ステップとする簡単なシーケンサ
  const SONGS = {
    // タイトル：短調にしたジングルベル（皮肉）。グロッケン＋ベース＋鈴
    title: {
      bpm: 112, steps: 64,
      mel: [[63, 2], [63, 2], [63, 4], [63, 2], [63, 2], [63, 4], [63, 2], [67, 2], [60, 3], [62, 1], [63, 8],
            [65, 2], [65, 2], [65, 3], [65, 1], [65, 2], [63, 2], [63, 2], [63, 1], [63, 1], [63, 2], [62, 2], [62, 2], [63, 2], [62, 4], [67, 4]],
      bass: [36, 36, 36, 36, 41, 36, 43, 43],
      bells: true,
    },
    // ステージ：デモ行進のマーチ
    stage: {
      bpm: 120, steps: 32,
      bassLine: [36, null, 36, null, 43, null, 46, null, 36, null, 36, 36, 43, null, 41, null,
                 36, null, 36, null, 43, null, 46, null, 44, null, 43, null, 41, null, 43, 43],
      drums: true,
    },
  };

  function glock(f, t, dest, vol) {
    osc('sine', f, t, 0.6, gainEnv(t, 0.003, vol, 0.6, dest));
    osc('sine', f * 2.76, t, 0.2, gainEnv(t, 0.002, vol * 0.25, 0.2, dest));
  }
  function bassNote(f, t, d, dest, vol) {
    const c = ctx(), lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 500; lp.connect(gainEnv(t, 0.01, vol, d, dest));
    osc('triangle', f, t, d, lp);
  }
  function kick(t, dest) {
    const o = osc('sine', 120, t, 0.18, gainEnv(t, 0.003, 0.5, 0.18, dest));
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  }
  function snare(t, dest, vol) { noiseSrc(t, 0.12, gainEnv(t, 0.002, vol, 0.12, dest), { type: 'bandpass', f: 1800, q: 0.8 }); }
  function bell(t, dest, vol) { noiseSrc(t, 0.05, gainEnv(t, 0.001, vol, 0.05, dest), { type: 'highpass', f: 7000 }); }

  const BGM = {
    cur: null, timer: null, next: 0, step: 0, gain: null,
    play(name) {
      if (!ready() || this.cur === name) return;
      this.stop(0.3);
      const c = ctx();
      this.cur = name; this.song = SONGS[name]; this.step = 0; this.next = c.currentTime + 0.1;
      this.gain = c.createGain(); this.gain.gain.value = 1; this.gain.connect(Au.bus.bgm);
      const g = this.gain;
      this.timer = setInterval(() => this._sched(g), 50);
    },
    stop(fade) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null; this.cur = null;
      const g = this.gain; this.gain = null;
      if (g && ctx()) {
        const t = ctx().currentTime;
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + (fade || 0.05));
        setTimeout(() => { try { g.disconnect(); } catch (e) { /* 済み */ } }, ((fade || 0.05) + 0.6) * 1000);
      }
    },
    _sched(g) {
      const c = ctx(), s = this.song;
      if (!s || g !== this.gain) return;
      const stepDur = 60 / s.bpm / 2;
      while (this.next < c.currentTime + 0.25) {
        const i = this.step % s.steps, t = this.next;
        if (s.mel) {
          let p = 0;
          for (const [n, len] of s.mel) { if (p === i) glock(midi(n + 12), t, g, 0.09); p += len; }
          if (i % 8 === 0) bassNote(midi(s.bass[(i / 8) % s.bass.length]), t, stepDur * 3.5, g, 0.16);
          if (i % 8 === 4) bassNote(midi(s.bass[Math.floor(i / 8) % s.bass.length] + 7), t, stepDur * 3.5, g, 0.12);
          if (s.bells) bell(t, g, i % 2 ? 0.02 : 0.045);
        }
        if (s.drums) {
          const n = s.bassLine[i];
          if (n) bassNote(midi(n), t, stepDur * 1.6, g, 0.2);
          if (i % 4 === 0) kick(t, g);
          if (i % 4 === 2) snare(t, g, 0.12);
          if (i >= 28) snare(t + stepDur / 2, g, 0.06);
        }
        this.next += stepDur; this.step++;
      }
    },
  };

  root.CSSfx = SFX;
  root.CSBgm = BGM;
})(window);
