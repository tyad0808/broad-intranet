// 스마트스토어 오늘출발 표시와 발송기한
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { normalize } = require('../src/channels/smartstore');
const { createCollector, applyOrders } = require('../src/collector');
const { startServer, addUser, loginAs } = require('./helpers');

function order(id, extra = {}) {
  return {
    channel: 'smartstore', channel_order_id: `O${id}`, channel_item_id: `P${id}`, product_name: `상품${id}`,
    option_text: null, quantity: 1, buyer_name: `구매자${id}`, receiver_name: `수령${id}`, receiver_phone: '010-0000-0000',
    receiver_address: '서울', paid_at: `2026-10-1${id}T01:00:00.000Z`, channel_status: 'PAYED', channel_confirmed: 0, ...extra,
  };
}

test('스마트스토어 주문의 배송 속성(TODAY)과 발송기한을 UTC 로 저장한다', () => {
  const o = normalize({ order: { orderId: 'O1' }, productOrder: { productOrderId: 'P1', deliveryAttributeType: 'TODAY', shippingDueDate: '2026-10-20T15:00:00.0+09:00' } });
  assert.deepStrictEqual([o.delivery_type, o.ship_due], ['TODAY', '2026-10-20T06:00:00.000Z']);
  const n = normalize({ order: {}, productOrder: { productOrderId: 'P2' } });
  assert.deepStrictEqual([n.delivery_type, n.ship_due], ['NORMAL', null]);
});

test('이 기능 전에 받은 발송 전 주문은 한 번 다시 읽어 오늘출발·발송기한을 채운다', async () => {
  const db = openDb(':memory:');
  applyOrders(db, [order(1, { channel_confirmed: 1 }), order(2, { channel_confirmed: 1, channel_status: 'DELIVERING' })]);
  const asked = [];
  const source = {
    channel: 'smartstore', fillsDeliveryType: true,
    fetchChanges: async () => [],
    fetchByIds: async ids => { asked.push(...ids); return ids.map(id => order(id.slice(1), { channel_confirmed: 1, delivery_type: 'TODAY', ship_due: '2026-10-20T06:00:00.000Z' })); },
  };
  const collector = createCollector({ db, source });
  await collector.run();
  assert.deepStrictEqual(asked, ['P1'], '발송 전(PAYED) 주문만');
  assert.deepStrictEqual({ ...db.prepare("SELECT delivery_type, ship_due FROM orders WHERE channel_item_id = 'P1'").get() }, { delivery_type: 'TODAY', ship_due: '2026-10-20T06:00:00.000Z' });
  asked.length = 0;
  await collector.run();
  assert.deepStrictEqual(asked, [], '채운 뒤에는 다시 읽지 않는다 (발주확인된 주문)');
});

test('화면: 오늘출발 표시·발송기한, 오늘출발만 모아 보기(발송기한 이른 순), 발송기한 지남', async t => {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  const { db } = ctx;
  addUser(db, { email: 'kim@broad.test' });
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const later = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  applyOrders(db, [
    order(1, { delivery_type: 'TODAY', ship_due: later }),
    order(2, { delivery_type: 'TODAY', ship_due: soon }),
    order(3, { delivery_type: 'NORMAL', ship_due: past }),
    order(4, { delivery_type: 'NORMAL', ship_due: new Date(Date.now() + 5 * 86400 * 1000).toISOString() }),
    order(5, { delivery_type: 'TODAY', ship_due: soon, channel_status: 'DELIVERING' }),
  ]);
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const list = (await kim.request('/')).text;
  assert.strictEqual((list.match(/class="today-badge"/g) || []).length, 2, '발송 전 오늘출발 주문만 표시');
  assert.match(list, /alert-today[^"]*"[^>]*>\s*오늘출발 <span class="count">2</);
  assert.match(list, /alert-shiplate[^"]*"[^>]*>\s*발송기한 지남 <span class="count">1</);
  assert.match(list, /class="pill ship-due due-over"[^>]*>발송기한 지남/);
  assert.strictEqual((list.match(/class="pill ship-due/g) || []).length, 3, '일반 주문은 기한이 멀면 표시하지 않는다');
  const today = (await kim.request('/?alert=today')).text;
  const names = [...today.matchAll(/class="buyer">(구매자\d)/g)].map(m => m[1]);
  assert.deepStrictEqual(names, ['구매자2', '구매자1'], '발송기한 이른 순');
  const id = db.prepare("SELECT id FROM orders WHERE channel_item_id = 'P2'").get().id;
  assert.match((await kim.request(`/orders/${id}`)).text, /today-badge">오늘출발<\/span>\s*<span class="pill [^"]*">(오늘|내일) \d\d:\d\d까지 발송/);
});
