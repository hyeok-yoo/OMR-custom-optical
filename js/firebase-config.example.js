// 로컬에서 이용 기록을 시험할 때 이 파일을 js/firebase-config.js 로 복사해 값을 채운다.
// (firebase-config.js 는 .gitignore 대상이며, 배포 때는 GitHub Actions 시크릿으로 생성된다)
export default {
  apiKey: '',
  authDomain: '',
  projectId: '',
  appId: '',
  ownerUid: ''  // 관리자 계정 uid — firestore.rules 의 isOwner() 와 같아야 한다
};
