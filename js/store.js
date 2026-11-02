/* 저장소
 *  - localStorage: 설정, 정답, 학습한 양식(문항 번호 매핑)
 *  - IndexedDB: 채점 기록(판독 이미지 포함), 반 채점 세션
 */
(function (root) {
  'use strict';
  const LS = {
    settings: 'omr.settings.v2',
    keys: 'omr.keys.v2',
    layouts: 'omr.layouts.v1'
  };

  const DEFAULT_SETTINGS = {
    apiKey: '',
    model: 'gemini-flash-latest',
    aiLayout: 'auto',        // auto | off — 처음 보는 양식이면 AI로 문항 번호 확인
    thrMode: 'auto',
    thr: 35,
    multi: 'wrong',          // wrong | darkest
    theme: 'system',         // system | light | dark
    haptics: true,
    autoCapture: true,
    lastKeyId: ''
  };

  const read = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const Settings = {
    get() { return Object.assign({}, DEFAULT_SETTINGS, read(LS.settings, {})); },
    set(patch) { const s = Object.assign(this.get(), patch); write(LS.settings, s); return s; }
  };

  // 정답: { id, name, subject, code(탐구 과목번호), items:[{no,a,p,type}], electives:[{label, items:[...]}] }
  //  a: 객관식 1~5 / 단답형 정수, p: 배점(null=모름), type: 'mc'|'sa'
  function blankItems(from, to, type) {
    const out = [];
    for (let no = from; no <= to; no++) out.push({ no, a: null, p: null, type: type || 'mc' });
    return out;
  }
  const PRESETS = {
    korean: () => ({ subject: '국어', items: blankItems(1, 34), electives: [{ label: '화법과 작문', items: blankItems(35, 45) }, { label: '언어와 매체', items: blankItems(35, 45) }] }),
    math: () => ({
      subject: '수학', items: blankItems(1, 15).concat(blankItems(16, 22, 'sa')),
      electives: ['확률과 통계', '미적분', '기하'].map(label => ({ label, items: blankItems(23, 28).concat(blankItems(29, 30, 'sa')) }))
    }),
    mathOld: () => ({ subject: '수학', items: blankItems(1, 21).concat(blankItems(22, 30, 'sa')), electives: [] }),
    english: () => ({ subject: '영어', items: blankItems(1, 45), electives: [] }),
    history: () => ({ subject: '한국사', items: blankItems(1, 20), electives: [] }),
    inquiry: () => ({ subject: '탐구', items: blankItems(1, 20), electives: [] }),
    custom: (n) => ({ subject: '', items: blankItems(1, n || 20), electives: [] })
  };

  const Keys = {
    all() { return read(LS.keys, []); },
    get(id) { return this.all().find(k => k.id === id) || null; },
    save(key) {
      const list = this.all();
      key.updatedAt = Date.now();
      const i = list.findIndex(k => k.id === key.id);
      if (i >= 0) list[i] = key; else list.unshift(key);
      return write(LS.keys, list);
    },
    remove(id) { write(LS.keys, this.all().filter(k => k.id !== id)); },
    replaceAll(list) { write(LS.keys, list); },
    create(preset, n) {
      const base = (PRESETS[preset] || PRESETS.custom)(n);
      return Object.assign({ id: uid('k'), name: '', code: null, createdAt: Date.now() }, base);
    },
    presets: PRESETS
  };

  // 학습한 양식: fingerprint → { map:[{ord, section, no}], sections:[...], electiveLabels, subject, source, keyId }
  const Layouts = {
    all() { return read(LS.layouts, {}); },
    get(fp) { return this.all()[fp] || null; },
    set(fp, v) { const a = this.all(); a[fp] = Object.assign({}, a[fp] || {}, v, { updatedAt: Date.now() }); write(LS.layouts, a); },
    remove(fp) { const a = this.all(); delete a[fp]; write(LS.layouts, a); },
    replaceAll(o) { write(LS.layouts, o); }
  };

  // ---------------- IndexedDB
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('omr-db', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('history')) d.createObjectStore('history', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function store(name) {
    const tx = (mode, fn) => db().then(d => new Promise((res, rej) => {
      const t = d.transaction(name, mode);
      const st = t.objectStore(name);
      let out;
      const rq = fn(st);
      if (rq) rq.onsuccess = () => { out = rq.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
    }));
    return {
      put: rec => tx('readwrite', st => st.put(rec)),
      get: id => tx('readonly', st => st.get(id)),
      all: () => tx('readonly', st => st.getAll()).then(l => (l || []).sort((a, b) => (b.date || 0) - (a.date || 0))),
      remove: id => tx('readwrite', st => st.delete(id)),
      clear: () => tx('readwrite', st => st.clear())
    };
  }

  root.Store = { Settings, Keys, Layouts, History: store('history'), Sessions: store('sessions'), uid };
})(self);
