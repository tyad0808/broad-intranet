// 3차: 쿠팡 주문 가져오기 (조회 전용)
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { openDb } = require('../src/db');
const { createCoupangClient, isAllowed, buildAuthorization, signedDate, parseJson } = require('../src/channels/coupangClient');
const { createCoupangSource, normalize } = require('../src/channels/coupang');
const { createCollector, createMultiCollector, applyOrders } = require('../src/collector');

const KEYS = { vendorId: 'A00012345', accessKey: 'ak-test', secretKey: 'sk-test' };

function sheet(id, status = 'ACCEPT', extra = {}) {
  return {
    shipmentBoxId: `64253897000640${id}`,
    orderId: `91000418632${id}`,
    orderedAt: '2026-10-16T10:00:00',
    paidAt: '2026-10-16T10:00:05',
    status,
    orderer: { name: '홍길동' },
    receiver: { name: '김수령', safeNumber: '0502-1234-5678', addr1: '서울 강남구 테헤란로 1', addr2: '2층', postCode: '06236' },
    orderItems: [
      { vendorItemId: `30000000${id}1`, sellerProductName: '명함 주문제작', sellerProductItemName: '양면 / 200매', shippingCount: 2, cancelCount: 0, holdCountForCancel: 0 },
    ],
    ...extra,
  };
}

// 실제 쿠팡 대신 응답하는 가짜 fetch. 상태별 발주서를 돌려주고, 받은 요청을 calls 에 남긴다
function fakeCoupang(byStatus) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, query: u.searchParams, auth: init.headers.authorization });
    const status = u.searchParams.get('status');
    const pages = byStatus[status] || [[]];
    const page = Number(u.searchParams.get('nextToken') || 0);
    const body = { code: 200, message: 'OK', data: pages[page] || [], nextToken: page + 1 < pages.length ? String(page + 1) : '' };
    // 실제 쿠팡처럼 긴 번호는 따옴표 없는 숫자로 보낸다
    const text = JSON.stringify(body).replace(/"(shipmentBoxId|orderId|vendorItemId)":"(\d+)"/g, '"$1":$2');
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchFn, calls };
}

test('쿠팡 서명: 시각(UTC yyMMddTHHmmssZ) + 메서드 + 경로 + 쿼리로 HMAC-SHA256', () => {
  const now = new Date('2026-10-16T01:02:03Z');
  assert.strictEqual(signedDate(now), '261016T010203Z');
  const auth = buildAuthorization({ ...KEYS, method: 'GET', path: '/v2/x', query: 'a=1&b=2', now });
  const expected = crypto.createHmac('sha256', 'sk-test').update('261016T010203ZGET/v2/xa=1&b=2').digest('hex');
  assert.strictEqual(auth, `CEA algorithm=HmacSHA256, access-key=ak-test, signed-date=261016T010203Z, signature=${expected}`);
});

test('쿠팡: 발주서 목록 조회 말고는 호출할 수 없다 (상태 변경 주소는 막힘)', async () => {
  let sent = 0;
  const client = createCoupangClient({ ...KEYS, fetchFn: async () => { sent++; }, minGapMs: 0 });
  assert.ok(isAllowed('GET', '/v2/providers/openapi/apis/api/v4/vendors/A00012345/ordersheets'));
  for (const [m, p] of [
    ['PUT', '/v2/providers/openapi/apis/api/v4/vendors/A00012345/ordersheets/acknowledgement'],
    ['POST', '/v2/providers/openapi/apis/api/v4/vendors/A00012345/orders/invoices'],
    ['GET', '/v2/providers/openapi/apis/api/v4/vendors/A00012345/ordersheets/123'],
  ]) {
    await assert.rejects(client.request(m, p), /허용되지 않은/);
  }
  assert.strictEqual(sent, 0);
});

test('쿠팡의 긴 번호(배송번호 등)는 끝자리가 틀어지지 않게 글자로 읽는다', () => {
  const body = parseJson('{"data":[{"shipmentBoxId":642538970006401429,"orderId":9100041863244}]}');
  assert.strictEqual(body.data[0].shipmentBoxId, '642538970006401429');
  assert.strictEqual(body.data[0].orderId, '9100041863244');
});

