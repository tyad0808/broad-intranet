// 3차: 자사몰(고도몰 구조 기반의 자체 쇼핑몰) 주문 가져오기 + 발주확인·송장 등록
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createGodoSource, createGodoClient, normalize, mapStatus, isAllowed } = require('../src/channels/godo');
const { createCollector } = require('../src/collector');

function mallOrder(no, status = 'p1', extra = {}) {
  return {
    orderNo: `251017123456${no}`, status, statusName: '결제완료',
    orderedAt: '2026-10-17 10:00:00', paidAt: '2026-10-17 10:01:00', modifiedAt: '2026-10-17 10:01:00',
    settleKind: 'gb', settleKindName: '무통장', bankSender: '홍길동', settlePrice: 55000,
    orderer: { name: '홍길동', email: 'a@b.c', phone: '', cellPhone: '010-1111-2222' },
    receiver: { name: '김수령', phone: '', cellPhone: '010-3333-4444', zipcode: '06236', address: '서울 강남구 테헤란로 1', addressDetail: '2층' },
    items: [
      { itemNo: 1, type: 'goods', status, goodsNo: 1000701702, name: '포맥스 안내판', option: '3T', textOption: '문구: 화장실', sizeW: 300, sizeH: 150, quantity: 2, amount: 24000, discount: 1000 },
      { itemNo: 2, type: 'addGoods', parentGoodsNo: 1000701702, status, goodsNo: 1000000001, name: '양면테이프', option: '', textOption: '', quantity: 1 },
    ],
    ...extra,
  };
}

function fakeMall(orders) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, auth: init.headers.authorization, method: init.method });
    const page = Number(u.searchParams.get('page'));
    const size = Number(u.searchParams.get('size'));
    const items = orders.slice((page - 1) * size, page * size);
    // 실제처럼 주문번호는 따옴표 없는 숫자로
    const text = JSON.stringify({ total: orders.length, page, size, items }).replace(/"orderNo":"(\d+)"/g, '"orderNo":$1');
    return new Response(text, { status: 200 });
  };
  return { fetchFn, calls };
}

test('자사몰 주문 → 인트라넷 주문: 추가상품은 묶음 안 추가상품으로, 사이즈·문구는 옵션에', () => {
  const [main, addon] = normalize(mallOrder(1));
  assert.deepStrictEqual(main, {
    channel: 'godo', channel_order_id: '2510171234561', channel_item_id: '2510171234561-1',
    product_name: '포맥스 안내판', item_type: 'main', option_text: '3T / 문구: 화장실 / 300x150mm', quantity: 2,
    buyer_name: '홍길동', receiver_name: '김수령', receiver_phone: '010-3333-4444',
    receiver_address: '(06236) 서울 강남구 테헤란로 1 2층', paid_at: '2026-10-17T10:01:00+09:00',
    channel_status: 'PAYED', channel_confirmed: 0, claim_type: null, claim_status: null, channel_status_label: '결제완료',
    pay_amount: 23000,
  });
  assert.strictEqual(addon.item_type, 'addon');
  assert.strictEqual(addon.channel_order_id, main.channel_order_id);
});

test('자사몰 주문상태 코드를 공통 상태로 맞춘다', () => {
  const s = code => { const m = mapStatus(code, false); return [m.status, m.confirmed, m.claimStatus]; };
  assert.deepStrictEqual(s('o1'), ['PAYMENT_WAITING', 0, null]);
  assert.deepStrictEqual(s('p1'), ['PAYED', 0, null]);
  assert.deepStrictEqual(s('g1'), ['PAYED', 1, null]);
  assert.deepStrictEqual(s('g4'), ['DELIVERING', 1, null]);
  assert.deepStrictEqual(s('d2'), ['DELIVERED', 1, null]);
  assert.deepStrictEqual(s('c3'), ['CANCELED', 1, null]);
  assert.deepStrictEqual(s('c4'), ['PAYED', 1, 'CANCEL_REQUEST']);
  assert.deepStrictEqual(s('r1'), ['CANCELED', 1, null], '환불접수 = 취소 받아준 뒤 → 끝난 주문');
  assert.deepStrictEqual(mapStatus('c4', false, { stale: true }).status, 'CANCELED', '오래 묵은 고객취소요청은 취소로');
  assert.deepStrictEqual(s('b1'), ['PAYED', 1, 'RETURN_REQUEST']);
  assert.deepStrictEqual(mapStatus('b1', true).status, 'DELIVERED');
  assert.deepStrictEqual(s('e5'), ['EXCHANGED', 1, 'EXCHANGE_DONE']);
});

