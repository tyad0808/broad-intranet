// 배송 방법(택배·퀵·방문수령)과 주문 금액(배송비 포함): 수집 → 목록·상세·발주서·수기 주문
const test = require('node:test');
const assert = require('node:assert');
const { applyOrders } = require('../src/collector');
const { shipWay, shipWayCode, orderMoney, moneyLabel, orderShipWay, dispatchMethodFor } = require('../src/channels/shipping');
const { normalize: godoNormalize } = require('../src/channels/godo');
const { startServer, addUser, loginAs } = require('./helpers');

const recent = id => new Date(Date.now() - (100 - id) * 60 * 1000).toISOString();

function order(id, extra = {}) {
  return {
    channel: 'smartstore', channel_order_id: `O${id}`, channel_item_id: `P${id}`, product_name: `상품${id}`,
    option_text: null, quantity: 1, buyer_name: '구매자', receiver_name: `수령${id}`, receiver_phone: '010-0000-0000',
    receiver_address: '서울', paid_at: recent(id), channel_status: 'PAYED', channel_confirmed: 0, ...extra,
  };
}

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  addUser(ctx.db, { email: 'kim@broad.test', name: '김디자' });
  ctx.kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  ctx.idOf = item => ctx.db.prepare('SELECT id FROM orders WHERE channel_item_id = ?').get(item).id;
  return ctx;
}

test('배송 방법: 채널 값(코드·한글)을 하나로 맞추고, 택배는 노랑·퀵은 파랑·방문은 테두리로 보여 준다', () => {
  assert.deepStrictEqual(
    ['DELIVERY', 'gdfw_issue_svc', 'QUICK_SVC', '퀵서비스', '방문수령', '택배', '등기,소포', '', null, '모름'].map(shipWayCode),
    ['DELIVERY', 'GDFW_ISSUE_SVC', 'QUICK_SVC', 'QUICK_SVC', 'VISIT_RECEIPT', 'DELIVERY', 'DELIVERY', null, null, null]);
  assert.deepStrictEqual(shipWay('DELIVERY'), { text: '택배', cls: 'sw-parcel' });
  assert.deepStrictEqual(shipWay('GDFW_ISSUE_SVC'), { text: '택배', cls: 'sw-parcel' }, '굿스플로 송장 출력도 택배');
  assert.deepStrictEqual(shipWay('QUICK_SVC'), { text: '퀵', cls: 'sw-quick' });
  assert.deepStrictEqual(shipWay('VISIT_RECEIPT'), { text: '방문수령', cls: 'sw-visit' });
  assert.strictEqual(shipWay(null), null);
  // 발송처리 칸에 처음 골라 둘 값
  assert.deepStrictEqual(['QUICK_SVC', 'VISIT_RECEIPT', 'DELIVERY', null].map(dispatchMethodFor), ['QUICK_SVC', 'DIRECT_DELIVERY', 'DELIVERY', 'DELIVERY']);
});

test('주문 금액: 배송비 빼고, 통계 매출과 같은 기준 (취소·반품·입금 전은 매출 아님)', () => {
  const item = extra => ({ channel: 'smartstore', channel_order_id: 'O1', channel_status: 'PAYED', item_type: 'main', ...extra });
  // 배송비(ship_fee)는 금액에 넣지 않는다
  const same = [
    item({ pay_amount: 19900, ship_fee: 3000, ship_pkg: 'K1' }),
    item({ pay_amount: 3000, ship_fee: 3000, ship_pkg: 'K1', item_type: 'addon' }),
  ];
  assert.deepStrictEqual(orderMoney(same), { goods: 22900, state: 'paid', pending: null });
  // 일부 취소·반품·입금 전 상품은 뺀다
  assert.deepStrictEqual(orderMoney([same[0], item({ pay_amount: 10000, channel_status: 'CANCELED' }), item({ pay_amount: 5000, channel_status: 'RETURNED' })]),
    { goods: 19900, state: 'paid', pending: null });
  // 모두 취소 → 금액 없음 + '취소됨' / 모두 반품 → '반품됨'
  assert.deepStrictEqual(orderMoney([item({ pay_amount: 10000, channel_status: 'CANCELED' }), item({ pay_amount: 5000, channel_status: 'RETURNED' })]),
    { goods: null, state: 'canceled', pending: null });
  assert.deepStrictEqual(orderMoney([item({ pay_amount: 5000, channel_status: 'RETURNED' })]), { goods: null, state: 'returned', pending: null });
  // 입금 전 주문 → 매출 아님, 입금되면 받을 금액만 따로
  assert.deepStrictEqual(orderMoney([item({ pay_amount: 50000, channel_status: 'PAYMENT_WAITING' })]), { goods: null, state: 'waiting', pending: 50000 });
  // 금액을 모르는 주문
  assert.deepStrictEqual(orderMoney([item({})]), { goods: null, state: 'paid', pending: null });
  // 수기 주문: 등록할 때 적은 금액. 입금대기·취소도 통계처럼
  const manual = extra => ({ channel: 'manual', amount: 154000, channel_status: 'PAYED', ...extra });
  assert.deepStrictEqual(orderMoney([manual(), manual()]), { goods: 154000, state: 'paid', pending: null });
  assert.deepStrictEqual(orderMoney([manual({ channel_status: 'PAYMENT_WAITING' })]), { goods: null, state: 'waiting', pending: 154000 });
  assert.deepStrictEqual(orderMoney([manual({ channel_status: 'CANCELED' })]), { goods: null, state: 'canceled', pending: null });
  // 화면 글자
  assert.deepStrictEqual(moneyLabel(orderMoney(same)), { text: '22,900원', off: false });
  assert.deepStrictEqual(moneyLabel(orderMoney([manual({ channel_status: 'PAYMENT_WAITING' })])), { text: '입금 전 154,000원', off: true });
  assert.deepStrictEqual(moneyLabel(orderMoney([manual({ channel_status: 'CANCELED' })])), { text: '취소됨', off: true });
  assert.deepStrictEqual(moneyLabel(orderMoney([item({ channel_status: 'RETURNED' })])), { text: '반품됨', off: true });
  assert.strictEqual(moneyLabel(orderMoney([])), null);
  // 배송 방법은 본상품 기준
  assert.strictEqual(orderShipWay([item({ item_type: 'addon', delivery_method: 'DELIVERY' }), item({ delivery_method: 'QUICK_SVC' })]), 'QUICK_SVC');
});

