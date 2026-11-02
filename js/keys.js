/* 정답 목록·편집 */
(function (root) {
  'use strict';
  const { $, $$, toast, haptic, Sheet, choose, confirmSheet, esc, fmtDate, CIRCLED } = root.UI;
  const { Keys, Settings } = root.Store;
  const core = () => root.AppCore;

  let K = null, tab = 0, dirty = false, fromResult = false;

  // ---------------- 목록
  function renderList() {
    const list = Keys.all();
    $('#keyEmpty').classList.toggle('hidden', list.length > 0);
    $('#keyList').innerHTML = list.map(k => {
      const missing = countMissingPoints(k);
      const sub = [k.subject, core().keySummary(k), missing ? '배점 미입력' : '', fmtDate(k.updatedAt || k.createdAt, false)].filter(Boolean).join(' · ');
      return `<button class="row row-tap" data-k="${esc(k.id)}"><span class="row-main"><span class="t">${esc(k.name || '이름 없음')}</span><span class="row-sub">${esc(sub)}</span></span><svg class="chev"><use href="#i-chev"/></svg></button>`;
    }).join('');
    $('#navActions').innerHTML = '';
    core().navAction('새 정답', () => create());
  }
  $('#keyList').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) open(b.dataset.k); });

  function allItems(k) { return (k.items || []).concat(...(k.electives || []).map(e => e.items)); }
  function countMissingPoints(k) { return allItems(k).filter(it => it.a != null && it.p == null).length; }

  // ---------------- 새 정답
  async function create() {
    const v = await choose('새 정답', [
      { label: '정답표 사진·PDF로 만들기', note: 'AI가 정답과 배점을 읽어 채웁니다', value: 'ai' },
      { label: '국어', note: '공통 1~34 · 화법과 작문/언어와 매체 35~45', value: 'korean' },
      { label: '수학', note: '공통 1~22 · 확률과 통계/미적분/기하 23~30', value: 'math' },
      { label: '수학 (선택과목 없음)', note: '객관식 1~21 · 단답형 22~30', value: 'mathOld' },
      { label: '영어', note: '1~45', value: 'english' },
      { label: '한국사', note: '1~20', value: 'history' },
      { label: '탐구 (과목 1개)', note: '1~20 · 과목번호로 자동 연결', value: 'inquiry' },
      { label: '직접 만들기', note: '문항 수 지정', value: 'custom' }
    ], null);
    if (!v) return;
    let key;
    if (v === 'custom') {
      const n = await askNumber('문항 수', '객관식 문항 수를 입력하세요', 20);
      if (!n) return;
      key = Keys.create('custom', n);
    } else key = Keys.create(v === 'ai' ? 'custom' : v, 0);
    if (v === 'ai') { key.items = []; key.subject = ''; }
    edit(key, true);
    if (v === 'ai') setTimeout(() => $('#kAiFiles').click(), 350);
  }
  function askNumber(title, sub, def) {
    return new Promise(resolve => {
      let done = false;
      const body = Sheet.open(`<h3>${esc(title)}</h3><p class="sub">${esc(sub)}</p><input class="field" id="askN" inputmode="numeric" value="${def}"><div class="btns"><button class="btn btn-primary btn-lg" id="askOk">확인</button></div>`, { onClose: () => { if (!done) resolve(null); } });
      body.querySelector('#askOk').addEventListener('click', () => { done = true; const n = parseInt(body.querySelector('#askN').value, 10); resolve(n > 0 && n <= 200 ? n : null); Sheet.close(); });
    });
  }

  function open(id, opts) {
    const k = id ? Keys.get(id) : null;
    if (!k) { toast('정답을 찾을 수 없습니다'); return; }
    edit(JSON.parse(JSON.stringify(k)), false, opts);
  }
  function edit(key, isNew, opts) {
    K = key; tab = 0; dirty = !!isNew;
    fromResult = core().S.view === 'result';
    core().pushView('keyedit');
    render();
    if (opts && opts.focusPoints) setTimeout(() => $('#kPointsBanner').scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
  }

  // ---------------- 편집 화면
  function curItems() { return tab === 0 ? K.items : (K.electives[tab - 1] ? K.electives[tab - 1].items : []); }
  function render() {
    $('#kName').value = K.name || '';
    $('#kSubject').value = K.subject || '';
    $('#kCode').value = K.code != null ? K.code : '';
    const st = Settings.get();
    $('#aiModelName').textContent = (root.Gemini.MODELS[st.model] || { name: st.model }).name;
    if (tab > K.electives.length) tab = 0;
    $('#kTabs').innerHTML = [`<button data-t="0" class="${tab === 0 ? 'on' : ''}">${K.electives.length ? '공통' : '문항'}</button>`]
      .concat(K.electives.map((e, i) => `<button data-t="${i + 1}" class="${tab === i + 1 ? 'on' : ''}">${esc(e.label)}</button>`)).join('');
    renderRows();
    renderCuts();
    $('#navActions').innerHTML = '';
    core().navAction('삭제', () => removeKey());
  }
  function renderRows() {
    const items = curItems();
    $('#kRows').innerHTML = items.length ? items.map((it, i) => `<div class="krow" data-i="${i}">
      <span class="no">${it.no}</span>
      <div>${it.type === 'sa'
        ? `<input class="sa-input" inputmode="numeric" data-sa="${i}" value="${it.a != null ? it.a : ''}" placeholder="단답형 정답">`
        : `<div class="bubbles">${[1, 2, 3, 4, 5].map(v => `<button class="bub ${it.a === v ? 'on' : ''}" data-a="${v}">${v}</button>`).join('')}</div>`}</div>
      <div class="kside"><button class="typ" data-typ>${it.type === 'sa' ? '단답' : '객관'}</button><button class="pts ${it.p != null ? 'set' : ''}" data-p>${it.p != null ? it.p + '점' : '배점'}</button></div>
    </div>`).join('') : '<p class="footnote" style="padding:14px 0">문항이 없습니다. 정답표를 불러오거나 문항을 추가하세요.</p>';
    renderTotals();
  }
  function renderTotals() {
    const filled = allItems(K).filter(it => it.a != null).length;
    const total = allItems(K).length;
    const commonPts = K.items.reduce((s, it) => s + (it.p || 0), 0);
    const parts = [`정답 입력 ${filled}/${total}`];
    if (K.electives.length) parts.push(...K.electives.map(e => `${e.label} 기준 ${commonPts + e.items.reduce((s, it) => s + (it.p || 0), 0)}점`));
    else parts.push(`총 ${commonPts}점`);
    $('#kTotal').textContent = parts.join(' · ');
    const miss = countMissingPoints(K);
    $('#kPointsBanner').innerHTML = miss ? `<div class="banner warn"><svg><use href="#i-warn"/></svg><div class="b-text"><b>배점 미입력 ${miss}문항</b> — 이 정답으로 채점하면 점수 대신 맞은 개수만 표시됩니다.</div><button class="b-act" id="kFillPts">배점 일괄</button></div>` : '';
    const f = $('#kFillPts'); f && f.addEventListener('click', bulkPoints);
  }
  function renderCuts() {
    const cuts = K.cutoffs || [];
    $('#kCuts').innerHTML = Array.from({ length: 8 }, (_, i) => `<label>${i + 1}등급<input inputmode="numeric" data-cut="${i}" value="${cuts[i] != null ? cuts[i] : ''}" placeholder="–"></label>`).join('');
  }

  $('#kTabs').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (!b) return; tab = +b.dataset.t; render(); });
  $('#kRows').addEventListener('click', e => {
    const row = e.target.closest('.krow'); if (!row) return;
    const it = curItems()[+row.dataset.i];
    const a = e.target.closest('[data-a]');
    if (a) {
      const v = +a.dataset.a; it.a = it.a === v ? null : v; haptic();
      row.querySelectorAll('.bub').forEach(b => b.classList.toggle('on', +b.dataset.a === it.a));
      dirty = true; renderTotals(); return;
    }
    if (e.target.closest('[data-p]')) {
      const order = [null, 2, 3, 4, 1];
      it.p = order[(order.indexOf(it.p) + 1) % order.length];
      const b = row.querySelector('.pts'); b.textContent = it.p != null ? it.p + '점' : '배점'; b.classList.toggle('set', it.p != null);
      dirty = true; renderTotals(); return;
    }
    if (e.target.closest('[data-typ]')) { it.type = it.type === 'sa' ? 'mc' : 'sa'; it.a = null; dirty = true; renderRows(); }
  });
  $('#kRows').addEventListener('input', e => {
    const inp = e.target.closest('[data-sa]'); if (!inp) return;
    const v = inp.value.replace(/[^0-9]/g, '');
    curItems()[+inp.dataset.sa].a = v === '' ? null : parseInt(v, 10);
    dirty = true; renderTotals();
  });
  ['#kName', '#kSubject', '#kCode'].forEach(s => $(s).addEventListener('input', () => { dirty = true; }));
  $('#kCuts').addEventListener('input', () => { dirty = true; });

  $('#kAddRow').addEventListener('click', () => {
    const items = curItems();
    const last = items[items.length - 1];
    items.push({ no: last ? last.no + 1 : (tab === 0 ? 1 : (K.items.length ? K.items[K.items.length - 1].no + 1 : 1)), a: null, p: last ? last.p : null, type: last ? last.type : 'mc' });
    dirty = true; renderRows();
  });

  // 빠른 입력: 정답 또는 배점을 순서대로
  $('#kQuick').addEventListener('click', () => {
    const body = Sheet.open(`<h3>빠른 입력</h3><p class="sub">현재 탭(${esc(tab === 0 ? '공통' : K.electives[tab - 1].label)})의 첫 문항부터 순서대로 채웁니다. 객관식은 숫자만 이어서(35241…), 단답형이 섞이면 띄어쓰기로 구분하세요.</p>
      <div class="seg seg-full" id="qMode" style="margin:0 0 10px"><button data-m="a" class="on">정답</button><button data-m="p">배점</button><button data-m="n">문항 수</button></div>
      <textarea id="qText" rows="4" placeholder="예: 35241 21354 …"></textarea>
      <div class="btns"><button class="btn btn-primary btn-lg" id="qOk">채우기</button></div>`);
    let mode = 'a';
    body.querySelector('#qMode').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      mode = b.dataset.m;
      body.querySelectorAll('#qMode button').forEach(x => x.classList.toggle('on', x === b));
      body.querySelector('#qText').placeholder = mode === 'a' ? '예: 35241 21354 …' : mode === 'p' ? '예: 2 2 3 2 … (또는 22323)' : `현재 ${curItems().length}문항`;
    });
    body.querySelector('#qOk').addEventListener('click', () => {
      const text = body.querySelector('#qText').value.trim();
      const items = curItems();
      if (mode === 'n') {
        const n = parseInt(text, 10);
        if (!(n > 0 && n <= 200)) { toast('1~200 사이로 입력하세요'); return; }
        while (items.length > n) items.pop();
        while (items.length < n) { const l = items[items.length - 1]; items.push({ no: l ? l.no + 1 : 1, a: null, p: l ? l.p : null, type: 'mc' }); }
      } else {
        const tokens = /[\s,]/.test(text) ? text.split(/[\s,]+/).filter(Boolean) : text.split('');
        let i = 0;
        for (const t of tokens) {
          if (i >= items.length) break;
          const v = parseInt(t, 10);
          if (!Number.isFinite(v)) continue;
          if (mode === 'a') { if (items[i].type === 'mc' && (v < 1 || v > 5)) { i++; continue; } items[i].a = v; }
          else items[i].p = v > 0 ? v : null;
          i++;
        }
        toast(`${Math.min(i, items.length)}문항을 채웠습니다`);
      }
      dirty = true; Sheet.close(); renderRows();
    });
  });

  async function bulkPoints() {
    const v = await choose('배점 일괄', [
      { label: '빈 칸만 2점', value: 'e2' }, { label: '빈 칸만 3점', value: 'e3' },
      { label: '모두 2점', value: 'a2' }, { label: '모두 3점', value: 'a3' }, { label: '모두 4점', value: 'a4' },
      { label: '배점 모두 지우기', note: '정오만 채점합니다', value: 'clear' }
    ], null, '공통·선택과목 전체에 적용합니다');
    if (!v) return;
    allItems(K).forEach(it => {
      if (v === 'clear') it.p = null;
      else if (v[0] === 'e') { if (it.p == null) it.p = +v[1]; }
      else it.p = +v[1];
    });
    dirty = true; renderRows();
  }
  $('#kBulkPts').addEventListener('click', bulkPoints);

  // 선택과목 관리
  $('#kElective').addEventListener('click', async () => {
    const opts = K.electives.map((e, i) => ({ label: e.label, note: `${e.items.length}문항 · 눌러서 이름 변경/삭제`, value: i }));
    opts.push({ label: '선택과목 추가', value: 'add' });
    const v = await choose('선택과목', opts, null, '선택과목별로 정답이 다른 문항(예: 국어 35~45, 수학 23~30)을 따로 입력합니다.');
    if (v == null) return;
    if (v === 'add') {
      const label = prompt('선택과목 이름', `선택 ${K.electives.length + 1}`);
      if (!label) return;
      const tmpl = K.electives[0];
      let items;
      if (tmpl) items = tmpl.items.map(it => ({ no: it.no, a: null, p: it.p, type: it.type }));
      else {
        const range = prompt('선택과목 문항 범위 (예: 35-45)', '');
        const m = range && range.match(/(\d+)\s*[-~]\s*(\d+)/);
        if (!m) return;
        items = [];
        for (let n = +m[1]; n <= +m[2]; n++) items.push({ no: n, a: null, p: null, type: 'mc' });
        // 공통에서 같은 번호 제거
        K.items = K.items.filter(it => it.no < +m[1] || it.no > +m[2]);
      }
      K.electives.push({ label, items });
      tab = K.electives.length;
    } else {
      const e = K.electives[v];
      const act = await choose(e.label, [{ label: '이름 변경', value: 'rename' }, { label: '삭제', value: 'del' }], null);
      if (act === 'rename') { const n = prompt('이름', e.label); if (n) e.label = n; }
      if (act === 'del') { K.electives.splice(v, 1); tab = 0; }
    }
    dirty = true; render();
  });

  // ---------------- AI 정답표 인식
  async function runAI(files) {
    if (!files || !files.length) return;
    const st = Settings.get();
    const box = $('#kAiStatus');
    if (!st.apiKey) { box.innerHTML = `<div class="banner bad"><svg><use href="#i-warn"/></svg><div class="b-text">설정에서 Gemini API 키를 먼저 입력하세요.</div></div>`; return; }
    if (!navigator.onLine) { box.innerHTML = `<div class="banner bad"><svg><use href="#i-warn"/></svg><div class="b-text">인터넷 연결이 필요합니다.</div></div>`; return; }
    box.innerHTML = `<div class="banner info"><svg><use href="#i-sparkdoc"/></svg><div class="b-text">${esc((root.Gemini.MODELS[st.model] || { name: st.model }).name)}가 정답표를 읽는 중입니다… (10~30초)</div></div>`;
    try {
      const r = await root.Gemini.extractAnswerKey(Array.from(files), { apiKey: st.apiKey, model: st.model });
      const n = r.items.length + r.electives.reduce((s, e) => s + e.items.length, 0);
      if (!n) throw new Error('정답을 찾지 못했습니다. 정답표가 잘 보이게 다시 찍어 보세요.' + (r.note ? ` (${r.note})` : ''));
      merge(r);
      if (r.title && !K.name) K.name = r.title;
      if (r.subject && !K.subject) K.subject = r.subject;
      dirty = true; tab = 0; render();
      const miss = countMissingPoints(K);
      box.innerHTML = `<div class="banner ok"><svg><use href="#i-check"/></svg><div class="b-text"><b>${n}문항</b>을 읽었습니다${r.electives.length ? ` (선택과목 ${r.electives.map(e => esc(e.label)).join(', ')})` : ''}. 원본과 대조한 뒤 저장하세요.${!r.pointsVisible || miss ? '<br>배점이 보이지 않은 문항은 비워 두었습니다 — 이대로 저장하면 맞은 개수만 채점합니다.' : ''}${r.note ? `<br><span style="color:var(--text-2)">${esc(r.note)}</span>` : ''}</div></div>`;
      haptic('success');
    } catch (e) {
      box.innerHTML = `<div class="banner bad"><svg><use href="#i-warn"/></svg><div class="b-text">${esc(e.message)}</div></div>`;
    }
  }
  function merge(r) {
    const mergeList = (dst, src) => {
      const map = new Map(dst.map(it => [it.no, it]));
      src.forEach(it => { if (map.has(it.no)) Object.assign(map.get(it.no), it); else dst.push(Object.assign({}, it)); });
      dst.sort((a, b) => a.no - b.no);
    };
    if (!allItems(K).some(it => it.a != null)) {
      // 비어 있는 정답이면 AI 결과 구조를 그대로 사용
      K.items = r.items.map(it => Object.assign({}, it));
      K.electives = r.electives.map(e => ({ label: e.label, items: e.items.map(it => Object.assign({}, it)) }));
      if (K.electives.length) { const en = new Set(K.electives[0].items.map(it => it.no)); K.items = K.items.filter(it => !en.has(it.no)); }
      return;
    }
    mergeList(K.items, r.items);
    r.electives.forEach(e => {
      const t = K.electives.find(x => x.label.replace(/\s/g, '') === e.label.replace(/\s/g, ''));
      if (t) mergeList(t.items, e.items); else K.electives.push({ label: e.label, items: e.items.map(it => Object.assign({}, it)) });
    });
  }
  $('#kAiFiles').addEventListener('change', e => { runAI(e.target.files); e.target.value = ''; });
  $('#kAiCamera').addEventListener('change', e => { runAI(e.target.files); e.target.value = ''; });

  // ---------------- 저장·삭제
  $('#kSave').addEventListener('click', () => {
    K.name = $('#kName').value.trim() || `${$('#kSubject').value.trim() || '정답'} ${fmtDate(Date.now(), false)}`;
    K.subject = $('#kSubject').value.trim();
    const code = parseInt($('#kCode').value, 10);
    K.code = Number.isFinite(code) ? code : null;
    const cuts = $$('#kCuts [data-cut]').map(i => { const v = parseInt(i.value, 10); return Number.isFinite(v) ? v : null; });
    K.cutoffs = cuts.some(v => v != null) ? cuts : null;
    if (!Keys.save(K)) { toast('저장 공간이 부족합니다'); return; }
    core().S.keyId = K.id;
    Settings.set({ lastKeyId: K.id });
    dirty = false;
    toast('정답을 저장했습니다');
    const back = fromResult;
    core().back();
    if (back && core().S.cur) {
      const rec = core().S.cur;
      rec.keyIds = rec.res.sections.map((s, i) => rec.keyIds[i] || K.id);
      rec.keySnaps = rec.keyIds.map(id => (id ? JSON.parse(JSON.stringify(Keys.get(id))) : null));
      setTimeout(() => { core().renderResult(); core().saveCurrent(); }, 60);
    }
  });
  async function removeKey() {
    if (!Keys.get(K.id)) { dirty = false; core().back(); return; }
    if (!(await confirmSheet('정답 삭제', `'${K.name || '이름 없음'}'을(를) 삭제할까요? 이미 채점한 기록은 그대로 남습니다.`, '삭제', true))) return;
    Keys.remove(K.id); dirty = false;
    if (core().S.keyId === K.id) core().S.keyId = '';
    core().back();
  }

  root.KeyEditor = { renderList, create, open, dirty: () => dirty };
})(self);
