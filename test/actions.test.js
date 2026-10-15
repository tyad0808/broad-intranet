// 2차: 스마트스토어 발주확인·발송처리
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { applyOrders } = require('../src/collector');
const { createOrderActions, checkDispatchInput } = require('../src/actions');
const { createSmartstoreWriter } = require('../src/channels/smartstore');
const { createNaverClient } = require('../src/channels/naverClient');
const { createNotifier } = require('../src/notifier');
const { startServer, addUser, loginAs } = require('./helpers');

function order(id, extra = {}) {
  return {
    channel: 'smartstore', channel_order_id: `O${id}`, channel_item_id: `P${id}`, product_name: `상품${id}`,
    option_text: null, quantity: 1, buyer_name: '구매자', receiver_name: `수령${id}`, receiver_phone: null,
    receiver_address: '서울', paid_at: `2026-10-1${id}T01:00:00.000Z`, channel_status: 'PAYED', channel_confirmed: 0, ...extra,
  };
}

// 네이버 대신 응답하는 가짜 writer. 받은 요청을 calls 에 남긴다.
function fakeWriter({ confirm, dispatch } = {}) {
  const calls = [];
  const ok = ids => ({ data: { successProductOrderIds: ids, failProductOrderInfos: [] } });
  return {
    calls,
    async confirm(ids) {
      calls.push({ type: 'confirm', ids });
      return confirm ? confirm(ids) : ok(ids);
    },
    async dispatch(list) {
      calls.push({ type: 'dispatch', list });
      return dispatch ? dispatch(list) : ok(list.map(l => l.productOrderId));
    },
  };
}

function setupDb() {
  const db = openDb(':memory:');
  // O1: 본상품 P1 + 추가상품 P9, O2: 본상품 P2
  applyOrders(db, [
    order(1), order(9, { channel_order_id: 'O1', item_type: 'addon', product_name: '양면테이프' }), order(2),
  ]);
  const row = item => ({ ...db.prepare('SELECT * FROM orders WHERE channel_item_id = ?').get(item) });
  const idOf = item => row(item).id;
  const stageName = item => db.prepare(
    'SELECT s.name FROM orders o JOIN work_stages s ON s.id = o.stage_id WHERE o.channel_item_id = ?'
  ).get(item).name;
  const logs = () => db.prepare('SELECT * FROM order_actions ORDER BY id').all().map(r => ({ ...r }));
  const userId = addUser(db, { email: 'kim@broad.test', name: '김직원' });
  return { db, row, idOf, stageName, logs, userId };
}

const SHIP = { method: 'DELIVERY', company: 'KGB', tracking: '123456789012' };

// ───────── 처리 모듈 ─────────

test('연습 모드에서는 네이버로 보내지 않고, 주문도 바꾸지 않고, 기록만 남긴다', async () => {
  const { db, row, idOf, logs, userId } = setupDb();
  const actions = createOrderActions({ db });
  assert.strictEqual(actions.mode, 'practice');
  const r = await actions.confirm(idOf('P1'), userId);
  assert.strictEqual(r.result, 'practice');
  assert.strictEqual(row('P1').channel_confirmed, 0);
  assert.strictEqual(row('P1').version, 0);
  const [log] = logs();
  assert.deepStrictEqual([log.action, log.mode, log.result, log.user_id], ['confirm', 'practice', 'practice', userId]);
  assert.deepStrictEqual(JSON.parse(log.item_ids), ['P1', 'P9']);
});

test('발주확인: 묶음의 상품을 함께 보내고, 성공하면 발주확인 단계로 옮기고 기록한다', async () => {
  const { db, row, idOf, stageName, logs, userId } = setupDb();
  const writer = fakeWriter();
  const actions = createOrderActions({ db, writer });
  const r = await actions.confirm(idOf('P9'), userId); // 추가상품 번호로 불러도 묶음 전체
  assert.strictEqual(r.result, 'ok');
  assert.deepStrictEqual(writer.calls, [{ type: 'confirm', ids: ['P1', 'P9'] }]);
  assert.deepStrictEqual([row('P1').channel_confirmed, row('P9').channel_confirmed], [1, 1]);
  assert.deepStrictEqual([stageName('P1'), stageName('P9')], ['발주확인', '발주확인']);
  assert.strictEqual(row('P1').version, 1, '카드를 열어 둔 직원이 옛 단계로 덮어쓰지 않게 version 을 올린다');
  assert.strictEqual(row('P2').channel_confirmed, 0, '다른 주문은 그대로');
  assert.deepStrictEqual(logs().map(l => [l.mode, l.result]), [['live', 'ok']]);
});

