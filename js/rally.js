/* クリスマス粉砕！ ― 実戦モード（コール＆レスポンス）
 *
 * 総帥のコール（文字）→ 自分が同じ言葉を叫んで返す、を60秒くり返す。
 * 返した叫びの「熱量」（heat.js）で街のクリスマス残量を削り、0% で完全粉砕。
 *
 * 音の扱い：マイクは60秒のあいだ開けたまま。自分の番（叫ぶ区間）の波形だけを切り出して判定する。
 *   スピーカーの音がマイクに入ると判定が乱れるので、伴奏は総帥の番だけ鳴らし、自分の番の少し前に止める。
 *   伴奏は「街に流れるジングルベル」＋デモ隊の太鼓。ジングルベルは残量が減るほど弱り、粉砕に成功すると止まる。
 * 数値と文章の調整は data.js の RALLY、熱量の調整は heat.js の TUNING。
 */
(function (root) {
  'use strict';
  const D = root.CSData, A = root.CSAnalysis, H = root.CSHeat, S = root.CSStore, Au = root.CSAudio, SFX = root.CSSfx, BGM = root.CSBgm, G = root.CSGame;
  const R = D.RALLY, scene = G.scene, JG = root.CSJingle; // JG：街に流れるジングルベル（sfx.js）
  const $ = (s) => document.querySelector(s);
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  const PRE = 0.15;   // 自分の番の手前から拾う秒数（食い気味に入った声を逃さない）
  const TAIL = 0.35;  // 自分の番のあとも拾う秒数（言い終わりのはみ出し）
  const CUE = 0.35;   // 自分の番の何秒前に伴奏を止めて合図を鳴らすか（合図の音が判定に入らないように）

  for (const c of Object.values(R.calls)) {
    c.morae = H.moraCount(c.yomi);
    c.leadSec = c.lead != null ? c.lead : R.lead;
    c.respSec = c.resp != null ? c.resp : R.resp;
  }

  let run = null; // 進行中のデモ（中断すると null）

  // ================================================================ 場所選び
  function open() { renderSpots(); G.show('rally'); }
  function renderSpots() {
    const ol = $('#rally-spots'); ol.innerHTML = '';
    R.spots.forEach((sp, i) => {
      const best = S.data.rallyBest[sp.id];
      const li = document.createElement('li');
      li.innerHTML = `<button class="stage-card ${sp.ready ? '' : 'locked'}">
        <span class="num"><small>SPOT</small>${i + 1}</span>
        <span><h3>${G.esc(sp.name)}</h3><p>${G.esc(sp.sub)}${sp.ready ? '' : '　準備中'}</p></span>
        <span class="best">${best ? `ベスト<b>${best.score}</b><span class="stamp${best.rate >= 100 ? ' perfect' : ''}">粉砕率 ${best.rate}%</span>` : ''}</span>
      </button>`;
      li.firstElementChild.onclick = () => {
        SFX.tap();
        if (!sp.ready) { G.toast('この場所は準備中（背景の素材待ち）'); return; }
        play(sp.id);
      };
      ol.appendChild(li);
    });
  }

  // ================================================================ 画面の部品
  function pop(main, sub) {
    const p = $('#rally-pop');
    p.innerHTML = `<b>${G.esc(main)}</b>${sub ? `<span>${G.esc(sub)}</span>` : ''}`;
    p.classList.remove('show'); void p.offsetWidth;
    p.classList.add('show', 'small');
  }
  function clearPop() { const p = $('#rally-pop'); p.classList.remove('show'); p.innerHTML = ''; }
  function showGauge(my) {
    $('#rally-gauge-bar').style.width = my.gauge.toFixed(1) + '%';
    $('#rally-gauge-num').textContent = Math.ceil(my.gauge) + '%';
    $('#rally-score').textContent = my.score;
    $('#rally-combo').textContent = my.combo >= 2 ? `${my.combo}連続！ ×${(1 + R.comboStep * Math.min(my.combo, R.comboMax)).toFixed(1)}` : '';
  }
  function showLead(call, i, n) {
    $('#rally-no').textContent = `コール ${i + 1}/${n}`;
    const lead = $('#rally-lead');
    lead.classList.remove('dim'); lead.classList.add('on');
    $('#rally-lead-face').src = 'assets/ren_call.png'; // 拡声器で叫ぶ総帥
    $('#rally-lead-text').textContent = call.leadText || call.text;
    $('#rally-panel').classList.remove('resp');
    $('#rally-phase').textContent = call.final ? '締めだ。構えろ…' : '総帥のコール… 続けて叫べ';
    $('#rally-text').textContent = call.text;
  }
  function showResp() {
    $('#rally-lead').classList.add('dim');
    $('#rally-lead-face').src = 'assets/ren_call_fist.png'; // 拳を上げて「続け！」
    $('#rally-panel').classList.add('resp');
    $('#rally-phase').textContent = '叫べ！';
  }

  // 残量に合わせて街を変える：電飾 → フォトスポット → ツリーの順に消え、カップルは少しずつ帰る
  function applyGauge(my, hit) {
    const g = my.gauge;
    const lv = { street: clamp01((g - 60) / 40), couple: clamp01((g - 30) / 30), tree: clamp01(g / 30) };
    for (const k of Object.keys(lv)) {
      const z = scene.zones[k];
      if (lv[k] <= 0) { if (!my.out[k]) { my.out[k] = true; scene.lightsOut(k, true); SFX.zap(); } }
      else { my.out[k] = false; z.target = lv[k]; if (hit && lv[k] < 1) z.flick = 0.5; }
    }
    // 飾りは、残量が等間隔の境目を下回るたびに、並びの順に1つずつ消える（8つなら約11%ごと）
    const nd = scene.decos.length;
    scene.decos.forEach((d, i) => {
      const gone = g < 100 - ((i + 1) * 100) / (nd + 1);
      if (gone && !d.out) SFX.tick();
      scene.decoOut(i, gone);
    });
    const cs = scene.L.couples, keep = Math.ceil(cs.length * clamp01((g - 15) / 80));
    cs.forEach((c, i) => { c.leave = i < cs.length - keep; }); // 奥の組から帰る
  }

  // 録音中の波形から [a, b) を取り出す（サンプル番号）
  function sliceCapture(a, b) {
    const out = new Float32Array(Math.max(0, b - a));
    let pos = 0;
    for (const c of Au.chunks) {
      const end = pos + c.length;
      if (end > a && pos < b) { const s = Math.max(a, pos), e = Math.min(b, end); out.set(c.subarray(s - pos, e - pos), s - a); }
      pos = end;
      if (pos >= b) break;
    }
    return out;
  }

  // ================================================================ 時計と一時停止
  // デモの中の時刻は clock() で測る（一時停止のあいだは進まない）。t0・区間の開始と終了は、すべてこの時刻。
  const clock = (my) => (my.paused ? my.pauseAt : performance.now()) - my.pauseTotal;
  // 時刻 t まで待つ。途中で一時停止 → 再開されたら、すぐ戻る（呼び出し元が、そのコールを頭からやり直す）
  async function until(my, t) {
    const epoch = my.pauses;
    for (;;) {
      while (my.paused) await G.sleepA(80);
      if (my.pauses !== epoch) return;
      const d = t - clock(my);
      if (d <= 0) return;
      await G.sleepA(Math.min(d, 60));
    }
  }
  function pauseUi(running, paused) {
    $('#btn-rally-quit').hidden = running;
    $('#btn-rally-pause').hidden = !running;
    $('#rally-paused').hidden = !paused;
  }
  // 一時停止する。止められたら（すでに止まっている場合も）true。開始前・決着後は false
  // マイクは閉じる（止めているあいだは録らない）。伴奏も止める
  function pause() {
    const my = run;
    if (!my || my.done || !my.t0) return false;
    if (my.paused) return true;
    my.paused = true; my.pauseAt = performance.now();
    BGM.stop(0.1); JG.pause(0.1); Au.closeMic(); scene.voice = 0;
    $('#rally-meter').style.width = '0%';
    pauseUi(true, true);
    return true;
  }
  // 再開する。マイクを開き直し、いまのコールを総帥の番からやり直す（時計もコールの頭まで戻す）
  async function resume() {
    const my = run;
    if (!my || !my.paused || my.resuming) return;
    my.resuming = true;
    try {
      await Au.openMic();
    } catch (e) {
      my.resuming = false;
      await G.micError(e); // 止まったまま。もう一度「再開する」か「やめる」を選べる
      return;
    }
    my.resuming = false;
    if (run !== my || my.done) { Au.closeMic(); return; }
    Au.startCapture();
    my.pauseTotal = performance.now() - my.callStart;
    my.pauses++; my.paused = false;
    pauseUi(true, false);
  }

  // ================================================================ 1コールの判定
  function judge(my, { call, mark }) {
    const sr = Au.sampleRate;
    const a = Math.max(0, mark - Math.round(sr * PRE));
    const b = Math.min(Au.mark(), mark + Math.round(sr * (call.respSec + TAIL)));
    const feat = A.analyze(sliceCapture(a, b), sr, { noiseDb: my.noiseDb });
    const onsetSec = feat.valid ? Math.max(0, feat.start * A.HOP_SEC - (mark - a) / sr) : undefined;
    const h = H.heat(feat, { calib: S.data.calib, sensDb: S.data.sensDb, onsetSec, morae: call.morae });

    const mult = (1 + R.comboStep * Math.min(my.combo, R.comboMax)) * (call.final ? R.finalBonus : 1);
    const before = my.gauge;
    const pushed = !h.valid || h.heat < R.pushHeat;
    if (pushed) { my.gauge = Math.min(100, my.gauge + R.regrow); my.combo = 0; }
    else {
      my.gauge = Math.max(0, my.gauge - h.heat * R.dmg * mult);
      my.combo = h.heat >= R.comboHeat ? my.combo + 1 : 0;
      my.maxCombo = Math.max(my.maxCombo, my.combo);
    }
    const pts = Math.round(h.heat * mult) * 10;
    my.score += pts;
    const delta = my.gauge - before;
    my.log.push({ call, heat: h.heat, parts: h.parts, weak: h.weak, valid: h.valid, pushed, delta, pts });

    // 演出
    const label = !h.valid ? '声が聞こえん！' : pushed ? '押し返された…' : h.heat >= 85 ? '完全燃焼！' : h.heat >= R.comboHeat ? 'いいぞ！' : 'まだ足りん！';
    const sub = `熱量 ${h.heat}　残量 ${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(0)}%${h.weak === 'great' ? '' : '　' + R.hints[h.weak]}`;
    pop(label, sub);
    if (pushed) { scene.loveTarget = Math.min(2, scene.loveTarget + 0.4); SFX.sparkle(); G.vibrate(50); }
    else {
      scene.loveTarget = 1; scene.shake = Math.max(scene.shake, 0.15 + 0.3 * (h.heat / 100));
      if (h.heat >= R.comboHeat) scene.shockT = 1.6;
      SFX.stamp(); G.vibrate(h.heat >= R.comboHeat ? [30, 40, 60] : 40);
      if (h.heat >= 85) G.flash(0.35);
    }
    applyGauge(my, !pushed);
    showGauge(my);
    JG.setMood(my.gauge / 100); // 街のジングルベルも、残量に合わせて弱る
  }

  // ================================================================ 本番
  async function play(spotId) {
    G.abortFlow();
    const spot = R.spots.find((s) => s.id === spotId);
    const calls = spot.calls.map((id) => R.calls[id]);
    const total = calls.reduce((s, c) => s + c.leadSec + c.respSec, 0);
    const my = run = { spot, gauge: 100, combo: 0, maxCombo: 0, score: 0, log: [], out: {}, phase: null, t0: 0, total, noiseDb: -60, done: false,
      paused: false, pauseAt: 0, pauseTotal: 0, pauses: 0, callStart: 0, resuming: false };
    pauseUi(false, false);
    await G.unlockAudio();
    // 街の作り（ツリーの高さ・カップルの数・空の色）はステージモードのステージから借りる。場所ごとの背景（spot.bg）があれば差し替える
    scene.setStage(Object.assign({}, D.STAGES[spot.stage - 1], { tree: R.tree, couples: R.coupleSpots.length, coupleSpots: R.coupleSpots },
      spot.scene || {}, spot.bg ? { bg: spot.bg } : {}));
    scene.setDecos(R.decos);   // 広場の飾り（残量が減るごとに1つずつ消える）
    scene.preloadPose('back'); // 帰っていく後ろ姿の絵を先に読んでおく
    for (const f of ['ren_call', 'ren_call_fist']) { const im = new Image(); im.src = `assets/${f}.png`; }
    scene.setFocus(null);
    G.hideBanner(); clearPop(); $('#haze').classList.remove('on');
    $('#rally-spot').textContent = spot.name; $('#rally-sub').textContent = '実戦モード　' + spot.sub;
    $('#rally-time').textContent = Math.round(total); $('.rally-time').classList.remove('hurry');
    $('#rally-no').textContent = `全${calls.length}コール`;
    $('#rally-lead').classList.remove('on', 'dim');
    const panel = $('#rally-panel'), start = $('#btn-rally-start');
    panel.classList.remove('resp'); panel.classList.add('idle');
    $('#rally-phase').textContent = '総帥に続いて、同じ言葉を叫べ';
    $('#rally-text').textContent = '';
    $('#rally-prog-bar').style.width = '0%'; $('#rally-meter').style.width = '0%';
    start.hidden = false;
    showGauge(my);
    G.show('rally-play');
    BGM.stop(0.3); JG.reset();
    try {
      await G.maybeAskCalib();
      await G.waitClick(start);
      SFX.tap();
      start.hidden = true;
      try { await Au.openMic(); } catch (e) { await G.micError(e); if (run === my) quit(); return; }
      if (run !== my) return;
      Au.startCapture();
      panel.classList.remove('idle');
      // カウントダウン（この間に周りの音を測る）
      $('#rally-phase').textContent = '構えろ…';
      for (const n of [3, 2, 1]) { pop(String(n)); SFX.beep(false); await G.sleepA(700); }
      const sr = Au.sampleRate;
      my.noiseDb = A.noiseFloor(sliceCapture(Math.round(sr * 0.35), Au.mark()), sr);
      clearPop();

      my.t0 = performance.now();
      let tPhase = my.t0, prev = null;
      pauseUi(true, false);
      ticker(my);
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i], epoch = my.pauses;
        my.callStart = tPhase; // 一時停止から再開したら、ここ（このコールの頭）へ戻る
        // --- 総帥の番
        showLead(call, i, calls.length);
        my.phase = { type: 'lead', start: tPhase, end: tPhase + call.leadSec * 1000 };
        JG.play(my.gauge / 100, true); // 街のジングルベル＋デモ隊の太鼓
        // 前のコールの判定（言い終わりのはみ出しを待ってから）
        if (prev) { await G.sleepA(TAIL * 1000); judge(my, prev); prev = null; if (my.gauge <= 0) break; }
        await until(my, my.phase.end - CUE * 1000);
        if (my.pauses !== epoch) { i--; continue; }
        JG.pause(0.12); SFX.beep(true);
        await until(my, my.phase.end);
        if (my.pauses !== epoch) { i--; continue; }
        // --- 自分の番
        const mark = Au.mark();
        showResp();
        my.phase = { type: 'resp', start: my.phase.end, end: my.phase.end + call.respSec * 1000 };
        await until(my, my.phase.end);
        if (my.pauses !== epoch) { i--; continue; }
        tPhase = my.phase.end;
        prev = { call, mark };
      }
      my.phase = null;
      if (prev) { await G.sleepA(TAIL * 1000); judge(my, prev); }
      await finale(my, Math.max(0, total - (clock(my) - my.t0) / 1000));
    } catch (e) {
      if (!G.isAbort(e)) throw e;
    } finally {
      my.done = true;
      if (run === my || !run) { Au.closeMic(); scene.voice = 0; }
    }
  }

  // 残り時間・区間の進み・声の大きさの表示（毎フレーム）
  function ticker(my) {
    const tick = () => {
      if (run !== my || my.done) return;
      const now = clock(my);
      const left = Math.max(0, my.total - (now - my.t0) / 1000);
      $('#rally-time').textContent = Math.ceil(left);
      $('.rally-time').classList.toggle('hurry', left <= 10);
      const ph = my.phase;
      let v = 0;
      if (ph) {
        const u = clamp01((now - ph.start) / (ph.end - ph.start));
        $('#rally-prog-bar').style.width = ((ph.type === 'resp' ? 1 - u : u) * 100).toFixed(1) + '%';
        if (ph.type === 'resp' && !my.paused) v = clamp01((Au.liveLevel() - (my.noiseDb + 10)) / 34);
      }
      scene.voice = v;
      $('#rally-meter').style.width = (v * 100).toFixed(0) + '%';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ================================================================ 決着
  async function finale(my, leftSec) {
    my.done = true; my.paused = false;
    pauseUi(false, false);
    scene.voice = 0; BGM.stop(0.3); Au.closeMic();
    $('#rally-lead').classList.remove('on');
    $('#rally-panel').classList.remove('resp');
    $('#rally-phase').textContent = 'そこまで！';
    $('#rally-text').textContent = ''; $('#rally-prog-bar').style.width = '0%'; $('#rally-meter').style.width = '0%';
    const complete = my.gauge <= 0, rate = Math.round(100 - my.gauge), success = complete || rate >= 70;
    if (complete) my.score += R.clearBonus + Math.round(leftSec) * R.secBonus;
    BGM.jingleOff = success; // 成功したら、メニューのジングルベルも止まったままになる（届かなければ、また流れる）
    // 街のジングルベルは、太鼓なしでまだ流れている。粉砕に成功すると止まり、届かなければ鳴り続ける
    // （成功のときは、止まるのが分かるように少し大きめに鳴らしておく）
    JG.play(success ? Math.max(0.6, my.gauge / 100) : rate >= 40 ? Math.max(0.5, my.gauge / 100) : 1, false);
    await G.sleepA(700);
    clearPop();
    if (complete) {
      scene.allOut();
      await G.sleepA(500);
      const fall = scene.collapseTree();
      await G.sleepA(900);
      JG.stopTape(); // ツリーが倒れるのに合わせて、ジングルベルが止まる
      await Promise.race([fall, G.sleepA(1900)]);
      scene.celebrate(); SFX.chant(); SFX.fanfare(); G.flash(0.5);
      G.banner('完全粉砕！', '聖夜は、俺たちのものだ！');
    } else if (success) {
      JG.stopTape();
      await G.sleepA(1900);
      SFX.fanfare();
      G.banner('粉砕成功！', `粉砕率 ${rate}%`);
    } else if (rate >= 40) {
      SFX.fail();
      G.banner('あと一歩…', `粉砕率 ${rate}%`, true);
    } else {
      scene.sparkleAll(); scene.L.couples.forEach((c) => { c.leave = false; });
      scene.decos.forEach((d, i) => scene.decoOut(i, false)); // 飾りも戻ってくる
      $('#haze').classList.add('on'); SFX.sparkle(); SFX.fail();
      G.banner('粉砕失敗…', 'やっぱり、恋は強い。', true);
    }
    await G.sleepA(2800);
    G.hideBanner();
    JG.pause(1.2); // 届かなかったときは、結果の画面に移るところで消える
    showResult(my, complete, rate);
  }

  function showResult(my, complete, rate) {
    const spot = my.spot;
    const isNew = S.recordRally(spot.id, my.score, rate);
    $('#rr-spot').textContent = `実戦モード　${spot.name}`;
    const t = $('#rr-title');
    t.textContent = complete ? '完全粉砕！' : rate >= 70 ? '粉砕成功！' : rate >= 40 ? 'あと一歩…' : '粉砕失敗…';
    t.className = 'sr-title ' + (rate >= 70 ? 'win' : 'lose');
    $('#rr-rate').textContent = rate;
    $('#rr-new').hidden = !isNew;
    const pc = (v) => Math.round(v * 100);
    $('#rr-calls').innerHTML = my.log.map((l) => {
      const detail = l.valid ? R.parts.map(([k, name]) => `${name}${pc(l.parts[k])}`).join(' ') : '声なし';
      const tag = l.pushed ? `<i class="push">+${Math.abs(l.delta).toFixed(0)}%</i>` : `<i class="ok">−${Math.abs(l.delta).toFixed(0)}%</i>`;
      return `<li><span>${G.esc(l.call.text)}<small>${detail}</small></span>${tag}<b>${l.heat}</b></li>`;
    }).join('');
    const avg = my.log.length ? Math.round(my.log.reduce((s, l) => s + l.heat, 0) / my.log.length) : 0;
    $('#rr-score').textContent = my.score; $('#rr-avg').textContent = avg; $('#rr-combo').textContent = my.maxCombo;
    // 総帥のひと言：いちばん多かった弱点
    const count = {};
    for (const l of my.log) if (l.weak !== 'great') count[l.weak] = (count[l.weak] || 0) + 1;
    const worst = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    $('#rr-advice').textContent = complete ? '完全粉砕だ。……浅野、お前を誇りに思う。' : worst ? R.hints[worst] : 'その調子だ。次は完全粉砕を狙え。';
    $('#btn-rr-retry').onclick = () => { SFX.tap(); play(spot.id); };
    $('#btn-rr-list').onclick = () => { SFX.tap(); leave(); open(); BGM.play('title'); };
    $('#btn-rr-title').onclick = () => { SFX.tap(); leave(); G.show('title'); BGM.play('title'); };
    G.show('rally-result');
  }

  // 街を元に戻す
  function leave() {
    pauseUi(false, false); JG.reset();
    G.hideBanner(); clearPop(); $('#haze').classList.remove('on');
    scene.reset(true); scene.voice = 0;
    scene.L.couples.forEach((c) => { c.leave = false; c.alpha = 1; c.drift = 0; });
    scene.decos.forEach((d) => { d.out = false; d.t = 0; });
  }
  // 中断して場所選びへ
  function quit() {
    run = null;
    G.abortFlow(); Au.closeMic(); BGM.stop(0.1);
    leave(); open(); BGM.play('title');
  }
  $('#btn-rally-quit').onclick = () => { SFX.tap(); quit(); };
  $('#btn-rally-pause').onclick = () => { pause(); };
  $('#btn-rally-resume').onclick = () => { resume(); };
  $('#btn-rally-pquit').onclick = () => { quit(); };
  $('#btn-rally-prestart').onclick = () => { if (run) play(run.spot.id); };

  root.CSRally = { open, play, quit, pause, resume, get state() { return run; } };
})(window);
