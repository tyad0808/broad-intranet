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
      { vendorItemId: `30000000${id}1`, sellerProductName: '명함 주문제작', sellerProductItemName: '양면 / 200매', shippingCount: 2, cancelCount: 0, holdCountForCancel: 0, salesPrice: 15000, orderPrice: 30000 },
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

test('쿠팡: 허용된 주소 3개(조회 1 + 상품준비중·송장 2)만, 상태 변경은 쓰기를 켠 클라이언트만', async () => {
  let sent = 0;
  const base = '/v2/providers/openapi/apis/api/v4/vendors/A00012345';
  const client = createCoupangClient({ ...KEYS, fetchFn: async () => { sent++; }, minGapMs: 0, allowWrite: true });
  assert.ok(isAllowed('GET', `${base}/ordersheets`));
  for (const [m, p] of [
    ['GET', `${base}/ordersheets/123`],
    ['PUT', `${base}/ordersheets/123/stop`],
    ['POST', `${base}/returnRequests`],
  ]) {
    await assert.rejects(client.request(m, p), /허용되지 않은/);
  }
  const readOnly = createCoupangClient({ ...KEYS, fetchFn: async () => { sent++; }, minGapMs: 0 });
  await assert.rejects(readOnly.request('PUT', `${base}/ordersheets/acknowledgement`, { json: {} }), /꺼져 있습니다/);
  await assert.rejects(readOnly.request('POST', `${base}/orders/invoices`, { json: {} }), /꺼져 있습니다/);
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
    channel_status: 'PAYED', channel_confirmed: 1, claim_type: null, claim_status: null, pay_amount: 30000,
  });
  assert.deepStrictEqual([normalize(sheet(1, 'ACCEPT'))[0].channel_status, normalize(sheet(1, 'ACCEPT'))[0].channel_confirmed], ['PAYED', 0]);
  assert.strictEqual(normalize(sheet(1, 'FINAL_DELIVERY'))[0].channel_status, 'DELIVERED');
  const hold = sheet(1, 'ACCEPT');
  hold.orderItems[0].holdCountForCancel = 1;
  assert.strictEqual(normalize(hold)[0].claim_status, 'CANCEL_REQUEST');
  // 취소가 끝나 출고 수량이 0 이면 (목록에 남아 있어도) 취소
  const zero = sheet(1, 'ACCEPT');
  zero.orderItems[0].shippingCount = 0;
  zero.orderItems[0].cancelCount = 2;
  assert.deepStrictEqual([normalize(zero)[0].channel_status, normalize(zero)[0].quantity], ['CANCELED', 2]);
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

// ───────── 2단계: 상품준비중 처리 · 송장 업로드 ─────────
const { createCoupangWriter, toCommonResult } = require('../src/channels/coupang');
const { createOrderActions } = require('../src/actions');
const { addUser } = require('./helpers');

function writeSetup(responses = {}) {
  const db = openDb(':memory:');
  applyOrders(db, normalize(sheet(1)));
  const userId = addUser(db, { email: 'kim@broad.test' });
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, raw: init.body, body: init.body ? JSON.parse(init.body.replace(/:(\d{15,})/g, ':"$1"')) : null });
    const key = `${init.method} ${u.pathname.split('/').slice(-2).join('/')}`;
    const make = responses[key];
    const body = make ? make(calls[calls.length - 1]) : { code: 200, data: { responseList: [] } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const writer = createCoupangWriter({ ...KEYS, fetchFn, minGapMs: 0 });
  const row = () => ({ ...db.prepare("SELECT * FROM orders WHERE channel = 'coupang'").get() });
  return { db, userId, calls, writer, row };
}

