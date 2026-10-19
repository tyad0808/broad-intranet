// 자사몰 문의 API 점검: 문의가 어떤 모양으로 오는지와 권한만 보여준다 (읽기만, 고객 내용은 출력하지 않음)
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run godo-inquiry-check
require('dotenv').config({ quiet: true });
const { createGodoClient } = require('../src/channels/godo');
const { BOARDS, normalizeInquiry } = require('../src/inbox/godoInquiry');

const shape = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k,
  v === null ? 'null' : Array.isArray(v) ? `목록(${v.length})` : typeof v === 'string' ? `글자(${v.length}자)` : typeof v]));
const kstDate = d => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

(async () => {
  console.log(`조회 키(GODO_API_KEY) ${process.env.GODO_API_KEY ? '있음' : '없음 ✗'} · 답변 키(GODO_WRITE_KEY) ${process.env.GODO_WRITE_KEY ? '있음' : '없음 ✗ (답변할 때 필요)'}`);
  const end = new Date();
  const start = new Date(end.getTime() - 29 * 24 * 3600 * 1000);
  console.log('\n▶ 자사몰 문의 (최근 30일)');
  try {
    const body = await createGodoClient().request('GET', '/inquiries', {
      query: { from: kstDate(start), to: kstDate(end), dateType: 'modified', page: 1, size: 100 },
    });
    console.log('  응답 항목:', JSON.stringify(shape(body)));
    const items = (body && body.items) || [];
    console.log(`  ✓ 문의 ${body.total ?? items.length}건`);
    for (const [board, name] of Object.entries(BOARDS)) {
      const list = items.filter(q => q.board === board);
      console.log(`  - ${name}: ${list.length}건 (미답변 ${list.filter(q => !q.answered).length})`);
    }
    if (items[0]) {
      console.log('  문의 1건의 항목:', JSON.stringify(shape(items[0])));
      const n = normalizeInquiry(items[0]);
      console.log(`  인트라넷으로 바꾸면: 번호 ${n ? '있음' : '없음 ✗'}, 날짜 ${n && n.received_at ? '있음' : '없음'}, 주문번호 ${n && n.order_no ? '있음' : '없음'}, 답변 ${n && n.answered ? '됨' : '안 됨'}`);
    }
  } catch (e) {
    console.log(`  ✗ 실패: ${e.message}`);
    if (e.status === 403) console.log('  → 견적 프로젝트 서버에서 조회 키에 inquiries 권한을 더해 주세요 (apiKeys.js grant).');
  }
})();
