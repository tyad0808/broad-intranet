// 스마트스토어 상품문의 API 점검: 네이버가 어떤 모양으로 응답하는지만 보여준다 (읽기만, 고객 내용은 출력하지 않음)
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run naver-inquiry-check
require('dotenv').config({ quiet: true });
const { createNaverClient } = require('../src/channels/naverClient');
const { toKstIso } = require('../src/channels/smartstore');
const { listFrom, normalizeQna } = require('../src/inbox/naverQna');

// 값은 숨기고 종류만: { questionId: 숫자, question: 글자(23자) … }
const shape = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k,
  v === null ? 'null' : Array.isArray(v) ? `목록(${v.length})` : typeof v === 'string' ? `글자(${v.length}자)` : typeof v]));

(async () => {
  const client = createNaverClient();
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
  console.log('▶ 상품문의 목록 (최근 30일)');
  try {
    const body = await client.request('GET', '/v1/contents/qnas', { query: { page: 1, size: 10, fromDate: toKstIso(start), toDate: toKstIso(end) } });
    console.log('  응답 항목:', JSON.stringify(shape(body)));
    if (body && body.data && !Array.isArray(body.data)) console.log('  data 안 항목:', JSON.stringify(shape(body.data)));
    const list = listFrom(body);
    if (!list) return console.log('  ✗ 목록을 찾지 못했습니다. 위 "응답 항목" 줄을 보여주세요.');
    console.log(`  ✓ 문의 ${list.length}건 (첫 페이지)`);
    if (list[0]) {
      console.log('  문의 1건의 항목:', JSON.stringify(shape(list[0])));
      const n = normalizeQna(list[0]);
      console.log(`  인트라넷으로 바꾸면: 번호 ${n ? '있음' : '없음 ✗'}, 날짜 ${n && n.received_at ? '있음' : '없음'}, 답변 ${n && n.answered ? '됨' : '안 됨'}`);
    }
  } catch (e) {
    console.log(`  ✗ 실패: ${e.message}`);
    if (e.status === 403 || e.status === 401) console.log('  → 커머스API센터에서 애플리케이션에 "문의" API 그룹을 추가했는지 확인하세요.');
  }
  console.log('▶ 답변 템플릿 목록');
  try {
    const t = await client.request('GET', '/v1/contents/qnas/templates');
    console.log('  ✓ 응답 항목:', JSON.stringify(shape(t)));
  } catch (e) {
    console.log(`  ✗ 실패: ${e.message}`);
  }
})();
