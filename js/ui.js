/* 공통 UI: 스프링 애니메이션, 하단 시트, 토스트, 햅틱, 서식 */
(function (root) {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------- 스프링 (감쇠비·응답시간 — Apple 방식 파라미터)
  // 현재 값과 속도에서 시작하므로 언제든 중단·재목표 가능
  function spring({ from, to, velocity = 0, damping = 1, response = 0.35, onUpdate, onDone }) {
    const k = Math.pow(2 * Math.PI / response, 2);
    const c = 4 * Math.PI * damping / response;
    let x = from, v = velocity, last = performance.now(), raf = 0, stopped = false;
    if (reduced()) { onUpdate(to, 0); onDone && onDone(); return { stop() {}, get value() { return to; }, get velocity() { return 0; } }; }
    const step = now => {
      if (stopped) return;
      let dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      // 반복 적분으로 안정성 확보
      const n = 4; dt /= n;
      for (let i = 0; i < n; i++) {
        const a = -k * (x - to) - c * v;
        v += a * dt; x += v * dt;
      }
      onUpdate(x, v);
      if (Math.abs(v) < 0.5 && Math.abs(x - to) < 0.3) { onUpdate(to, 0); onDone && onDone(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return { stop() { stopped = true; cancelAnimationFrame(raf); }, get value() { return x; }, get velocity() { return v; } };
  }
  // 손을 뗀 속도로 멈출 위치 예측 (Apple decelerationRate)
  const project = (v, d = 0.998) => (v / 1000) * d / (1 - d);
  const rubber = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));

  // ---------------- 햅틱
  function haptic(kind) {
    if (!root.AppSettings || !root.AppSettings().haptics) return;
    if (navigator.vibrate) navigator.vibrate(kind === 'success' ? [12, 40, 12] : kind === 'warn' ? [20, 30, 20] : 8);
  }

  // ---------------- 토스트
  let toastT = 0;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }

  // ---------------- 하단 시트 (드래그로 닫기, 속도 이어받기)
  const Sheet = (() => {
    const el = () => $('#sheet'), scrim = () => $('#scrim');
    let anim = null, y = 0, h = 0, openState = false, onClose = null;
    const set = v => { y = v; el().style.transform = `translateY(${v}px)`; scrim().style.opacity = String(Math.max(0, Math.min(1, 1 - v / Math.max(1, h)))); };
    function open(html, opts) {
      opts = opts || {};
      const s = el();
      $('#sheetBody').innerHTML = '';
      if (typeof html === 'string') $('#sheetBody').innerHTML = html; else $('#sheetBody').appendChild(html);
      onClose = opts.onClose || null;
      s.classList.add('open');
      scrim().classList.remove('hidden');
      scrim().classList.add('on');
      h = s.getBoundingClientRect().height || 400;
      if (anim) anim.stop();
      const start = openState ? y : h;
      openState = true;
      anim = spring({ from: start, to: 0, damping: 1, response: 0.38, onUpdate: set });
      return $('#sheetBody');
    }
    function close(velocity) {
      if (!openState) return;
      openState = false;
      if (anim) anim.stop();
      h = el().getBoundingClientRect().height || h;
      anim = spring({
        from: y, to: h + 20, velocity: velocity || 0, damping: 1, response: 0.32, onUpdate: set,
        onDone: () => { el().classList.remove('open'); scrim().classList.add('hidden'); scrim().classList.remove('on'); }
      });
      const cb = onClose; onClose = null;
      cb && cb();
    }
    function bindDrag() {
      const s = el();
      let start = null, hist = [];
      const down = e => {
        const onGrab = e.target.closest('.sheet-grabber');
        const body = $('#sheetBody');
        if (!onGrab && body.scrollTop > 0) return;
        if (!onGrab && e.target.closest('input, textarea, button, select, label, a')) return;
        start = { y: e.clientY, base: y, decided: !!onGrab };
        hist = [{ t: performance.now(), y: e.clientY }];
        if (anim) anim.stop();
      };
      const move = e => {
        if (!start) return;
        const dy = e.clientY - start.y;
        if (!start.decided) {
          if (Math.abs(dy) < 8) return;
          if (dy < 0) { start = null; return; }
          start.decided = true;
          s.setPointerCapture && s.setPointerCapture(e.pointerId);
        }
        let v = start.base + dy;
        if (v < 0) v = -rubber(-v, h);
        set(v);
        hist.push({ t: performance.now(), y: e.clientY });
        if (hist.length > 6) hist.shift();
        e.preventDefault();
      };
      const up = () => {
        if (!start || !start.decided) { start = null; return; }
        start = null;
        const a = hist[0], b = hist[hist.length - 1];
        const vel = b && a && b.t > a.t ? (b.y - a.y) / ((b.t - a.t) / 1000) : 0;
        const end = y + project(vel);
        if (end > h * 0.45) close(vel);
        else { if (anim) anim.stop(); anim = spring({ from: y, to: 0, velocity: vel, damping: 0.85, response: 0.32, onUpdate: set }); }
      };
      s.addEventListener('pointerdown', down);
      s.addEventListener('pointermove', move);
      s.addEventListener('pointerup', up);
      s.addEventListener('pointercancel', up);
      scrim().addEventListener('click', () => close(0));
    }
    return { open, close, bindDrag, get isOpen() { return openState; } };
  })();

  // 선택 목록 시트
  function choose(title, options, current, sub) {
    return new Promise(resolve => {
      let done = false;
      const body = Sheet.open(`<h3>${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}<div class="group">${options.map((o, i) =>
        `<button class="row row-tap check-row" data-i="${i}"><span class="row-main"><span class="t">${esc(o.label)}</span>${o.note ? `<span class="row-sub">${esc(o.note)}</span>` : ''}</span>${o.value === current ? '<svg class="tick"><use href="#i-check"/></svg>' : ''}</button>`).join('')}</div>`,
        { onClose: () => { if (!done) resolve(null); } });
      body.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => {
        done = true;
        resolve(options[+b.dataset.i].value);
        Sheet.close();
      }));
    });
  }

  function confirmSheet(title, message, okLabel, danger) {
    return new Promise(resolve => {
      let done = false;
      const body = Sheet.open(`<h3>${esc(title)}</h3><p class="sub">${esc(message)}</p><div class="btns">
        <button class="btn btn-lg ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okLabel || '확인')}</button>
        <button class="btn btn-lg btn-plain" data-cancel>취소</button></div>`, { onClose: () => { if (!done) resolve(false); } });
      body.querySelector('[data-ok]').addEventListener('click', () => { done = true; resolve(true); Sheet.close(); });
      body.querySelector('[data-cancel]').addEventListener('click', () => { done = true; resolve(false); Sheet.close(); });
    });
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDate(t, withTime) {
    const d = new Date(t), p = n => String(n).padStart(2, '0');
    const today = new Date();
    const same = d.toDateString() === today.toDateString();
    const date = same ? '오늘' : `${d.getMonth() + 1}월 ${d.getDate()}일`;
    return withTime === false ? date : `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const CIRCLED = ['', '①', '②', '③', '④', '⑤', '⑥'];

  // 숫자 카운트업 (점수 공개)
  function countUp(el, to, ms) {
    if (reduced()) { el.textContent = to; return; }
    const t0 = performance.now(), dur = ms || 900;
    const ease = t => 1 - Math.pow(1 - t, 3);
    const tick = now => {
      const t = Math.min(1, (now - t0) / dur);
      el.textContent = Math.round(to * ease(t));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // 누를 때 즉시 반응 (pointerdown) — :active 가 늦게 걸리는 iOS 보완
  document.addEventListener('pointerdown', () => {}, { passive: true });

  root.UI = { $, $$, spring, project, rubber, haptic, toast, Sheet, choose, confirmSheet, esc, fmtDate, CIRCLED, countUp, reduced };
})(self);
