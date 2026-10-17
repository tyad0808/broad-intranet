// 쿠팡 연결 확인: 상태별로 쿠팡이 돌려주는 주문 수와 주문번호를 보여준다 (키 값은 출력하지 않음)
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run coupang-check
require('dotenv').config({ quiet: true });
const { createCoupangClient } = require('../src/channels/coupangClient');

const STATUSES = { ACCEPT: '결제완료', INSTRUCT: '상품준비중', DEPARTURE: '배송지시', DELIVERING: '배송중', FINAL_DELIVERY: '배송완료' };

(async () => {
  const client = createCoupangClient();
  const kst = d => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  console.log(`쿠팡 업체코드 ${client.vendorId ? '있음' : '없음'} · 조회 기간 ${kst(from)} ~ ${kst(to)}`);
  for (const [status, label] of Object.entries(STATUSES)) {
    try {
      const body = await client.request('GET', `/v2/providers/openapi/apis/api/v4/vendors/${client.vendorId}/ordersheets`, {
        query: { createdAtFrom: kst(from), createdAtTo: kst(to), status, maxPerPage: 50 },
      });
      const list = (body && body.data) || [];
      const ids = list.slice(0, 5).map(s => `${s.orderId}(${String(s.paidAt || s.orderedAt || '').slice(5, 16)})`);
      console.log(`${label.padEnd(6)} ${String(list.length).padStart(3)}건 ${ids.join(', ')}${list.length > 5 ? ' …' : ''}`);
    } catch (e) {
      console.log(`${label.padEnd(6)} 실패: ${e.message}`);
    }
  }
})();
