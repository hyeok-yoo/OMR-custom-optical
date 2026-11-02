/* 범용 OMR 판독 엔진 (순수 JS, 외부 라이브러리·양식 템플릿 없음)
 *
 * 1) 정합: 상단 타이밍 마크 줄 + 하단 좌/우 기준 마크로 용지를 평면으로 펼친다.
 *    (방향 90°/180°, 원근 왜곡 자동 보정. 마크가 없으면 스캔 이미지로 간주)
 * 2) 버블 검출: 드롭아웃(빨강·분홍) 인쇄 잉크의 고리 + 검은 마킹 덩어리
 * 3) 격자 구성: 이웃 버블을 상하·좌우로 연결해 블록 단위 격자를 만든다.
 * 4) 블록 분류: 버블 안쪽 인쇄 글자의 생김새를 비교
 *      - 같은 열끼리 닮음(①②③④⑤ 반복) → 객관식 블록 (행 = 문항)
 *      - 같은 행끼리 닮음(0,0,0 / 1,1,1) → 숫자 표기칸 (열 = 자릿수)
 *      - 열 길이 19/21/21 반복 + 촘촘한 간격 → 성명 칸
 *      - 떨어져 세로로 놓인 2~4개 버블 → 선택과목
 * 5) 판독: 붉은 잉크를 제거한 흑도로 버블별 마킹 비율 측정, 자동 임계값
 */
