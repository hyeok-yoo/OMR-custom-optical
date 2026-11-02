/* 채점·통계 (순수 함수) */
(function (root) {
  'use strict';

  // 정답에서 문항 찾기: 선택과목 문항이 우선, 없으면 공통
  function keyItem(key, no, electiveIdx) {
    if (!key) return null;
    if (electiveIdx != null && electiveIdx >= 0 && key.electives && key.electives[electiveIdx]) {
      const it = key.electives[electiveIdx].items.find(x => x.no === no);
      if (it) return it;
    }
    return (key.items || []).find(x => x.no === no) || null;
  }

  // 정답에 선택과목이 정의된 문항 번호 범위
  function electiveNumbers(key) {
    const s = new Set();
    (key && key.electives || []).forEach(e => e.items.forEach(it => s.add(it.no)));
    return s;
  }

  /*
   * answers: [{ key, section, no, type, answer(mc 1~5 / 0 무응답 / -1 중복), value(sa) }]
   * keys: 구역(section)별 정답 객체 배열
   * electiveIdx: 선택과목 인덱스 (0부터) 또는 null
   */
  function grade(answers, keys, electiveIdx) {
    const sections = new Map();
    for (const a of answers) {
      const key = keys[a.section] || null;
      if (!sections.has(a.section)) sections.set(a.section, { section: a.section, key, rows: [], total: 0, max: 0, right: 0, graded: 0, hasPoints: true, missingPoints: 0 });
      const S = sections.get(a.section);
      const it = keyItem(key, a.no, electiveIdx);
      const correct = it && it.a != null ? it.a : null;
      const mine = a.type === 'sa' ? (a.value == null ? null : a.value) : (a.answer > 0 ? a.answer : null);
      const ok = correct != null && mine != null && mine === correct;
      const p = it && it.p != null ? it.p : null;
      if (correct != null) {
        S.graded++;
        if (ok) S.right++;
        if (p == null) { S.hasPoints = false; S.missingPoints++; }
        else { S.max += p; if (ok) S.total += p; }
      }
      S.rows.push({ q: a, correct, p, ok, graded: correct != null });
    }
    const list = Array.from(sections.values()).sort((a, b) => a.section - b.section);
    list.forEach(S => { if (!S.graded) S.hasPoints = false; });
    const all = {
      right: list.reduce((s, x) => s + x.right, 0),
      graded: list.reduce((s, x) => s + x.graded, 0),
      total: list.reduce((s, x) => s + x.total, 0),
      max: list.reduce((s, x) => s + x.max, 0),
      hasPoints: list.length > 0 && list.every(x => x.hasPoints),
      hasKey: list.some(x => x.key)
    };
    return { sections: list, all };
  }

  // 등급컷 → 예상 등급
  function gradeLevel(score, cutoffs) {
    if (!cutoffs || !cutoffs.length) return null;
    for (let i = 0; i < cutoffs.length; i++) if (cutoffs[i] != null && score >= cutoffs[i]) return i + 1;
    return cutoffs.length + 1;
  }

  // 여러 채점 결과로 문항별 정답률 (반 채점 / 같은 정답 기록 통계)
  function itemStats(records) {
    const m = new Map();
    for (const r of records) {
      for (const S of r.graded.sections) {
        for (const row of S.rows) {
          if (!row.graded) continue;
          const k = `${S.section}:${row.q.no}`;
          if (!m.has(k)) m.set(k, { section: S.section, no: row.q.no, n: 0, right: 0, picks: {} });
          const e = m.get(k);
          e.n++; if (row.ok) e.right++;
          const pk = row.q.type === 'sa' ? String(row.q.value ?? '–') : String(row.q.answer > 0 ? row.q.answer : (row.q.answer === -1 ? '중복' : '–'));
          e.picks[pk] = (e.picks[pk] || 0) + 1;
        }
      }
    }
    return Array.from(m.values()).sort((a, b) => a.section - b.section || a.no - b.no)
      .map(e => Object.assign(e, { rate: e.n ? e.right / e.n : 0 }));
  }

  function summary(values) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
    return { n: s.length, mean, sd, min: s[0], max: s[s.length - 1], median: s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 };
  }

  function csvEscape(v) {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  root.Grading = { grade, keyItem, electiveNumbers, gradeLevel, itemStats, summary, csvEscape };
})(self);
