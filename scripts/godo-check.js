// 자사몰 처리 연결 확인: 처리용 키(GODO_WRITE_KEY)로 택배사 목록만 읽어 본다 (주문은 아무것도 바꾸지 않음, 키 값은 출력하지 않음)
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run godo-check
require('dotenv').config({ quiet: true });
const { createGodoClient } = require('../src/channels/godo');
const { COURIERS } = require('../src/channels/shipping');

(async () => {
  console.log(`조회 키(GODO_API_KEY) ${process.env.GODO_API_KEY ? '있음' : '없음'} · 처리 키(GODO_WRITE_KEY) ${process.env.GODO_WRITE_KEY ? '있음' : '없음'}`);
  console.log(`처리 모드: ${process.env.GODO_WRITE === 'on' ? '실제로 자사몰에 보냄 (GODO_WRITE=on)' : '연습 모드 (GODO_WRITE=on 이 아님)'}`);
  try {
    const body = await createGodoClient().request('GET', '/couriers');
    const list = Array.isArray(body) ? body : (body && (body.items || body.couriers)) || [];
    console.log(`자사몰 배송업체 ${list.length}곳: ${list.map(c => `${c.name}${c.parcel === false ? '(택배 아님)' : ''}`).join(', ')}`);
    // 인트라넷에서 고르는 택배사가 자사몰 목록에 같은 이름으로 있는지
    for (const name of Object.values(COURIERS)) {
      console.log(`  ${list.some(c => c.name === name) ? '✓' : '✗ 없음 —'} ${name}`);
    }
    console.log('연결 정상: 자사몰 처리 기능을 쓸 수 있습니다.');
  } catch (e) {
    console.log(`실패: ${e.message}`);
    if (e.status === 401 || e.status === 403) console.log('→ 처리 키가 틀렸거나 orders:write 권한·IP(127.0.0.1) 제한을 확인하세요.');
    if (e.status === 503 || e.status === 502) console.log('→ 자사몰 API 쪽 처리 설정(MALL_WRITE_SECRET 등)이나 자사몰 처리 파일 설치를 확인하세요.');
  }
})();
