// 4단계: 스마트스토어 주문 수집 (조회 전용)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const { createNaverClient, isAllowed, ALLOWED } = require('../src/channels/naverClient');
const { createSmartstoreSource, toKstIso } = require('../src/channels/smartstore');
const { createMockSource } = require('../src/channels/mock');
const { createCollector, applyOrders } = require('../src/collector');
const { startServer, addUser, loginAs } = require('./helpers');

// 실제 네이버 대신 응답하는 가짜 fetch. 받은 요청을 calls 에 기록한다.
function fakeNaver(handlers) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || 'GET', path: u.pathname.replace('/external', ''), query: u.searchParams, body: init.body };
    calls.push(call);
    if (call.path === '/v1/oauth2/token') {
      return Response.json({ access_token: 'tok', expires_in: 10800 });
    }
    const handler = handlers[`${call.method} ${call.path}`];
    if (!handler) return Response.json({ message: 'not found' }, { status: 404 });
    return Response.json(handler(call));
  };
  return { fetchFn, calls };
}

function naverItem(id, { confirmed = false, status = 'PAYED' } = {}) {
  return {
    order: { orderId: `O${id}`, ordererName: '홍길동', paymentDate: '2026-10-14T10:00:00.0+09:00' },
    productOrder: {
      productOrderId: `P${id}`,
      productName: '명함',
      productOption: '양면 / 200매',
      quantity: 2,
      productOrderStatus: status,
      placeOrderStatus: confirmed ? 'OK' : 'NOT_YET',
      shippingAddress: { name: '김수령', tel1: '010-1234-5678', zipCode: '06236', baseAddress: '서울 강남구 테헤란로 1', detailedAddress: '2층' },
    },
  };
}

// ───────── 안전장치 ─────────

test('허용 목록 밖의 네이버 API 는 호출할 수 없다', async () => {
  const { fetchFn, calls } = fakeNaver({});
  const client = createNaverClient({ clientId: 'id', clientSecret: '$2a$04$abcdefghijklmnopqrstuu', fetchFn, allowWrite: true });
  const forbidden = [
    ['GET', '/v1/products/search'],
    ['POST', '/v1/pay-order/seller/product-orders/cancel/approve'],
    ['GET', '/v1/pay-order/seller/product-orders/confirm'],
  ];
  for (const [method, p] of forbidden) {
    await assert.rejects(client.request(method, p), /허용되지 않은/);
  }
  assert.strictEqual(calls.length, 0, '막힌 요청은 네이버로 아무것도 보내지 않아야 한다');
});

test('상태 변경(발주확인·발송처리)은 쓰기를 켠 클라이언트만 보낼 수 있다', async () => {
  const { fetchFn, calls } = fakeNaver({});
  const client = createNaverClient({ clientId: 'id', clientSecret: '$2a$04$abcdefghijklmnopqrstuu', fetchFn });
  for (const p of ['/v1/pay-order/seller/product-orders/confirm', '/v1/pay-order/seller/product-orders/dispatch']) {
    await assert.rejects(client.request('POST', p, { json: {} }), /꺼져 있습니다/);
  }
  assert.strictEqual(calls.length, 0);
});