test('쿠팡 발주서 → 인트라넷 주문 (상태는 공통 상태로)', () => {
  const [o] = normalize(sheet(1, 'INSTRUCT'));
  assert.deepStrictEqual(o, {
    channel: 'coupang', channel_order_id: '910004186321', channel_item_id: '642538970006401-3000000011',
    product_name: '명함 주문제작', item_type: 'main', option_text: '양면 / 200매', quantity: 2,
    buyer_name: '홍길동', receiver_name: '김수령', receiver_phone: '0502-1234-5678',
    receiver_address: '(06236) 서울 강남구 테헤란로 1 2층', paid_at: '2026-10-16T10:00:05+09:00',
    channel_status: 'PAYED', channel_confirmed: 1, claim_type: null, claim_status: null,
  });
  assert.deepStrictEqual([normalize(sheet(1, 'ACCEPT'))[0].channel_status, normalize(sheet(1, 'ACCEPT'))[0].channel_confirmed], ['PAYED', 0]);
  assert.strictEqual(normalize(sheet(1, 'FINAL_DELIVERY'))[0].channel_status, 'DELIVERED');
  const hold = sheet(1, 'ACCEPT');
  hold.orderItems[0].holdCountForCancel = 1;
  assert.strictEqual(normalize(hold)[0].claim_status, 'CANCEL_REQUEST');
});

test('쿠팡 수집: 상태별로 최근 주문을 읽고(다음 페이지 포함), 서명·업체코드가 붙는다', async () => {
  const { fetchFn, calls } = fakeCoupang({ ACCEPT: [[sheet(1)], [sheet(2)]], INSTRUCT: [[sheet(3, 'INSTRUCT')]] });
  const source = createCoupangSource({ ...KEYS, fetchFn, minGapMs: 0, now: () => new Date('2026-10-16T03:00:00Z') });
  const orders = await source.fetchChanges({});
  assert.deepStrictEqual(orders.map(o => o.channel_order_id).sort(), ['910004186321', '910004186322', '910004186323']);
  const accept = calls.filter(c => c.query.get('status') === 'ACCEPT');
  assert.strictEqual(accept.length, 2, '다음 페이지까지');
  assert.strictEqual(accept[0].path, '/v2/providers/openapi/apis/api/v4/vendors/A00012345/ordersheets');
  assert.deepStrictEqual([accept[0].query.get('createdAtFrom'), accept[0].query.get('createdAtTo')], ['2026-09-16', '2026-10-16']);
  assert.match(accept[0].auth, /^CEA algorithm=HmacSHA256, access-key=ak-test, signed-date=\d{6}T\d{6}Z, signature=[0-9a-f]{64}$/);
  assert.ok(calls.every(c => c.method === 'GET' && isAllowed('GET', c.path)));
  assert.deepStrictEqual([...new Set(calls.map(c => c.query.get('status')))].sort(),
    ['ACCEPT', 'DELIVERING', 'DEPARTURE', 'FINAL_DELIVERY', 'INSTRUCT', 'NONE_TRACKING']);
});

test('쿠팡 주문이 카드로 들어오고, 다시 읽어도 상태가 그대로면 바뀐 주문으로 세지 않는다', async () => {
  const db = openDb(':memory:');
  const state = { ACCEPT: [[sheet(1)]] };
  const { fetchFn } = fakeCoupang(state);
  const collector = createCollector({ db, source: createCoupangSource({ ...KEYS, fetchFn, minGapMs: 0 }) });
  const first = await collector.run();
  assert.deepStrictEqual([first.ok, first.createdOrders], [true, 1]);
  const row = db.prepare("SELECT * FROM orders WHERE channel = 'coupang'").get();
  assert.strictEqual(row.channel_order_id, '910004186321');
  const again = await collector.run();
  assert.deepStrictEqual([again.created, again.updated], [0, 0]);
  // 쿠팡에서 상품준비중(발주확인)으로 바뀌면 발주확인 단계로
  state.ACCEPT = [[]];
  state.INSTRUCT = [[sheet(1, 'INSTRUCT')]];
  const third = await collector.run();
  assert.strictEqual(third.updated, 1);
  assert.strictEqual(db.prepare(
    "SELECT s.name FROM orders o JOIN work_stages s ON s.id = o.stage_id WHERE o.channel = 'coupang'"
  ).get().name, '발주확인');
});

test('채널 여러 개를 함께 수집하고, 한 채널이 실패해도 다른 채널은 들어온다', async () => {
  const db = openDb(':memory:');
  const ok = { channel: 'smartstore', label: '스마트스토어', async fetchChanges() {
    return [{ channel: 'smartstore', channel_order_id: 'O1', channel_item_id: 'P1', product_name: 'x', option_text: null, quantity: 1,
      buyer_name: null, receiver_name: null, receiver_phone: null, receiver_address: null, paid_at: null, channel_status: 'PAYED', channel_confirmed: 0 }];
  } };
  const bad = { channel: 'coupang', label: '쿠팡', async fetchChanges() { throw new Error('인증 실패'); } };
  const multi = createMultiCollector([createCollector({ db, source: ok }), createCollector({ db, source: bad })]);
  assert.strictEqual(multi.source.label, '스마트스토어 + 쿠팡');
  const r = await multi.run();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /쿠팡: 인증 실패/);
  assert.strictEqual(r.createdOrders, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  applyOrders(db, []);
});
