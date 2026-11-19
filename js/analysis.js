/* クリスマス粉砕！ ― 声の解析と採点（お手本との再現度）
 *
 * ブラウザでも Node（テスト）でも動く純粋な関数だけで書く。
 *   analyze(samples, sampleRate, {noiseDb})  → 特徴量（音量・声の高さ・明るさ・声のかたまり）
 *   compare(model, player, {nChunks, calib, sensDb}) → 4項目の得点と内訳・助言の種類
 *   makeGuide(model, nChunks) → 譜面ガイド（音量の山・抑揚の線・区切りの時刻）
 *
 * 採点は「声の高さ・速さ・声質の個人差」に左右されないよう、すべて相対値で比べる。
 *   トーン：中央値からの半音差の形（男女で高さが違っても形が同じなら高得点）
 *   テンポ：長さの比と、音量の山・区切りの位置（時間を正規化して比較）
 *   熱量  ：大きさ（マイク調整値または周囲の雑音との差）・張りの持続・声の明るさ
 *   語尾  ：最後の部分の強さ・切れの速さ・音の上げ下げ
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SR = 16000;              // 解析用のサンプリング周波数
  const HOP = 160;               // 10ms ごとに1フレーム
  const HOP_SEC = HOP / SR;
  const YIN_W = 400;             // 声の高さの積分窓（25ms）
  const F0_MIN = 70, F0_MAX = 900;
  const TAU_MIN = Math.floor(SR / F0_MAX), TAU_MAX = Math.ceil(SR / F0_MIN);
  const FRAME = YIN_W + TAU_MAX; // 1フレームで読むサンプル数
  const N = 100;                 // 時間を正規化するときの点数

  // 採点の調整値。good で満点、bad で0点（その間は直線）。実際の声で試しながら詰める。
  // w は各項目の中の配分。
  const TUNING = {
    tone:   { shapeGood: 0.6, shapeBad: 4.0, corrBad: -0.1, corrGood: 0.9, rangeBad: 0.3, rangeGood: 0.9, w: [0.4, 0.35, 0.25] },
    tempo:  { durGood: 0.05, durBad: 0.6, envBad: 0.2, envGood: 0.92, segGood: 0.02, segBad: 0.2, w: [0.4, 0.6] },
    energy: { absBad: -45, absGood: -16, snrBad: 15, snrGood: 42, calBad: 1, calGood: 13,
              susBad: 0.4, susGood: 0.06, brightBad: 0.45, brightGood: 0.9, dynBad: 0.1, dynGood: 0.85,
              w: [0.45, 0.2, 0.15, 0.2] }, // 大きさ・持続・明るさ・強弱の形
    ending: { strGood: 2, strBad: 10, crispGood: 0.06, crispBad: 0.5, pitchGood: 1.5, pitchBad: 6.5, w: [0.45, 0.35, 0.2] },
    // リズムがお手本と合っていないとき、トーンと語尾の比較は当てにならないので割り引く
    //   トーン × (toneFloor + (1-toneFloor)×一致度)、語尾 × (endFloor + (1-endFloor)×一致度)
    match:  { envBad: 0.1, envGood: 0.7, toneFloor: 0.4, endFloor: 0.5 },
    minActiveSec: 0.25,          // これより短い声は「声なし」
    minSnrDb: 8,
  };

  // ---------------------------------------------------------------- 小道具
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  // x が bad で 0、good で 1（good < bad でも可）
  const lin = (x, bad, good) => clamp01((x - bad) / (good - bad));
  const db = (v) => 20 * Math.log10(v + 1e-9);

  function percentile(arr, p) {
    if (!arr.length) return NaN;
    const s = Array.from(arr).sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
    return s[i];
  }
  function mean(arr) { let s = 0; for (const v of arr) s += v; return arr.length ? s / arr.length : 0; }
  function median(arr) { return percentile(arr, 0.5); }

  function pearson(a, b) {
    const n = Math.min(a.length, b.length);
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    if (saa < 1e-9 || sbb < 1e-9) return 0;
    return sab / Math.sqrt(saa * sbb);
  }

  // 長さを n 点に引き伸ばす（直線補間）
  function stretch(arr, n) {
    const out = new Float32Array(n);
    const L = arr.length;
    if (!L) return out;
    if (L === 1) { out.fill(arr[0]); return out; }
    for (let i = 0; i < n; i++) {
      const p = (i * (L - 1)) / (n - 1), i0 = Math.floor(p), f = p - i0;
      out[i] = i0 + 1 < L ? arr[i0] * (1 - f) + arr[i0 + 1] * f : arr[L - 1];
    }
    return out;
  }

  function smooth(arr, k) {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) { s += arr[j]; c++; }
      out[i] = s / c;
    }
    return out;
  }

  // 帯の中だけで動的時間伸縮（DTW）し、経路上の平均差を返す
  function dtw(a, b, band) {
    const n = a.length, m = b.length, INF = 1e18;
    let prev = new Float64Array(m + 1).fill(INF), cur = new Float64Array(m + 1);
    let prevLen = new Float64Array(m + 1), curLen = new Float64Array(m + 1);
    prev[0] = 0;
    for (let i = 1; i <= n; i++) {
      cur.fill(INF); curLen.fill(0);
      const c = Math.round((i * m) / n);
      for (let j = Math.max(1, c - band); j <= Math.min(m, c + band); j++) {
        const cost = Math.abs(a[i - 1] - b[j - 1]);
        let best = prev[j - 1], len = prevLen[j - 1];
        if (prev[j] < best) { best = prev[j]; len = prevLen[j]; }
        if (cur[j - 1] < best) { best = cur[j - 1]; len = curLen[j - 1]; }
        cur[j] = best + cost; curLen[j] = len + 1;
      }
      [prev, cur] = [cur, prev]; [prevLen, curLen] = [curLen, prevLen];
    }
    return prevLen[m] ? prev[m] / prevLen[m] : INF;
  }

  // ---------------------------------------------------------------- 前処理
  // 16kHz へ変換（窓関数つき sinc の低域通過をかけてから直線補間）
  function resample(x, srIn, srOut) {
    srOut = srOut || SR;
    if (srIn === srOut) return Float32Array.from(x);
    const ratio = srIn / srOut;
    const outLen = Math.floor(x.length / ratio);
    const out = new Float32Array(outLen);
    if (ratio < 1) {
      for (let j = 0; j < outLen; j++) {
        const p = j * ratio, i0 = Math.floor(p), f = p - i0;
        out[j] = i0 + 1 < x.length ? x[i0] * (1 - f) + x[i0 + 1] * f : x[x.length - 1];
      }
      return out;
    }
    const fc = 0.45 / ratio;
    const taps = 2 * Math.ceil(ratio * 6) + 1, M = (taps - 1) / 2;
    const h = new Float32Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const n = i - M;
      const s = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
      h[i] = s * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
      sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    const L = x.length;
    const filt = (c) => {
      let s = 0;
      for (let k = 0; k < taps; k++) { const i = c + k - M; if (i >= 0 && i < L) s += x[i] * h[k]; }
      return s;
    };
    for (let j = 0; j < outLen; j++) {
      const p = j * ratio, i0 = Math.floor(p), f = p - i0;
      out[j] = f < 1e-6 ? filt(i0) : filt(i0) * (1 - f) + filt(i0 + 1) * f;
    }
    return out;
  }

  // 直流成分と超低域を除く（1次の高域通過）
  function highpass(x) {
    const y = new Float32Array(x.length);
    let px = 0, py = 0;
    const a = 0.995;
    for (let i = 0; i < x.length; i++) { const v = x[i] - px + a * py; px = x[i]; py = v; y[i] = v; }
    return y;
  }

  // YIN 法で1フレームの基本周波数を求める。[f0, 確からしさ]（無声なら f0=0）
  function yin(x, off, d) {
    for (let tau = 1; tau <= TAU_MAX; tau++) {
      let s = 0;
      for (let i = 0; i < YIN_W; i++) { const v = x[off + i] - x[off + i + tau]; s += v * v; }
      d[tau] = s;
    }
    d[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= TAU_MAX; tau++) { run += d[tau]; d[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
    let tau = -1;
    for (let t = TAU_MIN; t <= TAU_MAX; t++) {
      if (d[t] < 0.15) { while (t + 1 <= TAU_MAX && d[t + 1] < d[t]) t++; tau = t; break; }
    }
    if (tau < 0) {
      let mn = Infinity;
      for (let t = TAU_MIN; t <= TAU_MAX; t++) if (d[t] < mn) { mn = d[t]; tau = t; }
      if (mn > 0.35) return [0, 0];
    }
    let better = tau;
    if (tau > TAU_MIN && tau < TAU_MAX) {
      const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a + c - 2 * b;
      if (den !== 0) better = tau + (a - c) / (2 * den);
    }
    return [SR / better, 1 - d[tau]];
  }

  // ---------------------------------------------------------------- 特徴量
  /**
   * @param {Float32Array} samples モノラル音声
   * @param {number} sampleRate
   * @param {{noiseDb?:number}} [opts] noiseDb: 録音前（カウントダウン中）に測った雑音の大きさ
   */
  function analyze(samples, sampleRate, opts) {
    opts = opts || {};
    const x = highpass(resample(samples, sampleRate));
    const nF = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
    const level = new Float32Array(nF), tilt = new Float32Array(nF);
    const f0 = new Float32Array(nF), conf = new Float32Array(nF);

    for (let f = 0; f < nF; f++) {
      const off = f * HOP;
      let e = 0, ed = 0;
      for (let i = 0; i < YIN_W; i++) {
        const v = x[off + i]; e += v * v;
        const dv = v - (i ? x[off + i - 1] : v); ed += dv * dv;
      }
      level[f] = db(Math.sqrt(e / YIN_W));
      tilt[f] = e > 1e-12 ? Math.sqrt(ed / e) : 0;
    }

    const res = { sr: SR, hop: HOP_SEC, n: nF, level, f0, conf, tilt, valid: false };
    if (nF < 5) return res;

    const peakDb = percentile(level, 0.98);
    let noiseDb;
    if (typeof opts.noiseDb === 'number') {
      noiseDb = opts.noiseDb;
      // カウントダウン中に声が入って雑音を高く測りすぎたときは、録音の静かな部分で測り直す
      if (peakDb - noiseDb < 20) noiseDb = Math.min(noiseDb, percentile(level, 0.1));
    } else {
      noiseDb = Math.min(percentile(level, 0.1), peakDb - 40);
    }
    const thr = Math.max(noiseDb + 10, peakDb - 32, -75);
    res.peakDb = peakDb; res.noiseDb = noiseDb; res.thr = thr;

    // 声のある範囲（3フレーム続けて閾値を超えた最初と最後）
    let start = -1, end = -1;
    for (let i = 0; i + 2 < nF; i++) if (level[i] > thr && level[i + 1] > thr && level[i + 2] > thr) { start = i; break; }
    for (let i = nF - 1; i >= 2; i--) if (level[i] > thr && level[i - 1] > thr && level[i - 2] > thr) { end = i; break; }
    if (start < 0 || end <= start) return res;
    res.start = start; res.end = end;
    res.dur = (end - start + 1) * HOP_SEC;

    // 声の高さ（声のある範囲の中で、ある程度の大きさがあるフレームだけ）
    const d = new Float32Array(TAU_MAX + 1);
    for (let f = start; f <= end; f++) {
      if (level[f] < thr - 3) continue;
      const [hz, c] = yin(x, f * HOP, d);
      f0[f] = hz; conf[f] = c;
    }
    cleanPitch(f0, conf, start, end);

    // 半音（中央値=0）の輪郭。無声部分は前後の有声から補間
    const voicedHz = [];
    for (let f = start; f <= end; f++) if (f0[f] > 0) voicedHz.push(f0[f]);
    const len = end - start + 1;
    res.voicedRatio = voicedHz.length / len;
    res.medianHz = voicedHz.length ? median(voicedHz) : 0;
    const st = new Float32Array(len), voiced = new Uint8Array(len);
    if (voicedHz.length) {
      for (let i = 0; i < len; i++) {
        const hz = f0[start + i];
        if (hz > 0) { st[i] = 12 * Math.log2(hz / res.medianHz); voiced[i] = 1; } else st[i] = NaN;
      }
      fillGaps(st);
    }
    res.st = st; res.voiced = voiced;
    const stVoiced = []; for (let i = 0; i < len; i++) if (voiced[i]) stVoiced.push(st[i]);
    res.stRange = stVoiced.length > 5 ? percentile(stVoiced, 0.9) - percentile(stVoiced, 0.1) : 0;

    // 音量の包絡（閾値〜ピークを 0〜1 に）
    const act = level.subarray(start, end + 1);
    const p95 = percentile(act, 0.95);
    res.p95 = p95;
    res.l90 = percentile(act, 0.9);
    const env = new Float32Array(len);
    for (let i = 0; i < len; i++) env[i] = clamp01((act[i] - thr) / Math.max(6, p95 - thr));
    res.env = env;

    // 張りの持続：ピーク近く（-8dB以内）にいる割合
    let near = 0; for (const v of act) if (v >= p95 - 8) near++;
    res.sustain = near / len;

    // 声の明るさ（高域の多さ）：大きさのあるフレームの中央値
    const tl = []; for (let f = start; f <= end; f++) if (level[f] > p95 - 15) tl.push(tilt[f]);
    res.bright = tl.length ? median(tl) : 0;

    // 区切り（無音の切れ目）：高めの閾値で 60ms 以上の谷
    const segThr = Math.max(thr, p95 - 20);
    const gaps = [];
    let g0 = -1;
    for (let i = 0; i < len; i++) {
      const low = act[i] < segThr;
      if (low && g0 < 0) g0 = i;
      if ((!low || i === len - 1) && g0 >= 0) {
        const g1 = low ? i : i - 1;
        if (g0 > 0 && g1 < len - 1 && g1 - g0 + 1 >= 6) gaps.push({ at: (g0 + g1 + 1) / 2 / len, size: g1 - g0 + 1 });
        g0 = -1;
      }
    }
    res.gaps = gaps;

    // 語尾：最後の25%
    const eLen = Math.max(8, Math.round(len * 0.25));
    const eSeg = act.subarray(len - Math.min(eLen, len));
    res.endRel = mean(eSeg) - p95;
    let lastStrong = len - 1;
    for (let i = len - 1; i >= 0; i--) if (act[i] >= p95 - 6) { lastStrong = i; break; }
    res.release = (len - 1 - lastStrong) * HOP_SEC;
    const stEnd = st.subarray(len - Math.min(eLen, len));
    const k = Math.max(2, Math.floor(stEnd.length * 0.3));
    res.endSlope = voicedHz.length ? mean(stEnd.subarray(stEnd.length - k)) - mean(stEnd.subarray(0, k)) : 0;

    res.valid = res.dur >= TUNING.minActiveSec && p95 - noiseDb >= TUNING.minSnrDb && p95 > -70;
    return res;
  }

  // 声の高さの外れ値（倍・半分の誤検出）を直し、孤立点を除く
  function cleanPitch(f0, conf, start, end) {
    for (let f = start; f <= end; f++) if (f0[f] > 0 && conf[f] < 0.5) f0[f] = 0;
    const v = [];
    for (let f = start; f <= end; f++) if (f0[f] > 0) v.push(f0[f]);
    if (v.length < 3) return;
    const med = median(v);
    for (let f = start; f <= end; f++) {
      let hz = f0[f];
      if (!hz) continue;
      while (hz > med * 1.8) hz /= 2;
      while (hz < med / 1.8) hz *= 2;
      f0[f] = hz;
    }
    // 前後どちらにも有声がない1フレームは捨てる
    for (let f = start + 1; f < end; f++) if (f0[f] && !f0[f - 1] && !f0[f + 1]) f0[f] = 0;
    // 5点の中央値フィルタ（有声のみ）
    const copy = Float32Array.from(f0);
    for (let f = start; f <= end; f++) {
      if (!copy[f]) continue;
      const w = [];
      for (let j = Math.max(start, f - 2); j <= Math.min(end, f + 2); j++) if (copy[j]) w.push(copy[j]);
      f0[f] = median(w);
    }
  }

  function fillGaps(a) {
    const n = a.length;
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(a[i])) {
        if (last < 0) for (let j = 0; j < i; j++) a[j] = a[i];
        else for (let j = last + 1; j < i; j++) a[j] = a[last] + ((a[i] - a[last]) * (j - last)) / (i - last);
        last = i;
      }
    }
    if (last < 0) a.fill(0);
    else for (let j = last + 1; j < n; j++) a[j] = a[last];
  }

  // 大きい順に (k-1) 個の切れ目を選び、時刻順に並べる
  function topGaps(gaps, k) {
    return gaps.slice().sort((a, b) => b.size - a.size).slice(0, Math.max(0, k - 1)).map((g) => g.at).sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------- 採点
  /**
   * @param model  analyze() の結果（お手本）
   * @param player analyze() の結果（プレイヤー）
   * @param {{nChunks?:number, calib?:{normalDb:number}, sensDb?:number}} [opts]
   */
  function compare(model, player, opts) {
    opts = opts || {};
    const T = TUNING;
    if (!player.valid) return { valid: false, total: 0, reason: 'novoice', tone: 0, tempo: 0, energy: 0, ending: 0 };
    if (!model.valid) return { valid: false, total: 0, reason: 'nomodel', tone: 0, tempo: 0, energy: 0, ending: 0 };
    const nChunks = opts.nChunks || 1;
    const dt = {};

    // --- テンポ（25）：先に出す（リズムの一致度を他の項目でも使う）
    dt.durRatio = player.dur / model.dur;
    const sDur = lin(Math.abs(Math.log2(dt.durRatio)), T.tempo.durBad, T.tempo.durGood);
    dt.envCorr = pearson(smooth(stretch(model.env, N), 1), smooth(stretch(player.env, N), 1));
    const sEnv = lin(dt.envCorr, T.tempo.envBad, T.tempo.envGood);
    let sSeg = 1;
    if (nChunks > 1) {
      const mB = topGaps(model.gaps, nChunks), pB = topGaps(player.gaps, nChunks);
      let err = 0;
      for (const b of mB) {
        let best = 0.25; // 対応する切れ目が無い＝大きな誤差
        for (const q of pB) best = Math.min(best, Math.abs(q - b));
        err += best;
      }
      dt.segErr = mB.length ? err / mB.length : 0;
      sSeg = mB.length ? lin(dt.segErr, T.tempo.segBad, T.tempo.segGood) : 1;
    }
    const sRhythm = nChunks > 1 ? 0.5 * sEnv + 0.5 * sSeg : sEnv;
    const tempo = T.tempo.w[0] * sDur + T.tempo.w[1] * sRhythm;
    dt.sDur = sDur; dt.sEnv = sEnv; dt.sSeg = sSeg;

    // リズムの一致度（0〜1）。別のセリフや、ただの雄叫びはここが低くなる
    const mEnv = lin(dt.envCorr, T.match.envBad, T.match.envGood);
    const match = nChunks > 1 ? 0.5 * mEnv + 0.3 * sSeg + 0.2 * sDur : 0.7 * mEnv + 0.3 * sDur;
    dt.match = match;

    // --- トーン（30）
    const mSt = smooth(stretch(model.st, N), 2), pSt = smooth(stretch(player.st, N), 2);
    dt.toneDtw = dtw(mSt, pSt, 12);
    dt.toneCorr = pearson(mSt, pSt);
    dt.rangeRatio = model.stRange > 0.5 ? Math.min(player.stRange, model.stRange * 1.6) / Math.max(player.stRange, model.stRange) : (player.stRange < 2 ? 1 : 0.6);
    const sShape = lin(dt.toneDtw, T.tone.shapeBad, T.tone.shapeGood);
    const sCorr = lin(dt.toneCorr, T.tone.corrBad, T.tone.corrGood);
    const sRange = lin(dt.rangeRatio, T.tone.rangeBad, T.tone.rangeGood);
    let tone = T.tone.w[0] * sShape + T.tone.w[1] * sCorr + T.tone.w[2] * sRange;
    if (player.voicedRatio < 0.15) tone *= player.voicedRatio / 0.15; // ささやき・雑音
    tone *= T.match.toneFloor + (1 - T.match.toneFloor) * match;
    dt.sShape = sShape; dt.sCorr = sCorr; dt.sRange = sRange;

    // --- 熱量（30）
    const sens = opts.sensDb || 0;
    const L = player.l90 + sens;
    let sLoud;
    if (opts.calib && typeof opts.calib.normalDb === 'number') {
      dt.overNormal = L - opts.calib.normalDb;
      sLoud = lin(dt.overNormal, T.energy.calBad, T.energy.calGood);
    } else {
      dt.snr = L - player.noiseDb;
      sLoud = 0.5 * lin(L, T.energy.absBad, T.energy.absGood) + 0.5 * lin(dt.snr, T.energy.snrBad, T.energy.snrGood);
    }
    dt.loudDb = L;
    const sSus = player.sustain >= model.sustain ? 1 : lin(model.sustain - player.sustain, T.energy.susBad, T.energy.susGood);
    dt.brightRatio = model.bright > 0 ? player.bright / model.bright : 1;
    const sBright = lin(dt.brightRatio, T.energy.brightBad, T.energy.brightGood);
    const sDyn = lin(dt.envCorr, T.energy.dynBad, T.energy.dynGood);
    // 大きさが土台：小声なら、張りや強弱の形が合っていても熱量は伸びない
    const ew = T.energy.w;
    const rest = (ew[1] * sSus + ew[2] * sBright + ew[3] * sDyn) / (ew[1] + ew[2] + ew[3]);
    const energy = ew[0] * sLoud + (1 - ew[0]) * rest * (0.4 + 0.6 * sLoud);
    dt.sLoud = sLoud; dt.sSus = sSus; dt.sBright = sBright; dt.sDyn = sDyn;

    // --- 語尾（15）
    dt.endDiff = model.endRel - player.endRel; // 正ならプレイヤーの語尾が弱い
    const sStr = lin(dt.endDiff, T.ending.strBad, T.ending.strGood);
    dt.releaseDiff = player.release - model.release;
    const sCrisp = lin(dt.releaseDiff, T.ending.crispBad, T.ending.crispGood);
    dt.slopeDiff = Math.abs(player.endSlope - model.endSlope);
    const sPitch = lin(dt.slopeDiff, T.ending.pitchBad, T.ending.pitchGood);
    let ending = T.ending.w[0] * sStr + T.ending.w[1] * sCrisp + T.ending.w[2] * sPitch;
    ending *= T.match.endFloor + (1 - T.match.endFloor) * match;
    dt.sStr = sStr; dt.sCrisp = sCrisp; dt.sPitch = sPitch;

    const r = {
      valid: true,
      tone: Math.round(tone * 30),
      tempo: Math.round(tempo * 25),
      energy: Math.round(energy * 30),
      ending: Math.round(ending * 15),
      detail: dt,
    };
    r.total = r.tone + r.tempo + r.energy + r.ending;
    r.advice = pickAdvice(r, dt);
    return r;
  }

  function pickAdvice(r, dt) {
    if (r.total >= 92) return 'perfect';
    const ratio = { tone: r.tone / 30, tempo: r.tempo / 25, energy: r.energy / 30, ending: r.ending / 15 };
    const worst = Object.keys(ratio).sort((a, b) => ratio[a] - ratio[b])[0];
    const lowest = (o) => Object.keys(o).sort((a, b) => o[a] - o[b])[0];
    if (worst === 'tone') return dt.sRange < Math.min(dt.sShape, dt.sCorr) && dt.rangeRatio < 0.6 ? 'toneFlat' : 'toneShape';
    if (worst === 'tempo') {
      if (dt.durRatio > 1.2 && dt.sDur < 0.8) return 'tooLong';
      if (dt.durRatio < 0.83 && dt.sDur < 0.8) return 'tooShort';
      return 'rhythm';
    }
    if (worst === 'energy') return { sLoud: 'quiet', sSus: 'sustain', sBright: 'dull' }[lowest({ sLoud: dt.sLoud, sSus: dt.sSus, sBright: dt.sBright })];
    return { sStr: 'endWeak', sCrisp: 'endTrail', sPitch: 'endPitch' }[lowest({ sStr: dt.sStr, sCrisp: dt.sCrisp, sPitch: dt.sPitch })];
  }

  // ---------------------------------------------------------------- 譜面ガイド
  // お手本の「音量の山」「抑揚の線」「区切りの時刻」。お手本の声は聞かせず、これを画面に出す。
  // weights（区切りごとの文字数）があれば、文字数から見込んだ位置に近い谷を優先する。
  // 見込みから大きく外れた谷しかないときは使わない（文字数で按分）。
  function makeGuide(model, nChunks, weights) {
    if (!model || !model.valid) return null;
    const len = model.env.length;
    const st = new Float32Array(len);
    for (let i = 0; i < len; i++) st[i] = model.voiced[i] ? model.st[i] : NaN;
    let bounds = null;
    if (weights && weights.length === nChunks && nChunks > 1) {
      const sum = weights.reduce((a, b) => a + b, 0);
      const picked = [];
      let acc = 0;
      for (let i = 0; i < nChunks - 1; i++) {
        acc += weights[i];
        const exp = acc / sum;
        let best = null, bestScore = 0;
        for (const g of model.gaps) {
          const d = Math.abs(g.at - exp);
          if (d > 0.25 || picked.includes(g)) continue;
          const s = g.size * Math.exp(-((d / 0.2) ** 2));
          if (s > bestScore) { bestScore = s; best = g; }
        }
        if (!best) { picked.length = 0; break; }
        picked.push(best);
      }
      if (picked.length === nChunks - 1) bounds = picked.map((g) => g.at).sort((a, b) => a - b);
    } else {
      bounds = topGaps(model.gaps, nChunks);
      if (bounds.length !== Math.max(0, nChunks - 1)) bounds = null; // 区切りが足りない → 文字数で按分
    }
    return { dur: model.dur, hop: model.hop, env: model.env, st, bounds };
  }

  // お手本音声が無いときの代わり。秒数と区切りの数から「標準的な叫び」の特徴量を作る
  // （本番の音声が届くまで遊べるようにするための保険。採点はゆるめになる）
  function pseudoModel(sec, nChunks, weights) {
    const len = Math.max(20, Math.round(sec / HOP_SEC));
    const k = Math.max(1, nChunks || 1);
    const w = weights && weights.length === k ? weights : new Array(k).fill(1);
    const sum = w.reduce((a, b) => a + b, 0);
    const gap = Math.round(0.12 / HOP_SEC);
    const usable = len - gap * (k - 1);
    const env = new Float32Array(len), st = new Float32Array(len), voiced = new Uint8Array(len);
    const gaps = [];
    let p = 0;
    for (let c = 0; c < k; c++) {
      const n = Math.max(6, Math.round((usable * w[c]) / sum));
      for (let i = 0; i < n && p + i < len; i++) {
        const u = i / n;
        env[p + i] = Math.min(1, u * 8, (1 - u) * 6) * (c === k - 1 ? 1 : 0.85);
        // 句ごとに少し上がってから下がる。最後の句は高く入って落とす
        st[p + i] = c === k - 1 ? 3 - 5 * u : 1.5 * Math.sin(Math.PI * u) - c * 0.8;
        voiced[p + i] = 1;
      }
      p += n;
      if (c < k - 1) { gaps.push({ at: (p + gap / 2) / len, size: gap }); p += gap; }
    }
    fillGaps(st);
    return {
      valid: true, pseudo: true, hop: HOP_SEC, dur: len * HOP_SEC, env, st, voiced,
      stRange: 5, voicedRatio: 0.9, gaps, sustain: 0.55, bright: 0,
      endRel: -2, release: 0.05, endSlope: -3,
    };
  }

  // 周囲の雑音の大きさ（カウントダウン中の録音から測る）。analyze と同じ前処理・同じ窓で中央値をとる
  function noiseFloor(samples, sampleRate) {
    const x = highpass(resample(samples, sampleRate));
    const v = [];
    for (let off = 0; off + YIN_W <= x.length; off += HOP) {
      let e = 0;
      for (let i = 0; i < YIN_W; i++) e += x[off + i] * x[off + i];
      v.push(db(Math.sqrt(e / YIN_W)));
    }
    return v.length ? median(v) : -90;
  }

  // 1フレーム分の音量（ライブ表示用）
  function levelDb(buf) {
    let e = 0;
    for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
    return db(Math.sqrt(e / Math.max(1, buf.length)));
  }

  return { SR, HOP_SEC, TUNING, analyze, compare, makeGuide, pseudoModel, noiseFloor, levelDb, resample, stretch, percentile, pearson, dtw };
});
