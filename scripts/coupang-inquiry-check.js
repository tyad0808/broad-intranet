// 쿠팡 문의 API 점검: 상품별 고객문의 / 고객센터 문의가 어떤 모양으로 오는지만 보여준다 (읽기만, 고객 내용은 출력하지 않음)
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run coupang-inquiry-check
require('dotenv').config({ quiet: true });
const { createCoupangClient } = require('../src/channels/coupangClient');
const { KINDS, listFrom, normalizeInquiry } = require('../src/inbox/coupangInquiry');

const shape = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k,
  v === null ? 'null' : Array.isArray(v) ? `목록(${v.length})` : typeof v === 'string' ? `글자(${v.length}자)` : typeof v]));
const kstDate = d => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

(async () => {
  const client = createCoupangClient();
  console.log(`쿠팡 업체코드 ${client.vendorId ? '있음' : '없음'} · WING 아이디(COUPANG_WING_ID) ${process.env.COUPANG_WING_ID ? '있음' : '없음 ✗ (답변할 때 필요)'}`);
  const end = new Date();
  const start = new Date(end.getTime() - 6 * 24 * 3600 * 1000);
  for (const [kind, k] of Object.entries(KINDS)) {
    console.log(`\n▶ ${k.name} (최근 7일)`);
    try {
      const body = await client.request('GET', `/v2/providers/openapi/apis/api/v4/vendors/${client.vendorId}/${k.path}`, {
        query: { vendorId: client.vendorId, inquiryStartAt: kstDate(start), inquiryEndAt: kstDate(end), pageNum: 1, pageSize: 10, ...k.query },
      });
      console.log('  응답 항목:', JSON.stringify(shape(body)));
      if (body && body.data && !Array.isArray(body.data)) console.log('  data 안 항목:', JSON.stringify(shape(body.data)));
      const list = listFrom(body);
      if (!list) { console.log('  ✗ 목록을 찾지 못했습니다. 위 항목 줄을 보여주세요.'); continue; }
      console.log(`  ✓ 문의 ${list.length}건 (첫 페이지)`);
      if (list[0]) {
        console.log('  문의 1건의 항목:', JSON.stringify(shape(list[0])));
        const replies = list.find(q => Array.isArray(q.commentDtoList || q.replies || q.answers) && (q.commentDtoList || q.replies || q.answers).length);
        if (replies) console.log('  답변 1건의 항목:', JSON.stringify(shape((replies.commentDtoList || replies.replies || replies.answers)[0])));
        const n = normalizeInquiry(list[0], kind);
        console.log(`  인트라넷으로 바꾸면: 번호 ${n ? '있음' : '없음 ✗'}, 날짜 ${n && n.received_at ? '있음' : '없음'}, 주문번호 ${n && n.order_no ? '있음' : '없음'}, 답변 ${n && n.answered ? '됨' : '안 됨'}`);
      }
    } catch (e) {
      console.log(`  ✗ 실패: ${e.message}`);
    }
  }
})();