test('자사몰 API: 주문 목록 조회만 부를 수 있고, 키가 없으면 보내지 않는다', async () => {
  assert.ok(isAllowed('GET', '/orders'));
  assert.ok(!isAllowed('GET', '/products'));
  assert.ok(!isAllowed('POST', '/orders'));
  let sent = 0;
  const client = createGodoClient({ apiKey: 'k', fetchFn: async () => { sent++; } });
  await assert.rejects(client.request('GET', '/products'), /허용되지 않은/);
  await assert.rejects(createGodoClient({ apiKey: '', fetchFn: async () => { sent++; } }).request('GET', '/orders'), /GODO_API_KEY/);
  assert.strictEqual(sent, 0);
});

test('자사몰 수집: 바뀐 날짜 기준으로 페이지를 넘겨 읽고, 입금대기는 카드로 만들지 않는다', async () => {
  const db = openDb(':memory:');
  const orders = [];
  for (let i = 0; i < 101; i++) orders.push(mallOrder(String(i).padStart(3, '0')));
  orders.push(mallOrder('999', 'o1'));
  const { fetchFn, calls } = fakeMall(orders);
  const source = createGodoSource({ apiKey: 'test-key', baseUrl: 'http://127.0.0.1:3100/mall-api/v1', fetchFn, now: () => new Date('2026-10-17T03:00:00Z') });
  const collector = createCollector({ db, source, now: () => new Date('2026-10-17T03:00:00Z') });
  const r = await collector.run();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.createdOrders, 101, '입금대기 1건은 빠진다');
  assert.strictEqual(calls.length, 2, '100건씩 두 페이지');
  assert.strictEqual(calls[0].url.pathname, '/mall-api/v1/orders');
  assert.strictEqual(calls[0].url.searchParams.get('dateType'), 'modified');
  assert.strictEqual(calls[0].url.searchParams.get('to'), '2026-10-17');
  assert.strictEqual(calls[0].auth, 'Bearer test-key');
  assert.strictEqual(db.prepare("SELECT channel_order_id FROM orders WHERE channel = 'godo' ORDER BY id LIMIT 1").get().channel_order_id, '251017123456000');

  const again = await collector.run();
  assert.deepStrictEqual([again.created, again.updated], [0, 0], '그대로인 주문은 바뀐 주문으로 세지 않는다');
});

test('고도몰 내부 형식 옵션을 "옵션명: 선택값" 으로 풀어서 보여준다', () => {
  const { formatOption } = require('../src/channels/godo');
  assert.strictEqual(formatOption('[[\\"포맥스 선택\\",\\"백색 포맥스 3T\\",\\"\\",\\"\\",400,null]]'), '포맥스 선택: 백색 포맥스 3T');
  assert.strictEqual(formatOption('[["재단 선택","모양재단","",2000,"미사용"]]'), '재단 선택: 모양재단');
  assert.strictEqual(formatOption('[["포맥스","5T","","",0,null],["코팅","무광","","",0,null]]'), '포맥스: 5T / 코팅: 무광');
  assert.strictEqual(formatOption('일반 옵션'), '일반 옵션');
  assert.strictEqual(formatOption(''), null);
  const [o] = normalize(mallOrder(1, 'p1', { items: [{ itemNo: 1, type: 'goods', status: 'c4', statusName: '고객취소요청', name: 'x', option: '[["포맥스 선택","백색 3T","","",0,null]]', sizeW: 420, sizeH: 594, quantity: 8 }] }));
  assert.strictEqual(o.option_text, '포맥스 선택: 백색 3T / 420x594mm');
  assert.strictEqual(o.channel_status_label, '고객취소요청', '자사몰 상태 이름을 그대로 남긴다');
});