test('이미 발주확인됐거나 취소 요청 중인 상품은 보내지 않는다', async () => {
  const { db, idOf, userId } = setupDb();
  applyOrders(db, [order(9, { channel_order_id: 'O1', item_type: 'addon', claim_type: 'CANCEL', claim_status: 'CANCEL_REQUEST' })]);
  applyOrders(db, [order(2, { channel_confirmed: 1 })]);
  const writer = fakeWriter();
  const actions = createOrderActions({ db, writer });
  await actions.confirm(idOf('P1'), userId);
  assert.deepStrictEqual(writer.calls[0].ids, ['P1']);
  const r = await actions.confirm(idOf('P2'), userId);
  assert.strictEqual(r.result, 'skip');
  assert.strictEqual(writer.calls.length, 1);
});

test('일부만 성공하면 성공한 상품만 반영하고 일부 완료로 기록한다', async () => {
  const { db, row, idOf, logs, userId } = setupDb();
  const writer = fakeWriter({
    confirm: () => ({ data: { successProductOrderIds: ['P1'], failProductOrderInfos: [{ productOrderId: 'P9', message: '처리할 수 없는 상태' }] } }),
  });
  const r = await createOrderActions({ db, writer }).confirm(idOf('P1'), userId);
  assert.strictEqual(r.result, 'partial');
  assert.match(r.message, /처리할 수 없는 상태/);
  assert.deepStrictEqual([row('P1').channel_confirmed, row('P9').channel_confirmed], [1, 0]);
  assert.strictEqual(logs()[0].result, 'partial');
});

test('네이버가 거절하면 실패, 응답이 끊기거나 이상하면 "확인 필요" 로 남기고 주문은 바꾸지 않는다', async () => {
  const cases = [
    [() => { const e = new Error('잘못된 요청'); e.status = 400; throw e; }, 'fail'],
    [() => { throw new TypeError('fetch failed'); }, 'unknown'],
    [() => ({ something: 'else' }), 'unknown'],
    [() => { const e = new Error('server'); e.status = 503; throw e; }, 'unknown'],
  ];
  for (const [confirm, expected] of cases) {
    const { db, row, idOf, logs, userId } = setupDb();
    const r = await createOrderActions({ db, writer: fakeWriter({ confirm }) }).confirm(idOf('P1'), userId);
    assert.strictEqual(r.result, expected);
    assert.strictEqual(row('P1').channel_confirmed, 0);
    assert.strictEqual(row('P1').version, 0);
    assert.strictEqual(logs()[0].result, expected);
  }
});

test('발주확인 응답의 성공 목록(successProductOrderInfos)을 읽는다', async () => {
  const { db, row, idOf, userId } = setupDb();
  const writer = fakeWriter({
    confirm: ids => ({ data: { successProductOrderInfos: ids.map(id => ({ productOrderId: id, isReceiverAddressChanged: false })), failProductOrderInfos: [] } }),
  });
  const r = await createOrderActions({ db, writer }).confirm(idOf('P1'), userId);
  assert.strictEqual(r.result, 'ok');
  assert.strictEqual(row('P1').channel_confirmed, 1);
});

test('성공도 실패도 없는 응답은 실패가 아니라 "확인 필요" 로, 응답 내용과 함께 남긴다', async () => {
  const { db, row, idOf, logs, userId } = setupDb();
  const writer = fakeWriter({ confirm: () => ({ data: { failProductOrderInfos: [], somethingNew: [1] } }) });
  const r = await createOrderActions({ db, writer }).confirm(idOf('P1'), userId);
  assert.strictEqual(r.result, 'unknown');
  assert.match(logs()[0].message, /somethingNew/);
  assert.strictEqual(row('P1').channel_confirmed, 0);
});

test('같은 주문을 연달아 두 번 눌러도 네이버에는 한 번만 보낸다', async () => {
  const { db, idOf, userId } = setupDb();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writer = fakeWriter({ confirm: async ids => { await gate; return { data: { successProductOrderIds: ids } }; } });
  const actions = createOrderActions({ db, writer });
  const first = actions.confirm(idOf('P1'), userId);
  const second = await actions.confirm(idOf('P1'), userId);
  release();
  assert.strictEqual(second.result, 'skip');
  assert.strictEqual((await first).result, 'ok');
  assert.strictEqual(writer.calls.length, 1);
});

