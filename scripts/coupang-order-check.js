// 쿠팡 주문 한 건 점검 (조회만 — 아무것도 바꾸거나 보내지 않는다, 이름·주소·전화는 출력하지 않음)
// 쿠팡에서 취소했는데 인트라넷에 남아 있을 때: 쿠팡이 그 주문을 지금 어떤 상태로 알려 주는지,
// 취소·반품(출고중지) 요청 목록에 들어 있는지를 보여 준다.
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run coupang-order-check -- 주문번호(또는 주문자 이름)
require('dotenv').config({ quiet: true });
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createCoupangClient } = require('../src/channels/coupangClient');

const key = String(process.argv[2] || '').trim();
if (!key) {
  console.log('쿠팡 주문번호나 주문자 이름을 뒤에 적어 주세요.\n예: npm run coupang-order-check -- 주지영');
  process.exit(0);
}
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'intranet.db'), { readOnly: true });
const rows = db.prepare(`
  SELECT channel_order_id, channel_item_id, product_name, channel_status, channel_confirmed, claim_status, paid_at, tracking_no, shipped_at, updated_at
  FROM orders WHERE channel = 'coupang' AND (channel_order_id = ?1 OR buyer_name = ?1 OR receiver_name = ?1) ORDER BY paid_at DESC LIMIT 20
`).all(key);
const orderIds = [...new Set(rows.map(r => r.channel_order_id))];
if (!orderIds.length && /^\d+$/.test(key)) orderIds.push(key);
if (!orderIds.length) { console.log(`'${key}' 로 찾은 쿠팡 주문이 인트라넷에 없습니다.`); process.exit(0); }

const kstDay = d => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined && o[k] !== null && o[k] !== '').map(k => [k, o[k]]));

(async () => {
  const client = createCoupangClient();
  const v = client.vendorId;
  const base = `/v2/providers/openapi/apis/api/v4/vendors/${v}`;
  for (const orderId of orderIds.slice(0, 3)) {
    console.log(`\n━━ 쿠팡 주문 ${orderId}`);
    console.log('▶ 인트라넷에 저장된 상태');
    for (const r of rows.filter(x => x.channel_order_id === orderId)) {
      console.log(`  ${r.channel_item_id} · ${r.product_name.slice(0, 20)} · 상태 ${r.channel_status}${r.claim_status ? ` · 요청 ${r.claim_status}` : ''} · 송장 ${r.tracking_no || '-'} · 마지막 갱신 ${r.updated_at}`);
    }

    console.log('▶ 쿠팡이 지금 알려 주는 발주서 (주문번호로 조회)');
    try {
      const body = await client.request('GET', `${base}/${orderId}/ordersheets`);
      const list = Array.isArray(body && body.data) ? body.data : body && body.data ? [body.data] : [];
      if (!list.length) console.log('  (발주서 없음)', JSON.stringify(pick(body || {}, ['code', 'message'])));
      for (const s of list) {
        console.log(`  배송번호 ${s.shipmentBoxId} · 상태 ${s.status}${s.invoiceNumber ? ` · 송장 ${s.invoiceNumber}` : ''}`);
        for (const it of s.orderItems || []) {
          console.log(`    옵션 ${it.vendorItemId} · ${JSON.stringify(pick(it, ['shippingCount', 'cancelCount', 'holdCountForCancel', 'stockedOutCount', 'canceled', 'invoiceNumber']))}`);
        }
      }
    } catch (e) {
      console.log(`  조회 실패: ${e.message}`);
    }

    console.log('▶ 쿠팡 취소·반품(출고중지) 요청 목록에 있는지');
    const paid = rows.find(x => x.channel_order_id === orderId);
    const from = paid && paid.paid_at ? new Date(Date.parse(paid.paid_at) - 24 * 3600e3) : new Date(Date.now() - 7 * 24 * 3600e3);
    const to = new Date();
    const tries = [
      ['v6 취소', `/v2/providers/openapi/apis/api/v6/vendors/${v}/returnRequests`, { searchType: 'timeFrame', createdAtFrom: `${kstDay(from)}T00:00`, createdAtTo: `${kstDay(to)}T23:59`, cancelType: 'CANCEL' }],
      ['v6 반품', `/v2/providers/openapi/apis/api/v6/vendors/${v}/returnRequests`, { searchType: 'timeFrame', createdAtFrom: `${kstDay(from)}T00:00`, createdAtTo: `${kstDay(to)}T23:59`, cancelType: 'RETURN' }],
      ['v4 출고중지요청(RU)', `${base}/returnRequests`, { createdAtFrom: kstDay(from), createdAtTo: kstDay(to), status: 'RU' }],
      ['v4 반품접수(UC)', `${base}/returnRequests`, { createdAtFrom: kstDay(from), createdAtTo: kstDay(to), status: 'UC' }],
    ];
    for (const [label, p, query] of tries) {
      try {
        const body = await client.request('GET', p, { query });
        const list = (body && body.data) || [];
        const mine = list.filter(x => String(x.orderId) === String(orderId));
        console.log(`  ${label}: 전체 ${list.length}건, 이 주문 ${mine.length}건`);
        for (const x of mine) {
          console.log(`    ${JSON.stringify(pick(x, ['receiptId', 'receiptType', 'receiptStatus', 'cancelReasonCategory1', 'cancelReasonCategory2', 'releaseStopStatus', 'createdAt', 'modifiedAt', 'cancelCountSum']))}`);
        }
      } catch (e) {
        console.log(`  ${label}: 조회 실패 — ${e.message}`);
      }
    }
  }
})();