test('옵션 표시가 바뀌면 다시 읽을 때 기존 주문의 옵션도 고쳐진다', async () => {
  const db = openDb(':memory:');
  const raw = mallOrder(1);
  raw.items[0].option = '[["포맥스 선택","백색 3T","","",0,null]]';
  const { fetchFn } = fakeMall([raw]);
  const source = createGodoSource({ apiKey: 'k', fetchFn });
  const collector = createCollector({ db, source });
  db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, option_text, channel_status, channel_confirmed) VALUES ('godo', '2510171234561', '2510171234561-1', '포맥스 안내판', '[[옛날 형식]]', 'PAYED', 0)").run();
  await collector.run();
  assert.match(db.prepare("SELECT option_text FROM orders WHERE channel_item_id = '2510171234561-1'").get().option_text, /^포맥스 선택: 백색 3T/);
});

test('고객취소요청: 최근 14일 안이면 취소 요청 표시, 오래된 건 취소로 본다', () => {
  const now = new Date('2026-10-17T03:00:00Z');
  const req = (modifiedAt) => normalize(mallOrder(1, 'c4', { modifiedAt, items: [{ itemNo: 1, type: 'goods', status: 'c4', name: 'x', quantity: 1 }] }), now)[0];
  assert.deepStrictEqual([req('2026-10-15 10:00:00').channel_status, req('2026-10-15 10:00:00').claim_status], ['PAYED', 'CANCEL_REQUEST']);
  assert.deepStrictEqual([req('2026-09-14 13:43:00').channel_status, req('2026-09-14 13:43:00').claim_status], ['CANCELED', null]);
});

test('자사몰 관리자에서 삭제된 주문은 다음 수집 때 "자사몰에서 삭제됨" 으로 끝난 주문이 된다', async () => {
  const db = openDb(':memory:');
  let list = [mallOrder(1), mallOrder(2)];
  const single = new Set(['2510171234562']); // 2번은 한 건 조회로는 있음 (목록 기간 밖으로 밀려난 경우)
  const asked = [];
  const fetchFn = async url => {
    const u = new URL(url);
    const m = u.pathname.match(/\/orders\/(\d+)$/);
    if (m) {
      asked.push(m[1]);
      const found = mallOrder(2, 'g1');
      return single.has(m[1])
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response(JSON.stringify({ code: 'NOT_FOUND', message: '없는 주문' }), { status: 404 });
    }
    return new Response(JSON.stringify({ total: list.length, page: 1, size: 100, items: list }), { status: 200 });
  };
  const collector = createCollector({ db, source: createGodoSource({ apiKey: 'k', fetchFn }) });
  await collector.run();
  assert.strictEqual(db.prepare("SELECT COUNT(DISTINCT channel_order_id) AS n FROM orders WHERE channel = 'godo'").get().n, 2);

  list = []; // 1번은 삭제됨, 2번은 목록에서만 빠짐
  const r = await collector.run();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(asked.sort(), ['2510171234561', '2510171234562']);
  const row = no => db.prepare("SELECT channel_status, channel_status_label, channel_confirmed FROM orders WHERE channel_order_id = ? AND item_type = 'main'").get(no);
  assert.deepStrictEqual({ ...row('2510171234561') }, { channel_status: 'CANCELED', channel_status_label: '자사몰에서 삭제됨', channel_confirmed: 0 });
  assert.deepStrictEqual([row('2510171234562').channel_status, row('2510171234562').channel_confirmed], ['PAYED', 1], '있는 주문은 최신 상태로');

  asked.length = 0;
  await collector.run();
  assert.deepStrictEqual(asked, ['2510171234562'], '끝난 주문(삭제됨)은 다시 묻지 않는다');
});

// ───────── 발주확인 · 송장 등록 (자사몰 API orders:write) ─────────
const { createGodoWriter } = require('../src/channels/godo');
const { applyOrders } = require('../src/collector');
const { createOrderActions } = require('../src/actions');
const { addUser } = require('./helpers');

