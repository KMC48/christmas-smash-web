/* クリスマス粉砕！ ― 熱量の判定（実戦モード用）
 *
 * お手本と比べるのではなく、叫びそのものの「熱」を 0〜100 で出す。
 * analysis.js の analyze() が出した特徴量をそのまま使う（ブラウザでも Node のテストでも動く）。
 *
 *   heat(player, {calib, sensDb, onsetSec, morae}) → { valid, heat, parts, gate, weak, detail }
 *
 * 大きさだけでは決まらない。5つの要素を見る：
 *   声量   loud    普段の声との差（マイク調整済み）／周りの音との差と絶対値（未調整）。ステージモード・訓練の「熱量」と同じ式
 *   張り   bright  高い成分の多さ。本気で叫ぶと増え、マイクとの距離に左右されにくい
 *   持続   sustain ピーク近くの大きさを保てた割合（途中で息切れしていないか）
 *   語尾   end     最後の4分の1の強さと、切れの速さ
 *   入り   onset   総帥のコールが終わってから、すぐ返せたか
 * そのうえで「声らしさ」と「長さ」で足切りする（雑音・手拍子・一瞬の「あっ」では熱量が出ない）。
 * 声量が土台：小声なら、ほかの要素が良くても伸びない（ステージモード・訓練と同じ考え方）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./analysis.js'));
  else root.CSHeat = factory(root.CSAnalysis);
})(typeof self !== 'undefined' ? self : this, function (A) {
  'use strict';

  // 調整値。bad で 0、good で 1（その間は直線）。実際の叫び声で試しながら詰める。
  // 目安にした実測：デモの叫び（拡声器）は 張り0.32〜0.47・持続0.37〜0.68・語尾-3〜-12dB・声らしさ0.48〜0.78、
  //                読み上げ音声（普通の話し声）は 張り0.12〜0.28・持続0.26〜0.46・語尾-10〜-19dB。雑音の張りは約1.4。
  const TUNING = {
    brightBad: 0.18, brightGood: 0.40,        // 張り（絶対値）
    brightRelBad: 1.05, brightRelGood: 1.7,   // 張り（マイク調整で測った普段の声との比）
    noiseBright: [0.95, 1.3],                 // これより明るいのは声ではなく雑音（0.95 から割り引き、1.3 で 0）
    susBad: 0.25, susGood: 0.5,               // 持続
    endBad: -16, endGood: -7,                 // 語尾の強さ（dB、ピーク比）
    relBad: 0.5, relGood: 0.1,                // 語尾の切れ（秒）
    onsetBad: 1.4, onsetGood: 0.5,            // 入り（秒）
    voicedBad: 0.08, voicedGood: 0.3,         // 声らしさ（声の高さが取れたフレームの割合）
    moraSec: 0.13,                            // 1拍の長さの見込み（速めの叫び）
    lenBad: 0.35, lenGood: 0.7,               // 長さ（見込みに対する比）
    wLoud: 0.4,                               // 声量の重み（残りは下の rest）
    rest: { bright: 0.4, sustain: 0.2, end: 0.25, onset: 0.15 },
    restFloor: 0.4,                           // 声量が 0 のとき、rest が効く割合
  };

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lin = (x, bad, good) => clamp01((x - bad) / (good - bad));

  // よみの拍数（小さい「ゃゅょぁぃぅぇぉ」は前の字と合わせて1拍。「っ」「ー」「ん」は1拍）
  function moraCount(yomi) {
    let n = 0;
    for (const ch of String(yomi || '')) {
      if (/[ゃゅょぁぃぅぇぉャュョァィゥェォ]/.test(ch)) continue;
      if (/[ぁ-ゖァ-ヺー]/.test(ch)) n++;
    }
    return n;
  }

  /**
   * @param p    analyze() の結果（自分の叫び）
   * @param {{calib?:{normalDb:number, bright?:number}, sensDb?:number, onsetSec?:number, morae?:number}} [opts]
   *   onsetSec: 「叫べ！」から声が始まるまでの秒数。morae: コールの拍数
   */
  function heat(p, opts) {
    opts = opts || {};
    const T = TUNING, E = A.TUNING.energy;
    if (!p || !p.valid) return { valid: false, heat: 0, parts: { loud: 0, bright: 0, sustain: 0, end: 0, onset: 0 }, gate: { voice: 0, length: 0 }, weak: 'novoice', detail: {} };
    const dt = {};

    // --- 声量（ステージモード・訓練の「熱量」と同じ式）
    const L = p.l90 + (opts.sensDb || 0);
    let loud;
    if (opts.calib && typeof opts.calib.normalDb === 'number') {
      dt.overNormal = L - opts.calib.normalDb;
      loud = lin(dt.overNormal, E.calBad, E.calGood);
    } else {
      dt.snr = L - p.noiseDb;
      loud = 0.5 * lin(L, E.absBad, E.absGood) + 0.5 * lin(dt.snr, E.snrBad, E.snrGood);
    }
    dt.loudDb = L;

    // --- 張り
    dt.bright = p.bright;
    let bright = lin(p.bright, T.brightBad, T.brightGood);
    if (opts.calib && opts.calib.bright > 0.02) {
      dt.brightRel = p.bright / opts.calib.bright;
      bright = 0.5 * bright + 0.5 * lin(dt.brightRel, T.brightRelBad, T.brightRelGood);
    }

    // --- 持続・語尾・入り
    dt.sustain = p.sustain;
    const sustain = lin(p.sustain, T.susBad, T.susGood);
    dt.endRel = p.endRel; dt.release = p.release;
    const end = 0.6 * lin(p.endRel, T.endBad, T.endGood) + 0.4 * lin(p.release, T.relBad, T.relGood);
    dt.onsetSec = opts.onsetSec;
    const onset = typeof opts.onsetSec === 'number' ? lin(opts.onsetSec, T.onsetBad, T.onsetGood) : 1;

    // --- 足切り：声らしさ（雑音・手拍子を外す）と長さ（一瞬の声を外す）
    dt.voicedRatio = p.voicedRatio;
    const voice = lin(p.voicedRatio, T.voicedBad, T.voicedGood) * lin(p.bright, T.noiseBright[1], T.noiseBright[0]);
    let length = 1;
    if (opts.morae > 0) {
      dt.lenRatio = p.dur / (opts.morae * T.moraSec);
      length = lin(dt.lenRatio, T.lenBad, T.lenGood);
    }

    const w = T.rest;
    const rest = w.bright * bright + w.sustain * sustain + w.end * end + w.onset * onset;
    const raw = T.wLoud * loud + (1 - T.wLoud) * rest * (T.restFloor + (1 - T.restFloor) * loud);
    const value = Math.round(100 * raw * voice * length);

    const parts = { loud, bright, sustain, end, onset };
    let weak;
    if (voice < 0.5) weak = 'noword';
    else if (length < 0.6) weak = 'short';
    else {
      const lowest = Object.keys(parts).sort((a, b) => parts[a] - parts[b])[0];
      // 高得点でも、はっきり弱い要素が1つあれば、それを伝える（熱いが返しが遅い、など）
      weak = value >= 85 && parts[lowest] >= 0.5 ? 'great' : lowest;
    }
    return { valid: true, heat: value, parts, gate: { voice, length }, weak, detail: dt };
  }

  return { TUNING, heat, moraCount };
});