test('발송처리는 발주확인 뒤에만 되고, 성공하면 송장을 저장하고 마지막 단계로 옮긴다', async () => {
  const { db, row, idOf, stageName, logs, userId } = setupDb();
  const writer = fakeWriter();
  const actions = createOrderActions({ db, writer, now: () => new Date('2026-10-15T01:00:00Z') });
  assert.strictEqual((await actions.dispatch(idOf('P1'), userId, SHIP)).result, 'skip', '발주확인 전');
  assert.strictEqual(writer.calls.length, 0);

  await actions.confirm(idOf('P1'), userId);
  const r = await actions.dispatch(idOf('P1'), userId, SHIP);
  assert.strictEqual(r.result, 'ok');
  assert.deepStrictEqual(writer.calls[1].list[0], {
    productOrderId: 'P1', deliveryMethod: 'DELIVERY', deliveryCompanyCode: 'KGB', trackingNumber: '123456789012',
    dispatchDate: '2026-10-15T10:00:00.000+09:00',
  });
  assert.strictEqual(writer.calls[1].list.length, 2, '추가상품도 같은 송장으로');
  const p1 = row('P1');
  assert.deepStrictEqual([p1.ship_method, p1.ship_company, p1.tracking_no, p1.channel_status], ['DELIVERY', 'KGB', '123456789012', 'DELIVERING']);
  assert.ok(p1.shipped_at);
  assert.strictEqual(stageName('P1'), '발송');
  assert.deepStrictEqual(JSON.parse(logs()[1].detail), SHIP);
});

test('퀵·직접전달은 택배사와 송장번호 없이 보낸다', async () => {
  const { db, idOf, userId } = setupDb();
  applyOrders(db, [order(2, { channel_confirmed: 1 })]);
  const writer = fakeWriter();
  await createOrderActions({ db, writer }).dispatch(idOf('P2'), userId, { method: 'QUICK_SVC', company: null, tracking: null });
  const sent = writer.calls[0].list[0];
  assert.strictEqual(sent.deliveryMethod, 'QUICK_SVC');
  assert.ok(!('deliveryCompanyCode' in sent) && !('trackingNumber' in sent));
});

test('배송 정보 검사: 택배는 택배사와 송장번호가 필요하다', () => {
  assert.ok(checkDispatchInput({ method: 'DELIVERY', company: 'KGB', tracking: '' }).error);
  assert.ok(checkDispatchInput({ method: 'DELIVERY', company: 'CJGLS', tracking: '1234567890' }).error, '목록에 없는 택배사');
  assert.ok(checkDispatchInput({ method: 'POST', company: 'KGB', tracking: '1234567890' }).error);
  assert.deepStrictEqual(checkDispatchInput({ method: 'DELIVERY', company: 'KDEXP', tracking: ' 1234-5678-90 ' }),
    { method: 'DELIVERY', company: 'KDEXP', tracking: '1234567890' });
  assert.deepStrictEqual(checkDispatchInput({ method: 'DIRECT_DELIVERY', company: 'KGB', tracking: 'x' }),
    { method: 'DIRECT_DELIVERY', company: null, tracking: null });
});

test('실제 writer 는 허용된 주소 2개로 네이버 형식에 맞춰 보낸다', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname.replace('/external', '');
    calls.push({ path, method: init.method, body: init.body });
    if (path === '/v1/oauth2/token') return Response.json({ access_token: 'tok', expires_in: 10800 });
    return Response.json({ data: { successProductOrderIds: ['P1'], failProductOrderInfos: [] } });
  };
  const writer = createSmartstoreWriter({ clientId: 'id', clientSecret: '$2a$04$abcdefghijklmnopqrstuu', fetchFn });
  await writer.confirm(['P1']);
  await writer.dispatch([{ productOrderId: 'P1', deliveryMethod: 'DELIVERY' }]);
  const sent = calls.filter(c => c.path !== '/v1/oauth2/token');
  assert.deepStrictEqual(sent.map(c => [c.method, c.path, JSON.parse(c.body)]), [
    ['POST', '/v1/pay-order/seller/product-orders/confirm', { productOrderIds: ['P1'] }],
    ['POST', '/v1/pay-order/seller/product-orders/dispatch', { dispatchProductOrders: [{ productOrderId: 'P1', deliveryMethod: 'DELIVERY' }] }],
  ]);
});