function writeSetup(reply = body => ({ results: body.itemNos.map(itemNo => ({ itemNo, ok: true, message: '' })) }), status = 200) {
  const db = openDb(':memory:');
  applyOrders(db, normalize(mallOrder(1)));
  const userId = addUser(db, { email: 'kim@broad.test' });
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: new URL(url).pathname, method: init.method, auth: init.headers.authorization, body });
    return new Response(JSON.stringify(reply(body)), { status });
  };
  const writer = createGodoWriter({ apiKey: 'read-key', writeKey: 'write-key', fetchFn });
  const rows = () => db.prepare("SELECT * FROM orders WHERE channel = 'godo' ORDER BY id").all().map(r => ({ ...r }));
  return { db, userId, calls, writer, rows, actions: createOrderActions({ db, writers: { godo: writer } }) };
}

test('자사몰 발주확인: 처리용 키로 주문번호·주문상품번호를 보내고, 성공하면 발주확인(상품준비중)으로 반영', async () => {
  const { db, userId, calls, rows, actions } = writeSetup();
  assert.strictEqual(actions.modeOf('godo'), 'live');
  const r = await actions.confirm(rows()[0].id, userId);
  assert.strictEqual(r.result, 'ok');
  assert.deepStrictEqual(calls.map(c => [c.method, c.path, c.auth]), [['POST', '/mall-api/v1/orders/2510171234561/confirm', 'Bearer write-key']]);
  assert.deepStrictEqual(calls[0].body, { itemNos: ['1', '2'] }, '추가상품도 함께');
  assert.deepStrictEqual(rows().map(r => r.channel_confirmed), [1, 1]);
  const log = db.prepare('SELECT * FROM order_actions').get();
  assert.deepStrictEqual([log.channel, log.mode, log.result], ['godo', 'live', 'ok']);
});

test('자사몰 송장 등록: 택배는 택배사 이름·송장번호, 퀵·직접전달은 method 로 보내고 배송중으로 반영', async () => {
  const a = writeSetup();
  a.db.prepare("UPDATE orders SET channel_confirmed = 1 WHERE channel = 'godo'").run();
  const r = await a.actions.dispatch(a.rows()[0].id, a.userId, { method: 'DELIVERY', company: 'KGB', tracking: '123456789012' });
  assert.strictEqual(r.result, 'ok');
  assert.strictEqual(a.calls[0].path, '/mall-api/v1/orders/2510171234561/invoice');
  assert.deepStrictEqual(a.calls[0].body, { itemNos: ['1', '2'], courier: '로젠택배', invoiceNo: '123456789012' });
  assert.deepStrictEqual(a.rows().map(r => [r.channel_status, r.tracking_no]), [['DELIVERING', '123456789012'], ['DELIVERING', '123456789012']]);

  const b = writeSetup();
  b.db.prepare("UPDATE orders SET channel_confirmed = 1 WHERE channel = 'godo'").run();
  await b.actions.dispatch(b.rows()[0].id, b.userId, { method: 'QUICK_SVC', company: null, tracking: null });
  assert.deepStrictEqual(b.calls[0].body, { itemNos: ['1', '2'], method: 'quick' });
  const c = writeSetup();
  c.db.prepare("UPDATE orders SET channel_confirmed = 1 WHERE channel = 'godo'").run();
  await c.actions.dispatch(c.rows()[0].id, c.userId, { method: 'DIRECT_DELIVERY', company: null, tracking: null });
  assert.deepStrictEqual(c.calls[0].body, { itemNos: ['1', '2'], method: 'direct' });
});

