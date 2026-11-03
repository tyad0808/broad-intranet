// 자사몰 예전 주문의 배송 방법 채우기 (scripts/godo-shipway-backfill.js)
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { applyOrders } = require('../src/collector');
const { fillGodoShipWay } = require('../scripts/godo-shipway-backfill');

function row(channel, orderNo, itemNo, extra = {}) {
  return {
    channel, channel_order_id: orderNo, channel_item_id: `${orderNo}-${itemNo}`, product_name: '상품', option_text: null, quantity: 1,
    buyer_name: '구매자', receiver_name: '받는분', receiver_phone: '010-0000-0000', receiver_address: '서울',
    paid_at: '2026-10-01T01:00:00.000Z', channel_status: 'PURCHASE_DECIDED', channel_confirmed: 1, ...extra,
  };
}

// 가짜 자사몰 API: 주문번호별 응답 (없는 번호는 404)
function fakeClient(byNo) {
  const calls = [];
  return {
    calls,
    request: async (method, path) => {
      calls.push(`${method} ${path}`);
      const no = path.split('/').pop();
      if (!byNo[no]) throw Object.assign(new Error('자사몰 API 오류 (HTTP 404): 주문이 없습니다.'), { status: 404 });
      const order = { orderNo: no, status: 's1', items: [{ itemNo: '1', status: 's1', name: '상품' }], ...byNo[no] };
      return no === '1002' ? { item: order } : order; // 감싼 응답도 읽는지
    },
  };
}

function setup() {
  const db = openDb(':memory:');
  applyOrders(db, [
    row('godo', '1001', '1'), row('godo', '1001', '2'), // 빈 칸 → 택배
    row('godo', '1002', '1'), //                           빈 칸 → 퀵
    row('godo', '1003', '1', { delivery_method: 'VISIT_RECEIPT' }), // 이미 있음 → 그대로
    row('godo', '1004', '1'), //                           자사몰에서 지워짐 → 건너뜀
    row('godo', '1005', '1'), //                           자사몰도 모름 → 비워 둠
    row('smartstore', '1001', '9'), //                     다른 채널 → 건드리지 않음
  ]);
  const client = fakeClient({
    1001: { deliveryMethod: 'DELIVERY' },
    1002: { deliveryMethod: 'QUICK_SVC' },
    1003: { deliveryMethod: 'DELIVERY' },
    1005: { deliveryMethod: null },
  });
  const get = (channel, item) => db.prepare('SELECT * FROM orders WHERE channel = ? AND channel_item_id = ?').get(channel, item);
  return { db, client, get };
}

test('미리보기: 세기만 하고 아무것도 바꾸지 않는다', async () => {
  const { db, client, get } = setup();
  const out = await fillGodoShipWay(db, { client });
  assert.strictEqual(out.orders, 4); // 1001·1002·1004·1005 (1003 은 이미 있어서 읽지 않음)
  assert.deepStrictEqual(out.found, { DELIVERY: 1, QUICK_SVC: 1 });
  assert.strictEqual(out.unknown, 1);
  assert.deepStrictEqual(out.failed.map(f => f.orderNo), ['1004']);
  assert.strictEqual(out.filled, 0);
  assert.strictEqual(get('godo', '1001-1').delivery_method, null);
  // 읽기만: GET 주문 한 건 조회만 부른다
  assert.ok(client.calls.every(c => /^GET \/orders\/\d+$/.test(c)));
});

test('--apply: 빈 자사몰 주문의 배송 방법 칸만 채운다', async () => {
  const { db, client, get } = setup();
  const before = get('godo', '1001-1');
  const out = await fillGodoShipWay(db, { client, apply: true });
  assert.strictEqual(out.filled, 2);
  assert.strictEqual(out.filledRows, 3); // 1001 상품 2줄 + 1002 1줄
  assert.strictEqual(get('godo', '1001-1').delivery_method, 'DELIVERY');
  assert.strictEqual(get('godo', '1001-2').delivery_method, 'DELIVERY');
  assert.strictEqual(get('godo', '1002-1').delivery_method, 'QUICK_SVC');
  assert.strictEqual(get('godo', '1003-1').delivery_method, 'VISIT_RECEIPT'); // 이미 있던 값은 그대로
  assert.strictEqual(get('godo', '1004-1').delivery_method, null);
  assert.strictEqual(get('godo', '1005-1').delivery_method, null);
  assert.strictEqual(get('smartstore', '1001-9').delivery_method, null); // 다른 채널은 그대로
  // 배송 방법 말고 다른 칸은 그대로
  const after = get('godo', '1001-1');
  for (const k of Object.keys(before)) if (k !== 'delivery_method') assert.deepStrictEqual(after[k], before[k], k);

  // 다시 실행해도 채울 것만 남는다 (이미 채운 주문은 다시 읽지 않음)
  const again = await fillGodoShipWay(db, { client, apply: true });
  assert.strictEqual(again.orders, 2); // 1004·1005
  assert.strictEqual(again.filled, 0);
});
