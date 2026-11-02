/* 기록 · 통계 · 반 채점 */
(function (root) {
  'use strict';
  const { $, $$, toast, Sheet, choose, confirmSheet, esc, fmtDate, CIRCLED } = root.UI;
  const { Keys, History, Sessions } = root.Store;
  const G = root.Grading;
  const core = () => root.AppCore;
  let tab = 'list', statKey = null;

  function regrade(d) {
    const rec = { res: d.res, edits: d.edits || {}, keyIds: d.keyIds || [], keySnaps: d.keySnaps || [], electiveIdx: d.electiveIdx };
    const keys = rec.keySnaps.map((k, i) => (rec.keyIds[i] ? (Keys.get(rec.keyIds[i]) || k) : null));
    return G.grade(core().answersOf(rec), keys, rec.electiveIdx);
  }
  function scoreText(sum) {
    if (!sum || !sum.hasKey) return '–';
    return sum.hasPoints ? `${sum.total}` : `${sum.right}/${sum.graded}`;
  }
  function row(d) {
    const s = d.summary || {};
    const big = s.hasKey ? (s.hasPoints ? `${s.total}<small>점</small>` : `${s.right}<small>/${s.graded}</small>`) : '<small>정답 없음</small>';
    const title = d.name || d.keyName || d.profileLabel || '답안지';
    const sub = [fmtDate(d.date), d.name ? d.keyName : '', d.examNo].filter(Boolean).join(' · ');
    return `<button class="row row-tap" data-h="${esc(d.id)}"><span class="row-main"><span class="t">${esc(title)}</span><span class="row-sub">${esc(sub)}</span></span><span class="big-num">${big}</span><svg class="chev"><use href="#i-chev"/></svg></button>`;
  }

  async function render() {
    $$('#histSeg button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    ['list', 'stats', 'sessions'].forEach(t => $('#hist-' + t).classList.toggle('hidden', t !== tab));
    const all = await History.all().catch(() => []);
    if (tab === 'list') {
      if (!all.length) { $('#hist-list').innerHTML = empty('i-history', '채점 기록이 없습니다', '스캔한 답안지는 자동으로 여기에 저장됩니다.'); return; }
      const groups = new Map();
      all.forEach(d => { const k = fmtDate(d.date, false); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); });
      $('#hist-list').innerHTML = Array.from(groups.entries()).map(([k, list]) => `<h2 class="section-title">${esc(k)}</h2><div class="group">${list.map(row).join('')}</div>`).join('');
    } else if (tab === 'stats') renderStats(all);
    else renderSessions();
  }
  function empty(icon, h, p) { return `<div class="empty"><svg class="empty-icon"><use href="#${icon}"/></svg><h2>${esc(h)}</h2><p>${esc(p)}</p></div>`; }
  $('#histSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; tab = b.dataset.tab; render(); });
  $('#hist-list').addEventListener('click', e => { const b = e.target.closest('[data-h]'); if (b) root.AppOpenHistory(b.dataset.h); });

  // ---------------- 통계 (정답별)
  function renderStats(all) {
    const byKey = new Map();
    all.forEach(d => { const id = d.keyIds && d.keyIds[0]; if (id) { if (!byKey.has(id)) byKey.set(id, []); byKey.get(id).push(d); } });
    if (!byKey.size) { $('#hist-stats').innerHTML = empty('i-history', '통계가 없습니다', '정답을 선택해 채점한 기록이 쌓이면 문항별 오답률과 점수 추이를 보여줍니다.'); return; }
    if (!statKey || !byKey.has(statKey)) statKey = Array.from(byKey.keys())[0];
    const key = Keys.get(statKey);
    const recs = byKey.get(statKey).slice().sort((a, b) => a.date - b.date);
    const graded = recs.map(d => ({ d, graded: regrade(d) }));
    const hasPts = graded.every(x => x.graded.all.hasPoints);
    const vals = graded.map(x => hasPts ? x.graded.all.total : x.graded.all.right);
    const sm = G.summary(vals);
    const items = G.itemStats(graded);
    const name = key ? key.name : (recs[0].keyName || '정답');
    $('#hist-stats').innerHTML = `
      <div class="group" style="margin-top:14px"><button class="row row-tap" id="statPick"><span class="row-label">정답</span><span class="row-value">${esc(name)}</span><svg class="chev"><use href="#i-chev"/></svg></button></div>
      <div class="stat-hero"><div><b>${sm.n}</b><span>채점 횟수</span></div><div><b>${fmt1(sm.mean)}</b><span>평균 ${hasPts ? '점수' : '맞은 수'}</span></div><div><b>${sm.max}</b><span>최고</span></div></div>
      ${vals.length >= 2 ? `<h2 class="section-title">추이</h2><div class="group" style="padding:10px 12px">${spark(vals)}</div>` : ''}
      <h2 class="section-title">문항별 정답률 (낮은 순)</h2>
      <div class="group bars">${items.slice().sort((a, b) => a.rate - b.rate).map(barRow).join('')}</div>`;
    $('#statPick').addEventListener('click', async () => {
      const v = await choose('통계 볼 정답', Array.from(byKey.keys()).map(id => ({ label: (Keys.get(id) || {}).name || byKey.get(id)[0].keyName || '정답', note: `${byKey.get(id).length}회`, value: id })), statKey);
      if (v) { statKey = v; renderStats(all); }
    });
  }
  const fmt1 = v => (Math.round(v * 10) / 10).toString();
  function barRow(e) {
    const picks = Object.entries(e.picks).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${/^\d$/.test(k) ? CIRCLED[+k] || k : k} ${n}`).join(' · ');
    return `<div class="bar ${e.rate < 0.5 ? 'low' : ''}"><span>${e.section ? `${e.section + 1}-` : ''}${e.no}번</span><div class="track"><div class="fillbar" style="width:${Math.round(e.rate * 100)}%"></div></div><span style="text-align:right">${Math.round(e.rate * 100)}%</span>${e.n > 1 ? `<span class="pick">${esc(picks)}</span>` : ''}</div>`;
  }
  function spark(vals) {
    const W = 600, H = 90, mn = Math.min(...vals), mx = Math.max(...vals), span = mx - mn || 1;
    const pts = vals.map((v, i) => [vals.length === 1 ? W / 2 : (i / (vals.length - 1)) * (W - 16) + 8, H - 12 - ((v - mn) / span) * (H - 28)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="stroke-width:2"><path d="${d}" fill="none" stroke="currentColor" vector-effect="non-scaling-stroke"/>${pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="currentColor" stroke="none"/>`).join('')}<text x="${Math.min(W - 40, last[0])}" y="${Math.max(12, last[1] - 8)}" font-size="12" fill="currentColor" stroke="none">${vals[vals.length - 1]}</text></svg>`;
  }

  // ---------------- 반 채점 세션
  async function renderSessions() {
    const list = await Sessions.all().catch(() => []);
    if (!list.length) { $('#hist-sessions').innerHTML = empty('i-users', '반 채점 기록이 없습니다', '채점 화면에서 \'반 전체 연속\'을 고르고 스캔하면 학생별 점수와 문항별 정답률을 모아 보여줍니다.'); return; }
    $('#hist-sessions').innerHTML = `<div class="group" style="margin-top:14px">${list.map(s => `<button class="row row-tap" data-s="${esc(s.id)}"><svg class="row-icon"><use href="#i-users"/></svg><span class="row-main"><span class="t">${esc(s.title)}</span><span class="row-sub">${fmtDate(s.date)} · ${s.records.length}장</span></span><svg class="chev"><use href="#i-chev"/></svg></button>`).join('')}</div>`;
  }
  $('#hist-sessions').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (b) openSession(b.dataset.s); });

  async function loadSession(id) {
    const s = await Sessions.get(id);
    if (!s) return null;
    const recs = (await Promise.all(s.records.map(r => History.get(r)))).filter(Boolean);
    return { s, recs: recs.map(d => ({ d, graded: regrade(d) })) };
  }
  async function openSession(id, replace) {
    const data = await loadSession(id);
    if (!data) { toast('세션을 찾을 수 없습니다'); return; }
    if (replace) { core().resetTo('scan', 'session'); } else core().pushView('session');
    renderSession(data);
  }
  function renderSession({ s, recs }) {
    const hasPts = recs.length && recs.every(x => x.graded.all.hasPoints);
    const hasKey = recs.some(x => x.graded.all.hasKey);
    const vals = recs.map(x => hasPts ? x.graded.all.total : x.graded.all.right);
    const sm = G.summary(vals) || { n: 0, mean: 0, max: 0, min: 0, sd: 0 };
    const items = G.itemStats(recs);
    const rows = recs.map((x, i) => {
      const nm = x.d.res.name && x.d.res.name.text || `${i + 1}번째 답안지`;
      const sc = hasKey ? (hasPts ? `${x.graded.all.total}<small>점</small>` : `${x.graded.all.right}<small>/${x.graded.all.graded}</small>`) : '<small>–</small>';
      const chk = x.d.res.questions.filter(q => q.status === 'check' || q.status === 'multi').length;
      return `<button class="row row-tap" data-h="${esc(x.d.id)}"><span class="row-main"><span class="t">${esc(nm)}</span><span class="row-sub">${esc([x.d.res.examNo && x.d.res.examNo.text, chk ? `확인 ${chk}` : ''].filter(Boolean).join(' · ') || ' ')}</span></span><span class="big-num">${sc}</span><svg class="chev"><use href="#i-chev"/></svg></button>`;
    }).join('');
    $('#sessionBody').innerHTML = `
      <h1 class="large-title" style="font-size:26px">${esc(s.title)}</h1>
      <div class="stat-hero"><div><b>${sm.n}</b><span>인원</span></div><div><b>${fmt1(sm.mean)}</b><span>평균${hasPts ? '' : ' 맞은 수'}</span></div><div><b>${sm.n ? `${sm.max}/${sm.min}` : '–'}</b><span>최고/최저</span></div></div>
      <div class="row-actions"><button class="btn btn-plain btn-sm" id="sessCsv"><svg><use href="#i-download"/></svg>CSV 내보내기</button><button class="btn btn-plain btn-sm" id="sessRename">이름 변경</button><button class="btn btn-danger btn-sm" id="sessDel"><svg><use href="#i-trash"/></svg>삭제</button></div>
      <h2 class="section-title">학생별</h2><div class="group">${rows || '<p class="footnote" style="padding:12px 0">아직 없습니다.</p>'}</div>
      ${hasKey && items.length ? `<h2 class="section-title">문항별 정답률</h2><div class="group bars">${items.map(barRow).join('')}</div>` : ''}`;
    $('#sessionBody').querySelectorAll('[data-h]').forEach(b => b.addEventListener('click', () => root.AppOpenHistory(b.dataset.h)));
    $('#sessCsv').addEventListener('click', () => exportCsv(s, recs, hasPts));
    $('#sessRename').addEventListener('click', async () => { const t = prompt('세션 이름', s.title); if (t) { s.title = t; await Sessions.put(s); renderSession({ s, recs }); } });
    $('#sessDel').addEventListener('click', async () => {
      if (!(await confirmSheet('반 채점 삭제', '세션과 그 안의 채점 기록을 모두 지울까요?', '삭제', true))) return;
      for (const r of s.records) await History.remove(r);
      await Sessions.remove(s.id);
      if (core().S.session && core().S.session.id === s.id) core().S.session = null;
      core().back();
    });
  }
  function exportCsv(s, recs, hasPts) {
    const nos = [];
    recs.forEach(x => x.d.res.questions.forEach(q => { const k = `${q.section}:${q.no}`; if (!nos.find(n => n.k === k)) nos.push({ k, section: q.section, no: q.no }); }));
    nos.sort((a, b) => a.section - b.section || a.no - b.no);
    const multi = nos.some(n => n.section > 0);
    const head = ['순번', '이름', '수험번호', hasPts ? '점수' : '맞은 수', '채점 문항'].concat(nos.map(n => `${multi ? `${n.section + 1}-` : ''}${n.no}`));
    const lines = [head];
    recs.forEach((x, i) => {
      const map = new Map();
      x.graded.sections.forEach(S2 => S2.rows.forEach(r => map.set(`${S2.section}:${r.q.no}`, r)));
      lines.push([i + 1, x.d.res.name && x.d.res.name.text || '', x.d.res.examNo && x.d.res.examNo.text || '', hasPts ? x.graded.all.total : x.graded.all.right, x.graded.all.graded]
        .concat(nos.map(n => {
          const r = map.get(n.k); if (!r) return '';
          const mine = r.q.type === 'sa' ? (r.q.value ?? '') : (r.q.answer > 0 ? r.q.answer : r.q.answer === -1 ? '중복' : '');
          return r.graded ? `${mine}${r.ok ? '' : '✕'}` : mine;
        })));
    });
    const csv = '﻿' + lines.map(l => l.map(G.csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${s.title.replace(/[\\/:*?"<>|]/g, '_')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  root.HistoryView = { render, openSession };
})(self);