test('자사몰: 배송비(totalDeliveryCharge)를 받고, API 가 배송 방법을 보내 주면 그것도 받는다', () => {
  const mall = extra => ({
    orderNo: 25110300001, status: 'p1', paidAt: '2026-11-03 10:00:00', totalDeliveryCharge: 3000,
    orderer: {}, receiver: {}, items: [{ itemNo: 1, type: 'goods', name: '현수막', quantity: 1, amount: 20000 }], ...extra,
  });
  const [plain] = godoNormalize(mall());
  assert.deepStrictEqual([plain.delivery_method, plain.ship_fee, plain.ship_pkg], [null, 3000, '25110300001']);
  assert.strictEqual(godoNormalize(mall({ deliveryMethod: 'QUICK_SVC' }))[0].delivery_method, 'QUICK_SVC');
  assert.strictEqual(godoNormalize(mall({ deliveryMethod: '방문수령' }))[0].delivery_method, 'VISIT_RECEIPT');
  assert.strictEqual(godoNormalize(mall({ delivery: { method: '택배' } }))[0].delivery_method, 'DELIVERY');
});

test('이 기능 전에 받은 주문도 다시 읽으면 배송 방법·배송비가 채워지고, 모르는 값으로 지우지 않는다', () => {
  const { openDb } = require('../src/db');
  const db = openDb(':memory:');
  applyOrders(db, [order(1)]);
  const row = () => ({ ...db.prepare("SELECT delivery_method, ship_fee, ship_pkg FROM orders WHERE channel_item_id = 'P1'").get() });
  assert.deepStrictEqual(row(), { delivery_method: null, ship_fee: null, ship_pkg: null });
  const r = applyOrders(db, [{ ...order(1), refreshOnly: true, delivery_method: 'QUICK_SVC', ship_fee: 3000, ship_pkg: 'K1' }]);
  assert.strictEqual(r.updated, 1, '배송 방법이 새로 생기면 고친다');
  assert.deepStrictEqual(row(), { delivery_method: 'QUICK_SVC', ship_fee: 3000, ship_pkg: 'K1' });
  applyOrders(db, [{ ...order(1), refreshOnly: true }]);
  assert.deepStrictEqual(row(), { delivery_method: 'QUICK_SVC', ship_fee: 3000, ship_pkg: 'K1' }, '값이 없는 응답으로 지우지 않는다');
});

test('스마트스토어 수집: 배송 방법·배송비를 모르는 발송 전 주문은 상품주문번호로 다시 읽는다', async () => {
  const { openDb } = require('../src/db');
  const { createCollector } = require('../src/collector');
  const db = openDb(':memory:');
  applyOrders(db, [order(1, { channel_confirmed: 1, delivery_type: 'NORMAL', buyer_phone: '010' })]);
  let asked = null;
  const source = {
    channel: 'smartstore', fillsShipWay: true,
    fetchChanges: async () => [],
    fetchByIds: async ids => { asked = ids; return [{ ...order(1, { channel_confirmed: 1, delivery_type: 'NORMAL' }), delivery_method: 'VISIT_RECEIPT', ship_fee: 0, ship_pkg: 'K1' }]; },
  };
  await createCollector({ db, source }).run();
  assert.deepStrictEqual(asked, ['P1']);
  assert.strictEqual(db.prepare("SELECT delivery_method FROM orders WHERE channel_item_id = 'P1'").get().delivery_method, 'VISIT_RECEIPT');
});