test('쓰기를 켜지 않은 클라이언트로 만든 writer 는 아무것도 보내지 못한다', async () => {
  let sent = 0;
  const client = createNaverClient({ clientId: 'id', clientSecret: '$2a$04$abcdefghijklmnopqrstuu', fetchFn: async () => { sent++; } });
  const writer = createSmartstoreWriter({ client });
  await assert.rejects(writer.confirm(['P1']), /꺼져 있습니다/);
  assert.strictEqual(sent, 0);
});

// ───────── 화면 ─────────

async function setupServer(t, { writer = null } = {}) {
  const ctx = setupDb();
  const notifier = createNotifier({ db: ctx.db });
  const actions = createOrderActions({ db: ctx.db, writer });
  const server = await startServer({ db: ctx.db, actions, notifier });
  t.after(() => server.server.close());
  ctx.baseUrl = server.baseUrl;
  ctx.kim = await loginAs(server.baseUrl, 'kim@broad.test');
  return ctx;
}

test('주문 카드: 연습 모드 안내와 발주확인 버튼(확인창 포함)이 보이고, 누르면 처리 기록이 남는다', async t => {
  const { kim, idOf, logs, userId } = await setupServer(t);
  const id = idOf('P1');
  const page = await kim.request(`/orders/${id}`);
  assert.match(page.text, /연습 모드/);
  assert.match(page.text, new RegExp(`action="/orders/${id}/confirm" data-once\\s+data-confirm="`));
  assert.doesNotMatch(page.text, /발송처리 보내기/, '발주확인 전에는 송장 칸이 없다');

  const res = await kim.submit(`/orders/${id}`, `/orders/${id}/confirm`, {});
  assert.strictEqual(res.location, `/orders/${id}`);
  assert.strictEqual(logs()[0].user_id, userId);
  const after = await kim.request(`/orders/${id}`);
  assert.match(after.text, /발주확인 연습/);
  assert.match(after.text, /처리 기록/);
});

test('주문 카드: 발주확인 뒤에는 송장 입력 칸이 나오고 발송처리할 수 있다', async t => {
  const { kim, idOf, row } = await setupServer(t, { writer: fakeWriter() });
  const id = idOf('P1');
  await kim.submit(`/orders/${id}`, `/orders/${id}/confirm`, {});
  const page = await kim.request(`/orders/${id}`);
  assert.match(page.text, /발송처리 보내기/);
  assert.match(page.text, /로젠택배/);
  assert.match(page.text, /경동택배/);

  const bad = await kim.submit(`/orders/${id}`, `/orders/${id}/dispatch`, { method: 'DELIVERY', company: 'KGB', tracking: '' });
  assert.strictEqual(bad.status, 302);
  assert.strictEqual(row('P1').shipped_at, null);

  await kim.submit(`/orders/${id}`, `/orders/${id}/dispatch`, { method: 'DELIVERY', company: 'KDEXP', tracking: '5555-6666-7777' });
  assert.deepStrictEqual([row('P1').ship_company, row('P1').tracking_no], ['KDEXP', '555566667777']);
  const done = await kim.request(`/orders/${id}`);
  assert.match(done.text, /경동택배 555566667777/);
});

test('CSRF 토큰 없이 발주확인을 보내면 막힌다', async t => {
  const { kim, idOf, logs } = await setupServer(t, { writer: fakeWriter() });
  const res = await kim.request(`/orders/${idOf('P1')}/confirm`, { method: 'POST', form: {} });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(logs().length, 0);
});

test('목록: 처리할 수 있는 주문에 체크박스가 있고, 체크한 주문을 일괄 발주확인한다', async t => {
  const { kim, idOf, row } = await setupServer(t, { writer: fakeWriter() });
  const list = await kim.request('/');
  assert.match(list.text, new RegExp(`name="ids" value="${idOf('P1')}" form="bulk-form"`));
  assert.match(list.text, /data-bulk-kind="confirm"/);
  assert.match(list.text, /data-can="confirm"/);
  const res = await kim.submit('/', '/orders/bulk/confirm', { ids: [String(idOf('P1')), String(idOf('P2'))], back: '/' });
  assert.strictEqual(res.location, '/');
  assert.deepStrictEqual([row('P1').channel_confirmed, row('P9').channel_confirmed, row('P2').channel_confirmed], [1, 1, 1]);
  assert.match((await kim.request('/')).text, /발주확인 2건: 완료 2건/);
});