(function (root) {
  'use strict';

  // ================================================================ 기본 유틸
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function median(arr) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mean(arr) { let s = 0; for (const v of arr) s += v; return arr.length ? s / arr.length : 0; }

  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'.split('');
  const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'.split('');
  // 수능형 OMR 성명칸 종성 21종 → 유니코드 종성 인덱스
  const JONG_SHEET = 'ㄱㄲㄴㄶㄷㄹㄺㄻㄼㅀㅁㅂㅅㅆㅇㅈㅊㅋㅌㅍㅎ'.split('');
  const JONG_UNI = [1, 2, 4, 6, 7, 8, 9, 10, 11, 15, 16, 17, 19, 20, 21, 22, 23, 24, 25, 26, 27];

  // ================================================================ 조명 보정
  function maxChannel(data, n) {
    const out = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = data[j], g = data[j + 1], b = data[j + 2];
      out[i] = r > g ? (r > b ? r : b) : (g > b ? g : b);
    }
    return out;
  }

  // 블록별 상위 10% 밝기(용지 밝기) 격자. getter(i) 로 채널 값을 읽는다.
  function bgGrid(get, w, h, bs) {
    const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
    const g = new Float32Array(gw * gh);
    const hist = new Uint32Array(256);
    for (let by = 0; by < gh; by++) {
      for (let bx = 0; bx < gw; bx++) {
        hist.fill(0);
        const x0 = bx * bs, y0 = by * bs, x1 = Math.min(w, x0 + bs), y1 = Math.min(h, y0 + bs);
        let cnt = 0;
        for (let y = y0; y < y1; y += 2) {
          const o = y * w;
          for (let x = x0; x < x1; x += 2) { hist[get(o + x)]++; cnt++; }
        }
        const target = cnt * 0.1;
        let acc = 0, v = 255;
        for (; v > 0; v--) { acc += hist[v]; if (acc >= target) break; }
        g[by * gw + bx] = Math.max(v, 8);
      }
    }
    const s = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let sum = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= gh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= gw) continue;
            sum += g[yy * gw + xx]; c++;
          }
        }
        s[y * gw + x] = sum / c;
      }
    }
    return { g: s, gw, gh, bs };
  }

  // 값 / 용지밝기 × 200 (용지 ≈ 200) 로 정규화
  function normalizeBy(get, w, h, G, out) {
    const { g, gw, gh, bs } = G;
    const xi = new Int32Array(w), xt = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const fx = clamp((x + 0.5) / bs - 0.5, 0, gw - 1);
      const i0 = Math.min(Math.floor(fx), Math.max(0, gw - 2));
      xi[x] = i0; xt[x] = gw > 1 ? fx - i0 : 0;
    }
    const rowTop = new Float32Array(gw), rowBg = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      const fy = clamp((y + 0.5) / bs - 0.5, 0, gh - 1);
      const j0 = Math.min(Math.floor(fy), Math.max(0, gh - 2));
      const ty = gh > 1 ? fy - j0 : 0;
      const r0 = j0 * gw, r1 = Math.min(j0 + 1, gh - 1) * gw;
      for (let i = 0; i < gw; i++) rowTop[i] = g[r0 + i] + (g[r1 + i] - g[r0 + i]) * ty;
      for (let x = 0; x < w; x++) {
        const i0 = xi[x], i1 = i0 + 1 < gw ? i0 + 1 : i0;
        rowBg[x] = 200 / (rowTop[i0] + (rowTop[i1] - rowTop[i0]) * xt[x]);
      }
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const v = (get(o + x) * rowBg[x]) | 0;
        out[o + x] = v > 255 ? 255 : v;
      }
    }
    return out;
  }

  function normalizeLight(maxc, w, h, bs) {
    const get = i => maxc[i];
    const G = bgGrid(get, w, h, bs);
    return normalizeBy(get, w, h, G, new Uint8Array(w * h));
  }

  // ================================================================ 연결 요소
  // bin: Uint8Array(0/1). ring=true 이면 bbox 기준 타원 고리 비율(ringScore)도 계산
  function components(bin, w, h, opts) {
    opts = opts || {};
    const lab = new Int32Array(w * h);
    let cap = 4096;
    let parent = new Int32Array(cap);
    let next = 1;
    const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } return a < b ? a : b; };
    const conn8 = !!opts.conn8;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        if (!bin[o + x]) continue;
        let l = x > 0 ? lab[o + x - 1] : 0;
        const u = y > 0 ? lab[o + x - w] : 0;
        let cur = 0;
        if (l) cur = l;
        if (u) cur = cur ? unite(cur, u) : u;
        if (conn8 && y > 0) {
          const ul = x > 0 ? lab[o + x - w - 1] : 0, ur = x < w - 1 ? lab[o + x - w + 1] : 0;
          if (ul) cur = cur ? unite(cur, ul) : ul;
          if (ur) cur = cur ? unite(cur, ur) : ur;
        }
        if (!cur) {
          if (next >= cap) { const np = new Int32Array(cap * 2); np.set(parent); parent = np; cap *= 2; }
          parent[next] = next; cur = next++;
        }
        lab[o + x] = cur;
      }
    }
    const n = next;
    const root = new Int32Array(n);
    for (let i = 1; i < n; i++) root[i] = find(i);
    const area = new Float64Array(n), sx = new Float64Array(n), sy = new Float64Array(n);
    const sxx = new Float64Array(n), syy = new Float64Array(n), sxy = new Float64Array(n);
    const minx = new Int32Array(n).fill(1 << 30), maxx = new Int32Array(n).fill(-1);
    const miny = new Int32Array(n).fill(1 << 30), maxy = new Int32Array(n).fill(-1);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const l = lab[o + x];
        if (!l) continue;
        const r = root[l];
        lab[o + x] = r;
        area[r]++; sx[r] += x; sy[r] += y;
        sxx[r] += x * x; syy[r] += y * y; sxy[r] += x * y;
        if (x < minx[r]) minx[r] = x; if (x > maxx[r]) maxx[r] = x;
        if (y < miny[r]) miny[r] = y; if (y > maxy[r]) maxy[r] = y;
      }
    }
    let ringIn = null;
    if (opts.ring) {
      ringIn = new Float64Array(n);
      const maxW = opts.ringMaxW || 120, maxH = opts.ringMaxH || 160;
      for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) {
          const r = lab[o + x];
          if (!r) continue;
          const bw = maxx[r] - minx[r] + 1, bh = maxy[r] - miny[r] + 1;
          if (bw > maxW || bh > maxH || bw < 4 || bh < 4) continue;
          const nx = (x + 0.5 - (minx[r] + maxx[r] + 1) / 2) / (bw / 2);
          const ny = (y + 0.5 - (miny[r] + maxy[r] + 1) / 2) / (bh / 2);
          const rr = Math.sqrt(nx * nx + ny * ny);
          if (rr >= 0.62) ringIn[r]++;
        }
      }
    }
    const minArea = opts.minArea || 6;
    const blobs = [];
    for (let r = 1; r < n; r++) {
      if (root[r] !== r || area[r] < minArea) continue;
      const a = area[r];
      const cx = sx[r] / a, cy = sy[r] / a;
      const vxx = sxx[r] / a - cx * cx + 1 / 12, vyy = syy[r] / a - cy * cy + 1 / 12, vxy = sxy[r] / a - cx * cy;
      const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
      const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
      const theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
      const L = Math.sqrt(12 * l1), W = Math.sqrt(12 * l2);
      const bw = maxx[r] - minx[r] + 1, bh = maxy[r] - miny[r] + 1;
      blobs.push({
        cx, cy, area: a, L, W,
        ax: Math.cos(theta), ay: Math.sin(theta),
        aspect: L / W, solidity: a / (L * W),
        x0: minx[r], y0: miny[r], bw, bh,
        bcx: minx[r] + bw / 2, bcy: miny[r] + bh / 2,
        fill: a / (bw * bh),
        ring: ringIn ? ringIn[r] / a : 0
      });
    }
    return blobs;
  }

  // ================================================================ 선형대수
  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        if (!f) continue;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }
  function matMul(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0; for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
      C[i][j] = s;
    }
    return C;
  }
  function normT(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let d = 0;
    for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
    d = d / pts.length || 1;
    return { s: Math.SQRT2 / d, mx, my };
  }
  // src → dst 호모그래피 (가중 최소제곱, 정규화 DLT)
  function homography(src, dst, wts) {
    const ns = normT(src), nd = normT(dst);
    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Atb = new Array(8).fill(0);
    for (let i = 0; i < src.length; i++) {
      const w = wts ? wts[i] : 1;
      const x = (src[i][0] - ns.mx) * ns.s, y = (src[i][1] - ns.my) * ns.s;
      const u = (dst[i][0] - nd.mx) * nd.s, v = (dst[i][1] - nd.my) * nd.s;
      const rows = [[[x, y, 1, 0, 0, 0, -x * u, -y * u], u], [[0, 0, 0, x, y, 1, -x * v, -y * v], v]];
      for (const [r, t] of rows) {
        for (let a = 0; a < 8; a++) {
          if (!r[a]) continue;
          Atb[a] += w * r[a] * t;
          for (let c = 0; c < 8; c++) AtA[a][c] += w * r[a] * r[c];
        }
      }
    }
    const h = solveLinear(AtA, Atb);
    if (!h) return null;
    const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
    const Ts = [[ns.s, 0, -ns.s * ns.mx], [0, ns.s, -ns.s * ns.my], [0, 0, 1]];
    const TdI = [[1 / nd.s, 0, nd.mx], [0, 1 / nd.s, nd.my], [0, 0, 1]];
    const H = matMul(TdI, matMul(Hn, Ts));
    const k = H[2][2];
    return H.map(r => r.map(v => v / k));
  }
  function applyH(H, x, y) {
    const d = H[2][0] * x + H[2][1] * y + H[2][2];
    return [(H[0][0] * x + H[0][1] * y + H[0][2]) / d, (H[1][0] * x + H[1][1] * y + H[1][2]) / d];
  }

  // ================================================================ 1. 정합
  function findTrack(cands) {
    const n = cands.length;
    let best = null;
    for (let i = 0; i < n; i++) {
      const A = cands[i];
      for (let j = i + 1; j < n; j++) {
        const B = cands[j];
        const dx = B.cx - A.cx, dy = B.cy - A.cy;
        const d = Math.hypot(dx, dy);
        const Lm = (A.L + B.L) / 2;
        if (d < Lm * 12) continue;
        if (A.area > B.area * 1.8 || B.area > A.area * 1.8) continue;
        const ux = dx / d, uy = dy / d;
        if (Math.abs(A.ax * ux + A.ay * uy) > 0.45 || Math.abs(B.ax * ux + B.ay * uy) > 0.45) continue;
        const tol = Lm * 0.45, am = (A.area + B.area) / 2;
        let cnt = 0;
        for (let k = 0; k < n; k++) {
          const C = cands[k];
          if (Math.abs((C.cx - A.cx) * uy - (C.cy - A.cy) * ux) > tol) continue;
          if (C.area > am * 2 || C.area < am / 2) continue;
          if (Math.abs(C.ax * ux + C.ay * uy) > 0.5) continue;
          cnt++;
        }
        if (!best || cnt > best.cnt) best = { cnt, i, j, ux, uy };
      }
    }
    if (!best || best.cnt < 10) return null;
    let { ux, uy } = best;
    let ox = cands[best.i].cx, oy = cands[best.i].cy;
    const am = (cands[best.i].area + cands[best.j].area) / 2;
    const Lm = (cands[best.i].L + cands[best.j].L) / 2;
    let inl = [];
    for (let it = 0; it < 3; it++) {
      inl = cands.filter(C => Math.abs((C.cx - ox) * uy - (C.cy - oy) * ux) <= Lm * 0.45 &&
        C.area <= am * 2 && C.area >= am / 2 && Math.abs(C.ax * ux + C.ay * uy) <= 0.5);
      if (inl.length < 3) return null;
      let mx = 0, my = 0;
      for (const c of inl) { mx += c.cx; my += c.cy; }
      mx /= inl.length; my /= inl.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const c of inl) { const a = c.cx - mx, b = c.cy - my; sxx += a * a; syy += b * b; sxy += a * b; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const nux = Math.cos(th), nuy = Math.sin(th);
      if (nux * ux + nuy * uy < 0) { ux = -nux; uy = -nuy; } else { ux = nux; uy = nuy; }
      ox = mx; oy = my;
    }
    inl.forEach(c => { c.t = (c.cx - ox) * ux + (c.cy - oy) * uy; });
    inl.sort((a, b) => a.t - b.t);
    // 너무 멀리 떨어진 끝점(잡음) 제거: 인접 간격이 중앙값의 6배를 넘으면 잘라냄
    const gaps = [];
    for (let i = 1; i < inl.length; i++) gaps.push(inl[i].t - inl[i - 1].t);
    const mg = median(gaps);
    let s = 0, e = inl.length - 1;
    while (s < e && inl[s + 1].t - inl[s].t > mg * 6) s++;
    while (e > s && inl[e].t - inl[e - 1].t > mg * 6) e--;
    inl = inl.slice(s, e + 1);
    return { marks: inl, ux, uy, ox, oy, pitch: mg };
  }

  const STD_ASPECT = 0.754; // 수능형 OMR 카드 기준 마크 사각형 세로/가로 비

  function locate(img, log) {
    const { width: w, height: h, data } = img;
    const maxc = maxChannel(data, w * h);
    const bs = Math.max(24, Math.round(Math.max(w, h) / 60));
    const norm = normalizeLight(maxc, w, h, bs);
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < bin.length; i++) bin[i] = norm[i] < 95 ? 1 : 0;
    const blobs = components(bin, w, h, { minArea: 10 });
    const minArea = Math.max(12, (w * h) / 500000);
    const cands = blobs.filter(b =>
      b.area >= minArea && b.area < (w * h) / 800 &&
      b.aspect > 1.3 && b.aspect < 3.6 && b.solidity > 0.78 && b.solidity < 1.35);
    log && log(`검은 영역 ${blobs.length}개 · 마크 후보 ${cands.length}개`);
    const cl = cands.length > 700 ? cands.slice().sort((a, b) => b.area - a.area).slice(0, 700) : cands;
    const track = findTrack(cl);
    if (!track) return { ok: false, reason: 'notrack' };
    const marks = track.marks;
    const A = marks[0], B = marks[marks.length - 1];
    const L = Math.hypot(B.cx - A.cx, B.cy - A.cy);
    const ux = (B.cx - A.cx) / L, uy = (B.cy - A.cy) / L;
    const medArea = median(marks.map(m => m.area));
    const medAsp = median(marks.map(m => m.aspect));
    log && log(`타이밍 마크 ${marks.length}개 검출`);
    const pool = blobs.filter(b => b.area > medArea * 0.35 && b.area < medArea * 3 &&
      b.solidity > 0.72 && b.aspect > 1.1 && b.aspect < 4);
    let best = null;
    for (const side of [1, -1]) {
      const nx = -uy * side, ny = ux * side;
      const zone = (s0) => {
        const out = [];
        for (const b of pool) {
          const s = ((b.cx - A.cx) * ux + (b.cy - A.cy) * uy) / L;
          const d = ((b.cx - A.cx) * nx + (b.cy - A.cy) * ny) / L;
          const lo = s0 ? 0.84 : -0.34, hi = s0 ? 1.34 : 0.16;
          if (s > lo && s < hi && d > 0.42 && d < 1.15 && Math.abs(b.ax * nx + b.ay * ny) > 0.6) out.push({ b, s, d });
        }
        return out;
      };
      const left = zone(0), right = zone(1);
      for (const l of left) for (const r of right) {
        if (Math.abs(l.d - r.d) > 0.12) continue;
        const shape = Math.abs(Math.log(l.b.area / medArea)) + Math.abs(Math.log(r.b.area / medArea)) +
          Math.abs(Math.log(l.b.aspect / medAsp)) + Math.abs(Math.log(r.b.aspect / medAsp));
        // 기준 마크는 용지의 가장 바깥(아래·좌우 끝)에 있다 → 바깥쪽일수록 가산
        const score = (l.d + r.d) + 1.2 * (r.s - l.s) - 0.25 * shape;
        if (!best || score > best.score) best = { score, side, l: l.b, r: r.b, nx, ny };
      }
    }
    let TL, TR, BL, BR, method;
    if (best) {
      method = 'marks';
      if (best.side === 1) { TL = A; TR = B; } else { TL = B; TR = A; }
      // side=1 → 아래 방향 = rot90(u) 이므로 A가 왼쪽 위
      BL = best.side === 1 ? best.l : best.r;
      BR = best.side === 1 ? best.r : best.l;
    } else {
      // 하단 마크 없음: 용지 내용이 많은 쪽을 아래로 보고 닮음 변환으로 근사
      method = 'track';
      let cnt = [0, 0];
      [1, -1].forEach((side, k) => {
        const nx = -uy * side, ny = ux * side;
        for (const b of blobs) {
          const s = ((b.cx - A.cx) * ux + (b.cy - A.cy) * uy) / L;
          const d = ((b.cx - A.cx) * nx + (b.cy - A.cy) * ny) / L;
          if (s > 0 && s < 1 && d > 0.05 && d < 0.75) cnt[k]++;
        }
      });
      const side = cnt[0] >= cnt[1] ? 1 : -1;
      const nx = -uy * side, ny = ux * side;
      if (side === 1) { TL = A; TR = B; } else { TL = B; TR = A; }
      const down = STD_ASPECT * L;
      BL = { cx: TL.cx + nx * down, cy: TL.cy + ny * down };
      BR = { cx: TR.cx + nx * down, cy: TR.cy + ny * down };
      log && log('하단 기준 마크를 찾지 못해 근사 정합을 사용합니다');
    }
    const P = [TL, TR, BL, BR].map(m => [m.cx, m.cy]);
    const top = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]);
    const bot = Math.hypot(P[3][0] - P[2][0], P[3][1] - P[2][1]);
    const lef = Math.hypot(P[2][0] - P[0][0], P[2][1] - P[0][1]);
    const rig = Math.hypot(P[3][0] - P[1][0], P[3][1] - P[1][1]);
    let aspect = (lef + rig) / (top + bot);
    if (Math.abs(aspect - STD_ASPECT) < 0.07) aspect = STD_ASPECT;
    return { ok: true, method, corners: P, aspect, trackCount: marks.length, markSize: Math.sqrt(medArea) };
  }

  // 캔버스(펼친 평면) 정의: 기준 마크 사각형을 고정 위치에
  const CW = 2400, MARGIN = 48;
  function canonicalFrame(aspect) {
    const iw = CW - 2 * MARGIN;
    const ih = Math.round(iw * aspect);
    return { W: CW, H: ih + 2 * MARGIN, rect: [[MARGIN, MARGIN], [CW - MARGIN, MARGIN], [MARGIN, MARGIN + ih], [CW - MARGIN, MARGIN + ih]] };
  }

  function warp(img, H, W, Hh) {
    const out = new Uint8ClampedArray(W * Hh * 4);
    const { width: sw, height: sh, data } = img;
    for (let Y = 0; Y < Hh; Y++) {
      const ty = Y + 0.5;
      for (let X = 0; X < W; X++) {
        const tx = X + 0.5;
        const d = H[2][0] * tx + H[2][1] * ty + H[2][2];
        const u = (H[0][0] * tx + H[0][1] * ty + H[0][2]) / d - 0.5;
        const v = (H[1][0] * tx + H[1][1] * ty + H[1][2]) / d - 0.5;
        const o = (Y * W + X) * 4;
        if (u < 0 || v < 0 || u >= sw - 1 || v >= sh - 1) {
          out[o] = out[o + 1] = out[o + 2] = 235; out[o + 3] = 255; continue;
        }
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        out[o] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
        out[o + 1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
        out[o + 2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
        out[o + 3] = 255;
      }
    }
    return { width: W, height: Hh, data: out };
  }

  // ================================================================ 2. 잉크 맵
  function inkMaps(warped) {
    const { width: w, height: h, data } = warped;
    const n = w * h;
    const bs = 48;
    const ch = [0, 1, 2].map(c => {
      const get = i => data[i * 4 + c];
      const G = bgGrid(get, w, h, bs);
      return normalizeBy(get, w, h, G, new Uint8Array(n));
    });
    const [nr, ng, nb] = ch;
    const dk = new Float32Array(n);     // 검은 마킹 흑도 (0~1, 컬러 잉크 제외)
    const ink = new Uint8Array(n);      // 용지보다 어두운 모든 잉크 (밝기 기준 — JPEG 색 손실에 강함)
    const ci = new Uint8Array(n);       // 인쇄 잉크(검정 제외) — 버블 안 글자 패턴용
    for (let i = 0; i < n; i++) {
      const r = nr[i], g = ng[i], b = nb[i];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const spread = (mx - mn) / 200;
      let v = (0.8 - mx / 200) * 2;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      const sup = 1 - (spread - 0.1) / 0.12;
      dk[i] = sup >= 1 ? v : sup <= 0 ? 0 : v * sup;
      const lum = 0.3 * r + 0.59 * g + 0.11 * b;
      ink[i] = lum < 168 || mn < 140 ? 1 : 0;
      ci[i] = ink[i] && dk[i] < 0.5 ? 1 : 0;
    }
    return { dk, ci, ink, nr, ng, nb, w, h };
  }

  function close3(bin, w, h) {
    // 3x3 팽창 후 침식 (끊어진 얇은 고리 연결)
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    const pass = (src, dst, op) => {
      // 가로
      for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) {
          const a = src[o + x], l = x > 0 ? src[o + x - 1] : a, r = x < w - 1 ? src[o + x + 1] : a;
          tmp[o + x] = op ? (a | l | r) : (a & l & r);
        }
      }
      for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) {
          const a = tmp[o + x], u = y > 0 ? tmp[o + x - w] : a, d = y < h - 1 ? tmp[o + x + w] : a;
          dst[o + x] = op ? (a | u | d) : (a & u & d);
        }
      }
    };
    const dil = new Uint8Array(w * h);
    pass(bin, dil, 1);
    pass(dil, out, 0);
    return out;
  }

  // ================================================================ 3. 버블 검출
  // 고리 후보의 모양·색 특징: 닫힘 정도, 안쪽 글자 유무, 잉크 색 방향
  function ringFeatures(b, maps, cmask) {
    const { ci, nr, ng, nb, w, h } = maps;
    const cx = b.bcx, cy = b.bcy, ax = b.bw / 2, ay = b.bh / 2;
    let hits = 0;
    const NA = 32;
    for (let k = 0; k < NA; k++) {
      const t = (k / NA) * Math.PI * 2, c = Math.cos(t), sn = Math.sin(t);
      let hit = 0;
      for (const rr of [0.72, 0.82, 0.9, 0.97, 1.03]) {
        const x = Math.round(cx + c * ax * rr - 0.5), y = Math.round(cy + sn * ay * rr - 0.5);
        if (x >= 0 && y >= 0 && x < w && y < h && cmask[y * w + x]) { hit = 1; break; }
      }
      hits += hit;
    }
    let inner = 0, innerN = 0, sr = 0, sg = 0, sb = 0, sc = 0, sp = 0;
    const { ink } = maps;
    const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0), x1 = Math.min(w - 1, b.x0 + b.bw - 1), y1 = Math.min(h - 1, b.y0 + b.bh - 1);
    for (let y = y0; y <= y1; y++) {
      const ny = (y + 0.5 - cy) / ay;
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5 - cx) / ax;
        const rr = nx * nx + ny * ny;
        const i = y * w + x;
        if (rr < 0.25) { innerN++; inner += ink[i]; }
        if (ink[i]) {
          const r = nr[i], g = ng[i], bb = nb[i];
          sr += r; sg += g; sb += bb; sc++;
          sp += (Math.max(r, g, bb) - Math.min(r, g, bb)) / 200;
        }
      }
    }
    let hue = null;
    if (sc) {
      const r = sr / sc, g = sg / sc, bb = sb / sc, m = (r + g + bb) / 3;
      const v = [r - m, g - m, bb - m], n = Math.hypot(v[0], v[1], v[2]) || 1;
      hue = [v[0] / n, v[1] / n, v[2] / n];
    }
    const chroma = sc ? sp / sc : 0;
    return { closed: hits / NA, inner: innerN ? inner / innerN : 0, hue, chroma };
  }

  function detectBubbles(maps, opts) {
    const { dk, ink, w, h } = maps;
    const cmask = close3(ink, w, h);
    const rings = components(cmask, w, h, { ring: true, ringMaxW: 90, ringMaxH: 120, minArea: 15 });
    const relaxed = !!(opts && opts.relaxed);
    let rc = rings.filter(b => b.bw >= 7 && b.bh >= 9 && b.bw <= 80 && b.bh <= 110 &&
      b.bh / b.bw > 0.5 && b.bh / b.bw < 2.8 && b.fill > 0.1 && b.fill < (relaxed ? 1.01 : 0.93) && b.ring > (relaxed ? 0 : 0.3));
    rc.forEach(b => Object.assign(b, ringFeatures(b, maps, cmask)));
    rc = rc.filter(b => b.closed >= (relaxed ? 0.6 : 0.8) && b.hue);
    // 컬러(드롭아웃) 인쇄 버블이 충분하면 무채색(검은 글자 등)은 제외, 아니면 검은 인쇄 버블 양식으로 간주
    const colored = rc.filter(b => b.chroma > 0.07);
    const dropout = colored.length >= 20;
    if (dropout) rc = colored;
    if (rc.length < 10) return null;
    // 지배적인 버블 잉크 색 (대부분의 후보가 버블)
    let hm = [0, 0, 0];
    rc.forEach(b => { hm[0] += b.hue[0]; hm[1] += b.hue[1]; hm[2] += b.hue[2]; });
    for (let it = 0; it < 4; it++) {
      const n = Math.hypot(hm[0], hm[1], hm[2]) || 1; hm = hm.map(v => v / n);
      const sel = rc.filter(b => b.hue[0] * hm[0] + b.hue[1] * hm[1] + b.hue[2] * hm[2] > (it < 2 ? 0.5 : 0.75));
      if (!sel.length) break;
      hm = [0, 0, 0];
      sel.forEach(b => { hm[0] += b.hue[0]; hm[1] += b.hue[1]; hm[2] += b.hue[2]; });
    }
    { const n = Math.hypot(hm[0], hm[1], hm[2]) || 1; hm = hm.map(v => v / n); }
    if (dropout) rc = rc.filter(b => b.hue[0] * hm[0] + b.hue[1] * hm[1] + b.hue[2] * hm[2] > 0.8);
    // 안쪽에 인쇄 글자가 있는 버블이 대부분이면 빈 고리('0' 글자 등)는 제외
    const withInner = rc.filter(b => b.inner > 0.04).length;
    if (!relaxed && withInner > rc.length * 0.6) rc = rc.filter(b => b.inner > 0.04);
    if (rc.length < 10) return null;
    // 최빈 크기 (2px 단위 히스토그램)
    const hist = new Map();
    for (const b of rc) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = (Math.round(b.bw / 2) + dx) + ',' + (Math.round(b.bh / 2) + dy);
        hist.set(k, (hist.get(k) || 0) + (dx || dy ? 1 : 2));
      }
    }
    let mk = null, mv = -1;
    for (const [k, v] of hist) if (v > mv) { mv = v; mk = k; }
    const [mw, mh] = mk.split(',').map(v => +v * 2);
    rc = rc.filter(b => b.bw >= mw * 0.72 && b.bw <= mw * 1.35 && b.bh >= mh * 0.72 && b.bh <= mh * 1.35);
    const BW = median(rc.map(b => b.bw)), BH = median(rc.map(b => b.bh));
    // 검은 마킹 덩어리
    const bbin = new Uint8Array(w * h);
    for (let i = 0; i < bbin.length; i++) bbin[i] = dk[i] > 0.45 ? 1 : 0;
    const blacks = components(bbin, w, h, { minArea: 12 });
    const band = (opts && opts.band) || 0;
    const asp0 = BH / BW;
    const fills = blacks.filter(b => b.bw >= BW * 0.55 && b.bw <= BW * 2.2 && b.bh >= BH * 0.45 && b.bh <= BH * 1.8 &&
      b.fill > 0.5 && b.cy > band && b.cy < h - band && b.cx > band && b.cx < w - band &&
      (b.bh / b.bw) > asp0 * 0.55 && (b.bh / b.bw) < asp0 * 1.8);
    const pts = rc.map(b => ({ x: b.bcx, y: b.bcy, kind: 'ring' }));
    for (const f of fills) {
      let dup = false;
      for (const p of pts) if (Math.abs(p.x - f.cx) < BW * 0.6 && Math.abs(p.y - f.cy) < BH * 0.5) { dup = true; p.filled = true; break; }
      if (!dup) pts.push({ x: f.cx, y: f.cy, kind: 'fill', bw: f.bw, bh: f.bh });
    }
    return { pts, BW, BH, hue: hm, dropout };
  }

  // ================================================================ 4. 격자 구성
  function buildGroups(pts, BW, BH) {
    const n = pts.length;
    const down = new Int32Array(n).fill(-1), up = new Int32Array(n).fill(-1);
    const right = new Int32Array(n).fill(-1), left = new Int32Array(n).fill(-1);
    const bd = new Float64Array(n).fill(Infinity), bu = new Float64Array(n).fill(Infinity);
    const br = new Float64Array(n).fill(Infinity), bl = new Float64Array(n).fill(Infinity);
    const bestDown = new Int32Array(n).fill(-1), bestUp = new Int32Array(n).fill(-1);
    const bestRight = new Int32Array(n).fill(-1), bestLeft = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const q = pts[j];
        const dx = q.x - p.x, dy = q.y - p.y;
        if (dy > BH * 0.6 && dy < BH * 3.6 && Math.abs(dx) < Math.max(BW * 0.45, dy * 0.06)) {
          if (dy < bd[i]) { bd[i] = dy; bestDown[i] = j; }
          if (dy < bu[j]) { bu[j] = dy; bestUp[j] = i; }
        }
        if (dx > BW * 0.9 && dx < BW * 4.4 && Math.abs(dy) < Math.max(BH * 0.33, dx * 0.06)) {
          if (dx < br[i]) { br[i] = dx; bestRight[i] = j; }
          if (dx < bl[j]) { bl[j] = dx; bestLeft[j] = i; }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const j = bestDown[i];
      if (j >= 0 && bestUp[j] === i) { down[i] = j; up[j] = i; }
      const k = bestRight[i];
      if (k >= 0 && bestLeft[k] === i) { right[i] = k; left[k] = i; }
    }
    // 사슬 끝의 튀는 간격 연결 끊기 (안내 문구·머리글 등이 줄 끝에 붙는 것 방지)
    const trimChains = (next, prev, key) => {
      for (let i = 0; i < n; i++) {
        if (prev[i] >= 0 || next[i] < 0) continue;
        const chain = [];
        for (let c = i; c >= 0; c = next[c]) chain.push(c);
        if (chain.length < 4) continue;
        const ds = chain.slice(1).map((c, k) => pts[c][key] - pts[chain[k]][key]);
        const md = median(ds);
        // 앞쪽 끝
        if (ds[0] > md * 1.22) { next[chain[0]] = -1; prev[chain[1]] = -1; }
        // 뒤쪽 끝
        const L = ds.length - 1;
        if (ds[L] > md * 1.22) { next[chain[L]] = -1; prev[chain[L + 1]] = -1; }
      }
    };
    trimChains(down, up, 'y');
    trimChains(right, left, 'x');
    // union-find
    const par = new Int32Array(n);
    for (let i = 0; i < n; i++) par[i] = i;
    const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[b] = a; };
    for (let i = 0; i < n; i++) { if (down[i] >= 0) uni(i, down[i]); if (right[i] >= 0) uni(i, right[i]); }
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!map.has(r)) map.set(r, []);
      map.get(r).push(i);
    }
    const groups = [];
    for (const idx of map.values()) {
      // 열: 세로 연결 사슬
      const colOf = new Map(), rowOf = new Map();
      let cols = [], rows = [];
      for (const i of idx) {
        if (up[i] >= 0) continue;
        const chain = [];
        for (let c = i; c >= 0; c = down[c]) chain.push(c);
        cols.push(chain);
      }
      for (const i of idx) {
        if (left[i] >= 0) continue;
        const chain = [];
        for (let c = i; c >= 0; c = right[c]) chain.push(c);
        rows.push(chain);
      }
      // 같은 x 의 끊긴 열 병합, 같은 y 의 끊긴 행 병합
      // 같은 x(열) / 같은 y(행)의 끊긴 사슬 병합 — 같은 위치에 겹치는 점이 없을 때만
      const mergeLines = (lines, key, tol, otherKey, otherTol) => {
        lines = lines.map(l => ({ m: l, k: mean(l.map(i => pts[i][key])) }));
        lines.sort((a, b) => a.k - b.k);
        const out = [];
        const collide = (A, B) => A.some(i => B.some(j => Math.abs(pts[i][otherKey] - pts[j][otherKey]) < otherTol));
        for (const l of lines) {
          const prev = out.find(o => Math.abs(o.k - l.k) < tol && !collide(o.m, l.m));
          if (prev) { prev.m = prev.m.concat(l.m); prev.k = mean(prev.m.map(i => pts[i][key])); }
          else out.push(l);
        }
        return out.sort((a, b) => a.k - b.k).map(o => o.m);
      };
      cols = mergeLines(cols, 'x', BW * 0.5, 'y', BH * 0.5);
      rows = mergeLines(rows, 'y', BH * 0.42, 'x', BW * 0.6);
      cols = absorbFillLines(cols, pts, 'x', BW * 0.7);
      rows = absorbFillLines(rows, pts, 'y', BH * 0.6);
      cols.forEach((c, ci) => c.forEach(i => colOf.set(i, ci)));
      rows.forEach((r, ri) => r.forEach(i => rowOf.set(i, ri)));
      groups.push({ idx, cols, rows, colOf, rowOf });
    }
    return groups;
  }

  // 마킹 덩어리만으로 된 행/열이 인쇄 버블 행/열 바로 옆이면 합침 (큰 마킹의 무게중심 오차)
  function absorbFillLines(lines, pts, key, tol) {
    const isFillOnly = l => l.every(i => pts[i].kind === 'fill');
    const posOf = l => mean(l.map(i => pts[i][key]));
    const keep = lines.filter(l => !isFillOnly(l));
    if (!keep.length) return lines;
    const out = keep.map(l => l.slice());
    for (const l of lines) {
      if (!isFillOnly(l)) continue;
      const p = posOf(l);
      let best = -1, bd = Infinity;
      out.forEach((k, j) => { const d = Math.abs(posOf(k) - p); if (d < bd) { bd = d; best = j; } });
      if (best >= 0 && bd < tol) out[best] = out[best].concat(l); else out.push(l.slice());
    }
    return out.sort((a, b) => posOf(a) - posOf(b));
  }

  // 직선 적합: v = a + b*u
  function lineFit(us, vs) {
    const n = us.length;
    if (n < 2) return { a: n ? vs[0] : 0, b: 0 };
    const mu = mean(us), mv = mean(vs);
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (us[i] - mu) ** 2; sxy += (us[i] - mu) * (vs[i] - mv); }
    const b = sxx > 1e-6 ? sxy / sxx : 0;
    return { a: mv - b * mu, b: Math.abs(b) > 0.2 ? 0 : b };
  }

  // 그룹 → 격자 (행/열 위치 모델 + 점유 행렬)
  function makeGrid(g, pts, BW, BH) {
    const nc = g.cols.length, nr = g.rows.length;
    const ringPts = i => pts[i].kind === 'ring';
    const colFit = g.cols.map(c => {
      const use = c.filter(ringPts).length >= 2 ? c.filter(ringPts) : c;
      return lineFit(use.map(i => pts[i].y), use.map(i => pts[i].x));
    });
    const rowFit = g.rows.map(r => {
      const use = r.filter(ringPts).length >= 2 ? r.filter(ringPts) : r;
      return lineFit(use.map(i => pts[i].x), use.map(i => pts[i].y));
    });
    const rowY = g.rows.map(r => mean(r.map(i => pts[i].y)));
    const colX = g.cols.map(c => mean(c.map(i => pts[i].x)));
    const occ = Array.from({ length: nr }, () => new Array(nc).fill(-1));
    for (const i of g.idx) occ[g.rowOf.get(i)][g.colOf.get(i)] = i;
    const pos = (r, c) => {
      let y = rowY[r], x = colX[c];
      for (let k = 0; k < 2; k++) {
        x = colFit[c].a + colFit[c].b * y;
        y = rowFit[r].a + rowFit[r].b * x;
      }
      const i = occ[r][c];
      if (i >= 0 && pts[i].kind === 'ring') return [pts[i].x, pts[i].y];
      return [x, y];
    };
    const pitchY = nr > 1 ? median(rowY.slice(1).map((v, i) => v - rowY[i])) : BH * 2;
    const pitchX = nc > 1 ? median(colX.slice(1).map((v, i) => v - colX[i])) : BW * 3;
    return { nr, nc, occ, pos, rowY, colX, pitchX, pitchY, x0: Math.min(...colX), x1: Math.max(...colX), y0: Math.min(...rowY), y1: Math.max(...rowY) };
  }

  // 위/아래 가장자리의 듬성한 행 제거 (손글씨 등 잡음)
  function trimRows(G) {
    const cnt = G.occ.map(r => r.filter(v => v >= 0).length);
    const mx = Math.max(...cnt);
    let s = 0, e = G.nr - 1;
    while (s < e && cnt[s] < mx * 0.4) s++;
    while (e > s && cnt[e] < mx * 0.4) e--;
    if (s === 0 && e === G.nr - 1) return G;
    const keep = [];
    for (let r = s; r <= e; r++) keep.push(r);
    const occ = keep.map(r => G.occ[r]);
    const rowY = keep.map(r => G.rowY[r]);
    const oldPos = G.pos;
    return Object.assign({}, G, { nr: keep.length, occ, rowY, pos: (r, c) => oldPos(keep[r], c), y0: Math.min(...rowY), y1: Math.max(...rowY) });
  }

  function subGrid(G, cols) {
    const occ = G.occ.map(r => cols.map(c => r[c]));
    const colX = cols.map(c => G.colX[c]);
    const oldPos = G.pos;
    const pitchX = cols.length > 1 ? median(colX.slice(1).map((v, i) => v - colX[i])) : G.pitchX;
    return Object.assign({}, G, { nc: cols.length, occ, colX, pos: (r, c) => oldPos(r, cols[c]), pitchX, x0: Math.min(...colX), x1: Math.max(...colX) });
  }

  // 버블 안쪽 인쇄 글자 패턴 (정규화 벡터)
  function descriptor(maps, x, y, BW, BH) {
    const { ci, w, h } = maps;
    const gx = 5, gy = 8;
    const hw = BW * 0.3, hh = BH * 0.36;
    const v = new Float32Array(gx * gy);
    for (let j = 0; j < gy; j++) {
      for (let i = 0; i < gx; i++) {
        const xa = Math.round(x - hw + (2 * hw * i) / gx), xb = Math.round(x - hw + (2 * hw * (i + 1)) / gx);
        const ya = Math.round(y - hh + (2 * hh * j) / gy), yb = Math.round(y - hh + (2 * hh * (j + 1)) / gy);
        let s = 0, c = 0;
        for (let yy = ya; yy <= yb; yy++) {
          if (yy < 0 || yy >= h) continue;
          for (let xx = xa; xx <= xb; xx++) { if (xx < 0 || xx >= w) continue; s += ci[yy * w + xx]; c++; }
        }
        v[j * gx + i] = c ? s / c : 0;
      }
    }
    let m = 0; for (const a of v) m += a; m /= v.length;
    let nn = 0; for (let i = 0; i < v.length; i++) { v[i] -= m; nn += v[i] * v[i]; }
    nn = Math.sqrt(nn);
    if (nn < 1e-3) return null;
    for (let i = 0; i < v.length; i++) v[i] /= nn;
    return v;
  }
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  function rowSubGrid(G, rows) {
    const occ = rows.map(r => G.occ[r]);
    const rowY = rows.map(r => G.rowY[r]);
    const oldPos = G.pos;
    const pitchY = rows.length > 1 ? median(rowY.slice(1).map((v, i) => v - rowY[i])) : G.pitchY;
    return Object.assign({}, G, { nr: rows.length, occ, rowY, pos: (r, c) => oldPos(rows[r], c), pitchY, y0: Math.min(...rowY), y1: Math.max(...rowY) });
  }

  // 한 열 안에서 위아래 버블 글자가 얼마나 닮았는지 (객관식 열 ≈ 0.9, 번호 글자 열 ≈ 0.3)
  function columnConsistency(G, c, pts, maps, BW, BH) {
    const ds = [];
    for (let r = 0; r < G.nr; r++) {
      const i = G.occ[r][c];
      if (i < 0 || pts[i].kind !== 'ring' || pts[i].filled) { ds.push(null); continue; }
      ds.push(descriptor(maps, pts[i].x, pts[i].y, BW, BH));
    }
    const s = [];
    for (let r = 0; r < ds.length; r++) {
      if (!ds[r]) continue;
      for (let r2 = r + 1; r2 < Math.min(ds.length, r + 3); r2++) if (ds[r2]) s.push(dot(ds[r], ds[r2]));
    }
    return s.length ? mean(s) : null;
  }

  // 행끼리 닮음 vs 열끼리 닮음
  function similarityTest(G, pts, maps, BW, BH) {
    const desc = Array.from({ length: G.nr }, () => new Array(G.nc).fill(null));
    for (let r = 0; r < G.nr; r++) for (let c = 0; c < G.nc; c++) {
      const i = G.occ[r][c];
      if (i < 0 || pts[i].kind !== 'ring' || pts[i].filled) continue;
      desc[r][c] = descriptor(maps, pts[i].x, pts[i].y, BW, BH);
    }
    const sRow = [], sCol = [];
    for (let r = 0; r < G.nr; r++) for (let c = 0; c < G.nc; c++) {
      const a = desc[r][c]; if (!a) continue;
      for (let c2 = c + 1; c2 < G.nc && sRow.length < 600; c2++) if (desc[r][c2]) sRow.push(dot(a, desc[r][c2]));
      for (let r2 = r + 1; r2 < Math.min(G.nr, r + 4) && sCol.length < 600; r2++) if (desc[r2][c]) sCol.push(dot(a, desc[r2][c]));
    }
    return { row: sRow.length ? mean(sRow) : null, col: sCol.length ? mean(sCol) : null };
  }

  // 버블 테두리 위치의 잉크 밀도 (빠진 열 복원용)
  function ringInk(maps, x, y, BW, BH) {
    const { ink, w, h } = maps;
    let hit = 0;
    for (let k = 0; k < 24; k++) {
      const t = (k / 24) * Math.PI * 2;
      let any = 0;
      for (const rr of [0.82, 0.92, 1.0]) {
        const xx = Math.round(x + Math.cos(t) * BW / 2 * rr), yy = Math.round(y + Math.sin(t) * BH / 2 * rr);
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && ink[yy * w + xx]) { any = 1; break; }
      }
      hit += any;
    }
    return hit / 24;
  }

  // ================================================================ 5. 판독
  function fillScore(maps, x, y, BW, BH) {
    const { dk, w, h } = maps;
    const rx = BW * 0.3, ry = BH * 0.33;
    let s = 0, c = 0;
    const x0 = Math.floor(x - rx), x1 = Math.ceil(x + rx), y0 = Math.floor(y - ry), y1 = Math.ceil(y + ry);
    for (let yy = y0; yy <= y1; yy++) {
      if (yy < 0 || yy >= h) continue;
      const ny = (yy + 0.5 - y) / ry;
      for (let xx = x0; xx <= x1; xx++) {
        if (xx < 0 || xx >= w) continue;
        const nx = (xx + 0.5 - x) / rx;
        if (nx * nx + ny * ny > 1) continue;
        s += dk[yy * w + xx]; c++;
      }
    }
    return c ? s / c : 0;
  }

  function thresholds(all, opts) {
    const s = all.slice().sort((a, b) => a - b);
    const base = median(s);
    const p75 = s[Math.floor(s.length * 0.75)] || 0;
    const noise = Math.max(0.02, p75 - base);
    let thr = opts && opts.threshold;
    if (!thr) {
      thr = clamp(base + Math.max(0.22, noise * 4), 0.26, 0.45);
      let gap = 0, at = thr;
      for (let i = 1; i < s.length; i++) {
        const lo = s[i - 1], hi = s[i];
        if (hi < thr - 0.08 || lo > thr + 0.08) continue;
        if (hi - lo > gap) { gap = hi - lo; at = (lo + hi) / 2; }
      }
      if (gap > 0.06) thr = clamp(at, thr - 0.08, thr + 0.08);
    }
    const weak = Math.max(base + 0.06, thr * 0.4);
    return { thr, weak, base };
  }

  function classify(vals, T) {
    const marked = [], ambiguous = [];
    vals.forEach((v, i) => { if (v >= T.thr) marked.push(i); else if (v >= T.weak) ambiguous.push(i); });
    let pick, status;
    if (marked.length === 1) { pick = marked[0]; status = ambiguous.length || vals[pick] < T.thr + 0.08 ? 'check' : 'ok'; }
    else if (!marked.length) { pick = -1; status = ambiguous.length ? 'check' : 'blank'; }
    else { pick = -2; status = 'multi'; }
    return { pick, status, marked, ambiguous };
  }

  // ================================================================ 6. 전체 분석
  function analyze(img, opts) {
    opts = opts || {};
    const log = opts.log;
    const t0 = Date.now();
    let H, frame, method, locInfo = {};
    if (opts.corners) {
      frame = canonicalFrame(STD_ASPECT);
      H = homography(frame.rect, opts.corners);
      method = 'manual';
    } else {
      const loc = locate(img, log);
      if (loc.ok) {
        frame = canonicalFrame(loc.aspect);
        H = homography(frame.rect, loc.corners);
        method = loc.method;
        locInfo = loc;
      } else {
        // 기준 마크가 없음 → 이미 반듯한 스캔 이미지로 간주 (가로로 긴 방향)
        const { width: w, height: h } = img;
        const W = CW, Hh = Math.round(CW * h / w);
        frame = { W, H: Hh, rect: [[0, 0], [W, 0], [0, Hh], [W, Hh]] };
        H = homography(frame.rect, [[0, 0], [w, 0], [0, h], [w, h]]);
        method = 'scan';
        log && log('타이밍 마크가 없어 스캔 이미지로 처리합니다');
      }
    }
    if (!H) return { ok: false, error: '변환을 계산할 수 없습니다.' };
    const warped = warp(img, H, frame.W, frame.H);
    const maps = inkMaps(warped);
    const band = method === 'scan' ? 0 : MARGIN + 24;
    let det = detectBubbles(maps, { band });
    let structure = null, BW, BH;
    const run = d => { const g = buildGroups(d.pts, d.BW, d.BH); return interpret(g, d.pts, maps, d.BW, d.BH, frame); };
    if (det) structure = run(det);
    const weak = st => !st || st.mc.reduce((a, b) => a + b.rows.length, 0) + st.sa.length < 5;
    if (weak(structure)) {
      // 흐린 사진: 고리 대신 색 있는 버블 모양 덩어리로 재시도
      const d2 = detectBubbles(maps, { band, relaxed: true });
      if (d2) { const s2 = run(d2); if (!weak(s2) || !structure) { structure = s2; det = d2; } }
      log && log('흐림 보정 모드로 재검출');
    }
    if (!det || !structure) return { ok: false, error: '답안지의 인쇄 버블을 찾지 못했습니다. 용지 전체가 선명하게 나오도록 다시 촬영하세요.', method };
    BW = det.BW; BH = det.BH;
    log && log(`버블 ${det.pts.length}개 검출 (크기 ${BW.toFixed(0)}×${BH.toFixed(0)}px)`);
    // 판독
    const cells = [];
    const addCells = arr => arr.forEach(c => { c.score = fillScore(maps, c.x, c.y, BW, BH); cells.push(c); });
    structure.mc.forEach(b => b.rows.forEach(r => addCells(r.cells)));
    structure.digits.forEach(f => f.cols.forEach(c => addCells(c.cells)));
    if (structure.name) structure.name.cols.forEach(c => addCells(c.cells));
    if (structure.elective) addCells(structure.elective.cells);
    if (!structure.mc.length && !structure.digits.length) {
      return { ok: false, error: '객관식 답란을 찾지 못했습니다. 답안지 전체가 나오게 다시 촬영하세요.', method };
    }
    const T = thresholds(cells.map(c => c.score), opts);
    const result = assemble(structure, T, frame);
    // 안전망: 어떤 칸에도 속하지 않은 진한 마킹 (판독 누락 가능성)
    const allCells = cells.concat(structure.codes.flatMap(c => c.f.cols.flatMap(x => x.cells)));
    // 답란 블록 근처(블록 범위를 조금 넓힌 영역)만 검사 — 서명·필적란·배경은 제외
    const zones = structure.mc.map(b => b.G).concat(structure.digits.map(f => ({ x0: f.x0, x1: f.x1, y0: f.y0, y1: f.y1 })));
    const nearZone = p => zones.some(z => p.x > z.x0 - BW * 2.5 && p.x < z.x1 + BW * 2.5 && p.y > z.y0 - BH * 1.2 && p.y < z.y1 + BH * 1.2);
    const stray = det.pts.filter(p => p.kind === 'fill' && nearZone(p) && fillScore(maps, p.x, p.y, BW, BH) > T.thr &&
      !allCells.some(c => Math.abs(c.x - p.x) < BW * 0.7 && Math.abs(c.y - p.y) < BH * 0.6));
    const warnings = [];
    if (method === 'track') warnings.push('하단 기준 마크를 찾지 못해 근사 보정했습니다. 결과를 꼭 확인하세요.');
    if (method === 'scan') warnings.push('타이밍 마크가 없어 사진을 그대로 판독했습니다.');
    if (structure.mc.some(b => b.recovered)) warnings.push('흐린 버블 열 일부를 인쇄 숫자 모양으로 복원했습니다.');
    if (structure.mc.some(b => b.incomplete)) warnings.push('일부 답란 블록의 보기 열을 다 찾지 못했습니다. 해당 문항을 꼭 확인하세요.');
    if (stray.length) warnings.push(`답란 밖에서 인식되지 않은 마킹 ${stray.length}개가 있습니다.`);
    log && log(`판독 완료 · ${result.questions.length}문항 · ${Date.now() - t0}ms`);
    return Object.assign(result, {
      ok: true, method, H, warped, frame, bubble: { w: BW, h: BH },
      threshold: T.thr, base: T.base, trackCount: locInfo.trackCount || 0,
      warnings, stray: stray.map(p => ({ x: p.x, y: p.y })),
      groups: structure.debug
    });
  }

  // ================================================================ 구조 해석
  function interpret(groups, pts, maps, BW, BH, frame) {
    const mc = [], digitGroups = [], singles = [], debug = [];
    let name = null;
    // 그룹 → 열 간격이 크게 벌어지는 곳에서 분할 (같은 행 간격으로 붙은 객관식·숫자칸 분리)
    const segs = [];
    for (const g of groups) {
      if (g.idx.length === 1) { singles.push(pts[g.idx[0]]); continue; }
      const G0 = makeGrid(g, pts, BW, BH);
      const gaps = G0.colX.slice(1).map((v, i) => v - G0.colX[i]);
      const mg = median(gaps);
      let cur = [0];
      const parts = [];
      for (let c = 1; c < G0.nc; c++) {
        if (gaps[c - 1] > mg * 1.18 && gaps[c - 1] > BW * 1.6) { parts.push(cur); cur = []; }
        cur.push(c);
      }
      parts.push(cur);
      for (const p of parts) {
        let G = p.length === G0.nc ? G0 : subGrid(G0, p);
        // 빈 행 제거
        const keepRows = [];
        for (let r = 0; r < G.nr; r++) if (G.occ[r].some(v => v >= 0)) keepRows.push(r);
        if (keepRows.length < G.nr) G = rowSubGrid(G, keepRows);
        G = trimRows(G);
        const n = G.occ.reduce((s, r) => s + r.filter(v => v >= 0).length, 0);
        if (n === 1) { const i = G.occ.flat().find(v => v >= 0); singles.push(pts[i]); continue; }
        segs.push(G);
      }
    }
    for (let G of segs) {
      const nOcc = G.occ.reduce((s, r) => s + r.filter(v => v >= 0).length, 0);
      const colCounts = Array.from({ length: G.nc }, (_, c) => G.occ.filter(r => r[c] >= 0).length);
      const dbg = { x0: G.x0, y0: G.y0, x1: G.x1, y1: G.y1, nr: G.nr, nc: G.nc, n: nOcc, type: 'other' };
      debug.push(dbg);
      dbg.colX = G.colX.map(v => Math.round(v)); dbg.counts = colCounts;
      // 성명 칸: 6열 이상, 15행 이상, 촘촘한 세로 간격
      if (G.nc >= 6 && G.nr >= 15 && G.pitchY < BH * 1.75) {
        if (!name || nOcc > name.n) name = { G, n: nOcc, colCounts };
        dbg.type = 'name';
        continue;
      }
      // 꽉 찬 열(핵심 열)만으로 객관식 여부 판단 — 문항 번호 글자 등 잡음 열 제외
      let core = [];
      for (let c = 0; c < G.nc; c++) if (colCounts[c] >= Math.max(2, G.nr * 0.6)) core.push(c);
      // 객관식 버블 열은 위아래로 같은 글자(①…)가 반복됨 → 행마다 글자가 다른 열(문항 번호)은 제외
      if (core.length > 3 && G.nr >= 3) {
        const cons = core.map(c => columnConsistency(G, c, pts, maps, BW, BH));
        const good = cons.filter(v => v != null && v > 0.7).length;
        if (good >= 3) core = core.filter((c, i) => cons[i] == null || cons[i] > 0.55);
        dbg.cons = cons.map(v => v == null ? null : +v.toFixed(2));
      }
      let Gc = G;
      if (core.length && core.length < G.nc && core.length >= 3 && core.length <= 6) Gc = subGrid(G, core);
      const sim = similarityTest(Gc, pts, maps, BW, BH);
      dbg.sim = sim;
      const rc2 = Gc.occ.map(r => r.filter(v => v >= 0).length);
      const full2 = rc2.filter(v => v >= Gc.nc - (Gc.nc >= 5 ? 1 : 0)).length;
      const isMCshape = Gc.nc >= 3 && Gc.nc <= 6 && Gc.nr >= 2 && full2 >= Gc.nr * 0.85;
      let isMC;
      if (sim.row != null && sim.col != null) isMC = isMCshape && (sim.col > sim.row + 0.05 || (Math.abs(sim.col - sim.row) <= 0.05 && Gc.nr < 9));
      else isMC = isMCshape && Gc.nr < 9;
      if (isMC) {
        dbg.type = 'mc'; dbg.nc = Gc.nc; dbg.x0 = Gc.x0; dbg.x1 = Gc.x1;
        mc.push({ G: Gc, rows: [] });
      } else if (G.nr >= 9) {
        dbg.type = 'digits';
        digitGroups.push({ G, colCounts });
      } else {
        // 구조에 속하지 않는 점들 (선택과목 버블 후보)
        G.occ.flat().forEach(i => { if (i >= 0) singles.push(pts[i]); });
      }
    }
    // ---- 객관식 블록 → 행(문항)
    for (const b of mc) {
      const G = b.G;
      for (let r = 0; r < G.nr; r++) {
        const cells = [];
        for (let c = 0; c < G.nc; c++) { const [x, y] = G.pos(r, c); cells.push({ x, y }); }
        b.rows.push({ cells });
      }
      b.x = (G.x0 + G.x1) / 2; b.y = G.y0;
    }
    // 읽는 순서: x 범위가 겹치는 블록끼리 한 단(band), 단은 왼→오, 단 안에서는 위→아래
    const bands = [];
    mc.slice().sort((a, b) => a.G.x0 - b.G.x0).forEach(b => {
      const band = bands.find(B => b.G.x0 < B.x1 - BW && b.G.x1 > B.x0 + BW);
      if (band) { band.items.push(b); band.x0 = Math.min(band.x0, b.G.x0); band.x1 = Math.max(band.x1, b.G.x1); }
      else bands.push({ x0: b.G.x0, x1: b.G.x1, items: [b] });
    });
    bands.sort((a, b) => a.x0 - b.x0);
    const mcOrdered = [];
    bands.forEach(B => B.items.sort((a, b) => a.G.y0 - b.G.y0).forEach(b => mcOrdered.push(b)));

    // ---- 객관식 블록 열 수 일관성: 다른 블록보다 열이 적으면 빠진 열을 복원
    //      ① 온전한 블록의 열별 인쇄 숫자 모양(①~⑤)과 대조해 어느 열이 빠졌는지 판단
    //      ② 판단 불가 시 테두리 잉크로 판단, 그래도 안 되면 '확인 필요' 표시
    if (mcOrdered.length >= 2) {
      const major = Math.min(6, Math.max(...mcOrdered.filter(b => b.G.nr >= 2).map(b => b.G.nc)));
      const colDesc = (G, c) => {
        const acc = [];
        for (let r = 0; r < G.nr; r++) {
          const i = G.occ[r][c];
          if (i < 0 || pts[i].kind !== 'ring' || pts[i].filled) continue;
          const d = descriptor(maps, pts[i].x, pts[i].y, BW, BH);
          if (d) acc.push(d);
        }
        if (!acc.length) return null;
        const m = new Float32Array(acc[0].length);
        acc.forEach(d => d.forEach((v, k) => { m[k] += v; }));
        let nn = 0; m.forEach(v => { nn += v * v; }); nn = Math.sqrt(nn) || 1;
        return m.map(v => v / nn);
      };
      const ref = mcOrdered.filter(b => b.G.nc === major).sort((a, b) => b.G.nr - a.G.nr)[0];
      const refDesc = ref ? Array.from({ length: major }, (_, c) => colDesc(ref.G, c)) : null;
      for (const b of mcOrdered) {
        const G = b.G, nc0 = G.nc;
        if (nc0 >= major || nc0 < major - 2) continue;
        const px = G.pitchX;
        let offset = null;
        if (refDesc && refDesc.every(Boolean)) {
          const mine = Array.from({ length: nc0 }, (_, c) => colDesc(G, c));
          const scores = [];
          for (let o = 0; o <= major - nc0; o++) {
            let sc = 0, n = 0;
            mine.forEach((d, c) => { if (d) { sc += dot(d, refDesc[c + o]); n++; } });
            scores.push(n ? sc / n : -1);
          }
          const sorted = scores.slice().sort((x, y) => y - x);
          if (sorted[0] > 0.6 && sorted[0] - (sorted[1] ?? -1) > 0.08) offset = scores.indexOf(sorted[0]);
        }
        if (offset == null && major - nc0 === 1) {
          let left = 0, right = 0;
          for (let r = 0; r < G.nr; r++) {
            const [lx, ly] = G.pos(r, 0), [rx, ry] = G.pos(r, nc0 - 1);
            left += ringInk(maps, lx - px, ly, BW, BH); right += ringInk(maps, rx + px, ry, BW, BH);
          }
          const best = Math.max(left, right) / G.nr, other = Math.min(left, right) / G.nr;
          if (best > 0.5 && best - other > 0.25) offset = left >= right ? 1 : 0;
        }
        if (offset == null) { b.incomplete = true; continue; }
        const oldPos = G.pos;
        const pos = (r, c) => {
          const k = c - offset;
          if (k >= 0 && k < nc0) return oldPos(r, k);
          const [x, y] = oldPos(r, k < 0 ? 0 : nc0 - 1);
          return [x + (k < 0 ? k : k - (nc0 - 1)) * px, y];
        };
        b.G = Object.assign({}, G, { nc: major, pos, x0: G.x0 - offset * px, x1: G.x1 + (major - nc0 - offset) * px });
        b.rows = [];
        for (let r = 0; r < b.G.nr; r++) {
          const cells = [];
          for (let c = 0; c < b.G.nc; c++) { const [x, y] = b.G.pos(r, c); cells.push({ x, y }); }
          b.rows.push({ cells });
        }
        b.recovered = true;
      }
    }

    // ---- 숫자칸: 열 간격으로 필드 분리
    const digitFields = [];
    for (const dgrp of digitGroups) {
      const G = dgrp.G;
      // 각 열의 숫자 값: 그룹 전체 행 인덱스 기준. 10행이면 0~9, 9행이면 1~9
      const base = G.nr >= 10 ? 0 : (G.nr === 9 ? 1 : 0);
      const gaps = G.colX.slice(1).map((v, i) => v - G.colX[i]);
      const mg = median(gaps);
      let cur = [0];
      const parts = [];
      for (let c = 1; c < G.nc; c++) {
        if (gaps[c - 1] > mg * 1.3) { parts.push(cur); cur = []; }
        cur.push(c);
      }
      parts.push(cur);
      for (const p of parts) {
        const cols = p.map(c => {
          const cells = [];
          for (let r = 0; r < G.nr; r++) {
            // 열의 실제 범위(첫~끝 검출 행) 안쪽만 버블로 인정
            cells.push({ r, has: G.occ[r][c] >= 0 });
          }
          const rs = cells.filter(x => x.has).map(x => x.r);
          let lo = Math.min(...rs), hi = Math.max(...rs);
          // 0~9 처럼 거의 꽉 찬 열은 필드 전체 행 범위로 (가장자리 마킹 버블이 연결에서 빠져도 판독)
          if (rs.length >= G.nr * 0.75) { if (G.nr - 1 - hi <= 1) hi = G.nr - 1; if (lo <= 1 && G.nr >= 10 && rs.length >= G.nr - 1 && lo === 1 && !(c === p[0] && p.length >= 3)) lo = 0; }
          const out = [];
          for (let r = lo; r <= hi; r++) { const [x, y] = G.pos(r, c); out.push({ x, y, digit: (r + base) % 10 }); }
          return { cells: out, x: G.colX[c] };
        });
        digitFields.push({ cols, x0: G.colX[p[0]], x1: G.colX[p[p.length - 1]], y0: G.y0, y1: G.y1, pitch: mg || BW * 3, nr: G.nr });
      }
    }

    // ---- 선택과목: 구조 밖에 남은 버블이 세로로 2~4개, 일정한 간격
    let elective = null;
    const sing = singles.slice().sort((a, b) => a.y - b.y);
    const usedS = new Set();
    for (let i = 0; i < sing.length; i++) {
      if (usedS.has(i)) continue;
      const stack = [i];
      for (let j = i + 1; j < sing.length; j++) {
        if (usedS.has(j)) continue;
        const last = sing[stack[stack.length - 1]];
        if (Math.abs(sing[j].x - sing[i].x) < BW * 0.4 && sing[j].y > last.y + BH * 2.9 && sing[j].y < last.y + BH * 6.5) stack.push(j);
      }
      if (stack.length < 2 || stack.length > 4) continue;
      const ys = stack.map(k => sing[k].y);
      const dys = ys.slice(1).map((v, k) => v - ys[k]);
      if (Math.max(...dys) > Math.min(...dys) * 1.3) continue;
      const cand = stack.map(k => sing[k]);
      if (!cand.some(p => p.kind === 'ring')) continue;
      const asp0 = BH / BW;
      if (cand.some(p => p.kind === 'fill' && (p.bw > BW * 1.6 || p.bh > BH * 1.5 || p.bw < BW * 0.6 ||
        p.bh / p.bw < asp0 * 0.75 || p.bh / p.bw > asp0 * 1.45))) continue;
      // 숫자칸·객관식 블록 내부에 겹치면 제외
      // (객관식 블록 왼쪽의 문항 번호 영역 포함)
      const inside = cand.some(p => mc.some(b => p.x > b.G.x0 - BW * 5 && p.x < b.G.x1 + BW && p.y > b.G.y0 - BH && p.y < b.G.y1 + BH) ||
        digitGroups.some(d => p.x > d.G.x0 - BW && p.x < d.G.x1 + BW && p.y > d.G.y0 - BH && p.y < d.G.y1 + BH) ||
        (name && p.x > name.G.x0 - BW && p.x < name.G.x1 + BW && p.y > name.G.y0 - BH * 3 && p.y < name.G.y1 + BH));
      if (inside) continue;
      if (!elective || cand.length > elective.cells.length) elective = { cells: cand.map(p => ({ x: p.x, y: p.y })) };
      stack.forEach(k => usedS.add(k));
    }

    // ---- 숫자 필드 역할: 수험번호 / 단답형 / 과목코드 / 기타
    const W = frame.W;
    digitFields.sort((a, b) => a.x0 - b.x0);
    const examParts = [];
    const sa = [], codes = [], others = [];
    // 수험번호: 가장 왼쪽 필드에서 시작해 가까이 붙은 필드들 (용지 왼쪽 35% 이내)
    const leftMost = digitFields.find(f => f.x0 < W * 0.35);
    if (leftMost) {
      examParts.push(leftMost);
      let last = leftMost;
      for (const f of digitFields) {
        if (f === leftMost || f.x0 < last.x0) continue;
        if (f.x0 > W * 0.4) break;
        if (f.x0 - last.x1 <= last.pitch * 2.6 && Math.abs(f.y0 - last.y0) < BH * 4) { examParts.push(f); last = f; }
      }
    }
    for (const f of digitFields) {
      if (examParts.includes(f)) continue;
      const nCols = f.cols.length;
      // 바로 오른쪽에 객관식 블록이 있는 2열 필드 = 탐구 선택과목 번호
      const right = mcOrdered.find(b => b.G.x0 > f.x1 && b.G.x0 - f.x1 < f.pitch * 4.5 && b.G.y1 > f.y0 && b.G.y0 < f.y1);
      if (nCols === 2 && right && f.cols[1].cells.length >= 9) { codes.push({ f, block: right }); continue; }
      if (nCols >= 2 && nCols <= 4 && f.cols[nCols - 1].cells.length >= 9 && f.cols.every(c => c.cells.length >= 8)) { sa.push(f); continue; }
      others.push(f);
    }
    // 단답형 순서: 위 → 아래(행), 같은 행은 왼 → 오
    sa.sort((a, b) => (Math.abs(a.y0 - b.y0) < BH * 3 ? a.x0 - b.x0 : a.y0 - b.y0));

    // ---- 성명 칸
    let nameField = null;
    if (name) {
      const G = name.G;
      // 첫 열부터 3열씩 (초성 19, 중성 21, 종성 21). 열 길이로 시작 위치 보정
      const counts = name.colCounts;
      let offset = 0, bestFit = -Infinity;
      for (let o = 0; o < 3; o++) {
        let fit = 0;
        for (let c = 0; c < G.nc; c++) {
          const role = (c - o + 3) % 3;
          const exp = role === 0 ? 19 : 21;
          fit -= Math.abs(counts[c] - exp);
        }
        if (fit > bestFit) { bestFit = fit; offset = o; }
      }
      const cols = [];
      for (let c = offset; c < G.nc; c++) {
        const role = (c - offset) % 3;
        const list = role === 0 ? CHO : role === 1 ? JUNG : JONG_SHEET;
        const cells = [];
        for (let r = 0; r < Math.min(G.nr, list.length); r++) { const [x, y] = G.pos(r, c); cells.push({ x, y, jamo: list[r], idx: r }); }
        cols.push({ role, cells });
      }
      nameField = { cols };
    }

    return { mc: mcOrdered, digits: digitFields, sa, codes, examParts, others, name: nameField, elective, debug };
  }

  // 프로필(과목 유형) 추정과 문항 번호 부여
  function assemble(S, T, frame) {
    const nMC = S.mc.reduce((s, b) => s + b.rows.length, 0);
    const nSA = S.sa.length;
    const nEl = S.elective ? S.elective.cells.length : 0;
    let profile = { id: 'generic', label: `${nMC + nSA}문항`, electiveLabels: null, electiveFrom: null };
    if (nEl === 2 && nMC === 45 && !nSA) profile = { id: 'korean', label: '국어형 · 화법과 작문/언어와 매체', electiveLabels: ['화법과 작문', '언어와 매체'], electiveFrom: 35 };
    else if (nSA > 0 && nEl === 3) profile = { id: 'math', label: '수학형 · 확률과 통계/미적분/기하', electiveLabels: ['확률과 통계', '미적분', '기하'], electiveFrom: 23 };
    else if (nSA > 0) profile = { id: 'math-old', label: `수학형 · 객관식 ${nMC} + 단답형 ${nSA}`, electiveLabels: null, electiveFrom: null };
    else if (S.codes.length >= 2) profile = { id: 'inquiry', label: '탐구형 · 선택과목 2개', electiveLabels: null, electiveFrom: null };
    else if (nEl >= 2) profile = { id: 'generic-el', label: `${nMC}문항 · 선택 ${nEl}개`, electiveLabels: Array.from({ length: nEl }, (_, i) => `선택 ${i + 1}`), electiveFrom: null };

    // 블록 ID (AI 양식 해석·학습 양식 적용용): 객관식 A1…, 단답형 S1…
    S.mc.forEach((b, i) => { b.id = 'A' + (i + 1); b.rows.forEach((r, ri) => { r.blk = b.id; r.ri = ri; }); });
    S.sa.forEach((f, i) => { f.id = 'S' + (i + 1); });
    const blocks = S.mc.map(b => ({ id: b.id, type: 'mc', x0: b.G.x0, x1: b.G.x1, y0: b.G.y0, y1: b.G.y1, rows: b.rows.length }))
      .concat(S.sa.map(f => ({ id: f.id, type: 'sa', x0: f.x0, x1: f.x1, y0: f.y0, y1: f.y1 })));
    if (S.elective) {
      const xs = S.elective.cells.map(c => c.x), ys = S.elective.cells.map(c => c.y);
      blocks.push({ id: 'E', type: 'elective', x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }

    // 섹션: 탐구형은 선택과목 번호칸마다 별도 섹션(각 1번부터)
    const sections = [];
    const questions = [];
    const mkMC = (row, sec, no, block, incomplete) => {
      const vals = row.cells.map(c => c.score);
      const k = classify(vals, T);
      if (incomplete && k.status === 'ok') k.status = 'check';
      return {
        key: `${sec}:${no}`, section: sec, no, type: 'mc', options: row.cells.length, block, blockId: row.blk, row: row.ri,
        cells: row.cells, scores: vals,
        answer: k.pick >= 0 ? k.pick + 1 : k.pick === -1 ? 0 : -1,
        status: k.status, marked: k.marked.map(i => i + 1), ambiguous: k.ambiguous.map(i => i + 1)
      };
    };
    const readDigitCol = col => {
      const vals = col.cells.map(c => c.score);
      const k = classify(vals, T);
      return { digit: k.pick >= 0 ? col.cells[k.pick].digit : null, status: k.status, k, vals };
    };
    const mkSA = (f, sec, no) => {
      const ds = f.cols.map(readDigitCol);
      const cells = f.cols.flatMap(c => c.cells);
      let status = 'ok', value = null;
      if (ds.some(d => d.status === 'multi')) { status = 'multi'; value = -1; }
      else {
        const marked = ds.filter(d => d.digit != null);
        if (!marked.length) { status = ds.some(d => d.status === 'check') ? 'check' : 'blank'; value = null; }
        else {
          value = 0;
          ds.forEach(d => { value = value * 10 + (d.digit == null ? 0 : d.digit); });
          if (ds.some(d => d.status === 'check')) status = 'check';
          // 앞자리가 표기됐는데 가운데 자리가 비면 표기 오류 가능 → 확인
          const first = ds.findIndex(d => d.digit != null);
          if (ds.slice(first).some(d => d.digit == null)) status = 'check';
        }
      }
      return {
        key: `${sec}:${no}`, section: sec, no, type: 'sa', digitsCount: f.cols.length, blockId: f.id, row: 0,
        cells, cols: f.cols.map((c, i) => ({ cells: c.cells, digit: ds[i].digit, status: ds[i].status, marked: ds[i].k.marked, ambiguous: ds[i].k.ambiguous })),
        answer: value == null ? 0 : value, value, status,
        scores: cells.map(c => c.score)
      };
    };

    if (profile.id === 'inquiry') {
      S.codes.sort((a, b) => a.f.x0 - b.f.x0);
      const blocksBySec = S.codes.map(() => []);
      S.mc.forEach(b => {
        // 블록 왼쪽에 있는 가장 가까운 코드칸의 섹션
        let best = 0, bd = Infinity;
        S.codes.forEach((c, i) => { const d = b.G.x0 - c.f.x1; if (d > -1 && d < bd) { bd = d; best = i; } });
        blocksBySec[best].push(b);
      });
      S.codes.forEach((c, i) => {
        const ds = c.f.cols.map(readDigitCol);
        const code = ds.every(d => d.digit != null) ? ds.map(d => d.digit).join('') : null;
        sections.push({ id: i, title: `제${i + 1}선택`, code: code ? +code : null, codeCells: c.f.cols.flatMap(x => x.cells) });
        let no = 1;
        blocksBySec[i].forEach((b, bi) => b.rows.forEach(r => questions.push(mkMC(r, i, no++, `${i}-${bi}`, b.incomplete))));
      });
    } else {
      sections.push({ id: 0, title: '' });
      if (profile.id === 'math' && nMC === 21 && nSA === 9) {
        // 수능 수학: 공통 객관식 1~15, 단답형 16~22, 선택 객관식 23~28, 단답형 29~30
        const rows = [];
        S.mc.forEach((b, bi) => b.rows.forEach(r => rows.push([r, bi, b.incomplete])));
        rows.forEach(([r, bi, inc], i) => questions.push(mkMC(r, 0, i < 15 ? i + 1 : 23 + (i - 15), bi, inc)));
        S.sa.forEach((f, i) => questions.push(mkSA(f, 0, i < 7 ? 16 + i : 29 + (i - 7))));
      } else {
        let no = 1;
        S.mc.forEach((b, bi) => b.rows.forEach(r => questions.push(mkMC(r, 0, no++, bi, b.incomplete))));
        S.sa.forEach(f => questions.push(mkSA(f, 0, no++)));
      }
    }
    questions.sort((a, b) => a.section - b.section || a.no - b.no);

    // 선택과목
    let elective = null;
    if (S.elective) {
      const vals = S.elective.cells.map(c => c.score);
      const k = classify(vals, T);
      elective = {
        options: vals.length, labels: profile.electiveLabels || vals.map((_, i) => `선택 ${i + 1}`),
        cells: S.elective.cells, scores: vals,
        answer: k.pick >= 0 ? k.pick + 1 : k.pick === -1 ? 0 : -1, status: k.status, marked: k.marked.map(i => i + 1)
      };
    }

    // 성명
    let name = null;
    if (S.name) {
      const cols = S.name.cols.map(c => {
        const vals = c.cells.map(x => x.score);
        const k = classify(vals, T);
        return { role: c.role, cells: c.cells, pick: k.pick, status: k.status, marked: k.marked };
      });
      const chars = [];
      let anyMark = false, uncertain = false;
      for (let i = 0; i + 1 < cols.length; i += 3) {
        const cho = cols[i], jung = cols[i + 1], jong = cols[i + 2];
        const used = [cho, jung, jong].filter(Boolean).some(c => c.pick !== -1 || c.status === 'check');
        if (!used) { chars.push(null); continue; }
        anyMark = true;
        if (cho.pick >= 0 && jung.pick >= 0 && (!jong || jong.pick >= -1)) {
          const jo = jong && jong.pick >= 0 ? JONG_UNI[jong.pick] : 0;
          chars.push(String.fromCharCode(0xAC00 + (cho.pick * 21 + jung.pick) * 28 + jo));
          if ([cho, jung, jong].some(c => c && c.status !== 'ok' && c.status !== 'blank')) uncertain = true;
        } else { chars.push('?'); uncertain = true; }
      }
      while (chars.length && chars[chars.length - 1] === null) chars.pop();
      const text = chars.map(c => c || ' ').join('').trim();
      name = anyMark ? { text, uncertain, cols } : { text: '', uncertain: false, cols };
    }

    // 수험번호
    let examNo = null;
    if (S.examParts.length) {
      const cols = S.examParts.flatMap(f => f.cols);
      const ds = cols.map(c => {
        const vals = c.cells.map(x => x.score);
        const k = classify(vals, T);
        return { cells: c.cells, digit: k.pick >= 0 ? c.cells[k.pick].digit : null, status: k.status, short: c.cells.length <= 4 };
      });
      const any = ds.some(d => d.digit != null);
      let text = '';
      if (any) {
        const dstr = d => (d.digit == null ? '_' : String(d.digit));
        // 수능형: 학년(1~3, 짧은 열) + 반 2자리 + 번호 2자리
        if (ds.length === 5 && ds[0].short) {
          text = `${dstr(ds[0])}학년 ${ds[1].digit == null && ds[2].digit == null ? '__' : dstr(ds[1]) + dstr(ds[2])}반 ${dstr(ds[3]) + dstr(ds[4])}번`;
        } else {
          // 필드(간격) 단위로 '-' 구분
          const parts = [];
          let k = 0;
          S.examParts.forEach(f => { parts.push(ds.slice(k, k + f.cols.length).map(dstr).join('')); k += f.cols.length; });
          text = parts.join('-');
        }
      }
      examNo = { text, digits: ds, uncertain: ds.some(d => d.status === 'check' || d.status === 'multi') };
    }

    // 양식 지문(같은 양식 기억용)
    const fp = [profile.id, nMC, nSA, nEl, S.codes.length, S.mc.map(b => b.rows.length).join('.'),
      S.mc.map(b => Math.round(b.G.x0 / 60)).join('.')].join('|');

    return { profile, sections, questions, elective, name, examNo, fingerprint: fp, blocks };
  }

  // AI 해석·사용자 수정으로 얻은 양식 정보로 문항 번호 다시 매기기 (판독값은 그대로)
  // layout: { sections:[...], blocks:[{id, firstNo, section}], shortAnswers:[{id, no, section}], electiveLabels:[...] }
  function relabel(result, layout) {
    if (!layout) return result;
    const bmap = new Map((layout.blocks || []).map(b => [b.id, b]));
    const smap = new Map((layout.shortAnswers || []).map(b => [b.id, b]));
    result.questions.forEach(q => {
      if (q.type === 'mc' && bmap.has(q.blockId)) { const b = bmap.get(q.blockId); q.no = b.firstNo + q.row; q.section = b.section || 0; }
      if (q.type === 'sa' && smap.has(q.blockId)) { const b = smap.get(q.blockId); q.no = b.no; q.section = b.section || 0; }
      q.key = `${q.section}:${q.no}`;
    });
    result.questions.sort((a, b) => a.section - b.section || a.no - b.no);
    const nSec = Math.max(1, (layout.sections || []).length, ...result.questions.map(q => q.section + 1));
    const old = result.sections || [];
    result.sections = Array.from({ length: nSec }, (_, i) => Object.assign({}, old[i] || { id: i }, { id: i, title: (layout.sections || [])[i] ?? (old[i] && old[i].title) ?? '' }));
    if (result.elective && layout.electiveLabels && layout.electiveLabels.length === result.elective.options) result.elective.labels = layout.electiveLabels.slice();
    if (layout.subject) result.profile = Object.assign({}, result.profile, { subject: layout.subject });
    result.layoutSource = layout.source || 'user';
    return result;
  }

  // 미리보기(실시간 카메라)용: 기준 마크만 빠르게 찾기
  function quickLocate(img) {
    const loc = locate(img);
    return loc.ok ? { ok: true, corners: loc.corners, method: loc.method, trackCount: loc.trackCount } : { ok: false };
  }

  root.OMREngine = {
    analyze, quickLocate, relabel, homography, applyH, canonicalFrame, STD_ASPECT,
    CHO, JUNG, JONG_SHEET,
    _internal: { locate, warp, inkMaps, detectBubbles, buildGroups, interpret, components, close3, ringFeatures, homography, canonicalFrame }
  };
})(typeof self !== 'undefined' ? self : this);
