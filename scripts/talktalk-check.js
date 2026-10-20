// 네이버 톡톡 연결 점검: 톡톡 파트너센터에 넣을 Webhook 주소를 보여 주고, 그 주소가 서버에서 응답하는지 확인한다
// (가짜 '대화방 열기' 이벤트라 문의함에는 아무것도 생기지 않음)
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run talktalk-check
require('dotenv').config({ quiet: true });

const token = process.env.TALKTALK_WEBHOOK_TOKEN;
const base = (process.env.PUBLIC_URL || 'https://intranet.broadstore.co.kr').replace(/\/$/, '');
const port = process.env.PORT || 3000;

(async () => {
  if (!token) {
    console.log('✗ .env 에 TALKTALK_WEBHOOK_TOKEN 이 없습니다. 아래로 만들어서 넣어 주세요:\n  openssl rand -hex 24');
    return;
  }
  console.log(`보내기 API 키(TALKTALK_SEND_KEY) ${process.env.TALKTALK_SEND_KEY ? '있음' : '없음 (주도권 넘기기에 필요)'}`);
  console.log('\n▶ 톡톡 파트너센터 > 개발자도구 > 챗봇 API 설정 > Webhook 에 넣을 주소 (이 줄은 캡처·공유하지 마세요)');
  console.log(`  ${base}/hooks/talktalk/${token}`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/talktalk/${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'open', user: 'check' }),
    });
    console.log(res.status === 200
      ? '\n✓ 인트라넷이 이 주소에서 응답합니다.'
      : `\n✗ 응답 ${res.status} — 404 면 인트라넷을 재시작하지 않았거나 TALKTALK=off 입니다 (systemctl restart broad-intranet)`);
  } catch (e) {
    console.log(`\n✗ 인트라넷에 접속하지 못했습니다: ${e.message}`);
  }
})();
