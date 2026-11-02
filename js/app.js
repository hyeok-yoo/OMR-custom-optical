/* OMR 채점 — 앱 셸, 판독 흐름, 결과 화면, 설정 */
(function (root) {
  'use strict';
  const VERSION = '2.1.0';
  const { $, $$, toast, haptic, Sheet, choose, confirmSheet, esc, fmtDate, CIRCLED, countUp } = root.UI;
  const { Settings, Keys, Layouts, History, Sessions, uid } = root.Store;
  const E = root.OMREngine, G = root.Grading;
  const MAX_DIM = 3000;
  // 제품 구분: 'personal'(개인용, 내 답안지만) / 'academy'(학원용, 반 전체 연속 채점·성명 판독)
  // 학원용은 나중에 따로 출시할 예정이라 기능은 남겨 두고 화면에서만 숨긴다.
  const EDITION = root.OMR_EDITION || 'personal';
  const PERSONAL = EDITION === 'personal';
  document.documentElement.dataset.edition = EDITION;
  const myName = () => (root.OMRT && root.OMRT.getName && root.OMRT.getName()) || '';

  root.AppSettings = () => Settings.get();
  root.AppSettings.set = p => Settings.set(p);
  // 이용 기록(telemetry.js, 모듈이라 늦게 로드됨)이 준비되기 전의 이벤트는 큐에 모아 둔다
  root.OMRT = root.OMRT || { q: [], track(ev) { this.q.push(ev); }, enabled: false };

  const S = {
    view: 'scan', stack: [],
    mode: 'single',
    keyId: '',
    src: null, srcCanvas: null, srcFile: null,
    cur: null,            // 현재 결과
    session: null,        // 진행 중인 반 채점
    corners: null
  };

  // ================================================================ 테마
  function applyTheme() {
    const t = Settings.get().theme;
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }
  applyTheme();

  // ================================================================ 화면 전환
  const TABS = ['scan', 'keys', 'history', 'settings'];
  const BACK_LABEL = { scan: '채점', keys: '정답', history: '기록', settings: '설정', result: '결과', admin: '관리자' };
  function go(view, push) {
    if (TABS.includes(view) && !push) S.stack = [];
    else if (push) S.stack.push(S.view);
    S.view = view;
    $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + view));
    const sec = $('#view-' + view);
    $('#navTitle').textContent = sec ? sec.dataset.title : '';
    const nav = $('#nav');
    nav.classList.toggle('always-title', !(sec && sec.dataset.large));
    nav.classList.remove('show-title', 'scrolled');
    const prev = S.stack[S.stack.length - 1];
    $('#backBtn').classList.toggle('hidden', !S.stack.length);
    $('#backLabel').textContent = BACK_LABEL[prev] || '뒤로';
    $('#navActions').innerHTML = '';
    const tab = TABS.includes(view) ? view : (S.stack.find(v => TABS.includes(v)) || 'scan');
    $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $('#app').classList.toggle('hide-tabs', !TABS.includes(view));
    window.scrollTo(0, 0);
    syncHistory();
    const r = renderers[view]; r && r();
  }
  // Android 뒤로가기: 하위 화면에 있는 동안 history 항목 하나를 유지
  let hasState = false, ignorePop = false;
  function syncHistory() { if (S.stack.length && !hasState) { history.pushState({ omr: 1 }, ''); hasState = true; } }
  function back() {
    if (S.view === 'keyedit' && root.KeyEditor && root.KeyEditor.dirty() && !confirm('저장하지 않은 변경 사항이 있습니다. 나갈까요?')) return false;
    const prev = S.stack.pop();
    go(prev || 'scan', false);
    if (S.stack.length) { $('#backBtn').classList.remove('hidden'); $('#backLabel').textContent = BACK_LABEL[S.stack[S.stack.length - 1]] || '뒤로'; }
    if (!S.stack.length && hasState) { hasState = false; ignorePop = true; history.back(); }
    return true;
  }
  function pushView(view) { go(view, true); }
  function resetTo(base, view) { S.stack = [base]; go(view, false); S.stack = [base]; $('#backBtn').classList.remove('hidden'); $('#backLabel').textContent = BACK_LABEL[base]; syncHistory(); }
  window.addEventListener('popstate', () => {
    if (ignorePop) { ignorePop = false; return; }
    hasState = false;
    if (Sheet.isOpen) { Sheet.close(); syncHistory(); return; }
    if (root.Camera.isOpen) { root.Camera.close(); syncHistory(); return; }
    if (S.stack.length) { back(); syncHistory(); }
  });
  $('#backBtn').addEventListener('click', () => back());
  $('#tabbar').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    // 넓은 화면에서는 하위 화면에서도 사이드바가 보이므로 저장 안 한 편집을 지킨다
    if (S.view === 'keyedit' && root.KeyEditor && root.KeyEditor.dirty() && !confirm('저장하지 않은 변경 사항이 있습니다. 나갈까요?')) return;
    go(b.dataset.tab, false);
  });
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    $('#nav').classList.toggle('scrolled', y > 2);
    $('#nav').classList.toggle('show-title', y > 44);
  }, { passive: true });
  function navAction(label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    $('#navActions').appendChild(b);
  }

  // ================================================================ 워커
  let worker = null, reqId = 0;
  const pending = {};
  function getWorker() {
    if (worker) return worker;
    worker = new Worker('js/worker.js');
    worker.onmessage = e => {
      const p = pending[e.data.id];
      if (!p) return;
      if (e.data.type === 'log') p.onlog && p.onlog(e.data.msg);
      else { delete pending[e.data.id]; p.resolve(e.data); }
    };
    worker.onerror = e => {
      Object.keys(pending).forEach(id => { pending[id].resolve({ ok: false, error: '판독 엔진 오류: ' + (e.message || '') }); delete pending[id]; });
      worker = null;
    };
    return worker;
  }
  function runWorker(type, img, opts, onlog, copy) {
    return new Promise(resolve => {
      const id = ++reqId;
      pending[id] = { resolve, onlog };
      const buf = copy ? img.data.buffer.slice(0) : img.data.buffer;
      getWorker().postMessage({ id, type, width: img.width, height: img.height, buffer: buf, opts }, [buf]);
    });
  }

  // ================================================================ 이미지
  root.loadImageBitmap = async function (file) {
    if (root.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* 다음 */ }
      try { return await createImageBitmap(file); } catch (e) { /* 다음 */ }
    }
    return new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      img.onerror = () => rej(new Error('이미지를 열 수 없습니다. JPG·PNG 사진을 사용하세요.'));
      img.src = url;
    });
  };
  async function toImage(source) {
    let bmp = source;
    if (!(source instanceof HTMLCanvasElement)) bmp = await root.loadImageBitmap(source);
    const s = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return { canvas: c, data: ctx.getImageData(0, 0, c.width, c.height) };
  }

  // ================================================================ 채점 홈
  function currentKey() { return S.keyId ? Keys.get(S.keyId) : null; }
  function renderScan() {
    const k = currentKey();
    $('#keyPickValue').textContent = k ? (k.name || '이름 없음') : '선택 안 함';
    $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
    $('#pickPhoto').multiple = S.mode === 'batch';
    renderSessionCard();
    History.all().then(list => {
      const recent = list.filter(r => !r.sessionId).slice(0, 5);
      $('#recentTitle').classList.toggle('hidden', !recent.length);
      $('#scanGuide').classList.toggle('hidden', !!recent.length);
      $('#recentList').innerHTML = recent.map(historyRow).join('');
    }).catch(() => {});
  }
  function historyRow(r) {
    const big = r.summary && r.summary.hasKey ? (r.summary.hasPoints ? `${r.summary.total}<small>점</small>` : `${r.summary.right}<small>/${r.summary.graded}</small>`) : `<small>정답 없음</small>`;
    const title = PERSONAL ? (r.keyName || r.profileLabel || '답안지') : (r.name || r.keyName || r.profileLabel || '답안지');
    const sub = PERSONAL ? [fmtDate(r.date), r.keyName ? r.profileLabel : ''].filter(Boolean).join(' · ')
      : [fmtDate(r.date), r.name && r.keyName ? r.keyName : r.profileLabel].filter(Boolean).join(' · ');
    return `<button class="row row-tap" data-hist="${esc(r.id)}"><span class="row-main"><span class="t">${esc(title)}</span><span class="row-sub">${esc(sub)}</span></span><span class="big-num">${big}</span><svg class="chev"><use href="#i-chev"/></svg></button>`;
  }
  $('#recentList').addEventListener('click', e => { const b = e.target.closest('[data-hist]'); if (b) openHistory(b.dataset.hist); });
  $('#keyPick').addEventListener('click', async () => {
    const keys = Keys.all();
    const opts = [{ label: '선택 안 함', note: '마킹만 판독합니다', value: '' }].concat(keys.map(k => ({ label: k.name || '이름 없음', note: [k.subject, keySummary(k)].filter(Boolean).join(' · '), value: k.id })));
    opts.push({ label: '새 정답 만들기', value: '__new' });
    const v = await choose('정답 선택', opts, S.keyId);
    if (v == null) return;
    if (v === '__new') { setTimeout(() => root.KeyEditor.create(), 260); return; }
    S.keyId = v; Settings.set({ lastKeyId: v }); renderScan();
  });
  function keySummary(k) {
    const n = (k.items || []).length + (k.electives && k.electives[0] ? k.electives[0].items.length : 0);
    return `${n}문항${(k.electives || []).length ? ` · 선택 ${k.electives.length}` : ''}`;
  }
  $('#modeSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.mode = b.dataset.mode;
    renderScan();
    if (S.mode === 'batch') toast('반 전체 모드: 촬영할 때마다 이름을 읽어 자동으로 기록합니다');
  });
  $('#startCamera').addEventListener('click', () => startCamera());
  $('#pickPhoto').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []); e.target.value = '';
    if (!files.length) return;
    if (S.mode === 'batch' || files.length > 1) { await batchFiles(files); return; }
    handleSource(files[0]);
  });
  $$('.retake').forEach(inp => inp.addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) handleSource(f); }));

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('#pickPhoto').click(); return; }
    const batch = S.mode === 'batch';
    if (batch) ensureSession();
    try {
      await root.Camera.open({
        batch,
        count: () => (S.session ? S.session.records.length : 0),
        onCapture: src => batch ? batchCapture(src) : handleSource(src),
        onClose: () => { if (batch) renderScan(); }
      });
    } catch (err) { toast(err.message, 3500); }
  }

  // ================================================================ 판독 흐름
  async function handleSource(source, corners) {
    S.srcFile = source instanceof Blob ? source : null;
    resetTo('scan', 'process');
    $('#processSteps').innerHTML = '<li>사진 불러오는 중</li>';
    try {
      if (!corners) {
        const { canvas, data } = await toImage(source);
        S.srcCanvas = canvas; S.src = data;
      }
      const pc = $('#processPreview');
      pc.width = Math.min(1200, S.srcCanvas.width); pc.height = Math.round(pc.width * S.srcCanvas.height / S.srcCanvas.width);
      pc.getContext('2d').drawImage(S.srcCanvas, 0, 0, pc.width, pc.height);
      const r = await analyzeImage(S.src, corners, m => $('#processSteps').insertAdjacentHTML('beforeend', `<li>${esc(m)}</li>`));
      if (!r.ok) { showFail(r); return; }
      await revealSweep(r);
      await openResult(r, { fresh: true });
    } catch (err) {
      showFail({ error: err.message || String(err) });
    }
  }
  async function analyzeImage(img, corners, onlog) {
    const st = Settings.get();
    const opts = {};
    if (st.thrMode === 'manual') opts.threshold = st.thr / 100;
    if (corners) opts.corners = corners;
    const r = await runWorker('analyze', img, opts, onlog, true);
    if (!r.ok) return r;
    const wc = document.createElement('canvas');
    wc.width = r.warped.width; wc.height = r.warped.height;
    wc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.warped.buffer), wc.width, wc.height), 0, 0);
    r.warpedCanvas = wc;
    delete r.warped;
    const lay = Layouts.get(r.fingerprint);
    if (lay) E.relabel(r, lay);
    return r;
  }
  root.App = { locate: img => runWorker('locate', img, {}, null, false) };

  // 시그니처: 펼친 답안지 위로 스캔 빛줄기가 지나가며 인식한 마킹을 표시
  function revealSweep(r) {
    return new Promise(resolve => {
      if (root.UI.reduced()) { resolve(); return; }
      const pc = $('#processPreview');
      const W = Math.min(1200, r.warpedCanvas.width), k = W / r.warpedCanvas.width;
      pc.width = W; pc.height = Math.round(r.warpedCanvas.height * k);
      pc.style.opacity = '1'; pc.style.filter = 'none';
      $('.scanbar').style.display = 'none';
      const ctx = pc.getContext('2d');
      const marks = [];
      r.questions.forEach(q => {
        const cells = q.type === 'mc' ? (q.marked || []).map(c => q.cells[c - 1]) : (q.cols || []).flatMap(c => (c.marked || []).map(i => c.cells[i]));
        cells.forEach(c => c && marks.push(c));
      });
      const t0 = performance.now(), dur = 760;
      const frame = now => {
        const t = Math.min(1, (now - t0) / dur), ey = 1 - Math.pow(1 - t, 3);
        const y = ey * pc.height;
        ctx.drawImage(r.warpedCanvas, 0, 0, pc.width, pc.height);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(0, y, pc.width, pc.height - y);
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = '#17a35a';
        marks.forEach(c => { if (c.y * k < y) { ctx.beginPath(); ctx.ellipse(c.x * k, c.y * k, r.bubble.w * k * 0.7, r.bubble.h * k * 0.62, 0, 0, Math.PI * 2); ctx.stroke(); } });
        ctx.fillStyle = 'rgba(216,50,91,0.9)';
        ctx.fillRect(0, y - 1, pc.width, 2);
        if (t < 1) requestAnimationFrame(frame); else setTimeout(resolve, 160);
      };
      requestAnimationFrame(frame);
    });
  }
  function resetProcessPreview() { const pc = $('#processPreview'); pc.style.opacity = ''; pc.style.filter = ''; $('.scanbar').style.display = ''; }

  function showFail(r) {
    resetProcessPreview();
    resetTo('scan', 'fail');
    $('#failMsg').textContent = r.error || '알 수 없는 오류';
    $('#failSteps').innerHTML = $('#processSteps').innerHTML;
    const st = Settings.get();
    $('#failAI').classList.toggle('hidden', !(st.apiKey && S.srcCanvas));
    $('#failManual').classList.toggle('hidden', !S.src);
    haptic('warn');
  }
  $('#failManual').addEventListener('click', () => openManual());
  $('#toManual').addEventListener('click', () => openManual());
  $('#failAI').addEventListener('click', () => aiDirectRead());

  // ================================================================ 결과
  function keysForSections(res, keyIdOverride) {
    const base = keyIdOverride != null ? Keys.get(keyIdOverride) : currentKey();
    const all = Keys.all();
    return res.sections.map((sec, i) => {
      if (sec.code != null) { const m = all.find(k => k.code != null && +k.code === +sec.code); if (m) return m; }
      return i === 0 || !res.sections.some(s => s.code != null) ? base : base;
    });
  }
  async function openResult(r, o) {
    o = o || {};
    resetProcessPreview();
    const keys = keysForSections(r);
    const el = r.elective;
    const detectedEl = el && el.marked && el.marked.length === 1 ? el.marked[0] - 1 : null;
    const rec = {
      id: uid('h'), date: Date.now(), sessionId: o.sessionId || null,
      res: r, edits: {},
      keyIds: keys.map(k => (k ? k.id : '')),
      keySnaps: keys.map(k => (k ? JSON.parse(JSON.stringify(k)) : null)),
      electiveIdx: detectedEl, electiveDetected: detectedEl,
      ai: 'idle'
    };
    S.cur = rec;
    root.OMRT.track(r.ai ? 'ai' : 'scan');
    if (!o.silent) {
      S.stack = ['scan'];
      go('result', false); S.stack = ['scan'];
      $('#backBtn').classList.remove('hidden'); $('#backLabel').textContent = '채점';
      renderResult(true);
    }
    await saveCurrent();
    maybeAILayout(rec, o.silent);
    return rec;
  }

  function answersOf(rec) {
    return rec.res.questions.map(q => {
      const id = q.blockId != null ? `${q.blockId}:${q.row}` : q.key;
      const ed = rec.edits[id];
      const a = Object.assign({}, q, { editId: id });
      if (ed) { a.edited = true; if (q.type === 'sa') { a.value = ed.value; a.answer = ed.value == null ? 0 : ed.value; } else a.answer = ed.answer; }
      if (q.type === 'mc' && !ed && q.status === 'multi' && Settings.get().multi === 'darkest' && q.scores) {
        const vals = q.marked.map(c => ({ c, v: q.scores[c - 1] })).sort((x, y) => y.v - x.v);
        if (vals[0].v >= vals[1].v * 2) { a.answer = vals[0].c; a.status = 'check'; a.note = '더 진한 쪽'; }
      }
      return a;
    });
  }
  function gradeRec(rec) {
    const keys = rec.keySnaps.map((k, i) => (rec.keyIds[i] ? (Keys.get(rec.keyIds[i]) || k) : null));
    return G.grade(answersOf(rec), keys, rec.electiveIdx);
  }
  function electiveLabels(rec) {
    const k = rec.keyIds[0] ? Keys.get(rec.keyIds[0]) || rec.keySnaps[0] : null;
    if (k && k.electives && k.electives.length) return k.electives.map(e => e.label);
    if (rec.res.elective) return rec.res.elective.labels;
    return [];
  }

  function renderResult(first) {
    const rec = S.cur; if (!rec) return;
    const r = rec.res, g = gradeRec(rec);
    rec.graded = g;
    // 이름·수험번호
    const who = [];
    // 개인용은 답안지 성명 칸을 읽지 않는다 — 본인 답안지로 본다
    if (PERSONAL) who.push(`<span class="name">${esc(myName() || '내 답안지')}</span>`);
    else {
      if (r.name && r.name.text) who.push(`<span class="name">${esc(r.name.text)}</span>`);
      if (r.examNo && r.examNo.text) who.push(`<span class="meta num">${esc(r.examNo.text)}</span>`);
    }
    const k0 = rec.keyIds[0] ? Keys.get(rec.keyIds[0]) : null;
    who.push(`<span class="meta">${esc(k0 ? k0.name || '정답' : (r.profile.subject || r.profile.label))}</span>`);
    if (r.ai) who.push('<span class="tag">AI 판독</span>');
    $('#who').innerHTML = who.join('');
    // 점수
    const a = g.all;
    let big = 0, of = '', sub = [];
    if (a.hasKey && a.hasPoints) {
      big = a.total; of = `/ ${a.max}점`;
      sub.push(`맞은 문항 <b>${a.right}</b>/${a.graded}`);
      const lvl = k0 && G.gradeLevel(a.total, k0.cutoffs);
      if (lvl) sub.push(`예상 <b>${lvl}등급</b>`);
    } else if (a.hasKey) {
      big = a.right; of = `/ ${a.graded} 정답`;
      sub.push(`정답률 <b>${a.graded ? Math.round(a.right / a.graded * 100) : 0}%</b>`);
    } else {
      big = answersOf(rec).filter(q => q.type === 'sa' ? q.value != null : q.answer > 0).length;
      of = `/ ${r.questions.length} 문항 표기`;
    }
    if (g.sections.length > 1) g.sections.forEach(s => sub.push(`${esc(r.sections[s.section] && r.sections[s.section].title || `구역 ${s.section + 1}`)} <b>${s.hasPoints ? s.total + '점' : s.right + '/' + s.graded}</b>`));
    const sn = $('#scoreNum');
    if (first) countUp(sn, big, 800); else sn.textContent = big;
    $('#scoreOf').textContent = of;
    $('#scoreSub').innerHTML = sub.join('');
    renderBanners(rec, g);
    renderElective(rec);
    renderSectionKeys(rec);
    renderItems(rec, g);
    drawOverlay(rec, g);
    $('#toManual').classList.toggle('hidden', !S.src || !!r.ai);
    $('#nextScanBtn').classList.toggle('hidden', false);
    navActionsResult();
  }
  function navActionsResult() {
    $('#navActions').innerHTML = '';
    if (S.cur && !S.cur.res.ai) navAction('번호', () => editLayout());
  }

  function banner(kind, icon, html, actLabel, act) {
    const id = 'b' + Math.random().toString(36).slice(2, 8);
    setTimeout(() => { const b = document.getElementById(id); if (b && act) b.addEventListener('click', act); }, 0);
    return `<div class="banner ${kind}"><svg><use href="#${icon}"/></svg><div class="b-text">${html}</div>${actLabel ? `<button class="b-act" id="${id}">${esc(actLabel)}</button>` : ''}</div>`;
  }
  function renderBanners(rec, g) {
    const r = rec.res, out = [];
    const a = g.all;
    if (a.hasKey && !a.hasPoints) out.push(banner('warn', 'i-warn', '<b>배점 정보가 없어</b> 점수 대신 맞은 개수만 표시합니다.', '배점 입력', () => root.KeyEditor.open(rec.keyIds.find(Boolean), { focusPoints: true })));
    if (!a.hasKey) out.push(banner('info', 'i-key', '정답을 선택하면 바로 채점됩니다.', '정답 선택', () => pickKeyForResult()));
    const checks = answersOf(rec).filter(q => !q.edited && (q.status === 'check' || q.status === 'multi'));
    if (checks.length) out.push(banner('warn', 'i-warn', `확인이 필요한 문항 <b>${checks.length}개</b> · ${checks.slice(0, 8).map(q => q.no).join(', ')}${checks.length > 8 ? ' …' : ''}`, '보기', () => { $('#onlyWrong').checked = true; renderItems(rec, gradeRec(rec)); $('#tab-items').scrollIntoView({ behavior: 'smooth' }); }));
    (r.warnings || []).forEach(w => out.push(banner('bad', 'i-warn', esc(w))));
    if (r.ai) out.push(banner('bad', 'i-warn', 'AI가 사진을 보고 직접 읽은 결과입니다. 광학 판독보다 정확도가 낮으니 <b>모든 문항을 확인</b>하세요.'));
    if (rec.ai === 'running') out.push(banner('info', 'i-sparkdoc', 'AI가 처음 보는 양식의 문항 번호를 확인하는 중입니다…'));
    if (rec.ai === 'done') out.push(banner('ok', 'i-check', 'AI로 양식을 확인했습니다. 같은 양식은 다음부터 바로 인식합니다.', '번호 수정', () => editLayout()));
    if (rec.ai === 'error') out.push(banner('bad', 'i-warn', 'AI 양식 확인 실패: ' + esc(rec.aiError || ''), '다시', () => maybeAILayout(rec, false, true)));
    if (rec.ai === 'idle' && !Layouts.get(r.fingerprint) && needsAI(r) && r.profile.id !== 'generic' && !Settings.get().apiKey) out.push(banner('info', 'i-sparkdoc', `문항 번호를 자동으로 추정했습니다 (${esc(r.profile.label)}). 번호가 다르면 고치거나 Gemini 키를 설정하세요.`, '번호 수정', () => editLayout()));
    $('#banners').innerHTML = out.join('');
  }

  function renderElective(rec) {
    const labels = electiveLabels(rec);
    const box = $('#electiveBox');
    if (!labels.length) { box.innerHTML = ''; return; }
    const det = rec.electiveDetected;
    box.innerHTML = `<div class="sec-head"><h3>선택과목</h3><span>${det != null ? '답안지 표기 인식' : '표기 없음 · 직접 선택'}</span></div>
      <div class="seg seg-full" style="margin-top:0">${labels.map((l, i) => `<button data-el="${i}" class="${rec.electiveIdx === i ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
    box.querySelectorAll('[data-el]').forEach(b => b.addEventListener('click', () => { rec.electiveIdx = +b.dataset.el; renderResult(); saveCurrent(); }));
  }

  function renderSectionKeys(rec) {
    const r = rec.res, box = $('#sectionKeys');
    if (r.sections.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="group">${r.sections.map((s, i) => {
      const k = rec.keyIds[i] ? Keys.get(rec.keyIds[i]) : null;
      return `<button class="row row-tap" data-sec="${i}"><span class="row-label">${esc(s.title || `구역 ${i + 1}`)}${s.code != null ? ` <span class="small" style="color:var(--text-2)">과목번호 ${s.code}</span>` : ''}</span><span class="row-value">${esc(k ? k.name : '정답 선택')}</span><svg class="chev"><use href="#i-chev"/></svg></button>`;
    }).join('')}</div>`;
    box.querySelectorAll('[data-sec]').forEach(b => b.addEventListener('click', async () => {
      const i = +b.dataset.sec;
      const v = await choose(`${r.sections[i].title || '구역'} 정답`, [{ label: '선택 안 함', value: '' }].concat(Keys.all().map(k => ({ label: k.name || '이름 없음', note: k.code != null ? `과목번호 ${k.code}` : k.subject, value: k.id }))), rec.keyIds[i]);
      if (v == null) return;
      rec.keyIds[i] = v; rec.keySnaps[i] = v ? JSON.parse(JSON.stringify(Keys.get(v))) : null;
      renderResult(); saveCurrent();
    }));
  }

  async function pickKeyForResult() {
    const v = await choose('정답 선택', Keys.all().map(k => ({ label: k.name || '이름 없음', note: k.subject, value: k.id })).concat([{ label: '새 정답 만들기', value: '__new' }]), '');
    if (v == null) return;
    if (v === '__new') { setTimeout(() => root.KeyEditor.create(), 260); return; }
    S.keyId = v; Settings.set({ lastKeyId: v });
    const rec = S.cur;
    rec.keyIds = rec.res.sections.map((s, i) => rec.keyIds[i] || v);
    rec.keySnaps = rec.keyIds.map(id => (id ? JSON.parse(JSON.stringify(Keys.get(id))) : null));
    renderResult(); saveCurrent();
  }

  function renderItems(rec, g) {
    const only = $('#onlyWrong').checked;
    const r = rec.res;
    const html = g.sections.map(S2 => {
      const title = r.sections[S2.section] && r.sections[S2.section].title;
      const k = S2.key;
      const head = (g.sections.length > 1 || title) ? `<div class="sec-head"><h3>${esc(title || '문항')}</h3><span>${k ? esc(k.name) : ''}</span></div>` : '<div style="height:12px"></div>';
      const cells = S2.rows.map(row => {
        const q = row.q;
        const need = !q.edited && (q.status === 'check' || q.status === 'multi');
        if (only && !(need || (row.graded && !row.ok))) return '';
        let cls = 'item';
        if (row.graded) cls += row.ok ? ' ok' : ' bad';
        if (need) cls += ' chk';
        if (q.edited) cls += ' edited';
        const mine = q.type === 'sa'
          ? (q.value == null ? '–' : q.value === -1 ? '중복' : String(q.value))
          : (q.answer > 0 ? CIRCLED[q.answer] || q.answer : q.answer === -1 ? '중복' : '–');
        const cor = row.graded && !row.ok ? `정답 ${q.type === 'sa' ? row.correct : (CIRCLED[row.correct] || row.correct)}` : '';
        const flag = need ? (q.status === 'multi' ? '중복' : '확인') : '';
        return `<button class="${cls}" data-q="${esc(q.editId)}"><span class="no">${q.no}</span><span class="mine${q.type === 'sa' ? ' sa' : ''}">${esc(mine)}</span><span class="cor">${esc(cor)}</span>${flag && !cor && mine !== '중복' ? `<span class="flag">${flag}</span>` : ''}</button>`;
      }).join('');
      return head + `<div class="items">${cells || '<p class="footnote" style="grid-column:1/-1">해당 문항이 없습니다.</p>'}</div>`;
    }).join('');
    $('#itemSections').innerHTML = html;
  }
  $('#onlyWrong').addEventListener('change', () => S.cur && renderItems(S.cur, gradeRec(S.cur)));
  $('#itemSections').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) editItem(b.dataset.q); });
  $('#resultSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#resultSeg button').forEach(x => x.classList.toggle('on', x === b));
    $('#tab-items').classList.toggle('hidden', b.dataset.tab !== 'items');
    $('#tab-image').classList.toggle('hidden', b.dataset.tab !== 'image');
  });
  $('#sheetView').addEventListener('dblclick', () => $('#sheetView').classList.toggle('zoomed'));

  function editItem(editId) {
    const rec = S.cur;
    const q = answersOf(rec).find(x => x.editId === editId);
    if (!q) return;
    const k = G.keyItem(rec.keySnaps[q.section] && (Keys.get(rec.keyIds[q.section]) || rec.keySnaps[q.section]), q.no, rec.electiveIdx);
    const scores = q.type === 'mc' && q.scores ? `<div class="score-list">${q.scores.map((v, i) => `<span>${CIRCLED[i + 1]} ${Math.round(v * 100)}%</span>`).join('')}</div>` : '';
    const corr = k && k.a != null ? ` · 정답 ${q.type === 'sa' ? k.a : CIRCLED[k.a]}${k.p ? ` (${k.p}점)` : ''}` : '';
    let body;
    if (q.type === 'sa') {
      body = Sheet.open(`<h3>${q.no}번 답 수정</h3><p class="sub">단답형${corr}</p>
        <input class="field" id="saEdit" inputmode="numeric" value="${q.value != null && q.value >= 0 ? q.value : ''}" placeholder="비우면 무응답">
        <div class="btns"><button class="btn btn-primary btn-lg" id="saOk">적용</button></div>`);
      body.querySelector('#saOk').addEventListener('click', () => {
        const v = body.querySelector('#saEdit').value.trim();
        rec.edits[editId] = { value: v === '' ? null : parseInt(v, 10) };
        Sheet.close(); renderResult(); saveCurrent();
      });
      setTimeout(() => body.querySelector('#saEdit').focus(), 300);
    } else {
      const n = q.options || 5;
      body = Sheet.open(`<h3>${q.no}번 답 수정</h3><p class="sub">버블별 검은 비율${corr}</p>${scores}
        <div class="pick-grid">${Array.from({ length: n }, (_, i) => `<button data-v="${i + 1}" class="${q.answer === i + 1 ? 'on' : ''}">${CIRCLED[i + 1]}</button>`).join('')}<button data-v="0" class="blank ${q.answer === 0 ? 'on' : ''}">무응답</button></div>
        ${q.edited ? '<div class="btns"><button class="btn btn-plain" id="undoEdit">판독값으로 되돌리기</button></div>' : ''}`);
      body.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => {
        rec.edits[editId] = { answer: +b.dataset.v };
        haptic(); Sheet.close(); renderResult(); saveCurrent();
      }));
      const u = body.querySelector('#undoEdit');
      u && u.addEventListener('click', () => { delete rec.edits[editId]; Sheet.close(); renderResult(); saveCurrent(); });
    }
  }

  // 판독 이미지 오버레이
  function drawOverlay(rec, g) {
    const cv = $('#overlay'), ctx = cv.getContext('2d');
    const r = rec.res;
    if (!r.warpedCanvas) {
      if (rec.thumb) { const img = new Image(); img.onload = () => { cv.width = img.width; cv.height = img.height; ctx.drawImage(img, 0, 0); }; img.src = rec.thumb; }
      else if (S.srcCanvas && r.ai) { cv.width = Math.min(1600, S.srcCanvas.width); cv.height = Math.round(cv.width * S.srcCanvas.height / S.srcCanvas.width); ctx.drawImage(S.srcCanvas, 0, 0, cv.width, cv.height); }
      $('#alignNote').textContent = r.ai ? 'AI 판독은 위치 표시가 없습니다.' : '저장된 판독 이미지';
      return;
    }
    renderOverlayTo(cv, rec, g, 1);
    const m = { marks: '타이밍 마크·모서리 마크로 정합', track: '모서리 마크 없이 근사 정합', scan: '스캔 이미지로 처리', manual: '수동 기준점으로 정합' }[r.method] || '';
    $('#alignNote').textContent = `${m} · 판정 기준 ${Math.round(r.threshold * 100)}% · 두 번 탭하면 확대`;
  }
  function renderOverlayTo(cv, rec, g, scale) {
    const r = rec.res, wc = r.warpedCanvas;
    cv.width = Math.round(wc.width * scale); cv.height = Math.round(wc.height * scale);
    const ctx = cv.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.drawImage(wc, 0, 0);
    const bw = r.bubble.w, bh = r.bubble.h;
    const ring = (c, color, dash, lw) => {
      ctx.beginPath(); ctx.setLineDash(dash ? [6, 4] : []); ctx.strokeStyle = color; ctx.lineWidth = lw || 3;
      ctx.ellipse(c.x, c.y, bw * 0.72, bh * 0.64, 0, 0, Math.PI * 2); ctx.stroke();
    };
    const rowsByKey = new Map();
    g.sections.forEach(s => s.rows.forEach(row => rowsByKey.set(row.q.editId, row)));
    answersOf(rec).forEach(q => {
      const row = rowsByKey.get(q.editId);
      const need = !q.edited && (q.status === 'check' || q.status === 'multi');
      if (q.type === 'mc') {
        (q.ambiguous || []).forEach(c => q.cells[c - 1] && ring(q.cells[c - 1], '#d8901a', false, 3));
        const marked = q.edited ? (q.answer > 0 ? [q.answer] : []) : (q.status === 'multi' ? q.marked : (q.answer > 0 ? [q.answer] : []));
        marked.forEach(c => q.cells[c - 1] && ring(q.cells[c - 1], row && row.graded ? (row.ok ? '#149a52' : '#e03b3b') : '#149a52', false, 3.5));
        if (row && row.graded && !row.ok && row.correct >= 1 && q.cells[row.correct - 1]) ring(q.cells[row.correct - 1], '#2c66d4', true, 3);
        if (need) {
          const c0 = q.cells[0], c1 = q.cells[q.cells.length - 1];
          ctx.setLineDash([]); ctx.strokeStyle = '#d8901a'; ctx.lineWidth = 2.5;
          ctx.strokeRect(c0.x - bw * 1.1, c0.y - bh * 0.9, c1.x - c0.x + bw * 2.2, bh * 1.8);
        }
      } else if (q.cols) {
        q.cols.forEach(col => (col.marked || []).forEach(i => col.cells[i] && ring(col.cells[i], row && row.graded ? (row.ok ? '#149a52' : '#e03b3b') : '#149a52', false, 3)));
      }
    });
    const info = '#2c66d4';
    if (r.name && !PERSONAL) r.name.cols.forEach(c => { if (c.pick >= 0) ring(c.cells[c.pick], info, false, 2.5); });
    if (r.examNo) r.examNo.digits.forEach(d => { const i = d.cells.findIndex(x => x.digit === d.digit); if (d.digit != null && i >= 0) ring(d.cells[i], info, false, 2.5); });
    if (r.elective) (r.elective.marked || []).forEach(m => ring(r.elective.cells[m - 1], info, false, 3));
    (r.stray || []).forEach(p => { ctx.setLineDash([]); ctx.strokeStyle = '#e03b3b'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(p.x - 12, p.y - 12); ctx.lineTo(p.x + 12, p.y + 12); ctx.moveTo(p.x + 12, p.y - 12); ctx.lineTo(p.x - 12, p.y + 12); ctx.stroke(); });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ================================================================ 저장
  function thumbOf(rec) {
    if (!rec.res.warpedCanvas) return rec.thumb || null;
    const c = document.createElement('canvas');
    renderOverlayTo(c, rec, rec.graded || gradeRec(rec), Math.min(1, 1300 / rec.res.warpedCanvas.width));
    return c.toDataURL('image/jpeg', 0.78);
  }
  function serializeRes(r) {
    const o = {};
    for (const k of Object.keys(r)) if (!['warpedCanvas', 'H', 'frame'].includes(k)) o[k] = r[k];
    return o;
  }
  async function saveCurrent() {
    const rec = S.cur; if (!rec) return;
    const g = rec.graded || gradeRec(rec);
    const k0 = rec.keyIds[0] ? Keys.get(rec.keyIds[0]) : null;
    const data = {
      id: rec.id, date: rec.date, sessionId: rec.sessionId,
      name: !PERSONAL && rec.res.name ? rec.res.name.text : '', examNo: !PERSONAL && rec.res.examNo ? rec.res.examNo.text : '',
      keyName: k0 ? k0.name : '', profileLabel: rec.res.profile.subject || rec.res.profile.label,
      fingerprint: rec.res.fingerprint,
      keyIds: rec.keyIds, keySnaps: rec.keySnaps, electiveIdx: rec.electiveIdx, electiveDetected: rec.electiveDetected,
      edits: rec.edits, res: serializeRes(rec.res),
      summary: Object.assign({}, g.all, { sections: g.sections.map(s => ({ section: s.section, total: s.total, max: s.max, right: s.right, graded: s.graded, hasPoints: s.hasPoints })) }),
      thumb: rec.thumbDirty === false ? rec.thumb : thumbOf(rec)
    };
    rec.thumb = data.thumb;
    try { await History.put(data); } catch (e) { toast('저장 실패: ' + e.message); }
  }
  async function openHistory(id) {
    const d = await History.get(id);
    if (!d) return;
    S.cur = { id: d.id, date: d.date, sessionId: d.sessionId, res: d.res, edits: d.edits || {}, keyIds: d.keyIds || [], keySnaps: d.keySnaps || [], electiveIdx: d.electiveIdx, electiveDetected: d.electiveDetected, thumb: d.thumb, ai: 'stored' };
    S.src = null; S.srcCanvas = null;
    pushView('result');
    renderResult(true);
  }
  root.AppOpenHistory = openHistory;

  // ================================================================ AI 양식 해석
  const STRONG = { korean: 45, math: 30, inquiry: 40 };
  function needsAI(r) { return !(STRONG[r.profile.id] && STRONG[r.profile.id] === r.questions.length); }
  async function maybeAILayout(rec, silent, force) {
    const r = rec.res, st = Settings.get();
    if (r.ai || !r.warpedCanvas) return;
    if (!force && (Layouts.get(r.fingerprint) || st.aiLayout !== 'auto' || !needsAI(r))) return;
    if (!st.apiKey || !navigator.onLine) return;
    rec.ai = 'running';
    if (S.cur === rec && !silent) renderBanners(rec, gradeRec(rec));
    try {
      const W = 1600, k = W / r.warpedCanvas.width;
      const c = document.createElement('canvas');
      c.width = W; c.height = Math.round(r.warpedCanvas.height * k);
      const ctx = c.getContext('2d');
      ctx.drawImage(r.warpedCanvas, 0, 0, c.width, c.height);
      ctx.font = 'bold 26px sans-serif';
      (r.blocks || []).forEach(b => {
        const pad = 26;
        const x0 = (b.x0 - r.bubble.w * 1.2) * k, y0 = (b.y0 - r.bubble.h) * k, x1 = (b.x1 + r.bubble.w * 1.2) * k, y1 = (b.y1 + r.bubble.h) * k;
        const col = b.type === 'mc' ? '#0a7cff' : b.type === 'sa' ? '#e0600a' : '#c0179b';
        ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.fillStyle = col; ctx.fillRect(x0, y0 - 32, ctx.measureText(b.id).width + 14, 32);
        ctx.fillStyle = '#fff'; ctx.fillText(b.id, x0 + 7, y0 - 7);
        void pad;
      });
      const res = await root.Gemini.interpretLayout(c, { apiKey: st.apiKey, model: st.model });
      const ids = new Set((r.blocks || []).map(b => b.id));
      const lay = {
        source: 'ai', subject: res.subject || '',
        sections: (res.sections && res.sections.length ? res.sections : ['']),
        blocks: (res.blocks || []).filter(b => ids.has(b.id) && b.firstNo > 0),
        shortAnswers: (res.shortAnswers || []).filter(b => ids.has(b.id) && b.no > 0),
        electiveLabels: res.electiveLabels || []
      };
      if (!lay.blocks.length && !lay.shortAnswers.length) throw new Error('문항 번호를 읽지 못했습니다');
      Layouts.set(r.fingerprint, lay);
      E.relabel(r, lay);
      rec.ai = 'done';
    } catch (e) {
      rec.ai = 'error'; rec.aiError = e.message;
    }
    if (S.cur === rec && S.view === 'result') renderResult();
    saveCurrent();
  }

  // 문항 번호 수정 (양식 학습)
  function editLayout() {
    const rec = S.cur, r = rec.res;
    const lay = Layouts.get(r.fingerprint) || {};
    const blocks = (r.blocks || []).filter(b => b.type !== 'elective');
    const qByBlock = id => r.questions.filter(q => q.blockId === id);
    const rowsHtml = blocks.map(b => {
      const qs = qByBlock(b.id);
      const first = qs.length ? Math.min(...qs.map(q => q.no)) : 1;
      const sec = qs.length ? qs[0].section : 0;
      return `<div class="row"><span class="row-main"><span class="t">${b.type === 'mc' ? `객관식 ${b.id}` : `단답형 ${b.id}`}</span><span class="row-sub">${b.type === 'mc' ? `${b.rows}문항 · 맨 위 번호` : '문항 번호'}</span></span>
        <input class="sa-input" style="max-width:80px" inputmode="numeric" data-blk="${b.id}" value="${first}">
        ${r.sections.length > 1 || (lay.sections || []).length > 1 ? `<input class="sa-input" style="max-width:56px" inputmode="numeric" data-sec="${b.id}" value="${sec + 1}" title="구역">` : ''}</div>`;
    }).join('');
    const body = Sheet.open(`<h3>문항 번호</h3><p class="sub">블록마다 맨 위 문항 번호를 확인하세요. 저장하면 같은 양식은 다음부터 자동으로 적용됩니다. ${r.sections.length > 1 ? '두 번째 칸은 구역 번호입니다.' : ''}</p>
      <div class="group">${rowsHtml}</div>
      <div class="btns"><button class="btn btn-primary btn-lg" id="layOk">저장</button>
      ${Settings.get().apiKey ? '<button class="btn btn-plain btn-lg" id="layAI">AI로 다시 확인</button>' : ''}
      ${Layouts.get(r.fingerprint) ? '<button class="btn btn-plain" id="layReset">자동 추정으로 되돌리기</button>' : ''}</div>`);
    body.querySelector('#layOk').addEventListener('click', () => {
      const nl = { source: 'user', sections: r.sections.map(s => s.title || ''), blocks: [], shortAnswers: [], electiveLabels: r.elective ? r.elective.labels : [], subject: lay.subject || '' };
      blocks.forEach(b => {
        const no = parseInt(body.querySelector(`[data-blk="${b.id}"]`).value, 10);
        const se = body.querySelector(`[data-sec="${b.id}"]`);
        const section = se ? Math.max(0, parseInt(se.value, 10) - 1 || 0) : (qByBlock(b.id)[0] || { section: 0 }).section;
        if (!(no > 0)) return;
        if (b.type === 'mc') nl.blocks.push({ id: b.id, firstNo: no, section }); else nl.shortAnswers.push({ id: b.id, no, section });
      });
      while (nl.sections.length < Math.max(1, ...nl.blocks.map(b => b.section + 1), ...nl.shortAnswers.map(b => b.section + 1))) nl.sections.push(`구역 ${nl.sections.length + 1}`);
      Layouts.set(r.fingerprint, nl);
      E.relabel(r, nl);
      rec.keyIds = r.sections.map((s, i) => rec.keyIds[i] || rec.keyIds[0] || '');
      rec.keySnaps = rec.keyIds.map(id => (id ? JSON.parse(JSON.stringify(Keys.get(id))) : null));
      Sheet.close(); renderResult(); saveCurrent(); toast('양식을 기억했습니다');
    });
    const ai = body.querySelector('#layAI');
    ai && ai.addEventListener('click', () => { Sheet.close(); maybeAILayout(rec, false, true); });
    const rs = body.querySelector('#layReset');
    rs && rs.addEventListener('click', () => { Layouts.remove(r.fingerprint); Sheet.close(); toast('저장된 번호를 지웠습니다. 다시 스캔하면 자동 추정으로 인식합니다.'); });
  }

  // ================================================================ AI 직접 판독 (최후 수단)
  async function aiDirectRead() {
    const st = Settings.get();
    if (!S.srcCanvas) return;
    resetTo('scan', 'process');
    $('#processSteps').innerHTML = `<li>${esc(root.Gemini.MODELS[st.model] ? root.Gemini.MODELS[st.model].name : st.model)}로 마킹을 읽는 중 (10~40초)</li>`;
    try {
      const blob = await new Promise(res => S.srcCanvas.toBlob(res, 'image/jpeg', 0.92));
      const d = await root.Gemini.directRead(blob, { apiKey: st.apiKey, model: st.model });
      const questions = (d.answers || []).filter(x => x.q > 0).map(x => ({
        key: `0:${x.q}`, section: 0, no: x.q, type: x.sa ? 'sa' : 'mc', options: 5, blockId: 'AI', row: x.q,
        answer: x.sa ? (x.a >= 0 ? x.a : 0) : x.a, value: x.sa ? (x.a >= 0 ? x.a : null) : undefined,
        status: x.unsure ? 'check' : (x.a === -1 ? 'multi' : 'ok'), marked: [], ambiguous: [], cells: []
      })).sort((a, b) => a.no - b.no);
      if (!questions.length) throw new Error('AI도 마킹을 찾지 못했습니다.');
      const res = {
        ok: true, ai: true, method: 'ai', profile: { id: 'ai', label: `${questions.length}문항`, subject: '' },
        sections: [{ id: 0, title: '' }], questions,
        name: d.name ? { text: d.name, cols: [] } : null, examNo: d.examNo ? { text: d.examNo, digits: [] } : null,
        elective: null, fingerprint: 'ai', warnings: [], threshold: 0, bubble: { w: 0, h: 0 }
      };
      await openResult(res, { fresh: true });
    } catch (e) {
      showFail({ error: e.message });
    }
  }

  // ================================================================ 수동 기준점
  const PIN = ['#e5484d', '#3e7bfa', '#2fa36b', '#e08a1b'];
  function openManual() {
    if (!S.src) return;
    const W = S.src.width, H = S.src.height;
    if (!S.corners) {
      const r = S.cur && S.cur.res;
      if (r && r.H && r.frame) S.corners = r.frame.rect.map(p => E.applyH(r.H, p[0], p[1]));
      else S.corners = [[W * 0.1, H * 0.1], [W * 0.9, H * 0.1], [W * 0.1, H * 0.9], [W * 0.9, H * 0.9]];
    }
    pushView('manual');
    const cv = $('#manualCanvas');
    const s = Math.min(1, 1600 / Math.max(W, H));
    cv.width = Math.round(W * s); cv.height = Math.round(H * s); cv._s = s;
    drawManual();
  }
  function drawManual(active) {
    const cv = $('#manualCanvas'), ctx = cv.getContext('2d'), s = cv._s;
    ctx.drawImage(S.srcCanvas, 0, 0, cv.width, cv.height);
    const scr = cv.width / (cv.getBoundingClientRect().width || cv.width);
    const P = S.corners.map(p => [p[0] * s, p[1] * s]);
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.5 * scr; ctx.setLineDash([6 * scr, 4 * scr]);
    ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.lineTo(P[3][0], P[3][1]); ctx.lineTo(P[2][0], P[2][1]); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    P.forEach((p, i) => {
      const r = 13 * scr;
      ctx.lineWidth = 2.5 * scr; ctx.strokeStyle = PIN[i]; ctx.fillStyle = PIN[i] + '30';
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p[0] - r * 1.6, p[1]); ctx.lineTo(p[0] + r * 1.6, p[1]); ctx.moveTo(p[0], p[1] - r * 1.6); ctx.lineTo(p[0], p[1] + r * 1.6); ctx.stroke();
    });
    const lp = $('#loupe');
    if (active == null) { lp.classList.add('hidden'); return; }
    lp.classList.remove('hidden');
    const c = S.corners[active];
    lp.classList.toggle('right', c[0] < S.src.width / 2);
    const l = lp.getContext('2d'), z = Math.max(24, Math.round(Math.max(S.src.width, S.src.height) / 60));
    l.imageSmoothingEnabled = false;
    l.fillStyle = '#000'; l.fillRect(0, 0, 168, 168);
    l.drawImage(S.srcCanvas, c[0] - z, c[1] - z, z * 2, z * 2, 0, 0, 168, 168);
    l.strokeStyle = PIN[active]; l.lineWidth = 2;
    l.beginPath(); l.moveTo(84, 0); l.lineTo(84, 168); l.moveTo(0, 84); l.lineTo(168, 84); l.stroke();
  }
  (function manualDrag() {
    const cv = $('#manualCanvas');
    let drag = null;
    const toImg = e => { const r = cv.getBoundingClientRect(); const sx = cv.width / r.width / cv._s; return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sx, sx]; };
    cv.addEventListener('pointerdown', e => {
      const [x, y, sx] = toImg(e);
      let best = -1, bd = 48 * sx;
      S.corners.forEach((c, i) => { const d = Math.hypot(c[0] - x, c[1] - y); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      drag = { i: best, dx: S.corners[best][0] - x, dy: S.corners[best][1] - y };
      cv.setPointerCapture(e.pointerId); drawManual(best); e.preventDefault();
    });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      const [x, y] = toImg(e);
      S.corners[drag.i] = [Math.max(0, Math.min(S.src.width - 1, x + drag.dx)), Math.max(0, Math.min(S.src.height - 1, y + drag.dy))];
      drawManual(drag.i); e.preventDefault();
    });
    const end = () => { if (drag) { drag = null; drawManual(); } };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  })();
  $('#manualRun').addEventListener('click', () => handleSource(null, S.corners.map(p => p.slice())));

  // ================================================================ 반 채점 (연속)
  function ensureSession() {
    if (S.session) return S.session;
    const k = currentKey();
    S.session = { id: uid('s'), date: Date.now(), keyId: S.keyId, keyName: k ? k.name : '', title: `${k ? k.name : '반 채점'} · ${fmtDate(Date.now(), false)}`, records: [] };
    Sessions.put(S.session);
    return S.session;
  }
  async function batchCapture(src) {
    const sess = ensureSession();
    try {
      const { canvas, data } = await toImage(src);
      S.srcCanvas = canvas; S.src = data;
      const r = await analyzeImage(data, null, null);
      if (!r.ok) { root.Camera.resume('인식 실패 · 다시 비춰 주세요'); haptic('warn'); return; }
      const rec = await openResult(r, { silent: true, sessionId: sess.id });
      sess.records.push(rec.id);
      await Sessions.put(sess);
      const g = rec.graded || gradeRec(rec);
      const who = r.name && r.name.text ? r.name.text : `${sess.records.length}번째`;
      const sc = g.all.hasKey ? (g.all.hasPoints ? `${g.all.total}점` : `${g.all.right}/${g.all.graded}`) : '판독 완료';
      haptic('success');
      root.Camera.resume(`${who} · ${sc}`);
    } catch (e) {
      root.Camera.resume('오류 · 다시 비춰 주세요');
    }
  }
  async function batchFiles(files) {
    const sess = ensureSession();
    resetTo('scan', 'process');
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      $('#processSteps').innerHTML = `<li>${i + 1} / ${files.length}장 판독 중</li>`;
      try {
        const { canvas, data } = await toImage(files[i]);
        S.srcCanvas = canvas; S.src = data;
        const pc = $('#processPreview');
        pc.width = Math.min(1200, canvas.width); pc.height = Math.round(pc.width * canvas.height / canvas.width);
        pc.getContext('2d').drawImage(canvas, 0, 0, pc.width, pc.height);
        const r = await analyzeImage(data, null, null);
        if (!r.ok) continue;
        const rec = await openResult(r, { silent: true, sessionId: sess.id });
        sess.records.push(rec.id); ok++;
      } catch (e) { /* 다음 장 */ }
    }
    await Sessions.put(sess);
    toast(`${files.length}장 중 ${ok}장 채점 완료`);
    root.HistoryView.openSession(sess.id, true);
  }
  function renderSessionCard() {
    const box = $('#sessionCard');
    if (!S.session || !S.session.records.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="group"><button class="row row-tap" id="openSess"><svg class="row-icon"><use href="#i-users"/></svg><span class="row-main"><span class="t">진행 중인 반 채점</span><span class="row-sub">${esc(S.session.title)} · ${S.session.records.length}장</span></span><svg class="chev"><use href="#i-chev"/></svg></button>
      <button class="row row-tap" id="endSess"><span class="row-label danger-text">반 채점 끝내기</span></button></div>`;
    $('#openSess').addEventListener('click', () => root.HistoryView.openSession(S.session.id));
    $('#endSess').addEventListener('click', () => { S.session = null; S.mode = 'single'; renderScan(); toast('반 채점을 마쳤습니다. 기록 > 반 채점에서 다시 볼 수 있습니다.'); });
  }

  // ================================================================ 공유
  $('#shareResult').addEventListener('click', async () => {
    const rec = S.cur; if (!rec) return;
    const g = gradeRec(rec), a = g.all;
    const title = [!PERSONAL && rec.res.name && rec.res.name.text, Keys.get(rec.keyIds[0]) && Keys.get(rec.keyIds[0]).name].filter(Boolean).join(' · ') || 'OMR 채점 결과';
    const scoreText = a.hasKey ? (a.hasPoints ? `${a.total}/${a.max}점 (${a.right}/${a.graded} 정답)` : `${a.right}/${a.graded} 정답`) : '';
    const wrong = g.sections.flatMap(s => s.rows.filter(r => r.graded && !r.ok).map(r => r.q.no));
    const text = `${title}\n${scoreText}${wrong.length ? `\n틀린 문항: ${wrong.join(', ')}` : ''}`;
    try {
      const c = $('#overlay');
      const blob = c.width > 1 ? await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9)) : null;
      const file = blob ? new File([blob], 'omr-result.jpg', { type: 'image/jpeg' }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ title, text, files: [file] });
      else if (navigator.share) await navigator.share({ title, text });
      else { await navigator.clipboard.writeText(text); toast('결과를 복사했습니다'); }
    } catch (e) { /* 취소 */ }
  });

  // ================================================================ 설정
  function renderSettings() {
    const st = Settings.get();
    $('#sKey').value = st.apiKey;
    $('#sModelValue').textContent = (root.Gemini.MODELS[st.model] || { name: st.model }).name;
    $('#sAiLayout').checked = st.aiLayout === 'auto';
    $('#sThrValue').textContent = st.thrMode === 'auto' ? '자동' : `${st.thr}%`;
    $('#sMultiValue').textContent = st.multi === 'wrong' ? '오답 처리' : '진한 쪽 채택';
    $('#sAuto').checked = !!st.autoCapture;
    $('#sThemeValue').textContent = { system: '시스템', light: '밝게', dark: '어둡게' }[st.theme];
    $('#sHaptic').checked = !!st.haptics;
    $('#sLayoutsValue').textContent = `${Object.keys(Layouts.all()).length}개`;
    $('#version').textContent = `OMR 채점 ${VERSION} · 판독은 기기 안에서만 처리됩니다`;
    const T = root.OMRT;
    $('#sNameValue').textContent = (T.getName && T.getName()) || '없음';
    $('#sName').closest('.set-sec').classList.toggle('hidden', !T.enabled);
    $('#sAdmin').classList.toggle('hidden', !(T.isOwner && T.isOwner()));
  }
  $('#sName').addEventListener('click', () => {
    const T = root.OMRT; if (!T.setName) return;
    const body = Sheet.open(`<h3>이름 변경</h3><p class="sub">관리자 화면에 표시되는 이름입니다.</p>
      <input class="field" id="nmEdit" maxlength="20" value="${esc(T.getName())}">
      <div class="btns"><button class="btn btn-primary btn-lg" id="nmOk">저장</button></div>`);
    body.querySelector('#nmOk').addEventListener('click', async () => {
      const v = body.querySelector('#nmEdit').value.trim();
      const err = T.validateName(v);
      if (err) { toast(err); return; }
      await T.setName(v); Sheet.close(); renderSettings(); toast('이름을 바꿨습니다');
    });
  });
  $('#sAdmin').addEventListener('click', () => pushView('admin'));
  // 버전 문구를 다섯 번 누르면 관리자 화면(로그인)으로
  let verTaps = 0, verTimer = 0;
  $('#version').addEventListener('click', () => {
    clearTimeout(verTimer); verTimer = setTimeout(() => { verTaps = 0; }, 1500);
    if (++verTaps >= 5 && root.OMRT.enabled) { verTaps = 0; pushView('admin'); }
  });
  $('#sKey').addEventListener('change', e => { Settings.set({ apiKey: e.target.value.trim() }); toast('API 키를 저장했습니다'); });
  $('#sModel').addEventListener('click', async () => {
    const st = Settings.get();
    const v = await choose('Gemini 모델', Object.entries(root.Gemini.MODELS).map(([id, m]) => ({ label: m.name, note: `${id} · ${m.note}`, value: id })), st.model);
    if (v) { Settings.set({ model: v }); renderSettings(); }
  });
  $('#sAiLayout').addEventListener('change', e => Settings.set({ aiLayout: e.target.checked ? 'auto' : 'off' }));
  $('#sAuto').addEventListener('change', e => Settings.set({ autoCapture: e.target.checked }));
  $('#sHaptic').addEventListener('change', e => Settings.set({ haptics: e.target.checked }));
  $('#sTest').addEventListener('click', async () => {
    const st = Settings.get();
    const out = $('#sTestResult');
    if (!st.apiKey) { out.textContent = '키를 먼저 입력하세요'; return; }
    out.textContent = '확인 중…';
    try { await root.Gemini.test(st.apiKey, st.model); out.textContent = '연결됨'; out.style.color = 'var(--ok)'; }
    catch (e) { out.textContent = e.message; out.style.color = 'var(--bad)'; }
  });
  $('#sThr').addEventListener('click', async () => {
    const st = Settings.get();
    const v = await choose('마킹 판정 기준', [{ label: '자동', note: '답안지마다 빈 버블을 기준으로 조정 (권장)', value: 'auto' }]
      .concat([25, 30, 35, 40, 45, 50].map(p => ({ label: `${p}%`, note: '버블 안쪽이 이 비율 이상 검으면 마킹', value: p }))), st.thrMode === 'auto' ? 'auto' : st.thr);
    if (v == null) return;
    if (v === 'auto') Settings.set({ thrMode: 'auto' }); else Settings.set({ thrMode: 'manual', thr: v });
    renderSettings();
  });
  $('#sMulti').addEventListener('click', async () => {
    const v = await choose('중복 마킹', [{ label: '오답 처리', note: '실제 OMR 판독기와 같음', value: 'wrong' }, { label: '진한 쪽 채택', note: '한쪽이 두 배 이상 진할 때만', value: 'darkest' }], Settings.get().multi);
    if (v) { Settings.set({ multi: v }); renderSettings(); }
  });
  $('#sTheme').addEventListener('click', async () => {
    const v = await choose('테마', [{ label: '시스템', value: 'system' }, { label: '밝게', value: 'light' }, { label: '어둡게', value: 'dark' }], Settings.get().theme);
    if (v) { Settings.set({ theme: v }); applyTheme(); renderSettings(); }
  });
  $('#sExport').addEventListener('click', async () => {
    const data = { app: 'omr-scan', version: 2, exportedAt: Date.now(), keys: Keys.all(), layouts: Layouts.all(), history: await History.all(), sessions: await Sessions.all() };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `omr-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });
  $('#sImport').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.keys)) throw new Error('백업 파일이 아닙니다');
      const cur = Keys.all(), ids = new Set(cur.map(k => k.id));
      Keys.replaceAll(cur.concat(d.keys.filter(k => !ids.has(k.id))));
      if (d.layouts) Layouts.replaceAll(Object.assign({}, d.layouts, Layouts.all()));
      for (const h of d.history || []) await History.put(h);
      for (const s of d.sessions || []) await Sessions.put(s);
      toast(`가져오기 완료 · 정답 ${d.keys.length}개, 기록 ${(d.history || []).length}개`);
      renderSettings();
    } catch (err) { toast('가져오기 실패: ' + err.message); }
  });
  $('#sLayouts').addEventListener('click', async () => {
    const n = Object.keys(Layouts.all()).length;
    if (!n) { toast('아직 학습한 양식이 없습니다'); return; }
    if (await confirmSheet('학습한 양식', `문항 번호를 기억한 양식 ${n}개가 있습니다. 모두 지우면 다음 스캔부터 다시 자동 추정합니다.`, '모두 지우기', true)) { Layouts.replaceAll({}); renderSettings(); }
  });
  $('#sClear').addEventListener('click', async () => {
    if (!(await confirmSheet('모두 삭제', '모든 정답과 채점 기록, 반 채점 세션을 지웁니다. 되돌릴 수 없습니다.', '삭제', true))) return;
    Keys.replaceAll([]); await History.clear(); await Sessions.clear();
    S.session = null; toast('삭제했습니다');
  });

  // ================================================================ 시작
  const renderers = {
    scan: renderScan,
    settings: renderSettings,
    keys: () => root.KeyEditor.renderList(),
    history: () => root.HistoryView.render(),
    result: () => { if (S.cur) navActionsResult(); },
    admin: () => root.AdminView && root.AdminView.render()
  };
  root.AppCore = { S, PERSONAL, go, pushView, back, resetTo, navAction, renderResult, gradeRec, saveCurrent, renderScan, currentKey, keySummary, answersOf };

  S.keyId = Settings.get().lastKeyId && Keys.get(Settings.get().lastKeyId) ? Settings.get().lastKeyId : '';
  Sheet.bindDrag();
  go('scan');

  // 오프라인 동작용 서비스 워커
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then(reg => {
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('새 버전이 준비됐습니다. 앱을 다시 열면 적용됩니다.', 4000); });
        });
      }).catch(() => {});
    });
  }
  // 공유 대상(share target)으로 받은 사진
  if (location.search.includes('shared=1') && 'caches' in window) {
    caches.open('omr-share').then(c => c.match('shared-image')).then(r => r && r.blob()).then(b => {
      if (b) { handleSource(b); caches.open('omr-share').then(c => c.delete('shared-image')); }
      history.replaceState({}, '', location.pathname);
    }).catch(() => {});
  }
})(self);
