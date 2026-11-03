/* 이용 기록 — 첫 실행 이름 등록, 접속 시간·스캔 횟수 기록, 관리자 API
 *
 * Firebase(Firestore + Authentication)는 배포 때 생성되는 js/firebase-config.js 가 있을 때만 켜진다.
 * 설정 파일이 없으면(로컬 개발 등) 이름도 묻지 않고 아무것도 전송하지 않는다.
 *
 *   omr_users/{uid}                 이름, 가입·최근 접속 시각, 방문 수, 누적 사용 시간, 스캔 수, 기기
 *   omr_users/{uid}/sessions/{sid}  접속 1회: 시작·마지막 시각, 사용 시간(화면이 보이는 동안만), 스캔 수
 *
 * 일반 사용자는 익명 인증으로 본인 문서만 쓴다. 관리자는 별도 Firebase 앱 인스턴스에서
 * 이메일 로그인하므로, 관리자 로그인이 이 기기의 익명 사용자 신원을 바꾸지 않는다.
 * 접근 권한은 firestore.rules 가 강제한다(클라이언트 검사는 편의일 뿐).
 */
const SDK = 'https://www.gstatic.com/firebasejs/12.16.0/';
const NAME_KEY = 'omr_user_name';
// 비용 절약: 접속 중에는 5분에 한 번, 화면을 벗어날 때 한 번만 저장한다 (한 번 = 문서 2개를 묶은 batch)
const FLUSH_MS = 5 * 60 * 1000;
const MAX_RESULTS = 20;                // 접속 1회에 남기는 채점 요약 수
const RESULTS_MAX_CHARS = 2000;        // firestore.rules 의 상한과 같아야 한다
const NEW_SESSION_GAP = 30 * 60 * 1000; // 30분 넘게 자리를 비우면 새 접속으로 센다
const APP_VERSION = '2.1.2';

const T = window.OMRT;
const queued = T.q.splice(0);
let cfg = null, fb = null, auth = null, db = null, uid = '';
let blocked = false;

// ------------------------------------------------------------ 이름
function getName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; } }
function validateName(v) {
  if (!v || v.length < 2) return '이름은 2자 이상 입력해 주세요.';
  if (v.length > 20) return '이름은 20자까지 입력할 수 있습니다.';
  if (/[\u0000-\u001f\u007f<>]/.test(v)) return '이름에 쓸 수 없는 문자가 있습니다.';
  return '';
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const iPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const os = iPad ? 'iPadOS' : /iPhone|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '기타';
  const short = Math.min(screen.width, screen.height);
  const kind = iPad || (/Android/.test(ua) && !/Mobile/.test(ua)) || (navigator.maxTouchPoints > 1 && short >= 600) ? '태블릿'
    : /Mobi|iPhone|Android/.test(ua) ? '휴대폰' : 'PC';
  const app = matchMedia('(display-mode: standalone)').matches || navigator.standalone ? '앱' : '웹';
  return `${kind} · ${os} · ${app}`;
}

// ------------------------------------------------------------ 첫 실행 화면
const $ = s => document.querySelector(s);
function showGate(mode) {
  const g = $('#gate');
  g.classList.remove('hidden');
  g.classList.toggle('blocked', mode === 'blocked');
  if (mode === 'blocked') {
    $('#gateTitle').textContent = '이용이 제한되었습니다';
    $('#gateSub').textContent = '관리자에게 문의해 주세요.';
    return;
  }
  setTimeout(() => $('#gateName').focus(), 150);
}
function hideGate() { $('#gate').classList.add('hidden'); }

$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#gateName').value.trim();
  const err = validateName(v);
  $('#gateErr').textContent = err;
  if (err) return;
  try { localStorage.setItem(NAME_KEY, v); } catch (e2) { /* 저장 불가 */ }
  hideGate();
  start();
});

// ------------------------------------------------------------ Firebase 로드
async function loadSdk() {
  if (fb) return fb;
  const [app, authM, fs] = await Promise.all([
    import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')
  ]);
  fb = { ...app, ...authM, ...fs };
  return fb;
}

