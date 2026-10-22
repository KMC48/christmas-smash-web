/* クリスマス粉砕！ ― 画面の流れ
 * 1コールのサイクル：構える（コールと譜面を見る）→ 叫ぶ → 採点 → 街が変わる
 * お手本の声はアプリでは一切流さない（実際の音声は入れず、特徴量だけを採点の基準と譜面ガイドに使う）。
 */
(function (root) {
  'use strict';
  const D = root.CSData, A = root.CSAnalysis, S = root.CSStore, Au = root.CSAudio, SFX = root.CSSfx, BGM = root.CSBgm;
  const VERSION = 'v0.1.0（企画検討版）';
  const TRAIN_PASS = 70;
  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const DEV = /[?&]dev=1/.test(location.search) || (() => { try { return localStorage.getItem('xmas-smash.dev') === '1'; } catch (e) { return false; } })();
  const scene = new root.CSScene($('#scene'));
  const guide = new root.CSGuide($('#guide'), $('#call-text'));
  const CapApp = root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.App;

  // ================================================================ 中断できる待ち
  class Abort extends Error {}
  const pending = new Set();
  let flowId = 0;
  function abortFlow() { flowId++; for (const p of [...pending]) p(); }
  function sleepA(ms) {
    return new Promise((resolve, reject) => {
      const e = () => { clearTimeout(t); pending.delete(e); reject(new Abort()); };
      const t = setTimeout(() => { pending.delete(e); resolve(); }, ms);
      pending.add(e);
    });
  }
  function waitClick(...els) {
    return new Promise((resolve, reject) => {
      const hs = [];
      const done = (v, err) => { hs.forEach(([el, h]) => el.removeEventListener('click', h)); pending.delete(e); err ? reject(err) : resolve(v); };
      const e = () => done(null, new Abort());
      els.forEach((el) => { const h = () => done(el); el.addEventListener('click', h); hs.push([el, h]); });
      pending.add(e);
    });
  }
  const isAbort = (e) => e instanceof Abort;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function vibrate(p) { try { if (S.data.vib && navigator.vibrate) navigator.vibrate(p); } catch (e) { /* 非対応 */ } }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ================================================================ 画面
  let current = 'title';
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === 'scr-' + id));
    current = id;
    app.dataset.view = $('#scr-' + id).dataset.view;
    requestAnimationFrame(() => { updateView(); if (id === 'play') guide.resize(); });
  }
  function updateView() {
    const v = app.dataset.view, H = scene.H;
    if (v === 'play') {
      const panel = $('#panel');
      if (panel.classList.contains('away')) scene.setViewBottom(H - 10);
      else {
        const pr = panel.getBoundingClientRect(), ar = app.getBoundingClientRect();
        const vb = (pr.top - ar.top) / scene.scale + 26;
        scene.setViewBottom(vb);
        if ($('#result').hidden) scene.fitVb = vb; // ツリーの大きさはこの画面に合わせる
      }
    } else if (v === 'full') scene.setViewBottom(H - 10);
    else scene.setViewBottom(H * 0.86);
  }
  function resize() {
    const w = app.clientWidth, h = app.clientHeight;
    app.style.setProperty('--u', (w / 540) + 'px');
    scene.resize(w, h);
    guide.resize();
    updateView();
    scene.vb = scene.vbTarget;
  }
  root.addEventListener('resize', resize);

  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms || 2200);
  }
  // 確認ダイアログ。buttons: [[ラベル, 値, main?], ...]
  function modal(text, buttons) {
    return new Promise((resolve) => {
      const m = $('#modal'), box = $('#modal-btns');
      $('#modal-text').textContent = text;
      box.innerHTML = '';
      (buttons || [['OK', true, true]]).forEach(([label, val, main]) => {
        const b = document.createElement('button');
        b.className = 'btn ' + (main ? 'btn-main' : 'btn-sub'); b.textContent = label;
        b.onclick = () => { m.hidden = true; modal.close = null; resolve(val); };
        box.appendChild(b);
      });
      modal.close = () => { m.hidden = true; modal.close = null; resolve(undefined); };
      m.hidden = false;
    });
  }
  function pop(main, sub, small) {
    const p = $('#pop');
    p.innerHTML = `<b>${esc(main)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`;
    p.classList.remove('show'); void p.offsetWidth;
    p.classList.toggle('small', !!small);
    p.classList.add('show');
  }
  function clearPop() { $('#pop').classList.remove('show'); $('#pop').innerHTML = ''; }
  function banner(main, sub, lose) {
    const b = $('#banner');
    $('#banner-main').textContent = main; $('#banner-sub').textContent = sub || '';
    b.classList.toggle('lose', !!lose);
    b.hidden = false;
    // アニメーションをやり直す
    const m = $('#banner-main'); m.style.animation = 'none'; void m.offsetWidth; m.style.animation = '';
  }
  function hideBanner() { $('#banner').hidden = true; }
  function flash(a) { const f = $('#flash'); f.style.transition = 'none'; f.style.opacity = a || 0.8; void f.offsetWidth; f.style.transition = 'opacity .5s'; f.style.opacity = 0; }
  function shakeApp() { app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake'); }

  // ================================================================ 会話
  // 表情差分（assets/face_<名前>_<表情>.jpg）があれば使い、無ければ通常の顔に戻す
  function setFace(img, who, expr) {
    const base = D.CHARS[who].face;
    img.onerror = () => { img.onerror = null; img.src = base; };
    img.src = expr ? `assets/face_${who}_${expr}.jpg` : base;
  }
  async function talk(lines) {
    const box = $('#talk');
    let skipped = false, tapped = null;
    const onTap = () => { if (tapped) tapped(); };
    const onSkip = (e) => { e.stopPropagation(); skipped = true; if (tapped) tapped(); };
    box.addEventListener('click', onTap);
    $('#talk-skip').addEventListener('click', onSkip);
    const waitTap = () => new Promise((resolve, reject) => {
      const e = () => { pending.delete(e); tapped = null; reject(new Abort()); };
      tapped = () => { pending.delete(e); tapped = null; resolve(); };
      pending.add(e);
    });
    box.hidden = false;
    try {
      for (const [who, text, expr] of lines) {
        if (skipped) break;
        const c = D.CHARS[who];
        $('#talk-box').style.setProperty('--who', c.color);
        setFace($('#talk-face'), who, expr);
        $('#talk-name').textContent = c.name;
        $('#talk-role').textContent = c.role;
        const el = $('#talk-text');
        let i = 0, full = false;
        const timer = setInterval(() => { i++; el.textContent = text.slice(0, i); if (i >= text.length) { clearInterval(timer); full = true; } }, 32);
        el.textContent = '';
        await waitTap();
        if (!full) { clearInterval(timer); el.textContent = text; if (!skipped) await waitTap(); }
        SFX.tap();
      }
    } finally {
      box.hidden = true;
      box.removeEventListener('click', onTap);
      $('#talk-skip').removeEventListener('click', onSkip);
    }
  }

  // ================================================================ タイトル・メニュー
  async function unlockAudio() {
    await Au.ensure();
    Au.setVolume('bgm', S.data.bgm * 0.5);
    Au.setVolume('se', S.data.se);
    Au.setVolume('voice', 1);
  }
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', async () => {
    await unlockAudio(); SFX.tap();
    const go = b.dataset.go;
    if (go === 'stages') { renderStages(); show('stages'); }
    else if (go === 'train') { renderTrain(); show('train'); }
    else if (go === 'ranking') { renderRanking('runs'); show('ranking'); }
    else if (go === 'howto') { show('howto'); }
    else if (go === 'settings') { renderSettings(); show('settings'); }
    if (current !== 'title') { setMenuScene(); BGM.play('title'); }
  }));
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => { SFX.tap(); goBack(); }));
  function goBack() {
    if (current === 'calib') { abortFlow(); Au.closeMic(); calibDone(); return; }
    if (['stages', 'train', 'ranking', 'howto', 'settings'].includes(current)) { show('title'); BGM.play('title'); }
  }
  function setMenuScene() {
    if (!scene.stage) scene.setStage(D.STAGES[0]);
    scene.setFocus(null);
  }

  function renderStages() {
    const ol = $('#stage-list'); ol.innerHTML = '';
    D.STAGES.forEach((st) => {
      const unlocked = S.isUnlocked(st.id), best = S.data.stageBest[st.id], cleared = S.data.cleared.includes(st.id);
      const li = document.createElement('li');
      li.innerHTML = `<button class="stage-card ${unlocked ? '' : 'locked'}">
        <span class="num"><small>STAGE</small>${st.id}</span>
        <span><h3>${unlocked ? esc(st.name) : '？？？'}</h3><p>${unlocked ? esc(st.sub) + '　成功ライン ' + st.pass : '前のステージを突破すると解放'}</p></span>
        <span class="best">${best ? `ベスト<b>${best.total}</b>` : ''}${best && best.perfect ? '<span class="stamp perfect">完全粉砕</span>' : cleared ? '<span class="stamp">突破</span>' : ''}</span>
      </button>`;
      li.firstElementChild.onclick = () => {
        SFX.tap();
        if (!unlocked) { toast('前のステージを突破すると挑戦できる'); return; }
        playStage(st.id);
      };
      ol.appendChild(li);
    });
    $('#total-score').innerHTML = `総合スコア<br><b>${S.totalScore()}</b> / ${D.STAGES.length * 300}`;
  }

  function renderTrain() {
    const box = $('#call-list'); box.innerHTML = '';
    D.STAGES.forEach((st) => {
      const unlocked = S.isUnlocked(st.id);
      const g = document.createElement('div'); g.className = 'call-group';
      g.innerHTML = `<h3>STAGE ${st.id}　${unlocked ? esc(st.name) : '？？？'}</h3>`;
      st.calls.forEach((cid) => {
        const c = D.CALL_BY_ID[cid], best = S.data.callBest[cid];
        const b = document.createElement('button');
        b.className = 'call-row' + (unlocked ? '' : ' locked');
        b.innerHTML = `<span>${unlocked ? esc(c.text) : '？？？'}</span>${best != null ? `<em>${best}</em>` : '<em class="none">未挑戦</em>'}`;
        b.onclick = () => { SFX.tap(); playTraining(cid); };
        g.appendChild(b);
      });
      box.appendChild(g);
    });
  }

  // ================================================================ プレイ画面の部品
  const btnShout = $('#btn-shout'), status = (t) => { $('#status').textContent = t; };
  const ZONE_LABEL = { street: '街', couple: 'フォト', tree: 'ツリー' };
  function renderZones(targetKey) {
    const box = $('#hud-zones'); box.innerHTML = '';
    for (const z of D.ZONES) {
      const lv = scene.zones[z.key].target;
      const d = document.createElement('span');
      d.className = 'zone' + (z.key === targetKey ? ' target' : '') + (lv <= 0.01 ? ' off' : lv > 1.01 ? ' up' : '');
      d.textContent = ZONE_LABEL[z.key];
      box.appendChild(d);
    }
  }
  function panelMode(mode) {
    $('#result').hidden = mode !== 'result';
    btnShout.disabled = !(mode === 'ready' || mode === 'live');
    btnShout.classList.toggle('ready', mode === 'ready');
    btnShout.classList.toggle('live', mode === 'live');
    $('.shout-label').textContent = mode === 'live' ? '止める' : '叫ぶ';
  }
  function setPanelAway(away) { $('#panel').classList.toggle('away', away); setTimeout(updateView, 20); }

  // ================================================================ 1コール
  // 録音して採点し、有効な結果を返す（声が無ければやり直し）
  async function runCall(call, ctx) {
    const id = flowId;
    $('#call-no').textContent = ctx.mode === 'campaign' ? `コール ${ctx.index + 1}/3` : '訓練';
    $('#call-target').textContent = ctx.zone ? `狙い：${ctx.zone.name}` : '';
    $('#call-dir').textContent = call.dir;
    guide.setCall(call, null);
    panelMode('loading'); status('お手本を読み込み中…');
    const model = await Au.loadModel(call);
    if (id !== flowId) throw new Abort();
    guide.setCall(call, model.guide);
    const note = model.src === 'none' || model.src === 'broken' ? '（お手本音声が未登録のため、標準の型で採点）' : '';
    for (;;) {
      panelMode('ready');
      status('ボタンを押して、構えろ' + note);
      await waitClick(btnShout);
      SFX.tap();
      let rec;
      try {
        rec = await capture(model);
      } catch (e) {
        if (isAbort(e)) throw e;
        await micError(e);
        continue;
      }
      panelMode('analyzing'); status('解析中…');
      await sleepA(60);
      const feat = A.analyze(rec.samples, rec.sr, { noiseDb: rec.noiseDb });
      const res = A.compare(model.feat, feat, { nChunks: call.chunks.length, calib: S.data.calib, sensDb: S.data.sensDb });
      lastRec = rec;
      if (!res.valid) {
        guide.setPlayer(null);
        toast('声が検出できなかった。マイクに向かって、もう一度！', 2600);
        continue;
      }
      guide.setPlayer(feat);
      return { res, feat, rec, model };
    }
  }
  let lastRec = null;

  // カウントダウン → 叫ぶ → 自動で止まる
  async function capture(model) {
    const id = flowId;
    BGM.stop(0.15);
    panelMode('countdown'); status('マイクを準備中…');
    await Au.openMic();
    let stopReq = false;
    const stopper = () => { stopReq = true; };
    try {
      Au.startCapture();
      status('構えろ…');
      for (const n of [3, 2, 1]) { pop(String(n), '', false); SFX.beep(false); await sleepA(620); }
      const sr = Au.sampleRate;
      const goIdx = Au.mark();
      const pre = Au.peek();
      const noiseDb = A.noiseFloor(pre.subarray(Math.min(pre.length, Math.round(sr * 0.35))), sr);
      pop('叫べ！'); vibrate(40);
      panelMode('live'); status('叫べ！（言い終わると自動で止まる）');
      btnShout.addEventListener('click', stopper);
      const dur = model.feat.dur;
      // 声の始まり・終わりは、録れた波形のサンプル数で測る（画面の描画が一瞬止まっても誤って止めない）
      let ci = Au.chunks.length, idx = goIdx, onsetIdx = null, lastLoudIdx = 0, peak = -100;
      await new Promise((resolve, reject) => {
        const tick = () => {
          if (id !== flowId) { reject(new Abort()); return; }
          const chunks = Au.chunks;
          while (ci < chunks.length) {
            const c = chunks[ci++], lv = A.levelDb(c);
            if (onsetIdx == null && lv > Math.max(noiseDb + 14, -58)) { onsetIdx = idx; lastLoudIdx = idx; clearPop(); }
            if (onsetIdx != null) {
              peak = Math.max(peak, lv);
              if (lv > Math.max(noiseDb + 9, peak - 28)) lastLoudIdx = idx + c.length;
              guide.pushLive((idx - onsetIdx) / sr, clamp01((lv - (noiseDb + 10)) / 34));
            }
            idx += c.length;
          }
          const v = clamp01((Au.liveLevel() - (noiseDb + 10)) / 34);
          scene.voice = v;
          $('#meter-bar').style.width = (v * 100).toFixed(0) + '%';
          if (onsetIdx != null) {
            const t = (idx - onsetIdx) / sr;
            guide.setCursor(t);
            if (((idx - lastLoudIdx) / sr > 0.6 && t > dur * 0.45) || t > dur * 2 + 1) stopReq = true;
          } else if ((idx - goIdx) / sr > 6) stopReq = true;
          if (stopReq) resolve(); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const onset = onsetIdx;
      await sleepA(120);
      const all = Au.stopCapture();
      return { samples: all.subarray(Math.max(0, goIdx - Math.round(sr * 0.3))), sr, noiseDb, heard: onset != null };
    } finally {
      btnShout.removeEventListener('click', stopper);
      Au.closeMic();
      scene.voice = 0;
      $('#meter-bar').style.width = '0%';
      clearPop();
    }
  }

  async function micError(e) {
    const code = e && e.code;
    const msg = code === 'denied'
      ? 'マイクの使用が許可されていません。\nブラウザやスマホの設定で、このゲームのマイクを「許可」にしてから、もう一度ボタンを押してください。'
      : code === 'unsupported'
        ? 'この環境ではマイクが使えません。\nブラウザ版は https のページ（またはこのパソコンの localhost）で開いてください。'
        : 'マイクを開けませんでした。\n他のアプリがマイクを使っていないか確認して、もう一度ボタンを押してください。';
    await modal(msg);
  }

  // 採点結果を表示する
  function judgeOf(score, pass) {
    if (score >= Math.max(pass + 20, 90)) return 'perfect';
    if (score >= pass) return 'good';
    if (score >= pass - 12) return 'near';
    return 'bad';
  }
  const JUDGE_TEXT = { perfect: '完全粉砕！', good: '粉砕成功！', near: 'あと一歩…', bad: '粉砕失敗…' };
  async function showScore(r, call, judge) {
    const res = r.res;
    panelMode('result');
    const el = $('#result');
    el.scrollTop = 0;
    $('#judge').className = 'judge'; $('#judge').textContent = '';
    $('#cats').innerHTML = D.CATEGORIES.map((c) => `<li class="cat"><span>${c.name}</span><span class="bar-bg"><i class="bar-fg" data-k="${c.key}"></i></span><b>${res[c.key]}<small> / ${c.max}</small></b></li>`).join('');
    $('#advice-text').textContent = pick(D.ADVICE[res.advice] || D.ADVICE.toneShape);
    setFace($('#advice-face'), 'satoshi', judge === 'perfect' ? 'smile' : judge === 'bad' ? 'angry' : null);
    const dd = $('#dev-detail');
    dd.hidden = !DEV;
    if (DEV) dd.textContent = Object.entries(res.detail).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(3) : v}`).join('  ') + `  model=${r.model.src}`;
    $('#btn-myvoice').hidden = !lastRec;
    // 数字をカウントアップ
    const num = $('#sync-num');
    const t0 = performance.now(), dur = 900;
    await new Promise((resolve) => {
      let lastTick = 0;
      const step = () => {
        const u = Math.min(1, (performance.now() - t0) / dur);
        num.textContent = Math.round(res.total * (1 - Math.pow(1 - u, 3)));
        if (performance.now() - lastTick > 70) { SFX.tick(); lastTick = performance.now(); }
        if (u < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    document.querySelectorAll('#cats .bar-fg').forEach((b) => {
      const c = D.CATEGORIES.find((x) => x.key === b.dataset.k), ratio = res[c.key] / c.max;
      b.style.width = (ratio * 100).toFixed(0) + '%';
      b.classList.toggle('low', ratio < 0.5);
    });
    $('#judge').className = 'judge ' + judge; $('#judge').textContent = JUDGE_TEXT[judge];
    SFX.stamp(); vibrate(judge === 'perfect' || judge === 'good' ? [30, 40, 60] : 50);
  }

  // 採点に応じて街を変える
  function applyEffect(judge, zoneKey) {
    if (judge === 'perfect' || judge === 'good') {
      scene.lightsOut(zoneKey, judge === 'perfect'); SFX.zap();
      if (judge === 'perfect') { flash(0.7); shakeApp(); }
    } else if (judge === 'near') { scene.flicker(zoneKey); SFX.zap(); }
    else { scene.sparkUp(zoneKey); SFX.sparkle(); }
  }

  // 結果画面の「自分の声」（直前に録った自分の叫び）
  let playing = null;
  function playBuf(fn) { if (playing) playing.stop(); playing = fn(); }
  $('#btn-myvoice').onclick = () => { if (lastRec) playBuf(() => Au.playSamples(lastRec.samples, lastRec.sr)); };

  // ================================================================ 実戦モード
  async function playStage(stageId) {
    abortFlow();
    const id = flowId;
    const stage = D.STAGES[stageId - 1];
    await unlockAudio();
    scene.setStage(stage); scene.setFocus(null);
    $('#hud-stage').textContent = stage.name; $('#hud-sub').textContent = stage.sub; $('#hud-pass').textContent = stage.pass;
    $('#haze').classList.remove('on'); hideBanner(); clearPop();
    renderZones(null);
    setPanelAway(true);
    show('play');
    BGM.play('stage');
    stage.calls.forEach((cid) => Au.loadModel(D.CALL_BY_ID[cid]));
    try {
      if (!S.data.seenIntro[stage.id]) { await sleepA(500); await talk(stage.intro); S.data.seenIntro[stage.id] = true; S.save(); }
      await maybeAskCalib();
      const results = [];
      for (let i = 0; i < 3; i++) {
        const call = D.CALL_BY_ID[stage.calls[i]], zone = D.ZONES[i];
        scene.setFocus(zone.key); renderZones(zone.key);
        setPanelAway(false);
        const r = await runCall(call, { mode: 'campaign', index: i, zone });
        const judge = judgeOf(r.res.total, stage.pass);
        results.push({ call, total: r.res.total, judge, res: r.res });
        S.recordCall(call.id, r.res.total);
        scene.setFocus(null);
        applyEffect(judge, zone.key);
        renderZones(null);
        const line = pick(judge === 'perfect' ? D.LINES.callPerfect : judge === 'good' ? D.LINES.callGood : judge === 'near' ? D.LINES.callNear : D.LINES.callBad);
        pop(JUDGE_TEXT[judge], `${D.CHARS[line[0]].name}「${line[1]}」`, true);
        await showScore(r, call, judge);
        $('#btn-retry').hidden = true;
        $('#btn-next').textContent = i < 2 ? '次のコールへ' : '結果を見る';
        await waitClick($('#btn-next'));
        if (playing) playing.stop();
        SFX.tap(); clearPop();
        BGM.play('stage');
      }
      // ---- ステージの決着
      const passes = results.filter((r) => r.total >= stage.pass).length;
      const cleared = passes >= 2, perfect = passes === 3;
      const total = results.reduce((s, r) => s + r.total, 0);
      setPanelAway(true);
      BGM.stop(0.4);
      await sleepA(400);
      if (cleared) {
        scene.allOut(); SFX.zap();
        await sleepA(900);
        await Promise.race([scene.collapseTree(), sleepA(2600)]);
        scene.celebrate(); SFX.chant(); SFX.fanfare(); flash(0.5);
        banner(perfect ? '完全粉砕！' : '粉砕成功！', '聖夜は、俺たちのものだ！');
        await sleepA(3200);
        hideBanner();
        await talk([pick(perfect ? D.LINES.stagePerfect : D.LINES.stageClear)]);
      } else {
        scene.sparkleAll(); $('#haze').classList.add('on'); SFX.sparkle(); SFX.fail();
        banner('粉砕失敗…', 'やっぱり、恋は強い。', true);
        await sleepA(3000);
        hideBanner();
        await talk([pick(D.LINES.stageFail)]);
      }
      const isNew = S.recordStage(stage.id, total, cleared, perfect);
      showStageResult(stage, results, total, cleared, perfect, isNew);
    } catch (e) {
      if (!isAbort(e)) throw e;
    } finally {
      if (id === flowId) scene.setFocus(null);
    }
  }

  function titleOf(avg) { return D.TITLES.find(([min]) => avg >= min)[1]; }

  function showStageResult(stage, results, total, cleared, perfect, isNew) {
    $('#sr-stage').textContent = `STAGE ${stage.id}　${stage.name}`;
    const t = $('#sr-title');
    t.textContent = perfect ? '完全粉砕！' : cleared ? '粉砕成功！' : '粉砕失敗…';
    t.className = 'sr-title ' + (cleared ? 'win' : 'lose');
    $('#sr-catch').textContent = cleared ? '聖夜は、俺たちのものだ！' : 'やっぱり、恋は強い。';
    $('#sr-calls').innerHTML = results.map((r) => `<li><span>${esc(r.call.text)}</span><i class="${r.total >= stage.pass ? 'ok' : ''}">${r.total >= stage.pass ? '成功' : '失敗'}</i><b>${r.total}</b></li>`).join('');
    $('#sr-total').textContent = total;
    $('#sr-new').hidden = !isNew;
    const avg = Math.round(total / 3);
    $('#sr-rank').textContent = titleOf(avg);
    const next = $('#btn-sr-next');
    const isLast = stage.id === D.STAGES.length;
    next.hidden = !cleared;
    next.textContent = isLast ? (S.data.endingSeen ? 'エンディングをもう一度' : 'エンディングへ') : '次のステージへ';
    $('#btn-sr-retry').onclick = () => { SFX.tap(); playStage(stage.id); };
    $('#btn-sr-list').onclick = () => { SFX.tap(); scene.reset(true); $('#haze').classList.remove('on'); renderStages(); show('stages'); BGM.play('title'); };
    next.onclick = () => { SFX.tap(); if (isLast) playEnding(); else playStage(stage.id + 1); };
    $('#btn-sr-share').onclick = () => { SFX.tap(); shareResult(stage, results, total, cleared, perfect); };
    show('stage-result');
    if (cleared) SFX.fanfare();
  }

  // ================================================================ 訓練モード
  async function playTraining(callId) {
    abortFlow();
    const id = flowId;
    const call = D.CALL_BY_ID[callId];
    const stage = D.STAGES.find((s) => s.calls.includes(callId));
    await unlockAudio();
    scene.setStage(stage); scene.setFocus(null);
    $('#hud-stage').textContent = '訓練モード'; $('#hud-sub').textContent = stage.name; $('#hud-pass').textContent = TRAIN_PASS;
    $('#haze').classList.remove('on'); hideBanner(); clearPop();
    renderZones(null);
    setPanelAway(false);
    show('play');
    BGM.stop(0.3);
    let zi = 0;
    try {
      await maybeAskCalib();
      for (;;) {
        const zone = D.ZONES[zi % 3];
        scene.setFocus(zone.key); renderZones(zone.key);
        const r = await runCall(call, { mode: 'training', zone });
        const judge = judgeOf(r.res.total, TRAIN_PASS);
        const isBest = S.recordCall(call.id, r.res.total);
        scene.setFocus(null);
        applyEffect(judge, zone.key);
        renderZones(null);
        pop(JUDGE_TEXT[judge], isBest ? '自己ベスト更新！' : '', true);
        await showScore(r, call, judge);
        $('#btn-retry').hidden = false;
        $('#btn-next').textContent = 'コール選択へ';
        const b = await waitClick($('#btn-retry'), $('#btn-next'));
        if (playing) playing.stop();
        SFX.tap(); clearPop();
        if (b === $('#btn-next')) { renderTrain(); scene.reset(true); show('train'); BGM.play('title'); return; }
        zi++;
        if (zi % 3 === 0) { scene.reset(false); }
        guide.setPlayer(null);
      }
    } catch (e) {
      if (!isAbort(e)) throw e;
    }
  }

  // ================================================================ 中断
  $('#btn-quit').onclick = async () => {
    SFX.tap();
    const ok = await modal('中断して戻りますか？\n（このステージの結果は記録されません）', [['続ける', false], ['中断する', true, true]]);
    if (!ok) return;
    quitPlay();
  };
  // 採点結果の「タイトル」：実戦の途中ならステージは記録されないので確認する
  $('#btn-title').onclick = async () => {
    SFX.tap();
    const wasTraining = $('#hud-stage').textContent === '訓練モード';
    if (!wasTraining && !(await modal('タイトルへ戻りますか？\n（このステージの結果は記録されません）', [['続ける', false], ['タイトルへ', true, true]]))) return;
    quitPlay(true);
  };
  function quitPlay(toTitle) {
    const wasTraining = $('#hud-stage').textContent === '訓練モード';
    abortFlow(); Au.closeMic(); if (playing) playing.stop();
    $('#talk').hidden = true; hideBanner(); clearPop(); $('#haze').classList.remove('on');
    scene.reset(true); scene.voice = 0;
    if (toTitle) show('title');
    else if (wasTraining) { renderTrain(); show('train'); } else { renderStages(); show('stages'); }
    BGM.play('title');
  }

  // ================================================================ エンディング
  async function playEnding() {
    abortFlow();
    show('ending');
    BGM.stop(0.5);
    const box = $('#ending-text'); box.innerHTML = '';
    $('#btn-ending').hidden = true;
    try {
      for (let i = 0; i < D.ENDING.length; i++) {
        const p = document.createElement('p');
        p.textContent = D.ENDING[i];
        if (i === 0 || i === D.ENDING.length - 2) p.className = 'big';
        box.appendChild(p);
        await sleepA(60); p.classList.add('on');
        if (i === 0) SFX.chant();
        await sleepA(1900);
      }
      const c = document.createElement('p'); c.className = 'credits';
      c.innerHTML = 'LOVE IS NOT THE ONLY ANSWER.<br>企画・制作　KMC Creative Lab<br>登場人物・団体はすべて架空です。';
      box.appendChild(c); await sleepA(60); c.classList.add('on');
      S.set('endingSeen', true);
      $('#btn-ending').hidden = false;
      await waitClick($('#btn-ending'));
      SFX.tap(); show('title'); BGM.play('title');
    } catch (e) { if (!isAbort(e)) throw e; }
  }

  // ================================================================ シェア
  async function makeCard(stage, total, cleared, perfect) {
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1350;
    const g = c.getContext('2d');
    const img = $('.title-art img');
    if (img && img.complete && img.naturalWidth) {
      const s = Math.max(1080 / img.naturalWidth, 1350 / img.naturalHeight);
      g.drawImage(img, (1080 - img.naturalWidth * s) / 2, 0, img.naturalWidth * s, img.naturalHeight * s);
    } else { g.fillStyle = '#0B0D1A'; g.fillRect(0, 0, 1080, 1350); }
    const gr = g.createLinearGradient(0, 300, 0, 1350); gr.addColorStop(0, 'rgba(8,9,20,0)'); gr.addColorStop(0.5, 'rgba(8,9,20,.85)'); gr.addColorStop(1, 'rgba(8,9,20,.97)');
    g.fillStyle = gr; g.fillRect(0, 0, 1080, 1350);
    g.save(); g.translate(70, 760); g.rotate(-0.05);
    g.fillStyle = '#E0262E'; g.fillRect(0, -70, 400, 86);
    g.fillStyle = '#fff'; g.font = "60px 'Dela Gothic One', sans-serif"; g.fillText('クリスマス', 20, 0);
    g.fillStyle = '#FFD23F'; g.fillRect(0, 30, 470, 150);
    g.fillStyle = '#111'; g.font = "120px 'Dela Gothic One', sans-serif"; g.fillText('粉砕！', 20, 152);
    g.restore();
    g.fillStyle = '#fff'; g.font = "bold 44px 'Noto Sans JP', sans-serif";
    g.fillText(`STAGE ${stage.id}　${stage.name}`, 70, 1010);
    g.fillStyle = cleared ? '#FFD23F' : '#FF5FA2'; g.font = "84px 'Dela Gothic One', sans-serif";
    g.fillText(perfect ? '完全粉砕！' : cleared ? '粉砕成功！' : '粉砕失敗…', 70, 1110);
    g.fillStyle = '#fff'; g.font = "bold 40px 'Noto Sans JP', sans-serif";
    g.fillText(`非モテ魂シンクロ率 平均 ${Math.round(total / 3)}%　称号：${titleOf(Math.round(total / 3))}`, 70, 1190);
    g.fillStyle = '#A9AAC2'; g.font = "32px 'Noto Sans JP', sans-serif";
    g.fillText('#クリスマス粉砕　#反恋愛至上戦線', 70, 1270);
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }
  async function shareResult(stage, results, total, cleared, perfect) {
    const avg = Math.round(total / 3);
    const text = `『クリスマス粉砕！』STAGE${stage.id}「${stage.name}」で${perfect ? '完全粉砕' : cleared ? '粉砕成功' : '粉砕失敗'}！ 非モテ魂シンクロ率 平均${avg}%（称号：${titleOf(avg)}） #クリスマス粉砕 #反恋愛至上戦線`;
    try {
      const blob = await makeCard(stage, total, cleared, perfect);
      const file = blob && new File([blob], 'christmas-smash.png', { type: 'image/png' });
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text }); return; }
      if (navigator.share) { await navigator.share({ text }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast('結果の文章をコピーしました'); }
    catch (e) { await modal(text); }
  }

  // ================================================================ ランキング
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { SFX.tap(); renderRanking(t.dataset.tab); }));
  function renderRanking(tab) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
    const body = $('#rank-body');
    const fmt = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
    if (tab === 'runs') {
      const runs = S.data.runs.slice(0, 10);
      body.innerHTML = runs.length ? `<table class="rank-table"><tr><th></th><th>隊員</th><th>ステージ</th><th>日付</th><th style="text-align:right">合計</th></tr>${
        runs.map((r, i) => `<tr><td class="pos">${i + 1}</td><td>${esc(r.name)}</td><td>${r.stage}. ${esc(D.STAGES[r.stage - 1].name)}${r.perfect ? ' ★' : ''}</td><td>${fmt(r.at)}</td><td class="n">${r.total}</td></tr>`).join('')}</table>`
        : '<p class="empty">まだ記録がない。実戦モードで粉砕に挑もう。</p>';
    } else if (tab === 'stages') {
      body.innerHTML = `<table class="rank-table"><tr><th>ステージ</th><th>状態</th><th style="text-align:right">ベスト</th></tr>${
        D.STAGES.map((s) => { const b = S.data.stageBest[s.id]; return `<tr><td>${s.id}. ${S.isUnlocked(s.id) ? esc(s.name) : '？？？'}</td><td>${b && b.perfect ? '完全粉砕' : S.data.cleared.includes(s.id) ? '突破' : b ? '未突破' : '―'}</td><td class="n">${b ? b.total : '―'}</td></tr>`; }).join('')
      }<tr><td><b>総合スコア</b></td><td></td><td class="n">${S.totalScore()}</td></tr></table>`;
    } else {
      body.innerHTML = `<table class="rank-table"><tr><th>コール</th><th style="text-align:right">ベスト</th></tr>${
        D.CALLS.map((c) => { const st = D.STAGES.find((s) => s.calls.includes(c.id)); const b = S.data.callBest[c.id]; return `<tr><td>${S.isUnlocked(st.id) ? esc(c.text) : '？？？'}</td><td class="n">${b != null ? b : '―'}</td></tr>`; }).join('')
      }</table>`;
    }
  }

  // ================================================================ 遊び方
  $('#cycle').innerHTML = D.CYCLE.map((c) => `<li><b>${c.n}</b><strong>${c.title}</strong><span>${c.text}</span></li>`).join('');
  $('#score-table').innerHTML = D.CATEGORIES.map((c) => `<tr><td>${c.name}<small>${c.desc}</small></td><td>${c.max}点</td></tr>`).join('') + '<tr><td><b>合計</b></td><td>100点</td></tr>';

  // ================================================================ 設定
  function renderSettings() {
    const d = S.data;
    $('#set-name').value = d.name;
    $('#set-sens').value = d.sensDb; sensLabel();
    $('#set-bgm').value = d.bgm; $('#set-se').value = d.se;
    $('#set-vib').checked = d.vib;
    $('#calib-state').textContent = d.calib ? `調整済み（普段の声 ${d.calib.normalDb.toFixed(0)} dB）` : '未調整（調整すると熱量の判定が正確になる）';
    $('#version').textContent = VERSION;
    $('#dev-panel').hidden = !DEV;
    if (DEV) renderDevModels();
  }
  function sensLabel() { const v = +$('#set-sens').value; $('#set-sens-label').textContent = v === 0 ? '標準' : v > 0 ? `+${v}（小さな声でも熱量が出やすい）` : `${v}（厳しめ）`; }
  $('#set-name').onchange = (e) => S.set('name', e.target.value.trim() || '名無しの隊員');
  $('#set-sens').oninput = (e) => { S.set('sensDb', +e.target.value); sensLabel(); };
  $('#set-bgm').oninput = (e) => { S.set('bgm', +e.target.value); Au.setVolume('bgm', +e.target.value * 0.5); };
  $('#set-se').oninput = (e) => { S.set('se', +e.target.value); Au.setVolume('se', +e.target.value); };
  $('#set-se').onchange = () => SFX.zap();
  $('#set-vib').onchange = (e) => S.set('vib', e.target.checked);
  $('#btn-reset').onclick = async () => {
    const ok = await modal('クリア状況・ランキング・自己ベストをすべて消します。よろしいですか？', [['やめる', false], ['消去する', true, true]]);
    if (ok) { S.reset(); toast('記録を消しました'); renderSettings(); }
  };
  // バージョン表示を7回タップすると開発者向けの項目が出る
  let devTaps = 0;
  $('#version').onclick = () => { if (++devTaps >= 7) { try { localStorage.setItem('xmas-smash.dev', '1'); } catch (e) { /* 無視 */ } location.reload(); } };

  // ================================================================ マイク調整
  let calibReturn = 'settings';
  $('#btn-calib').onclick = () => { SFX.tap(); runCalib('settings'); };
  async function maybeAskCalib() {
    if (S.data.calib || S.data.calibAsked) return;
    S.set('calibAsked', true);
    const go = await modal('はじめに「マイク調整」をしますか？\n普段の声の大きさを測っておくと、熱量の判定が正確になります（約10秒）。', [['あとで', false], ['調整する', true, true]]);
    if (go) {
      await new Promise((resolve) => { calibResolve = resolve; runCalib(current); });
    }
  }
  let calibResolve = null;
  function calibDone() {
    show(calibReturn);
    if (calibReturn === 'settings') renderSettings();
    if (calibResolve) { const r = calibResolve; calibResolve = null; r(); }
  }
  async function recordFor(sec, onLevel, untilQuiet) {
    await Au.openMic();
    Au.startCapture();
    const t0 = performance.now() / 1000;
    let heard = null, lastLoud = 0, noise = -60;
    try {
      await new Promise((resolve) => {
        const tick = () => {
          const now = performance.now() / 1000, lv = Au.liveLevel();
          onLevel(lv);
          if (untilQuiet) {
            if (heard == null && lv > noise + 14) { heard = now; lastLoud = now; }
            if (heard != null && lv > noise + 9) lastLoud = now;
            if (heard != null && now - lastLoud > 0.6) return resolve();
          }
          if (now - t0 > sec) return resolve();
          requestAnimationFrame(tick);
        };
        if (untilQuiet) noise = untilQuiet;
        requestAnimationFrame(tick);
      });
      return Au.stopCapture();
    } finally { Au.closeMic(); }
  }
  async function runCalib(returnTo) {
    calibReturn = returnTo || 'settings';
    await unlockAudio();
    BGM.stop(0.3);
    show('calib');
    const step = $('#calib-step'), msg = $('#calib-msg'), val = $('#calib-val'), bar = $('#calib-bar');
    const meter = (lv) => { bar.style.width = (clamp01((lv + 70) / 64) * 100).toFixed(0) + '%'; };
    const go = $('#btn-calib-go'), skip = $('#btn-calib-skip');
    step.textContent = 'マイク調整'; msg.textContent = '周りの静けさと、あなたの普段の声の大きさを測ります。'; val.textContent = '';
    go.textContent = 'はじめる'; go.hidden = false; skip.hidden = false;
    const id = flowId;
    try {
      const b = await waitClick(go, skip);
      if (b === skip) { calibDone(); return; }
      go.hidden = true; skip.hidden = true;
      step.textContent = 'STEP 1 / 2'; msg.textContent = '2秒間、静かにしていてください。';
      const sr = (await Au.ensure()).sampleRate;
      const quiet = await recordFor(2, meter);
      const noiseDb = A.noiseFloor(quiet.subarray(Math.round(sr * 0.3)), sr);
      val.textContent = `周りの音：${noiseDb.toFixed(0)} dB`;
      for (let tries = 0; ; tries++) {
        if (id !== flowId) return;
        step.textContent = 'STEP 2 / 2'; msg.textContent = '普段の声で「メリークリスマス」と言ってください。';
        const talkRec = await recordFor(5, meter, noiseDb);
        const f = A.analyze(talkRec, sr, { noiseDb });
        if (f.valid) {
          S.set('calib', { noiseDb, normalDb: f.l90, at: Date.now() });
          step.textContent = '完了'; msg.textContent = '調整しました。本番は、これよりずっと大きな声で！';
          val.textContent = `周りの音 ${noiseDb.toFixed(0)} dB ／ 普段の声 ${f.l90.toFixed(0)} dB`;
          break;
        }
        val.textContent = '声が聞こえませんでした。もう一度どうぞ。';
        if (tries >= 2) { msg.textContent = '声がうまく測れませんでした。マイクの許可や向きを確かめてください。'; break; }
      }
      go.textContent = 'OK'; go.hidden = false;
      await waitClick(go);
      calibDone();
    } catch (e) {
      if (isAbort(e)) return;
      if (e && e.code) { await micError(e); calibDone(); return; }
      throw e;
    }
  }

  // ================================================================ 開発者向け：お手本の確認と差し替え
  async function renderDevModels() {
    const box = $('#dev-models'); box.innerHTML = '';
    for (const c of D.CALLS) {
      const row = document.createElement('div'); row.className = 'dev-row';
      row.innerHTML = `<span>${c.id} ${esc(c.text)}<br><small>読み込み中…</small></span><span class="btns"><button data-a="play">再生</button><button data-a="rec">録音</button><button data-a="del">削除</button></span>`;
      box.appendChild(row);
      Au.loadModel(c).then((m) => {
        const label = { features: '基準データ（models.json）', custom: '自分で録音（この端末のみ）', none: '未登録（標準の型）', broken: '読めない（標準の型）' }[m.src];
        row.querySelector('small').textContent = `${label}　${m.feat.dur.toFixed(2)}秒　区切り${m.guide && m.guide.bounds ? m.guide.bounds.length + 1 : '?'}`;
        row.querySelector('[data-a=del]').disabled = m.src !== 'custom';
        row.querySelector('[data-a=play]').disabled = !m.buffer;
      });
      row.querySelector('[data-a=play]').onclick = async () => { const m = await Au.loadModel(c); if (m.buffer) playBuf(() => Au.play(m.buffer)); };
      row.querySelector('[data-a=del]').onclick = async () => { await S.deleteCustomModel(c.id); Au.forgetModel(c.id); renderDevModels(); };
      row.querySelector('[data-a=rec]').onclick = () => devRecord(c);
    }
  }
  async function devRecord(call) {
    const ok = await modal(`「${call.text}」をお手本として録音します。\nボタンを押すと 2 秒後に録音開始。言い終わると自動で止まります。`, [['やめる', false], ['録音する', true, true]]);
    if (!ok) return;
    try {
      await unlockAudio();
      const sr = Au.ctx.sampleRate;
      toast('2秒後に録音開始…', 1800);
      await Au.openMic(); Au.startCapture();
      await new Promise((r) => setTimeout(r, 2000));
      const pre = Au.peek(); const noiseDb = A.noiseFloor(pre.subarray(Math.round(sr * 0.3)), sr);
      const goIdx = Au.mark();
      toast('どうぞ！', 1500);
      const t0 = performance.now() / 1000;
      let heard = null, lastLoud = 0;
      await new Promise((resolve) => {
        const tick = () => {
          const now = performance.now() / 1000, lv = Au.liveLevel();
          if (heard == null && lv > noiseDb + 14) { heard = now; lastLoud = now; }
          if (heard != null && lv > noiseDb + 9) lastLoud = now;
          if ((heard != null && now - lastLoud > 0.7) || now - t0 > 8) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const all = Au.stopCapture(); Au.closeMic();
      const s = all.subarray(Math.max(0, goIdx - Math.round(sr * 0.2)));
      const f = A.analyze(s, sr, { noiseDb });
      if (!f.valid) { toast('声が録れませんでした'); return; }
      await S.putCustomModel(call.id, sr, s);
      Au.forgetModel(call.id);
      toast(`お手本を保存しました（${f.dur.toFixed(2)}秒）`);
      renderDevModels();
    } catch (e) { Au.closeMic(); if (e && e.code) await micError(e); else throw e; }
  }

  // ================================================================ 端末のイベント
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (Au.stream) { abortFlow(); Au.closeMic(); if (current === 'play') quitPlay(); }
      BGM.stop(0.05);
      if (Au.ctx) Au.ctx.suspend().catch(() => {});
    } else if (Au.ctx) {
      Au.ctx.resume().catch(() => {});
      if (['title', 'stages', 'train', 'ranking', 'howto', 'settings'].includes(current)) BGM.play('title');
    }
  });
  if (CapApp) {
    CapApp.addListener('backButton', () => {
      if (!$('#modal').hidden && modal.close) { modal.close(); return; }
      if (!$('#talk').hidden) { $('#talk-skip').click(); return; }
      if (current === 'play') { $('#btn-quit').click(); return; }
      if (current === 'stage-result') { $('#btn-sr-list').click(); return; }
      if (current === 'title') { CapApp.exitApp(); return; }
      goBack();
    });
  }

  // ================================================================ 起動
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (app.dataset.view !== 'title' && app.dataset.view !== 'none') { scene.update(dt); scene.draw(); }
    requestAnimationFrame(frame);
  }
  resize();
  scene.setStage(D.STAGES[0]);
  show('title');
  requestAnimationFrame(frame);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { scene.bldCache = null; });

  // テスト・デバッグ用の窓口
  root.CSGame = { scene, guide, playStage, playTraining, show, abortFlow, get current() { return current; }, VERSION, DEV };
})(window);
