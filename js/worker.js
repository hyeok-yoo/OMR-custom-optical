/* 판독 워커 — UI가 멈추지 않도록 이미지 처리를 별도 스레드에서 */
importScripts('omr-engine.js');

self.onmessage = function (e) {
  const { id, type, width, height, buffer, opts } = e.data;
  const post = (m, t) => self.postMessage(Object.assign({ id }, m), t || []);
  try {
    const img = { width, height, data: new Uint8ClampedArray(buffer) };
    if (type === 'locate') {
      post({ type: 'result', ...self.OMREngine.quickLocate(img) });
      return;
    }
    const r = self.OMREngine.analyze(img, Object.assign({}, opts, { log: msg => post({ type: 'log', msg }) }));
    if (!r.ok) { post({ type: 'result', ok: false, error: r.error, method: r.method }); return; }
    const warped = r.warped;
    delete r.warped;
    delete r.groups;
    r.warped = { width: warped.width, height: warped.height, buffer: warped.data.buffer };
    post(Object.assign({ type: 'result' }, r), [warped.data.buffer]);
  } catch (err) {
    post({ type: 'result', ok: false, error: '처리 중 오류: ' + (err && err.message || err) });
  }
};
