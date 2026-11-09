// G마켓·옥션 한 달 매출을 항목별로 나눠 보기 (ESM 판매내역 화면과 인트라넷 통계를 맞춰 보려고)
//   조회만 한다. 고객 정보는 출력하지 않는다. 결제일(=입금확인일) 기준, 구매결정까지 모든 상태
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run esm-sales-check -- 2026-10
require('dotenv').config({ quiet: true });
const { createEsmClient, SITES } = require('../src/channels/esmClient');

const month = /^\d{4}-\d{2}$/.test(process.argv[2] || '') ? process.argv[2] : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;

(async () => {
  const client = createEsmClient();
  if (!client.sites.length) return console.log('G마켓·옥션 판매자 ID 가 .env 에 없습니다.');
  const first = `${month}-01`;
  const next = addDays(addDays(first, 32).slice(0, 8) + '01', 0); // 다음 달 1일
  // 31일 제한 → 두 번에 나눠 묻는다 (1~16일, 16일~다음 달 1일), 주문번호로 겹침 제거
  const windows = [[first, addDays(first, 15)], [addDays(first, 15), next]];
  console.log(`${month} 결제분 (결제일 ${first} ~ ${addDays(next, -1)}) · 상태 1~5 · 5초에 1번 규칙이라 1~2분 걸립니다`);
  for (const site of client.sites) {
    const seen = new Map();
    for (let status = 1; status <= 5; status++) {
      for (const [a, b] of windows) {
        for (let page = 1; page <= 30; page++) {
          const body = await client.request('POST', '/shipping/v1/Order/RequestOrders', {
            siteType: SITES[site.key].code, orderStatus: status, requestDateType: 2,
            requestDateFrom: a, requestDateTo: b, pageIndex: page, pageSize: 100,
          });
          const data = (body && (body.Data || body.data)) || {};
          const rows = data.RequestOrders || [];
          for (const o of rows) {
            if (String(o.PayDate || '').slice(0, 7) === month) seen.set(String(o.OrderNo), o);
          }
          if (rows.length < 100) break;
        }
      }
    }
    const t = { n: 0, order: 0, opt: 0, add: 0, sellerDc: 0, siteDc: 0, ship: 0 };
    for (const o of seen.values()) {
      t.n += 1;
      t.order += num(o.OrderAmount);
      t.opt += num(o.OptSelPrice);
      t.add += num(o.OptAddPrice);
      t.sellerDc += num(o.SellerDiscountPrice);
      t.siteDc += num(o.DirectDiscountPrice);
      t.ship += num(o.ShippingFee);
    }
    console.log(`\n▶ ${site.name}: 주문 ${t.n}건 (취소·반품된 주문은 주문조회에 안 나와서 빠짐)`);
    console.log(`  판매금액(판매단가×수량)   ${won(t.order)}`);
    console.log(`  옵션 추가금액              ${won(t.opt)}`);
    console.log(`  추가구성 금액              ${won(t.add)}`);
    console.log(`  판매자 할인                -${won(t.sellerDc)}`);
    console.log(`  (참고) 사이트 할인         ${won(t.siteDc)}  · 배송비 ${won(t.ship)}`);
    console.log(`  = 인트라넷 통계 금액        ${won(t.order + t.opt + t.add - t.sellerDc)}  (판매금액 + 옵션 + 추가구성 − 판매자 할인)`);
    console.log(`  판매금액 + 옵션 + 추가구성  ${won(t.order + t.opt + t.add)}  (할인 빼기 전)`);
  }
})().catch(e => { console.error(`실패: ${e.message}`); process.exit(1); });