test('일괄 발송처리: 송장 입력 화면 → 한 줄이라도 틀리면 아무것도 보내지 않는다', async t => {
  const { db, kim, idOf, row } = await setupServer(t, { writer: fakeWriter() });
  applyOrders(db, [order(1, { channel_confirmed: 1 }), order(9, { channel_order_id: 'O1', item_type: 'addon', channel_confirmed: 1 }), order(2, { channel_confirmed: 1 })]);
  applyOrders(db, [order(3)]); // 발주확인 전 → 입력 화면에서 빠진다
  const ids = [idOf('P1'), idOf('P2'), idOf('P3')].map(String);

  const form = await kim.submit('/', '/orders/bulk/dispatch-form', { ids, back: '/' });
  assert.strictEqual(form.status, 200);
  assert.match(form.text, /일괄 발송처리 \(2건\)/);
  assert.match(form.text, /뺀 주문 1건: 상품3/);
  assert.match(form.text, new RegExp(`name="tracking_${idOf('P1')}"`));

  const token = /name="_csrf" value="([^"]+)"/.exec(form.text)[1];
  const send = fields => kim.request('/orders/bulk/dispatch', { method: 'POST', form: { _csrf: token, back: '/', ids: ids.slice(0, 2), ...fields } });
  const p1 = idOf('P1');
  const p2 = idOf('P2');
  await send({ [`method_${p1}`]: 'DELIVERY', [`company_${p1}`]: 'KGB', [`tracking_${p1}`]: '111122223333', [`method_${p2}`]: 'DELIVERY', [`company_${p2}`]: 'KGB', [`tracking_${p2}`]: '' });
  assert.deepStrictEqual([row('P1').shipped_at, row('P2').shipped_at], [null, null]);

  await send({ [`method_${p1}`]: 'DELIVERY', [`company_${p1}`]: 'KGB', [`tracking_${p1}`]: '111122223333', [`method_${p2}`]: 'DIRECT_DELIVERY' });
  assert.deepStrictEqual([row('P1').tracking_no, row('P9').tracking_no, row('P2').ship_method], ['111122223333', '111122223333', 'DIRECT_DELIVERY']);
});

test('취소 요청이 들어오면 목록에 빨간 표시가 붙고, 관리자와 담당자에게만 알린다', async t => {
  const { db, kim, idOf, userId } = await setupServer(t);
  const adminId = addUser(db, { email: 'boss@broad.test', role: 'admin' });
  const otherId = addUser(db, { email: 'other@broad.test' });
  db.prepare('UPDATE orders SET assignee_id = ? WHERE channel_order_id = ?').run(userId, 'O1');

  const sent = [];
  const hub = { send: (event, data, canReceive) => sent.push({ event, data, canReceive }) };
  const notifier = createNotifier({ db, hub });
  const result = applyOrders(db, [order(1, { claim_type: 'CANCEL', claim_status: 'CANCEL_REQUEST' })]);
  notifier.afterCollect({ ok: true, ...result });

  const alert = sent.find(s => s.event === 'notify' && s.data.type === 'claim');
  assert.ok(alert, '클레임 알림');
  assert.match(alert.data.title, /취소 요청/);
  assert.strictEqual(alert.data.url, `/orders/${idOf('P1')}`);
  assert.deepStrictEqual([adminId, userId, otherId].map(alert.canReceive), [true, true, false]);

  const list = await kim.request('/');
  assert.match(list.text, /class="order-item has-claim"/);
  assert.match(list.text, /class="claim-badge open">취소 요청</);
  const detail = await kim.request(`/orders/${idOf('P1')}`);
  assert.match(detail.text, /판매자센터에서 먼저 처리하세요/);
});

test('관리자 메뉴 처리 기록: 누가 언제 무엇을 했는지 보인다 (직원은 볼 수 없음)', async t => {
  const { db, kim, idOf, baseUrl } = await setupServer(t);
  await kim.submit(`/orders/${idOf('P1')}`, `/orders/${idOf('P1')}/confirm`, {});
  addUser(db, { email: 'boss@broad.test', role: 'admin', name: '사장' });
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  const page = await boss.request('/admin/actions');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /김직원/);
  assert.match(page.text, /발주확인/);
  assert.match(page.text, /상품1/);
  assert.notStrictEqual((await kim.request('/admin/actions')).status, 200);
});
