/* クリスマス粉砕！ ― 音の入出力
 *   お手本：voice/models.json の特徴量（強弱・抑揚・区切りの数値）。実際の音声はアプリに入れない
 *          （開発用に自分で録ったものがあれば最優先。端末の中だけに保存）
 *   マイク：叫ぶたびに開いて、録り終えたら閉じる（iOS で再生音量が下がる問題と、常時録音の不安を避ける）
 *   録音は AudioWorklet（使えなければ ScriptProcessor）で生の波形をそのまま集める
 */
(function (root) {
  'use strict';
  const A = root.CSAnalysis;

  const WORKLET = `
    class CsCapture extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) {
          for (let i = 0; i < ch.length; i++) {
            this.buf[this.n++] = ch[i];
            if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
          }
        }
        return true;
      }
    }
    registerProcessor('cs-capture', CsCapture);`;

  function concat(chunks) {
    let n = 0; for (const c of chunks) n += c.length;
    const out = new Float32Array(n);
    let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  // 録音の音量をそろえる：いちばん大きい所を 0.9 に（小さすぎる録音は 40 倍まで。雑音だけを持ち上げすぎない）
  function normalize(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
    const k = peak > 0 ? Math.min(40, 0.9 / peak) : 1;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * k;
    return out;
  }
  // 16bit モノラルの WAV
  function wavBlob(x, sr) {
    const v = new DataView(new ArrayBuffer(44 + x.length * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, x.length * 2, true);
    for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
    return new Blob([v], { type: 'audio/wav' });
  }

  const Audio = {
    ctx: null, bus: {}, models: {},
    stream: null, capturing: false, chunks: [], capCount: 0,

    async ensure() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        for (const k of ['bgm', 'se', 'voice']) { const g = this.ctx.createGain(); g.connect(this.master); this.bus[k] = g; }
      }
      if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { /* 無視 */ } }
      return this.ctx;
    },
    setVolume(kind, v) { if (this.bus[kind]) this.bus[kind].gain.value = v; },

    // ---------------------------------------------------------- お手本
    loadModel(call) {
      if (!this.models[call.id]) this.models[call.id] = this._load(call);
      return this.models[call.id];
    },
    forgetModel(id) { delete this.models[id]; },
    // 採点の基準（特徴量）を読む。音声ファイルは読まない（実際の音声はアプリに入れない）
    loadFeatures() {
      if (!this._features) {
        this._features = fetch('voice/models.json').then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.models) || {}).catch(() => ({}));
      }
      return this._features;
    },
    async _load(call) {
      await this.ensure();
      let feat = null, src = 'none', buffer = null;
      // 開発用：この端末で自分で録ったお手本（端末の外には出ない）
      const custom = await root.CSStore.getCustomModel(call.id);
      if (custom && custom.data) {
        const mono = new Float32Array(custom.data);
        feat = A.analyze(mono, custom.sr); src = 'custom';
        buffer = this.ctx.createBuffer(1, mono.length, custom.sr);
        buffer.getChannelData(0).set(mono);
      } else {
        const m = (await this.loadFeatures())[call.id];
        if (m) {
          feat = Object.assign({}, m, { valid: true, env: Float32Array.from(m.env), st: Float32Array.from(m.st), voiced: Uint8Array.from(m.voiced) });
          src = 'features';
        }
      }
      if (!feat || !feat.valid) {
        // お手本が無い → 標準的な叫びの型で代用
        feat = A.pseudoModel(call.sec, call.chunks.length, call.weights);
        if (src !== 'none') src = 'broken';
      }
      return { id: call.id, src, buffer, feat, guide: A.makeGuide(feat, call.chunks.length, call.weights) };
    },
    // ---------------------------------------------------------- 再生
    play(buffer, bus) {
      const s = this.ctx.createBufferSource();
      s.buffer = buffer;
      s.connect(this.bus[bus || 'voice']);
      const ended = new Promise((r) => { s.onended = r; });
      s.start();
      return { stop() { try { s.stop(); } catch (e) { /* 済み */ } }, ended };
    },
    playSamples(samples, sr) {
      const b = this.ctx.createBuffer(1, samples.length, sr);
      b.getChannelData(0).set(samples);
      return this.play(b, 'voice');
    },

    // 自分の声の聞き返し。iOS では、マイクを使ったあとの Web Audio が鳴らないことがあり（中断されたまま／消音スイッチで無音）、
    // 自動音量調整なしの録音は音も小さい。そこで、音量をそろえた WAV にして <audio> で鳴らす（だめなら Web Audio に切り替える）。
    // ボタンを押した処理の中から、待たずに呼ぶこと（iOS は、押した直後でないと再生を許さない）
    playVoice(samples, sr) {
      const x = normalize(samples);
      const el = new root.Audio();
      const url = URL.createObjectURL(wavBlob(x, sr));
      let done, stopped = false, inner = null;
      const ended = new Promise((r) => { done = r; });
      const finish = () => { if (stopped) return; stopped = true; URL.revokeObjectURL(url); done(); };
      const fallback = async () => {
        if (stopped || inner) return;
        inner = { stop() {} }; // 二重に入らない
        try {
          await this.ensure();
          if (stopped) return;
          inner = this.playSamples(x, sr);
          inner.ended.then(finish);
        } catch (e) { finish(); }
      };
      el.setAttribute('playsinline', '');
      el.onended = finish;
      el.onerror = fallback;
      el.src = url;
      const p = el.play();
      if (p && p.catch) p.catch(fallback);
      return { stop() { el.onerror = null; try { el.pause(); } catch (e) { /* 済み */ } if (inner) inner.stop(); finish(); }, ended };
    },

    // ---------------------------------------------------------- マイク
    get micSupported() { return !!(root.navigator.mediaDevices && root.navigator.mediaDevices.getUserMedia); },

    async openMic() {
      await this.ensure();
      if (this.stream) return;
      if (!this.micSupported) throw Object.assign(new Error('nomic'), { code: 'unsupported' });
      try {
        this.stream = await root.navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        });
      } catch (e) {
        throw Object.assign(new Error('mic'), { code: e && e.name === 'NotAllowedError' ? 'denied' : 'failed', cause: e });
      }
      const ctx = this.ctx;
      this.micSrc = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.liveBuf = new Float32Array(1024);
      this.micSrc.connect(this.analyser);
      this.capNode = null;
      if (ctx.audioWorklet && !this.workletFailed) {
        try {
          if (!this.workletReady) {
            const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
            await ctx.audioWorklet.addModule(url);
            this.workletReady = true;
          }
          this.capNode = new root.AudioWorkletNode(ctx, 'cs-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          this.capNode.port.onmessage = (e) => { if (this.capturing) { this.chunks.push(e.data); this.capCount += e.data.length; } };
        } catch (e) { this.workletFailed = true; this.capNode = null; }
      }
      if (!this.capNode) {
        this.capNode = ctx.createScriptProcessor(2048, 1, 1);
        this.capNode.onaudioprocess = (e) => {
          if (!this.capturing) return;
          const d = new Float32Array(e.inputBuffer.getChannelData(0));
          this.chunks.push(d); this.capCount += d.length;
        };
      }
      this.mute = ctx.createGain();
      this.mute.gain.value = 0;
      this.micSrc.connect(this.capNode);
      this.capNode.connect(this.mute);
      this.mute.connect(ctx.destination);
    },
    closeMic() {
      this.capturing = false;
      try { this.micSrc && this.micSrc.disconnect(); } catch (e) { /* 済み */ }
      try { this.capNode && this.capNode.disconnect(); } catch (e) { /* 済み */ }
      try { this.mute && this.mute.disconnect(); } catch (e) { /* 済み */ }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null; this.micSrc = null; this.capNode = null; this.analyser = null;
      // iOS：マイクを閉じると音の出口が切り替わり、AudioContext が中断されることがある。少し待って起こし直す
      setTimeout(() => { if (!this.stream && this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }, 300);
    },
    startCapture() { this.chunks = []; this.capCount = 0; this.capturing = true; },
    get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; },
    // 今まで録れたサンプル数（「叫べ！」の瞬間の目印に使う）
    mark() { return this.capCount; },
    // 録音を続けたまま、ここまでの波形を取り出す（カウントダウン中の雑音を測る）
    peek() { return concat(this.chunks); },
    stopCapture() { this.capturing = false; const out = concat(this.chunks); this.chunks = []; return out; },
    // 直近 約20ms の音量（dBFS）
    liveLevel() {
      if (!this.analyser) return -100;
      if (this.analyser.getFloatTimeDomainData) this.analyser.getFloatTimeDomainData(this.liveBuf);
      return A.levelDb(this.liveBuf);
    },
  };

  root.CSAudio = Audio;
})(window);