test('소스 코드 어디에도 허용 목록 밖의 네이버 API 주소가 없다', () => {
  const allowed = new Set([...ALLOWED.map(a => a.path), '/v1/oauth2/token']);
  const files = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.js')) files.push(full);
  });
  walk(path.join(__dirname, '..', 'src'));
  for (const file of files) {
    const found = fs.readFileSync(file, 'utf8').match(/['"`](\/v\d+\/[^'"`?]+)['"`]/g) || [];
    for (const raw of found) {
      const p = raw.slice(1, -1);
      assert.ok(allowed.has(p), `${path.basename(file)} 에 허용되지 않은 주소: ${p}`);
    }
  }
});

test('허용 목록은 조회 2개 + 상태 변경 2개(발주확인·발송처리)뿐이다', () => {
  assert.ok(isAllowed('GET', '/v1/pay-order/seller/product-orders/last-changed-statuses'));
  assert.ok(isAllowed('POST', '/v1/pay-order/seller/product-orders/query'));
  assert.deepStrictEqual(ALLOWED.filter(a => a.write).map(a => a.path).sort(), [
    '/v1/pay-order/seller/product-orders/confirm',
    '/v1/pay-order/seller/product-orders/dispatch',
  ]);
  assert.strictEqual(ALLOWED.length, 4);
});

// ───────── 스마트스토어 응답 처리 ─────────

test('네이버 시각 형식은 한국 시간(+09:00)이다', () => {
  assert.strictEqual(toKstIso(new Date('2026-10-14T01:02:03.000Z')), '2026-10-14T10:02:03.000+09:00');
});

test('바뀐 주문 목록 → 상세 조회 → 인트라넷 형식으로 바꾼다 (페이지 넘김 포함)', async () => {
  const { fetchFn, calls } = fakeNaver({
    'GET /v1/pay-order/seller/product-orders/last-changed-statuses': call =>
      call.query.get('moreSequence')
        ? { data: { lastChangeStatuses: [{ productOrderId: 'P2' }] } }
        : { data: { lastChangeStatuses: [{ productOrderId: 'P1' }], more: { moreFrom: '2026-10-14T09:00:00.000+09:00', moreSequence: '5' } } },
    'POST /v1/pay-order/seller/product-orders/query': call => {
      const ids = JSON.parse(call.body).productOrderIds;
      return { data: ids.map(id => naverItem(id.slice(1), { confirmed: id === 'P2' })) };
    },
  });
  const source = createSmartstoreSource({ clientId: 'id', clientSecret: '$2a$04$abcdefghijklmnopqrstuu', fetchFn });
  const orders = await source.fetchChanges({ from: new Date('2026-10-14T00:00:00Z'), to: new Date('2026-10-14T01:00:00Z') });

  assert.strictEqual(orders.length, 2);
  assert.deepStrictEqual(orders[0], {
    channel: 'smartstore',
    channel_order_id: 'O1',
    channel_item_id: 'P1',
    product_name: '명함',
    item_type: 'main',
    option_text: '양면 / 200매',
    quantity: 2,
    buyer_name: '홍길동',
    receiver_name: '김수령',
    receiver_phone: '010-1234-5678',
    receiver_address: '(06236) 서울 강남구 테헤란로 1 2층',
    paid_at: '2026-10-14T10:00:00.0+09:00',
    channel_status: 'PAYED',
    channel_confirmed: 0,
    claim_type: null,
    claim_status: null,
  });
  assert.strictEqual(orders[1].channel_confirmed, 1);

  for (const c of calls) {
    assert.ok(c.path === '/v1/oauth2/token' || isAllowed(c.method, c.path), `허용되지 않은 호출: ${c.method} ${c.path}`);
  }
});

test('24시간보다 긴 기간은 24시간씩 나눠서 조회한다', async () => {
  const { fetchFn, calls } = fakeNaver({
    'GET /v1/pay-order/seller/product-orders/last-changed-statuses': () => ({ data: { lastChangeStatuses: [] } }),
  });
  const source = createSmartstoreSource({ clientId: 'id', clientSecret: '$2a$04$abcdefghijklmnopqrstuu', fetchFn });
  await source.fetchChanges({ from: new Date('2026-10-11T00:00:00Z'), to: new Date('2026-10-13T02:00:00Z') });
  const windows = calls.filter(c => c.path.endsWith('last-changed-statuses'));
  assert.strictEqual(windows.length, 3);
});

// ───────── DB 반영 ─────────

const stageName = (db, orderItemId) => db.prepare(
  'SELECT s.name FROM orders o JOIN work_stages s ON s.id = o.stage_id WHERE o.channel_item_id = ?'
).get(orderItemId).name;

function order(id, extra = {}) {
  return {
    channel: 'smartstore', channel_order_id: `O${id}`, channel_item_id: `P${id}`, product_name: '명함',
    option_text: null, quantity: 1, buyer_name: 'a', receiver_name: 'b', receiver_phone: null,
    receiver_address: null, paid_at: null, channel_status: 'PAYED', channel_confirmed: 0, ...extra,
  };
}

test('새 주문은 발주 단계 카드로 생기고 신규 발주 알림이 남는다', () => {
  const db = openDb(':memory:');
  const r = applyOrders(db, [order(1), order(2, { channel_confirmed: 1 })]);
  assert.strictEqual(r.created, 2);
  assert.strictEqual(stageName(db, 'P1'), '발주');
  assert.strictEqual(stageName(db, 'P2'), '발주확인', '처음부터 발주확인된 주문은 발주확인 단계로');
  const n = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'new_order'").get().n;
  assert.strictEqual(n, 2);
});

test('같은 주문을 다시 받아도 카드가 두 개 생기지 않는다', () => {
  const db = openDb(':memory:');
  applyOrders(db, [order(1)]);
  const r = applyOrders(db, [order(1)]);
  assert.deepStrictEqual([r.created, r.updated], [0, 1]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
});

test('판매자센터에서 발주확인되면 발주 단계 카드가 발주확인으로 옮겨진다', () => {
  const db = openDb(':memory:');
  applyOrders(db, [order(1)]);
  applyOrders(db, [order(1, { channel_confirmed: 1 })]);
  assert.strictEqual(stageName(db, 'P1'), '발주확인');
});

test('관리자가 이미 다음 단계로 옮긴 카드는 되돌리지 않고, 디자인 단계·메모·담당자도 그대로 둔다', () => {
  const db = openDb(':memory:');
  const designer = addUser(db, { email: 'd@broad.test' });
  applyOrders(db, [order(1)]);
  const sent = db.prepare("SELECT id FROM work_stages WHERE name = '발송'").get().id;
  const working = db.prepare("SELECT id FROM design_stages WHERE name = '디자인 작업 중'").get().id;
  db.prepare("UPDATE orders SET stage_id = ?, design_stage_id = ?, assignee_id = ?, memo = '금박 추가' WHERE channel_item_id = 'P1'")
    .run(sent, working, designer);

  applyOrders(db, [order(1, { channel_confirmed: 1, channel_status: 'DELIVERING' })]);
  const row = db.prepare("SELECT design_stage_id, assignee_id, memo, channel_status FROM orders WHERE channel_item_id = 'P1'").get();
  assert.strictEqual(stageName(db, 'P1'), '발송');
  assert.deepStrictEqual({ ...row }, { design_stage_id: working, assignee_id: designer, memo: '금박 추가', channel_status: 'DELIVERING' });
});

test('같은 주문에 나중에 들어온 추가상품은 디자인 단계도 이어받는다', () => {
  const db = openDb(':memory:');
  applyOrders(db, [order(1)]);
  const working = db.prepare("SELECT id FROM design_stages WHERE name = '디자인 작업 중'").get().id;
  db.prepare("UPDATE orders SET design_stage_id = ? WHERE channel_item_id = 'P1'").run(working);
  applyOrders(db, [order(9, { channel_order_id: 'O1', item_type: 'addon' })]);
  assert.strictEqual(db.prepare("SELECT design_stage_id FROM orders WHERE channel_item_id = 'P9'").get().design_stage_id, working);
});

test('고객이 취소를 요청하면 한 번만 클레임으로 알려주고 상태를 저장한다', () => {
  const db = openDb(':memory:');
  applyOrders(db, [order(1)]);
  const r1 = applyOrders(db, [order(1, { claim_type: 'CANCEL', claim_status: 'CANCEL_REQUEST' })]);
  assert.strictEqual(r1.claims.length, 1);
  assert.strictEqual(r1.claims[0].claim_status, 'CANCEL_REQUEST');
  const r2 = applyOrders(db, [order(1, { claim_type: 'CANCEL', claim_status: 'CANCEL_REQUEST' })]);
  assert.strictEqual(r2.claims.length, 0, '같은 요청은 다시 알리지 않는다');
  const row = db.prepare("SELECT claim_type, claim_status FROM orders WHERE channel_item_id = 'P1'").get();
  assert.deepStrictEqual({ ...row }, { claim_type: 'CANCEL', claim_status: 'CANCEL_REQUEST' });
});

test('결제 전 주문은 카드로 만들지 않는다', () => {
  const db = openDb(':memory:');
  const r = applyOrders(db, [order(1, { channel_status: 'PAYMENT_WAITING' })]);
  assert.strictEqual(r.created, 0);
});

test('관리자가 단계 이름을 바꿔도 새 주문은 첫 단계로 들어간다', () => {
  const db = openDb(':memory:');
  db.prepare("UPDATE work_stages SET name = '접수' WHERE name = '발주'").run();
  applyOrders(db, [order(1)]);
  assert.strictEqual(stageName(db, 'P1'), '접수');
});

// ───────── 수집기 ─────────

test('수집 기록이 남고, 다음 수집은 지난번 끝 시각 10분 전부터 본다', async () => {
  const db = openDb(':memory:');
  const ranges = [];
  let clock = new Date('2026-10-14T00:00:00Z');
  const source = { channel: 'smartstore', fetchChanges: async r => { ranges.push(r); return [order(ranges.length)]; } };
  const collector = createCollector({ db, source, now: () => clock });

  assert.strictEqual((await collector.run()).created, 1);
  clock = new Date('2026-10-14T00:05:00Z');
  await collector.run();

  assert.strictEqual(ranges[0].from.toISOString(), '2026-10-11T00:00:00.000Z', '처음에는 최근 3일');
  assert.strictEqual(ranges[1].from.toISOString(), '2026-10-13T23:50:00.000Z');
  const runs = db.prepare('SELECT ok, created FROM collect_runs ORDER BY id').all().map(r => ({ ...r }));
  assert.deepStrictEqual(runs, [{ ok: 1, created: 1 }, { ok: 1, created: 1 }]);
});

test('수집에 실패하면 이유를 기록하고, 다음 수집 범위를 앞으로 당기지 않는다', async () => {
  const db = openDb(':memory:');
  const source = { channel: 'smartstore', fetchChanges: async () => { throw new Error('IP 가 등록되지 않음'); } };
  const collector = createCollector({ db, source });
  const r = await collector.run();
  assert.strictEqual(r.ok, false);
  const run = db.prepare('SELECT ok, error FROM collect_runs').get();
  assert.deepStrictEqual({ ...run }, { ok: 0, error: 'IP 가 등록되지 않음' });
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'collect_last_to_smartstore'").get(), undefined);
});

test('수집이 겹쳐 실행되면 한 번만 돈다', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const source = { channel: 'smartstore', fetchChanges: async () => { calls += 1; await new Promise(r => setTimeout(r, 20)); return []; } };
  const collector = createCollector({ db, source });
  await Promise.all([collector.run(), collector.run(), collector.run()]);
  assert.strictEqual(calls, 1);
});

test('가짜 주문 출처: 처음 3건, 이후 일부가 발주확인으로 바뀐다', async () => {
  let i = 0;
  const seq = [0.1, 0.5, 0.9, 0.2, 0.7, 0.3];
  const source = createMockSource({ random: () => seq[i++ % seq.length] });
  const first = await source.fetchChanges();
  assert.strictEqual(first.filter(o => o.item_type === 'main').length, 3);
  assert.ok(first.filter(o => o.item_type === 'addon').every(a => first.some(m => m.item_type === 'main' && m.channel_order_id === a.channel_order_id)),
    '추가상품은 본상품과 같은 주문번호');
  assert.ok(first.every(o => o.channel_confirmed === 0));
  const second = await source.fetchChanges();
  assert.ok(second.some(o => o.channel_confirmed === 1));
});

// ───────── 관리자 화면 ─────────

test('관리자가 "지금 수집"을 누르면 주문이 들어오고 화면에 보인다', async t => {
  const db = openDb(':memory:');
  const collector = createCollector({ db, source: createMockSource() });
  collector.intervalMinutes = 5;
  const { server, baseUrl } = await startServer({ db, collector });
  t.after(() => server.close());
  addUser(db, { email: 'boss@broad.test', role: 'admin' });
  const admin = await loginAs(baseUrl, 'boss@broad.test');

  const res = await admin.submit('/admin/collect', '/admin/collect', {});
  assert.strictEqual(res.location, '/admin/collect');
  const page = await admin.request('/admin/collect');
  assert.match(page.text, /수집 완료: 새 주문 3건/);
  assert.match(page.text, /저장된 주문 <strong>3건/);
});

// ───────── 첫 수집 때 지난 주문 처리 ─────────

test('처음 보는 주문이 이미 배송·구매확정이면 마지막 단계로 넣고 알림을 보내지 않는다', () => {
  const db = openDb(':memory:');
  const r = applyOrders(db, [
    order(1, { channel_status: 'PURCHASE_DECIDED' }),
    order(2, { channel_status: 'DELIVERED' }),
    order(3, { channel_status: 'DELIVERING' }),
    order(4),
  ]);
  assert.deepStrictEqual([r.created, r.archived], [1, 3]);
  assert.strictEqual(stageName(db, 'P1'), '발송');
  assert.strictEqual(stageName(db, 'P4'), '발주');
  const n = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'new_order'").get().n;
  assert.strictEqual(n, 1, '진짜 새 주문 1건만 알림');
});

test('처음 보는 주문이 이미 취소됐으면 카드를 만들지 않는다', () => {
  const db = openDb(':memory:');
  const r = applyOrders(db, [order(1, { channel_status: 'CANCELED' })]);
  assert.deepStrictEqual([r.created, r.archived], [0, 0]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
});

test('이미 있는 카드는 나중에 배송완료·취소가 되어도 직원이 둔 단계를 바꾸지 않는다', () => {
  const db = openDb(':memory:');
  applyOrders(db, [order(1)]);
  applyOrders(db, [order(1, { channel_status: 'CANCELED' })]);
  assert.strictEqual(stageName(db, 'P1'), '발주');
  assert.strictEqual(db.prepare("SELECT channel_status FROM orders WHERE channel_item_id = 'P1'").get().channel_status, 'CANCELED');
});

test('지난 주문 정리: 미리보기는 바꾸지 않고, --apply 는 손대지 않은 카드만 옮긴다', () => {
  const { tidyOrders } = require('../scripts/tidy-orders');
  const db = openDb(':memory:');
  // 고치기 전 수집기가 만든 상황을 재현: 지난 주문이 '발주' 단계로 들어가 있음
  const early = db.prepare("SELECT id FROM work_stages WHERE name = '발주'").get().id;
  const ins = db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, channel_status, stage_id) VALUES ('smartstore', ?, ?, '상품', ?, ?)");
  ins.run('O1', 'P1', 'PURCHASE_DECIDED', early);
  ins.run('O2', 'P2', 'DELIVERED', early);
  ins.run('O3', 'P3', 'CANCELED', early);
  ins.run('O4', 'P4', 'PAYED', early);               // 진짜 진행 중 → 그대로
  ins.run('O5', 'P5', 'DELIVERED', early);
  const staff = addUser(db, { email: 's@broad.test' });
  db.prepare("UPDATE orders SET assignee_id = ? WHERE channel_item_id = 'P5'").run(staff); // 직원이 맡음 → 그대로

  const preview = tidyOrders(db);
  assert.strictEqual(preview.total, 3);
  assert.strictEqual(preview.moved, 0);
  assert.strictEqual(stageName(db, 'P1'), '발주', '미리보기는 바꾸지 않음');

  const done = tidyOrders(db, { apply: true });
  assert.strictEqual(done.moved, 3);
  assert.deepStrictEqual(['P1', 'P2', 'P3', 'P4', 'P5'].map(p => stageName(db, p)), ['발송', '발송', '발송', '발주', '발주']);
});

test('스마트스토어 추가구성상품은 추가상품(addon)으로 표시한다', () => {
  const { normalize } = require('../src/channels/smartstore');
  const item = naverItem(9);
  item.productOrder.productClass = '추가구성상품';
  assert.strictEqual(normalize(item).item_type, 'addon');
  item.productOrder.productClass = '조합형옵션상품';
  assert.strictEqual(normalize(item).item_type, 'main');
});

test('같은 주문번호의 상품은 사내 칸을 이어받고, 발주확인도 주문 단위로 옮긴다', () => {
  const db = openDb(':memory:');
  const designer = addUser(db, { email: 'd@broad.test' });
  applyOrders(db, [order(1)]);
  db.prepare("UPDATE orders SET assignee_id = ?, due_date = '2026-10-20' WHERE channel_item_id = 'P1'").run(designer);

  // 같은 주문(O1)의 추가상품이 나중에 들어옴
  applyOrders(db, [order(2, { channel_order_id: 'O1', item_type: 'addon' })]);
  const addon = db.prepare("SELECT assignee_id, due_date, item_type FROM orders WHERE channel_item_id = 'P2'").get();
  assert.deepStrictEqual({ ...addon }, { assignee_id: designer, due_date: '2026-10-20', item_type: 'addon' });

  // 본상품만 발주확인돼도 주문 전체가 발주확인으로
  applyOrders(db, [order(1, { channel_confirmed: 1 })]);
  assert.deepStrictEqual([stageName(db, 'P1'), stageName(db, 'P2')], ['발주확인', '발주확인']);
});

test('주문 목록에서 직원 누구나 지금 수집을 누를 수 있다', async t => {
  const db = openDb(':memory:');
  addUser(db, { email: 'staff@broad.test' });
  const collector = createCollector({ db, source: createMockSource() });
  const { server, baseUrl } = await startServer({ db, collector });
  t.after(() => server.close());
  const b = await loginAs(baseUrl, 'staff@broad.test');
  const page = await b.request('/');
  assert.match(page.text, /지금 수집/);
  const res = await b.submit('/', '/orders/collect', { back: '/' });
  assert.strictEqual(res.location, '/');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n > 0);
  assert.match((await b.request('/')).text, /수집 완료/);
});

test('수집이 꺼져 있으면 목록에 지금 수집 버튼이 없다', async t => {
  const db = openDb(':memory:');
  addUser(db, { email: 'staff@broad.test' });
  const { server, baseUrl } = await startServer({ db });
  t.after(() => server.close());
  const b = await loginAs(baseUrl, 'staff@broad.test');
  assert.doesNotMatch((await b.request('/')).text, /지금 수집/);
});

test('네이버가 429(요청이 많음)로 거절하면 잠시 기다렸다가 다시 시도한다', async () => {
  let tries = 0;
  const waits = [];
  const fetchFn = async url => {
    if (url.includes('/v1/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 10800 });
    tries++;
    return tries < 3 ? Response.json({ message: '요청이 많아' }, { status: 429 }) : Response.json({ data: { ok: 1 } });
  };
  const client = createNaverClient({
    clientId: 'id', clientSecret: '$2a$04$abcdefghijklmnopqrstuu', fetchFn, minGapMs: 0,
    sleep: async ms => { waits.push(ms); },
  });
  const body = await client.request('POST', '/v1/pay-order/seller/product-orders/query', { json: {} });
  assert.deepStrictEqual(body, { data: { ok: 1 } });
  assert.strictEqual(tries, 3);
  assert.deepStrictEqual(waits, [1000, 2000]);
});

test('429 가 계속되면 몇 번 시도한 뒤 오류로 알린다', async () => {
  let tries = 0;
  const fetchFn = async url => {
    if (url.includes('/v1/oauth2/token')) return Response.json({ access_token: 'tok', expires_in: 10800 });
    tries++;
    return Response.json({ message: '요청이 많아' }, { status: 429 });
  };
  const client = createNaverClient({ clientId: 'id', clientSecret: '$2a$04$abcdefghijklmnopqrstuu', fetchFn, minGapMs: 0, sleep: async () => {} });
  await assert.rejects(client.request('POST', '/v1/pay-order/seller/product-orders/query', { json: {} }), /429/);
  assert.strictEqual(tries, 5);
});
