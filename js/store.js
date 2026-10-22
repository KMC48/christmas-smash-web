/* クリスマス粉砕！ ― 記録と設定の保存
 * 記録・設定は localStorage（この端末だけ）。開発用の「自分で録ったお手本」は IndexedDB。
 * どちらも使えない環境（プライベートモード等）でも、ゲームは保存なしで動く。
 */
(function (root) {
  'use strict';
  const KEY = 'xmas-smash.v1';
  const DEFAULTS = {
    name: '浅野ユウ',
    sensDb: 0,          // マイク感度（熱量の判定に足す dB）
    calib: null,        // { noiseDb, normalDb, at }
    bgm: 0.5,
    se: 0.8,
    vib: true,
    cleared: [],        // クリア済みのステージ番号
    stageBest: {},      // { [stageId]: { total, perfect, at } }
    callBest: {},       // { [callId]: score }
    runs: [],           // 総合ランキング用 { stage, total, cleared, perfect, name, at }
    seenIntro: {},      // ステージ導入の会話を見たか
    endingSeen: false,
  };

  let data = load();

  function load() {
    try {
      const raw = root.localStorage && root.localStorage.getItem(KEY);
      return Object.assign(structuredCloneSafe(DEFAULTS), raw ? JSON.parse(raw) : {});
    } catch (e) {
      return structuredCloneSafe(DEFAULTS);
    }
  }
  function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }
  function save() {
    try { root.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 保存できない環境 */ }
  }

  const Store = {
    get data() { return data; },
    set(k, v) { data[k] = v; save(); },
    save,
    reset() {
      const keep = { name: data.name, sensDb: data.sensDb, calib: data.calib, bgm: data.bgm, se: data.se, vib: data.vib };
      data = Object.assign(structuredCloneSafe(DEFAULTS), keep);
      save();
    },
    isUnlocked(stageId) { return stageId === 1 || data.cleared.includes(stageId - 1); },
    recordCall(callId, score) {
      if (!(data.callBest[callId] >= score)) { data.callBest[callId] = score; save(); return true; }
      return false;
    },
    // ステージ1回分の結果を記録。新記録なら true
    recordStage(stageId, total, cleared, perfect) {
      if (cleared && !data.cleared.includes(stageId)) data.cleared.push(stageId);
      const prev = data.stageBest[stageId];
      const isNew = !prev || total > prev.total;
      if (isNew) data.stageBest[stageId] = { total, perfect: perfect || !!(prev && prev.perfect), at: Date.now() };
      else if (perfect && !prev.perfect) prev.perfect = true;
      data.runs.push({ stage: stageId, total, cleared, perfect, name: data.name, at: Date.now() });
      data.runs.sort((a, b) => b.total - a.total || a.at - b.at);
      data.runs = data.runs.slice(0, 50);
      save();
      return isNew;
    },
    totalScore() { return Object.values(data.stageBest).reduce((s, b) => s + b.total, 0); },
  };

  // ---- 開発用：自分で録ったお手本（IndexedDB）
  const DB_NAME = 'xmas-smash', DB_STORE = 'models';
  function openDb() {
    return new Promise((resolve) => {
      try {
        const req = root.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  function tx(mode, fn) {
    return openDb().then((db) => new Promise((resolve) => {
      if (!db) return resolve(null);
      try {
        const t = db.transaction(DB_STORE, mode), s = t.objectStore(DB_STORE);
        const req = fn(s);
        t.oncomplete = () => resolve(req ? req.result : null);
        t.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    }));
  }
  Store.getCustomModel = (id) => tx('readonly', (s) => s.get(id));
  Store.putCustomModel = (id, sr, samples) => tx('readwrite', (s) => s.put({ sr, data: Float32Array.from(samples).buffer, at: Date.now() }, id));
  Store.deleteCustomModel = (id) => tx('readwrite', (s) => s.delete(id));

  root.CSStore = Store;
})(window);
