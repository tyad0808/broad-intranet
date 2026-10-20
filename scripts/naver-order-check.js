// 스마트스토어 주문 점검: 오늘출발·발송기한처럼 '배송' 관련 항목이 어떤 이름과 값으로 오는지만 보여 준다
// (읽기만, 이름·주소·전화번호 같은 고객 정보는 출력하지 않음)
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run naver-order-check
require('dotenv').config({ quiet: true });
const { createNaverClient } = require('../src/channels/naverClient');
const { toKstIso } = require('../src/channels/smartstore');

const DAYS = 3;
const WANT = /deliver|ship|dispatch|today|due|hope|arrival|sla|expect/i;
const PRIVATE = /address|name|tel|phone|memo|zip|base|detail|city|state/i;

(async () => {
  const client = createNaverClient();
  const to = new Date();
  const ids = new Set();
  for (let start = to.getTime() - DAYS * 86400_000; start < to.getTime(); start += 86400_000) {
    const end = new Date(Math.min(start + 86400_000, to.getTime()));
    const body = await client.request('GET', '/v1/pay-order/seller/product-orders/last-changed-statuses', {
      query: { lastChangedFrom: toKstIso(new Date(start)), lastChangedTo: toKstIso(end) },
    });
    for (const s of (body && body.data && body.data.lastChangeStatuses) || []) ids.add(String(s.productOrderId));
  }
  const list = [...ids].slice(0, 300);
  console.log(`최근 ${DAYS}일 바뀐 상품주문 ${ids.size}건 (그중 ${list.length}건 확인)`);
  if (!list.length) return console.log('확인할 주문이 없습니다. 주문이 들어온 뒤 다시 실행해 주세요.');
  const body = await client.request('POST', '/v1/pay-order/seller/product-orders/query', { json: { productOrderIds: list } });
  const items = (body && body.data) || [];

  // 항목 이름별로 값 모으기 (code 처럼 짧은 값은 종류별 건수, 날짜는 모양만)
  const found = new Map();
  const add = (where, key, value) => {
    if (!WANT.test(key) || PRIVATE.test(key) || value === null || value === undefined || typeof value === 'object') return;
    const k = `${where}.${key}`;
    if (!found.has(k)) found.set(k, new Map());
    const v = /^\d{4}-\d\d-\d\dT/.test(String(value)) ? `날짜(${String(value).replace(/\d/g, '0')})` : String(value).slice(0, 40);
    found.get(k).set(v, (found.get(k).get(v) || 0) + 1);
  };
  for (const it of items) {
    for (const [where, obj] of [['order', it.order], ['productOrder', it.productOrder], ['delivery', it.delivery]]) {
      for (const [key, value] of Object.entries(obj || {})) add(where, key, value);
    }
  }
  console.log(`\n주문 1건의 큰 묶음: ${Object.keys(items[0] || {}).join(', ')}`);
  console.log(`productOrder 항목: ${Object.keys((items[0] && items[0].productOrder) || {}).join(', ')}`);
  console.log('\n▶ 배송 관련 항목과 값 (건수)');
  for (const [k, values] of found) {
    const top = [...values].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v} ${n}건`).join(' / ');
    console.log(`  ${k}: ${top}`);
  }
  console.log('\n위 결과를 그대로 보여 주세요. (고객 정보는 출력되지 않습니다)');
})().catch(e => console.log(`실패: ${e.message}`));