test('쿠팡 발주확인 = 상품준비중 처리: 배송번호를 숫자 그대로 보내고, 성공하면 발주확인으로 반영', async () => {
  const ok = c => ({ code: 200, data: { responseCode: 0, responseList: c.body.shipmentBoxIds.map(id => ({ shipmentBoxId: id, succeed: true })) } });
  const { db, userId, calls, writer, row } = writeSetup({ 'PUT ordersheets/acknowledgement': ok });
  const actions = createOrderActions({ db, writers: { coupang: writer } });
  assert.strictEqual(actions.modeOf('coupang'), 'live');
  assert.strictEqual(actions.modeOf('smartstore'), 'practice', '채널마다 따로');
  const r = await actions.confirm(row().id, userId);
  assert.strictEqual(r.result, 'ok');
  assert.strictEqual(calls[0].method, 'PUT');
  assert.strictEqual(calls[0].path, '/v2/providers/openapi/apis/api/v4/vendors/A00012345/ordersheets/acknowledgement');
  assert.match(calls[0].raw, /"shipmentBoxIds":\[642538970006401\]/, '긴 번호는 따옴표 없는 숫자로');
  assert.strictEqual(calls[0].body.vendorId, 'A00012345');
  assert.strictEqual(row().channel_confirmed, 1);
  const log = db.prepare('SELECT * FROM order_actions').get();
  assert.deepStrictEqual([log.channel, log.mode, log.result], ['coupang', 'live', 'ok']);
});

test('쿠팡 송장 업로드: 배송번호·주문번호·옵션번호·택배사·송장번호를 보내고, 성공하면 발송으로 반영', async () => {
  const ok = c => ({ code: 200, data: { responseList: c.body.orderSheetInvoiceApplyDtos.map(d => ({ shipmentBoxId: d.shipmentBoxId, succeed: true })) } });
  const { db, userId, calls, writer, row } = writeSetup({ 'POST orders/invoices': ok });
  db.prepare("UPDATE orders SET channel_confirmed = 1 WHERE channel = 'coupang'").run();
  const actions = createOrderActions({ db, writers: { coupang: writer } });
  const r = await actions.dispatch(row().id, userId, { method: 'DELIVERY', company: 'KGB', tracking: '123456789012' });
  assert.strictEqual(r.result, 'ok');
  assert.deepStrictEqual(calls[0].body.orderSheetInvoiceApplyDtos, [{
    shipmentBoxId: '642538970006401', orderId: 910004186321, vendorItemId: 3000000011,
    deliveryCompanyCode: 'KGB', invoiceNumber: '123456789012', splitShipping: false, preSplitShipped: false, estimatedShippingDate: '',
  }]);
  assert.match(calls[0].raw, /"orderId":910004186321,/);
  assert.deepStrictEqual([row().channel_status, row().tracking_no], ['DELIVERING', '123456789012']);
});

test('쿠팡: 실패 응답은 실패로, 모르는 응답은 확인 필요로, 퀵·직접전달은 받지 않는다', async () => {
  const fail = c => ({ code: 200, data: { responseList: c.body.shipmentBoxIds.map(id => ({ shipmentBoxId: id, succeed: false, resultMessage: '이미 처리된 주문' })) } });
  const a = writeSetup({ 'PUT ordersheets/acknowledgement': fail });
  const r1 = await createOrderActions({ db: a.db, writers: { coupang: a.writer } }).confirm(a.row().id, a.userId);
  assert.strictEqual(r1.result, 'fail');
  assert.match(r1.message, /이미 처리된 주문/);
  assert.strictEqual(a.row().channel_confirmed, 0);

  const b = writeSetup({ 'PUT ordersheets/acknowledgement': () => ({ code: 200, data: { something: 1 } }) });
  const r2 = await createOrderActions({ db: b.db, writers: { coupang: b.writer } }).confirm(b.row().id, b.userId);
  assert.strictEqual(r2.result, 'unknown');

  const c = writeSetup();
  c.db.prepare("UPDATE orders SET channel_confirmed = 1 WHERE channel = 'coupang'").run();
  const r3 = await createOrderActions({ db: c.db, writers: { coupang: c.writer } }).dispatch(c.row().id, c.userId, { method: 'QUICK_SVC', company: null, tracking: null });
  assert.strictEqual(r3.result, 'skip');
  assert.match(r3.message, /택배/);
  assert.strictEqual(c.calls.length, 0);
});