test('자사몰 처리 결과: 일부 실패는 일부만 반영, 모르는 응답·서버 오류는 확인 필요, 거절은 실패', async () => {
  const part = writeSetup(body => ({ results: [{ itemNo: body.itemNos[0], ok: true }, { itemNo: body.itemNos[1], ok: false, message: '취소된 상품' }] }));
  const r1 = await part.actions.confirm(part.rows()[0].id, part.userId);
  assert.strictEqual(r1.result, 'partial');
  assert.match(r1.message, /취소된 상품/);
  assert.deepStrictEqual(part.rows().map(r => r.channel_confirmed), [1, 0]);

  const odd = writeSetup(() => ({ something: 1 }));
  const r2 = await odd.actions.confirm(odd.rows()[0].id, odd.userId);
  assert.strictEqual(r2.result, 'unknown');
  assert.match(r2.message, /자사몰 관리자에서 처리됐는지/);

  const down = writeSetup(() => ({ code: 'MALL_UNREACHABLE', message: '쇼핑몰 서버에 연결하지 못했습니다' }), 502);
  assert.strictEqual((await down.actions.confirm(down.rows()[0].id, down.userId)).result, 'unknown');

  const denied = writeSetup(() => ({ code: 'FORBIDDEN', message: '권한이 없습니다' }), 403);
  const r4 = await denied.actions.confirm(denied.rows()[0].id, denied.userId);
  assert.strictEqual(r4.result, 'fail');
  assert.match(r4.message, /권한이 없습니다/);

  const unset = writeSetup(() => ({ code: 'NOT_CONFIGURED', message: '주문 처리 설정이 없습니다' }), 503);
  assert.strictEqual((await unset.actions.confirm(unset.rows()[0].id, unset.userId)).result, 'fail', '자사몰로 넘어가지 않은 게 확실하면 실패');
  assert.deepStrictEqual(unset.rows().map(r => r.channel_confirmed), [0, 0]);
});

test('자사몰 연습 모드(GODO_WRITE 꺼짐)와 안전장치: 보내지 않고, 처리 주소는 처리용 키 + allowWrite 일 때만', async () => {
  const { db, userId, calls, rows } = writeSetup();
  const r = await createOrderActions({ db }).confirm(rows()[0].id, userId);
  assert.strictEqual(r.result, 'practice');
  assert.match(r.message, /자사몰로 보내지 않았습니다/);
  assert.strictEqual(calls.length, 0);

  let sent = 0;
  const fetchFn = async () => { sent++; return new Response('{}'); };
  await assert.rejects(createGodoClient({ apiKey: 'k', writeKey: 'w', fetchFn }).request('POST', '/orders/1/confirm', { json: {} }), /GODO_WRITE=on/);
  await assert.rejects(createGodoClient({ apiKey: 'k', writeKey: '', fetchFn, allowWrite: true }).request('POST', '/orders/1/confirm', { json: {} }), /GODO_WRITE_KEY/);
  await assert.rejects(createGodoClient({ apiKey: 'k', writeKey: 'w', fetchFn, allowWrite: true }).request('POST', '/orders/1/cancel', { json: {} }), /허용되지 않은/);
  assert.strictEqual(sent, 0);
});

test('자사몰 주문 카드에 발주확인·송장 버튼이 나오고, 목록에서 체크해 일괄 처리할 수 있다', async t => {
  const { startServer, loginAs } = require('./helpers');
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  applyOrders(ctx.db, normalize(mallOrder(1)));
  addUser(ctx.db, { email: 'kim@broad.test' });
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const id = ctx.db.prepare("SELECT id FROM orders WHERE channel = 'godo' ORDER BY id").get().id;
  const detail = (await kim.request(`/orders/${id}`)).text;
  assert.match(detail, /자사몰 처리/);
  assert.match(detail, /발주확인 \(상품준비중\) 보내기/);
  assert.match(detail, /버튼을 눌러도 자사몰로 보내지 않고/, '기본은 연습 모드');
  const list = (await kim.request('/')).text;
  assert.match(list, new RegExp(`value="${id}" form="bulk-form"`));

  const res = await kim.submit(`/orders/${id}`, `/orders/${id}/confirm`, {});
  assert.strictEqual(res.status, 302);
  const log = ctx.db.prepare('SELECT * FROM order_actions').get();
  assert.deepStrictEqual([log.channel, log.result], ['godo', 'practice']);
});
