/* 관리자 화면 — 사용자 목록, 접속 시간·이용 내역, 차단·삭제 */
(function (root) {
  'use strict';
  const { $, toast, Sheet, confirmSheet, esc } = root.UI;
  const LIVE_MS = 5 * 60 * 1000;
  const wide = () => matchMedia('(min-width: 1024px)').matches;
  const A = { users: [], sel: '', q: '', loading: false };

  function api() { return root.OMRT && root.OMRT.admin; }
  function dur(sec) {
    if (!sec) return '0분';
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
    return h ? `${h}시간 ${m}분` : m ? `${m}분` : `${sec}초`;
  }
  function ago(t) {
    if (!t) return '-';
    const d = Date.now() - t;
    if (d < 60e3) return '방금';
    if (d < 3600e3) return `${Math.floor(d / 60e3)}분 전`;
    if (d < 86400e3) return `${Math.floor(d / 3600e3)}시간 전`;
    if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)}일 전`;
    return dt(t, false);
  }
  function dt(t, time) {
    if (!t) return '-';
    const d = new Date(t), p = n => String(n).padStart(2, '0');
    const s = `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
    return time ? `${s} ${p(d.getHours())}:${p(d.getMinutes())}` : s;
  }
  function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }

  // ---------------------------------------------------------------- 로그인
  function renderLogin(msg) {
    $('#navActions').innerHTML = '';
    $('#adminBody').innerHTML = `
      <div class="empty"><svg class="empty-icon"><use href="#i-users"/></svg><h2>관리자 로그인</h2><p>관리자 계정으로 로그인하면 사용자별 접속 기록을 볼 수 있습니다.</p></div>
      <form class="group" id="admForm" autocomplete="on" style="margin-top:22px">
        <label class="row"><span class="row-label">이메일</span><input class="row-input" type="email" id="admEmail" autocomplete="username" required></label>
        <label class="row"><span class="row-label">비밀번호</span><input class="row-input" type="password" id="admPw" autocomplete="current-password" required></label>
      </form>
      <p class="footnote danger-text" id="admErr">${esc(msg || '')}</p>
      <div class="stack"><button class="btn btn-primary btn-lg" id="admLogin" form="admForm" type="submit">로그인</button></div>`;
    $('#admForm').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('#admLogin'); btn.disabled = true; btn.textContent = '확인 중…';
      try { await api().signIn($('#admEmail').value.trim(), $('#admPw').value); render(); }
      catch (err) {
        const code = err && err.code || '';
        renderLogin(/invalid-credential|wrong-password|user-not-found|invalid-email/.test(code) ? '이메일 또는 비밀번호가 맞지 않습니다.'
          : /too-many-requests/.test(code) ? '시도가 너무 많습니다. 잠시 후 다시 시도하세요.'
          : /network/.test(code) ? '네트워크에 연결할 수 없습니다.' : (err.message || '로그인 실패'));
      }
    });
  }

  // ---------------------------------------------------------------- 목록
  async function load() {
    A.loading = true;
    try { A.users = await api().listUsers(); }
    catch (e) { toast('불러오기 실패: ' + (e.code === 'permission-denied' ? '권한이 없습니다' : e.message)); A.users = []; }
    A.loading = false;
  }
  function heroHtml() {
    const now = Date.now(), today = new Date(); today.setHours(0, 0, 0, 0);
    const u = A.users;
    const live = u.filter(x => now - x.lastSeen < LIVE_MS).length;
    const todayN = u.filter(x => x.lastSeen >= today.getTime()).length;
    const week = u.filter(x => now - x.lastSeen < 7 * 86400e3).length;
    const scans = u.reduce((s, x) => s + x.scans, 0);
    return `<div class="adm-hero">
      <div><b class="num">${u.length}</b><span>전체 사용자</span></div>
      <div><b class="num">${todayN}</b><span>오늘 접속${live ? ` · 지금 ${live}` : ''}</span></div>
      <div><b class="num">${week}</b><span>7일 내 접속</span></div>
      <div><b class="num">${scans}</b><span>누적 스캔</span></div></div>`;
  }
  function listHtml() {
    const q = A.q.toLowerCase();
    const rows = A.users.filter(u => !q || u.name.toLowerCase().includes(q));
    if (!rows.length) return `<p class="footnote center" style="margin-top:20px">${A.users.length ? '검색 결과가 없습니다' : '아직 등록한 사용자가 없습니다'}</p>`;
    const now = Date.now();
    return `<div class="group">${rows.map(u => `
      <button class="row row-tap adm-user${u.id === A.sel && wide() ? ' sel' : ''}" data-uid="${esc(u.id)}">
        <i class="dot${u.blocked ? ' blocked' : now - u.lastSeen < LIVE_MS ? ' live' : ''}"></i>
        <span class="row-main"><span class="t">${esc(u.name || '(이름 없음)')}${u.blocked ? '<span class="adm-badge">차단</span>' : ''}</span>
          <span class="row-sub">방문 ${u.visits}회 · ${dur(u.totalSec)} · 스캔 ${u.scans}</span></span>
        <span class="row-value">${esc(ago(u.lastSeen))}<small>${esc(u.device.split(' · ')[0] || '')}</small></span>
        <svg class="chev"><use href="#i-chev"/></svg>
      </button>`).join('')}</div>`;
  }
  function renderList() {
    $('#admList').innerHTML = listHtml();
  }

  async function render() {
    const a = api();
    if (!a) { $('#adminBody').innerHTML = '<div class="empty"><h2>이용 기록이 꺼져 있습니다</h2><p>이 배포에는 Firebase 설정이 없습니다.</p></div>'; return; }
    $('#adminBody').innerHTML = '<p class="footnote center" style="margin-top:30px">불러오는 중…</p>';
    await a.ready();
    if (!root.OMRT.isOwner()) { renderLogin(); return; }
    $('#navActions').innerHTML = '';
    root.AppCore.navAction('새로고침', () => render());
    root.AppCore.navAction('로그아웃', async () => { await a.signOut(); A.sel = ''; renderLogin(); });
    await load();
    $('#adminBody').innerHTML = `
      ${heroHtml()}
      <div class="adm-split">
        <div>
          <div class="adm-tools"><input class="field" id="admQ" type="search" placeholder="이름 검색" value="${esc(A.q)}"></div>
          <div id="admList"></div>
        </div>
        <div class="adm-detail" id="admDetail"><p class="footnote center" style="margin-top:40px">왼쪽에서 사용자를 고르세요</p></div>
      </div>`;
    renderList();
    $('#admQ').addEventListener('input', e => { A.q = e.target.value.trim(); renderList(); });
    $('#admList').addEventListener('click', e => { const b = e.target.closest('[data-uid]'); if (b) openUser(b.dataset.uid); });
    if (A.sel && wide() && A.users.some(u => u.id === A.sel)) openUser(A.sel);
  }

  // ---------------------------------------------------------------- 상세
  async function openUser(id) {
    const u = A.users.find(x => x.id === id); if (!u) return;
    A.sel = id;
    let host;
    if (wide()) { renderList(); host = $('#admDetail'); host.innerHTML = '<p class="footnote center" style="margin-top:40px">불러오는 중…</p>'; }
    else host = Sheet.open('<p class="footnote center">불러오는 중…</p>');
    let sessions = [];
    try { sessions = await root.OMRT.admin.listSessions(id, 200); } catch (e) { toast('접속 기록을 불러오지 못했습니다'); }
    if (A.sel !== id) return;
    host.innerHTML = detailHtml(u, sessions);
    host.querySelector('#admBlock').addEventListener('click', () => toggleBlock(u));
    host.querySelector('#admDel').addEventListener('click', () => removeUser(u));
  }
  function daysChart(sessions) {
    const N = 14, today = new Date(); today.setHours(0, 0, 0, 0);
    const keys = Array.from({ length: N }, (_, i) => dayKey(today.getTime() - (N - 1 - i) * 86400e3));
    const sum = Object.fromEntries(keys.map(k => [k, 0]));
    sessions.forEach(s => { const k = dayKey(s.start); if (k in sum) sum[k] += s.sec; });
    const max = Math.max(60, ...Object.values(sum));
    const bars = keys.map(k => `<i class="${sum[k] ? '' : 'zero'}" style="height:${sum[k] ? Math.max(6, Math.round(sum[k] / max * 100)) : 4}%" title="${dur(sum[k])}"></i>`).join('');
    return `<div class="group"><div class="adm-days">${bars}</div><div class="adm-days-lab"><span>14일 전</span><span>사용 시간 · 최대 ${dur(max)}</span><span>오늘</span></div></div>`;
  }
  function detailHtml(u, sessions) {
    const rows = sessions.slice(0, 60).map(s => `<div class="row"><span class="row-main"><span class="t num">${esc(dt(s.start, true))}</span>
      <span class="row-sub">${esc(s.device)}</span></span><span class="row-value small">${dur(s.sec)}${s.scans ? ` · 스캔 ${s.scans}` : ''}${s.aiReads ? ` · AI ${s.aiReads}` : ''}</span></div>`).join('');
    return `
      <h3 style="margin:${wide() ? '10px' : '8px'} 4px 2px">${esc(u.name || '(이름 없음)')}${u.blocked ? '<span class="adm-badge">차단</span>' : ''}</h3>
      <p class="sub" style="margin:0 4px 6px;color:var(--text-2);font-size:14px">${esc(u.device || '기기 정보 없음')}${u.appVersion ? ` · v${esc(u.appVersion)}` : ''}</p>
      <div class="stat-hero">
        <div><b class="num">${dur(u.totalSec)}</b><span>누적 사용</span></div>
        <div><b class="num">${u.visits}</b><span>방문</span></div>
        <div><b class="num">${u.scans}${u.aiReads ? `<small style="font-size:14px;color:var(--text-2)"> +AI ${u.aiReads}</small>` : ''}</b><span>스캔</span></div>
      </div>
      <div class="group">
        <div class="row"><span class="row-label">처음 접속</span><span class="row-value num">${esc(dt(u.createdAt, true))}</span></div>
        <div class="row"><span class="row-label">최근 접속</span><span class="row-value num">${esc(dt(u.lastSeen, true))} (${esc(ago(u.lastSeen))})</span></div>
        <div class="row"><span class="row-label">사용자 ID</span><span class="row-value small mono">${esc(u.id.slice(0, 10))}…</span></div>
      </div>
      <h2 class="section-title">최근 14일</h2>
      ${daysChart(sessions)}
      <h2 class="section-title">접속 기록 ${sessions.length ? `(${sessions.length >= 200 ? '최근 200' : sessions.length}회)` : ''}</h2>
      ${rows ? `<div class="group">${rows}</div>` : '<p class="footnote">접속 기록이 없습니다</p>'}
      <div class="row-actions" style="margin:16px 0 8px">
        <button class="btn btn-plain btn-sm" id="admBlock">${u.blocked ? '차단 해제' : '이용 차단'}</button>
        <button class="btn btn-danger btn-sm" id="admDel">사용자 삭제</button>
      </div>`;
  }
  async function toggleBlock(u) {
    const next = !u.blocked;
    if (next && !(await confirmSheet('이용 차단', `${u.name}님의 기기에서 앱을 열면 이용 제한 화면이 뜹니다.`, '차단', true))) return;
    try { await root.OMRT.admin.setBlocked(u.id, next); u.blocked = next; toast(next ? '차단했습니다' : '차단을 풀었습니다'); }
    catch (e) { toast('실패: ' + e.message); return; }
    if (!wide()) Sheet.close();
    renderList(); if (wide()) openUser(u.id);
  }
  async function removeUser(u) {
    if (!(await confirmSheet('사용자 삭제', `${u.name}님의 이름과 접속 기록을 모두 지웁니다. 같은 기기에서 다시 열면 새 사용자로 등록됩니다.`, '삭제', true))) return;
    try { await root.OMRT.admin.deleteUser(u.id); } catch (e) { toast('삭제 실패: ' + e.message); return; }
    A.users = A.users.filter(x => x.id !== u.id); A.sel = '';
    if (!wide()) Sheet.close();
    toast('삭제했습니다');
    render();
  }

  root.AdminView = { render };
})(self);