test('주문 금액 합계 = 통계 매출 (같은 목록으로 빼서 어긋나지 않는다)', () => {
  const { openDb } = require('../src/db');
  const { totals } = require('../src/stats');
  const db = openDb(':memory:');
  applyOrders(db, [
    order(1, { pay_amount: 32000, ship_fee: 3000 }),
    order(2, { channel_order_id: 'O1', item_type: 'addon', pay_amount: 4500, channel_status: 'CANCELED' }),
    order(3, { pay_amount: 7000, channel_status: 'CANCELED' }),
    order(4, { pay_amount: 9000, channel_status: 'RETURNED' }),
    order(5, { pay_amount: 50000, channel_status: 'PAYMENT_WAITING' }),
    order(6, { pay_amount: 8900 }),
  ]);
  const rows = db.prepare('SELECT * FROM orders').all();
  const groups = Object.values(Object.groupBy(rows, r => r.channel_order_id));
  const shown = groups.reduce((t, g) => t + (orderMoney(g).goods || 0), 0);
  const sales = totals(db, '2000-01-01 00:00:00', '2100-01-01 00:00:00').sales;
  assert.strictEqual(shown, 32000 + 8900);
  assert.strictEqual(sales, shown);
});

test('목록: 배송 방법 표시와 상품 금액(배송비 빼고 = 통계 기준), 휴대폰용 디자인·담당 이름표', async t => {
  const { db, kim } = await setup(t);
  applyOrders(db, [
    order(1, { delivery_method: 'QUICK_SVC', pay_amount: 32000, ship_fee: 3000, ship_pkg: 'K1' }),
    order(9, { channel_order_id: 'O1', item_type: 'addon', product_name: '풍선', delivery_method: 'QUICK_SVC', pay_amount: 4500, ship_fee: 3000, ship_pkg: 'K1' }),
    order(2, { delivery_method: 'GDFW_ISSUE_SVC', pay_amount: 8900, ship_fee: 3000, ship_pkg: 'K2' }),
  ]);
  const list = (await kim.request('/')).text;
  assert.match(list, /class="ship-way sw-quick"[^>]*>퀵</);
  assert.match(list, /class="ship-way sw-parcel"[^>]*>택배</);
  assert.match(list, />36,500원</, '32,000 + 4,500 (배송비는 빼고)');
  assert.match(list, />8,900원</);
  assert.doesNotMatch(list, />39,500원</, '배송비를 더하지 않는다');
  assert.match(list, /class="cell-cap">디자인</);
  assert.match(list, /class="cell-cap">담당</);
  assert.match(list, /<body[^>]*class="[^"]*orders-wide/, '주문 목록은 넓게');
});

test('상세: 배송 방법·상품 금액(배송비 빼고)을 보여 주고, 발송처리 칸은 고객이 고른 방법(퀵)으로 미리 골라 둔다', async t => {
  const { db, kim, idOf } = await setup(t);
  applyOrders(db, [order(1, { delivery_method: 'QUICK_SVC', pay_amount: 32000, ship_fee: 3000, ship_pkg: 'K1', channel_confirmed: 1 })]);
  const page = (await kim.request(`/orders/${idOf('P1')}`)).text;
  assert.match(page, /<dt>배송 방법<\/dt><dd><span class="ship-way sw-quick">퀵<\/span>/);
  assert.match(page, /<dt>상품 금액<\/dt><dd><strong class="oi-amount">32,000원<\/strong> <span class="muted small">배송비 빼고/);
  assert.match(page, /<option value="QUICK_SVC:" selected>퀵서비스<\/option>/, '퀵 주문은 발송처리도 퀵서비스로');
  assert.match(page, /name="method" value="QUICK_SVC"/);
  // 발주서에도 배송 방법
  const print = (await kim.request(`/orders/${idOf('P1')}/print`)).text;
  assert.match(print, /<span class="label">배송 방법<\/span><strong>퀵<\/strong>/);
});

test('수기 주문: 배송 방법을 골라 등록·수정한다 (모르는 값이면 택배)', async t => {
  const { db, kim } = await setup(t);
  const form = {
    item_name: ['현수막', ''], item_option: ['', ''], item_qty: ['1', '1'], item_id: ['', ''],
    buyer_name: '홍길동', buyer_phone: '010-1111-2222', receiver_address: '서울', pay_method: 'BANK', amount: '55000', pay_status: 'paid',
  };
  const page = (await kim.request('/orders/new')).text;
  assert.match(page, /<select id="delivery_method" name="delivery_method">/);
  await kim.submit('/orders/new', '/orders/new', { ...form, delivery_method: 'VISIT_RECEIPT' });
  const row = () => db.prepare("SELECT * FROM orders WHERE channel = 'manual'").get();
  assert.strictEqual(row().delivery_method, 'VISIT_RECEIPT');
  assert.match((await kim.request('/')).text, /class="ship-way sw-visit"[^>]*>방문수령</);
  const id = row().id;
  const edit = (await kim.request(`/orders/${id}/manual-edit`)).text;
  assert.match(edit, /<option value="VISIT_RECEIPT" selected>/);
  const version = /name="version" value="(\d+)"/.exec(edit)[1];
  await kim.submit(`/orders/${id}/manual-edit`, `/orders/${id}/manual-edit`, { ...form, item_id: [String(id), ''], version, delivery_method: 'NOPE' });
  assert.strictEqual(row().delivery_method, 'DELIVERY');
});
