/* Gemini API
 *  1) extractAnswerKey  — 정답표/문제지(사진·PDF) → 정답·배점
 *  2) interpretLayout   — 광학 엔진이 찾은 답란 블록에 문항 번호·역할을 붙임 (양식당 1회, 결과는 기억)
 *  3) directRead        — 광학 판독이 불가능한 특이 양식에서 마킹을 직접 읽음 (확인 필요 표시)
 * 마킹 판독 자체는 기본적으로 광학 엔진이 담당하고, AI는 '글자를 읽어야 하는 일'에만 쓴다.
 */
(function (root) {
  'use strict';
  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const MODELS = {
    'gemini-flash-latest': { name: 'Gemini Flash', note: '정확도 우선' },
    'gemini-flash-lite-latest': { name: 'Gemini Flash-Lite', note: '속도·비용 우선' }
  };

  async function call(apiKey, model, parts, schema, signal) {
    if (!apiKey) throw new Error('설정에서 Gemini API 키를 먼저 입력하세요.');
    const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0 } };
    if (schema) { body.generationConfig.responseMimeType = 'application/json'; body.generationConfig.responseSchema = schema; }
    let res;
    try {
      res = await fetch(ENDPOINT + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal
      });
    } catch (e) {
      throw new Error('네트워크에 연결할 수 없습니다.');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json.error && json.error.message) || res.statusText;
      const e = new Error(res.status === 400 && /API key/i.test(msg) ? 'API 키가 올바르지 않습니다.' : `Gemini 오류 (${res.status}): ${msg}`);
      e.status = res.status;
      throw e;
    }
    const cand = json.candidates && json.candidates[0];
    if (!cand) throw new Error('Gemini 응답이 비어 있습니다.');
    const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
    if (!schema) return text;
    try { return JSON.parse(text); } catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('응답을 해석할 수 없습니다.');
      return JSON.parse(m[0]);
    }
  }

  function blobToInline(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res({ mimeType: blob.type || 'image/jpeg', data: String(fr.result).split(',')[1] });
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  async function fileToInline(file, maxDim) {
    if (file.type === 'application/pdf') return blobToInline(file);
    const bmp = await root.loadImageBitmap(file);
    const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return { mimeType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.9).split(',')[1] };
  }
  function canvasToInline(canvas, quality) {
    return { mimeType: 'image/jpeg', data: canvas.toDataURL('image/jpeg', quality || 0.88).split(',')[1] };
  }

  // ------------------------------------------------------------ 1. 정답표
  const item = {
    type: 'OBJECT',
    properties: {
      q: { type: 'INTEGER', description: '문항 번호' },
      a: { type: 'INTEGER', description: '정답. 객관식은 1~5(①=1), 단답형(주관식)은 정수 값' },
      p: { type: 'INTEGER', description: '배점. 보이지 않으면 0' },
      sa: { type: 'BOOLEAN', description: '단답형(주관식)이면 true' }
    },
    required: ['q', 'a', 'p', 'sa']
  };
  const KEY_SCHEMA = {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING', description: '시험명·회차 (없으면 빈 문자열)' },
      subject: { type: 'STRING', description: '과목명 (국어/수학/영어/한국사/탐구 과목명 등)' },
      pointsVisible: { type: 'BOOLEAN', description: '문항별 배점이 자료에 표시되어 있으면 true' },
      items: { type: 'ARRAY', items: item, description: '모든 응시자 공통 문항' },
      electives: {
        type: 'ARRAY',
        description: '선택과목별 문항 (예: 화법과 작문/언어와 매체, 확률과 통계/미적분/기하). 없으면 빈 배열',
        items: { type: 'OBJECT', properties: { label: { type: 'STRING' }, items: { type: 'ARRAY', items: item } }, required: ['label', 'items'] }
      },
      note: { type: 'STRING', description: '읽기 어려웠던 부분 (없으면 빈 문자열)' }
    },
    required: ['title', 'subject', 'pointsVisible', 'items', 'electives', 'note']
  };
  const KEY_PROMPT = `첨부 자료는 시험의 정답표(빠른 정답, 정답 및 해설, 채점 기준 등)이거나 문제지입니다.
정답과 배점을 정확히 추출해 JSON으로만 답하세요.

규칙
- 객관식 정답은 1~5 정수(①=1 … ⑤=5). 단답형(주관식) 정답은 숫자 값 그대로, sa=true.
- 배점: 정답표의 배점 열, 또는 문제지 각 문항 끝의 [2점]·[3점]·[4점] 표기를 사용. 어디에도 없으면 p=0, pointsVisible=false.
- 선택과목이 있으면 공통 문항은 items, 선택과목 문항은 electives에 과목별로 넣으세요.
  (예: 국어 1~34 공통 + 35~45 화법과 작문/언어와 매체, 수학 1~22 공통 + 23~30 확률과 통계/미적분/기하)
- 여러 과목이 섞여 있으면 가장 비중 있는 한 과목만. 해설 본문의 숫자는 무시하고 '정답' 표기만 사용.
- 추측하지 말고, 확실하지 않은 문항은 note에 적으세요.`;

  async function extractAnswerKey(files, opts) {
    const parts = [{ text: KEY_PROMPT }];
    for (const f of files) parts.push({ inlineData: await fileToInline(f, 2400) });
    const d = await call(opts.apiKey, opts.model, parts, KEY_SCHEMA, opts.signal);
    const norm = arr => (arr || [])
      .filter(it => Number.isFinite(+it.q) && Number.isFinite(+it.a))
      .map(it => ({ no: +it.q, a: +it.a, p: +it.p > 0 ? +it.p : null, type: it.sa ? 'sa' : 'mc' }))
      .sort((x, y) => x.no - y.no);
    return {
      title: d.title || '', subject: d.subject || '', note: d.note || '',
      pointsVisible: !!d.pointsVisible,
      items: norm(d.items),
      electives: (d.electives || []).map(e => ({ label: e.label || '선택', items: norm(e.items) })).filter(e => e.items.length)
    };
  }

  // ------------------------------------------------------------ 2. 양식 해석
  const LAYOUT_SCHEMA = {
    type: 'OBJECT',
    properties: {
      subject: { type: 'STRING', description: '과목명 (예: 국어, 수학, 영어, 탐구). 모르면 빈 문자열' },
      sections: { type: 'ARRAY', items: { type: 'STRING' }, description: '채점 구역 이름. 보통 [""] 하나, 탐구처럼 과목 2개면 ["제1선택","제2선택"]' },
      blocks: {
        type: 'ARRAY',
        description: '객관식 블록(A1, A2 …)마다 맨 위 행의 문항 번호',
        items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, firstNo: { type: 'INTEGER' }, section: { type: 'INTEGER', description: 'sections 배열의 인덱스' } }, required: ['id', 'firstNo', 'section'] }
      },
      shortAnswers: {
        type: 'ARRAY',
        description: '단답형 칸(S1, S2 …)마다 문항 번호',
        items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, no: { type: 'INTEGER' }, section: { type: 'INTEGER' } }, required: ['id', 'no', 'section'] }
      },
      electiveLabels: { type: 'ARRAY', items: { type: 'STRING' }, description: '선택과목 표기란(E)이 있으면 보기 순서대로 과목명, 없으면 빈 배열' }
    },
    required: ['subject', 'sections', 'blocks', 'shortAnswers', 'electiveLabels']
  };
  const LAYOUT_PROMPT = `이 이미지는 OMR 답안지를 반듯하게 펼친 것입니다. 광학 판독기가 찾은 답란을 색 상자로 표시했습니다.
- A1, A2 … : 객관식 블록 (한 행 = 한 문항, 보기 ①~⑤가 가로로 있음)
- S1, S2 … : 단답형(주관식) 숫자 표기칸 (백·십·일 자리 등)
- E : 선택과목 표기란
각 상자 근처에 인쇄된 문항 번호와 글자를 읽어서 알려주세요.
- blocks: 각 A 상자의 '맨 위 행'에 인쇄된 문항 번호 (예: 1, 21, 23)
- shortAnswers: 각 S 상자 위에 인쇄된 문항 번호 (예: '22번' → 22)
- electiveLabels: E 상자의 보기 순서대로 과목명 (예: ["확률과 통계","미적분","기하"])
- sections: 대부분 [""] 하나. 탐구처럼 과목별로 1번부터 다시 시작하는 구역이 있으면 구역 이름들.
상자 안의 마킹 여부는 신경 쓰지 말고 인쇄된 글자만 읽으세요.`;

  async function interpretLayout(canvas, opts) {
    const parts = [{ text: LAYOUT_PROMPT }, { inlineData: canvasToInline(canvas, 0.85) }];
    return call(opts.apiKey, opts.model, parts, LAYOUT_SCHEMA, opts.signal);
  }

  // ------------------------------------------------------------ 3. 직접 판독 (최후 수단)
  const READ_SCHEMA = {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING' },
      examNo: { type: 'STRING' },
      elective: { type: 'STRING', description: '표기된 선택과목명, 없으면 빈 문자열' },
      answers: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            q: { type: 'INTEGER' },
            a: { type: 'INTEGER', description: '객관식은 칠해진 보기 번호(1~5), 비었으면 0, 두 개 이상이면 -1. 단답형은 표기된 숫자' },
            sa: { type: 'BOOLEAN' },
            unsure: { type: 'BOOLEAN' }
          },
          required: ['q', 'a', 'sa', 'unsure']
        }
      }
    },
    required: ['name', 'examNo', 'elective', 'answers']
  };
  const READ_PROMPT = `OMR 답안지 사진입니다. 검게 칠해진 마킹을 문항 번호별로 정확히 읽어 JSON으로 답하세요.
- 객관식: 칠해진 보기 번호(1~5). 아무것도 안 칠했으면 0, 두 개 이상이면 -1.
- 단답형: 자리별로 칠한 숫자를 이어 붙인 값.
- 성명·수험번호 칸이 칠해져 있으면 읽어서 적고, 없으면 빈 문자열.
- 흐리거나 애매하면 unsure=true. 추측하지 마세요.`;

  async function directRead(file, opts) {
    const parts = [{ text: READ_PROMPT }, { inlineData: await fileToInline(file, 3000) }];
    return call(opts.apiKey, opts.model, parts, READ_SCHEMA, opts.signal);
  }

  async function test(apiKey, model) {
    const t = await call(apiKey, model, [{ text: '연결 테스트입니다. OK 라고만 답하세요.' }]);
    return String(t).trim();
  }

  root.Gemini = { MODELS, extractAnswerKey, interpretLayout, directRead, test };
})(self);