test('쿠팡 연습 모드(COUPANG_WRITE 꺼짐): 쿠팡으로 보내지 않고 기록만 남긴다', async () => {
  const { db, userId, calls, row } = writeSetup();
  const actions = createOrderActions({ db });
  const r = await actions.confirm(row().id, userId);
  assert.strictEqual(r.result, 'practice');
  assert.match(r.message, /쿠팡으로 보내지 않았습니다/);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(row().channel_confirmed, 0);
});

test('쿠팡 응답 → 공통 모양: 배송번호별 성공을 상품 번호로 바꾼다', () => {
  const body = { code: 200, data: { responseList: [{ shipmentBoxId: '11', succeed: true }, { shipmentBoxId: '22', succeed: false, resultMessage: '안 됨' }] } };
  assert.deepStrictEqual(toCommonResult(body, ['11-1', '11-2', '22-1']), {
    data: { successProductOrderIds: ['11-1', '11-2'], failProductOrderInfos: [{ productOrderId: '22', message: '안 됨' }] },
  });
});

test('쿠팡에서 취소돼 목록에서 사라진 주문은 취소로, 7일 지나 배송완료된 주문은 30일치로 다시 찾아 배송완료로', async () => {
  const db = openDb(':memory:');
  const state = { ACCEPT: [[sheet(1), sheet(2)]] };
  const { fetchFn } = fakeCoupang(state);
  // 결제 10/16, 지금 10/26: 배송중·배송완료를 7일치로 볼 때는 안 나오고 30일치로 볼 때만 나오게
  const datedFetch = async (url, init) => {
    const u = new URL(url);
    if (['DELIVERING', 'FINAL_DELIVERY', 'NONE_TRACKING'].includes(u.searchParams.get('status')) && u.searchParams.get('createdAtFrom') > '2026-10-16') {
      return new Response(JSON.stringify({ code: 200, data: [], nextToken: '' }), { status: 200 });
    }
    return fetchFn(url, init);
  };
  const now = () => new Date('2026-10-26T03:00:00Z');
  const collector = createCollector({ db, now, source: createCoupangSource({ ...KEYS, fetchFn: datedFetch, minGapMs: 0, now }) });
  await collector.run();
  assert.deepStrictEqual(db.prepare("SELECT channel_status FROM orders WHERE channel = 'coupang' ORDER BY id").all().map(r => r.channel_status), ['PAYED', 'PAYED']);

  // 1번은 쿠팡에서 취소(목록에서 사라짐), 2번은 배송완료
  state.ACCEPT = [[]];
  state.FINAL_DELIVERY = [[sheet(2, 'FINAL_DELIVERY')]];
  await collector.run();
  const rows = db.prepare("SELECT channel_order_id, channel_status, channel_status_label FROM orders WHERE channel = 'coupang' ORDER BY id").all();
  assert.deepStrictEqual(rows.map(r => [r.channel_status, r.channel_status_label]), [['CANCELED', '쿠팡에서 취소됨'], ['DELIVERED', null]]);

  // 쿠팡에 잠깐 연결이 안 되면 취소로 바꾸지 않는다
  db.prepare("UPDATE orders SET channel_status = 'PAYED', channel_status_label = NULL WHERE channel = 'coupang'").run();
  let fail = false;
  const flaky = async (url, init) => (fail && ['DELIVERING', 'FINAL_DELIVERY', 'NONE_TRACKING'].includes(new URL(url).searchParams.get('status')) && new URL(url).searchParams.get('createdAtFrom') < '2026-10-16'
    ? new Response('oops', { status: 500 }) : datedFetch(url, init));
  state.FINAL_DELIVERY = [[]];
  fail = true;
  await createCollector({ db, now, source: createCoupangSource({ ...KEYS, fetchFn: flaky, minGapMs: 0, now }) }).run();
  assert.deepStrictEqual(db.prepare("SELECT channel_status FROM orders WHERE channel = 'coupang'").all().map(r => r.channel_status), ['PAYED', 'PAYED']);
});