// 로컬 시험용: 설정에 emulator 가 있으면 Firebase 에뮬레이터에 붙는다 (배포 설정에는 없음)
function useEmulator(a, d) {
  if (!cfg.emulator || !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  fb.connectAuthEmulator(a, `http://127.0.0.1:${cfg.emulator.auth}`, { disableWarnings: true });
  fb.connectFirestoreEmulator(d, '127.0.0.1', cfg.emulator.firestore);
}

let signingIn = null;
async function signIn() {
  if (uid) return uid;
  if (signingIn) return signingIn;
  signingIn = (async () => {
    await loadSdk();
    const app = fb.initializeApp(cfg);
    auth = fb.getAuth(app);
    db = fb.getFirestore(app);
    useEmulator(auth, db);
    await auth.authStateReady();
    if (!auth.currentUser) await fb.signInAnonymously(auth);
    uid = auth.currentUser.uid;
    return uid;
  })();
  try { return await signingIn; } finally { signingIn = null; }
}

// ------------------------------------------------------------ 접속 기록
const sess = { id: '', visibleSince: 0, sec: 0, scans: 0, aiReads: 0, flushed: { sec: 0, scans: 0, aiReads: 0 }, hiddenAt: 0, results: [], resultsDirty: false };
let userRef = null, sessRef = null, timer = 0, starting = false, started = false;

function newSessionId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function liveSec() { return sess.sec + (sess.visibleSince ? Math.floor((Date.now() - sess.visibleSince) / 1000) : 0); }

async function openSession(countVisit) {
  const { doc, setDoc, updateDoc, serverTimestamp, increment, getDoc } = fb;
  userRef = doc(db, 'omr_users', uid);
  const snap = await getDoc(userRef);
  const name = getName();
  const device = deviceLabel();
  if (!snap.exists()) {
    await setDoc(userRef, {
      name, device, appVersion: APP_VERSION,
      createdAt: serverTimestamp(), lastSeen: serverTimestamp(),
      visits: 1, totalSec: 0, scans: 0, aiReads: 0, blocked: false
    });
  } else {
    if (snap.data().blocked === true) { blocked = true; stopTimer(); showGate('blocked'); return false; }
    const patch = { name, device, appVersion: APP_VERSION, lastSeen: serverTimestamp() };
    if (countVisit) patch.visits = increment(1);
    await updateDoc(userRef, patch);
  }
  sess.id = newSessionId();
  sess.sec = 0; sess.scans = 0; sess.aiReads = 0; sess.flushed = { sec: 0, scans: 0, aiReads: 0 };
  // 직전 접속에서 아직 못 보낸 채점 요약은 새 접속으로 넘긴다
  if (!sess.resultsDirty) sess.results = [];
  sess.visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;
  sessRef = doc(db, 'omr_users', uid, 'sessions', sess.id);
  await setDoc(sessRef, { start: serverTimestamp(), last: serverTimestamp(), sec: 0, scans: 0, aiReads: 0, device });
  return true;
}

async function flush() {
  if (!sessRef || blocked) return;
  const sec = liveSec();
  const d = { sec: sec - sess.flushed.sec, scans: sess.scans - sess.flushed.scans, aiReads: sess.aiReads - sess.flushed.aiReads };
  if (!d.sec && !d.scans && !d.aiReads && !sess.resultsDirty) return;
  const snapshot = { sec, scans: sess.scans, aiReads: sess.aiReads };
  sess.flushed = snapshot;
  const extra = {};
  if (sess.resultsDirty) { extra.results = packResults(); sess.resultsDirty = false; }
  const { writeBatch, serverTimestamp, increment } = fb;
  const b = writeBatch(db);
  b.update(sessRef, { last: serverTimestamp(), ...snapshot, ...extra });
  b.update(userRef, { lastSeen: serverTimestamp(), totalSec: increment(d.sec), scans: increment(d.scans), aiReads: increment(d.aiReads) });
  try { await b.commit(); }
  catch (e) {
    // 거부 = 관리자가 차단했거나 삭제함 (삭제된 경우 다음 실행 때 새로 등록된다)
    if (e && (e.code === 'permission-denied' || e.code === 'not-found')) { stopTimer(); sessRef = null; checkBlocked(); }
  }
}
async function checkBlocked() {
  try {
    const s = await fb.getDoc(userRef);
    if (s.exists() && s.data().blocked === true) { blocked = true; showGate('blocked'); }
  } catch (e) { /* 오프라인 */ }
}
function startTimer() { stopTimer(); timer = setInterval(() => { if (document.visibilityState === 'visible') flush(); }, FLUSH_MS); }
function stopTimer() { clearInterval(timer); timer = 0; }

document.addEventListener('visibilitychange', async () => {
  if (!started || blocked) return;
  if (document.visibilityState === 'hidden') {
    if (sess.visibleSince) { sess.sec += Math.floor((Date.now() - sess.visibleSince) / 1000); sess.visibleSince = 0; }
    sess.hiddenAt = Date.now();
    flush();
  } else {
    const away = sess.hiddenAt ? Date.now() - sess.hiddenAt : 0;
    if (away > NEW_SESSION_GAP) { try { await openSession(true); } catch (e) { /* 오프라인 */ } }
    else sess.visibleSince = Date.now();
  }
});
window.addEventListener('pagehide', () => { if (started) flush(); });

// 채점 요약: 같은 답안지를 고치면 덮어쓰고, 접속 1회당 최근 MAX_RESULTS 건만 짧은 문자열로 보낸다
function result(r) {
  const item = [String(r.k || '').slice(0, 30), r.s | 0, r.m | 0, r.p ? 1 : 0, r.g | 0, Date.now()];
  const i = sess.results.findIndex(x => x.id === r.id);
  if (i >= 0) sess.results[i].v = item; else sess.results.push({ id: r.id, v: item });
  if (sess.results.length > MAX_RESULTS) sess.results.splice(0, sess.results.length - MAX_RESULTS);
  sess.resultsDirty = true;
}
function packResults() {
  const list = sess.results.map(x => x.v);
  let out = JSON.stringify(list);
  while (out.length > RESULTS_MAX_CHARS && list.length) { list.shift(); out = JSON.stringify(list); }
  return out;
}

function track(ev) {
  if (ev === 'scan') sess.scans++;
  else if (ev === 'ai') sess.aiReads++;
}

async function start() {
  if (started || starting || !getName()) return;
  starting = true;
  try {
    await signIn();
    if (await openSession(true)) { started = true; startTimer(); }
  } catch (e) {
    // 오프라인·차단된 네트워크: 연결되면 다시 시도
    window.addEventListener('online', () => start(), { once: true });
  } finally { starting = false; }
}

async function setName(v) {
  try { localStorage.setItem(NAME_KEY, v); } catch (e) { /* 저장 불가 */ }
  if (userRef) { try { await fb.updateDoc(userRef, { name: v, lastSeen: fb.serverTimestamp() }); } catch (e) { /* 다음 접속 때 반영 */ } }
}

// ------------------------------------------------------------ 관리자 (별도 앱 인스턴스)
let adm = null;
async function admin() {
  if (adm) return adm;
  await loadSdk();
  const app = fb.initializeApp(cfg, 'omr-admin');
  const a = fb.getAuth(app);
  const d = fb.getFirestore(app);
  useEmulator(a, d);
  await a.authStateReady();
  adm = { auth: a, db: d };
  return adm;
}
function isOwner() { return !!(adm && adm.auth.currentUser && adm.auth.currentUser.uid === cfg.ownerUid); }
async function adminSignIn(email, password) {
  const a = await admin();
  const cred = await fb.signInWithEmailAndPassword(a.auth, email, password);
  if (cred.user.uid !== cfg.ownerUid) { await fb.signOut(a.auth); throw new Error('관리자 계정이 아닙니다.'); }
}
async function adminSignOut() { const a = await admin(); await fb.signOut(a.auth); }
function ms(ts) { return ts && ts.toMillis ? ts.toMillis() : 0; }
async function listUsers() {
  const a = await admin();
  const { collection, getDocs, query, orderBy } = fb;
  const snap = await getDocs(query(collection(a.db, 'omr_users'), orderBy('lastSeen', 'desc')));
  return snap.docs.map(d => {
    const x = d.data();
    return { id: d.id, name: x.name || '', device: x.device || '', appVersion: x.appVersion || '', createdAt: ms(x.createdAt), lastSeen: ms(x.lastSeen),
      visits: x.visits || 0, totalSec: x.totalSec || 0, scans: x.scans || 0, aiReads: x.aiReads || 0, blocked: x.blocked === true };
  });
}
async function listSessions(id, n) {
  const a = await admin();
  const { collection, getDocs, query, orderBy, limit } = fb;
  const snap = await getDocs(query(collection(a.db, 'omr_users', id, 'sessions'), orderBy('start', 'desc'), limit(n || 200)));
  return snap.docs.map(d => {
    const x = d.data();
    let results = [];
    try { const r = JSON.parse(x.results || '[]'); if (Array.isArray(r)) results = r.filter(Array.isArray).map(v => ({ k: String(v[0] || ''), s: +v[1] || 0, m: +v[2] || 0, p: !!v[3], g: +v[4] || 0, t: +v[5] || 0 })); } catch (e) { /* 손상된 값은 무시 */ }
    return { id: d.id, start: ms(x.start), last: ms(x.last), sec: x.sec || 0, scans: x.scans || 0, aiReads: x.aiReads || 0, device: x.device || '', results };
  });
}
async function setBlocked(id, b) { const a = await admin(); await fb.updateDoc(fb.doc(a.db, 'omr_users', id), { blocked: !!b }); }
async function deleteUser(id) {
  const a = await admin();
  const { collection, getDocs, writeBatch, doc } = fb;
  // Firestore는 문서를 지워도 하위 컬렉션이 남으므로 접속 기록부터 지운다
  for (;;) {
    const s = await getDocs(collection(a.db, 'omr_users', id, 'sessions'));
    if (s.empty) break;
    const b = writeBatch(a.db);
    s.docs.slice(0, 450).forEach(d => b.delete(d.ref));
    await b.commit();
  }
  await fb.deleteDoc(doc(a.db, 'omr_users', id));
}

// ------------------------------------------------------------ 시작
(async () => {
  try { cfg = (await import('./firebase-config.js')).default; } catch (e) { cfg = null; }
  if (!cfg || !cfg.projectId || !cfg.ownerUid) return; // 설정 없음 → 이용 기록 끔
  Object.assign(T, {
    enabled: true, track, result, getName, validateName, setName, isOwner,
    admin: { ready: admin, signIn: adminSignIn, signOut: adminSignOut, listUsers, listSessions, setBlocked, deleteUser }
  });
  queued.forEach(track);
  if (!getName()) showGate('name'); else start();
  // 관리자 로그인 상태 복원 (설정 화면의 '관리자' 항목 표시용)
  admin().then(() => { if (isOwner() && window.AppCore && window.AppCore.S.view === 'settings') window.AppCore.go('settings'); }).catch(() => {});
})();
