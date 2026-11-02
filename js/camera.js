/* 실시간 카메라: 기준 마크를 찾아 고정되면 자동 촬영 */
(function (root) {
  'use strict';
  const { $, haptic } = root.UI;
  let stream = null, track = null, running = false, busy = false, timer = 0, opts = null;
  let history = [], torchOn = false, autoOn = true, lastQuad = null, lockedAt = 0;

  function overlayCtx() {
    const c = $('#camOverlay');
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  // 비디오 좌표 → 화면 좌표 (object-fit: cover)
  function mapper() {
    const v = $('#camVideo');
    const vw = v.videoWidth, vh = v.videoHeight, W = v.clientWidth, H = v.clientHeight;
    const s = Math.max(W / vw, H / vh);
    const ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
    return p => [p[0] * s + ox, p[1] * s + oy];
  }
  function drawGuide(quad, locked) {
    const { ctx, w, h } = overlayCtx();
    ctx.clearRect(0, 0, w, h);
    if (!quad) {
      // 가이드 모서리
      const portrait = h > w;
      const gw = portrait ? w * 0.84 : Math.min(w * 0.8, h * 0.8 / 0.76);
      const gh = portrait ? Math.min(h * 0.62, gw / 0.76) : gw * 0.76;
      const x = (w - gw) / 2, y = (h - gh) / 2, L = 26;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      [[x, y, 1, 1], [x + gw, y, -1, 1], [x, y + gh, 1, -1], [x + gw, y + gh, -1, -1]].forEach(([cx, cy, dx, dy]) => {
        ctx.beginPath(); ctx.moveTo(cx, cy + dy * L); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * L, cy); ctx.stroke();
      });
      return;
    }
    const m = mapper();
    const P = quad.map(m); // TL, TR, BL, BR
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = locked ? 'rgba(60,200,120,0.95)' : 'rgba(255,255,255,0.9)';
    ctx.fillStyle = locked ? 'rgba(60,200,120,0.14)' : 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.lineTo(P[3][0], P[3][1]); ctx.lineTo(P[2][0], P[2][1]); ctx.closePath();
    ctx.fill(); ctx.stroke();
    P.forEach(p => { ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, Math.PI * 2); ctx.fillStyle = locked ? '#3cc878' : '#fff'; ctx.fill(); });
  }
  function status(t, locked) {
    const s = $('#camStatus');
    s.textContent = t;
    s.classList.toggle('locked', !!locked);
  }

  async function open(o) {
    opts = o || {};
    autoOn = root.AppSettings().autoCapture;
    $('#camAuto').classList.toggle('on', autoOn);
    $('#camera').classList.remove('hidden');
    $('#camera').setAttribute('aria-hidden', 'false');
    updateCount();
    status('카메라 준비 중');
    drawGuide(null);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }
      });
    } catch (e) {
      close();
      throw new Error(e && e.name === 'NotAllowedError' ? '카메라 권한이 필요합니다. 브라우저 설정에서 허용하거나 사진으로 가져오세요.' : '카메라를 열 수 없습니다. 사진으로 가져오세요.');
    }
    track = stream.getVideoTracks()[0];
    const v = $('#camVideo');
    v.srcObject = stream;
    await v.play().catch(() => {});
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    $('#camTorch').classList.toggle('hidden', !caps.torch);
    try { if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* 무시 */ }
    running = true; history = []; lockedAt = 0;
    status('답안지 전체를 화면에 맞춰 주세요');
    loop();
  }

  function updateCount() {
    const n = opts && opts.count ? opts.count() : 0;
    $('#camCount').classList.toggle('hidden', !opts || !opts.batch);
    $('#camCount').textContent = `${n}장 채점됨`;
  }

  function grabFrame(maxDim) {
    const v = $('#camVideo');
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw) return null;
    const s = Math.min(1, maxDim / Math.max(vw, vh));
    const c = document.createElement('canvas');
    c.width = Math.round(vw * s); c.height = Math.round(vh * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return { canvas: c, scale: s, data: ctx.getImageData(0, 0, c.width, c.height) };
  }

  async function loop() {
    if (!running) return;
    if (!busy) {
      const f = grabFrame(1100);
      if (f) {
        busy = true;
        let r = null;
        try { r = await root.App.locate(f.data); } catch (e) { r = null; }
        busy = false;
        if (!running) return;
        if (r && r.ok && r.method === 'marks') {
          const quad = r.corners.map(p => [p[0] / f.scale, p[1] / f.scale]);
          history.push(quad);
          if (history.length > 4) history.shift();
          const v = $('#camVideo');
          const tol = Math.max(v.videoWidth, v.videoHeight) * 0.018;
          const stable = history.length >= 3 && history.slice(-3).every((q, i, arr) => i === 0 || q.every((p, k) => Math.hypot(p[0] - arr[i - 1][k][0], p[1] - arr[i - 1][k][1]) < tol));
          lastQuad = quad;
          drawGuide(quad, stable);
          if (stable) {
            if (!lockedAt) { lockedAt = performance.now(); haptic(); }
            status(autoOn ? '고정됨 · 촬영합니다' : '고정됨 · 셔터를 누르세요', true);
            if (autoOn && performance.now() - lockedAt > 350) { capture(); return; }
          } else { lockedAt = 0; status('움직이지 말고 잠시 기다려 주세요'); }
        } else {
          history = []; lockedAt = 0; lastQuad = null;
          drawGuide(null);
          status(r && r.ok ? '아래쪽 모서리 마크까지 보이게 해 주세요' : '상단 검은 마크 줄이 보이게 해 주세요');
        }
      }
    }
    timer = setTimeout(loop, 140);
  }

  async function capture() {
    if (!running) return;
    running = false;
    clearTimeout(timer);
    $('#camShutter').classList.add('busy');
    haptic('success');
    const fl = document.createElement('div'); fl.className = 'flash'; document.body.appendChild(fl); setTimeout(() => fl.remove(), 400);
    let blob = null;
    try {
      if (root.ImageCapture && track) {
        const ic = new ImageCapture(track);
        blob = await Promise.race([ic.takePhoto(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))]);
      }
    } catch (e) { blob = null; }
    let source;
    if (blob) source = blob;
    else {
      const f = grabFrame(4096);
      source = f ? f.canvas : null;
    }
    $('#camShutter').classList.remove('busy');
    if (!source) { status('촬영 실패 · 다시 시도하세요'); running = true; loop(); return; }
    if (!(opts && opts.batch)) close();
    else status('판독 중…');
    opts && opts.onCapture && opts.onCapture(source);
  }

  function resume(msg) {
    if (!stream) return;
    updateCount();
    history = []; lockedAt = 0;
    status(msg || '다음 답안지를 비춰 주세요');
    drawGuide(null);
    // 같은 장을 다시 찍지 않도록 잠깐 쉼
    setTimeout(() => { running = true; loop(); }, 1200);
  }

  function close() {
    running = false;
    clearTimeout(timer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; track = null; torchOn = false;
    $('#camTorch').classList.remove('on');
    $('#camera').classList.add('hidden');
    $('#camera').setAttribute('aria-hidden', 'true');
    opts && opts.onClose && opts.onClose();
  }

  // 버튼
  $('#camClose').addEventListener('click', () => close());
  $('#camShutter').addEventListener('click', () => capture());
  $('#camAuto').addEventListener('click', () => {
    autoOn = !autoOn;
    root.AppSettings.set({ autoCapture: autoOn });
    $('#camAuto').classList.toggle('on', autoOn);
    root.UI.toast(autoOn ? '자동 촬영 켬' : '자동 촬영 끔');
  });
  $('#camTorch').addEventListener('click', async () => {
    if (!track) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; }
    $('#camTorch').classList.toggle('on', torchOn);
  });
  $('#camPick').addEventListener('change', e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!(opts && opts.batch)) close();
    opts && opts.onCapture && opts.onCapture(f);
  });

  root.Camera = { open, close, resume, status, get isOpen() { return !!stream; } };
})(self);
