// 3차: 자사몰(고도몰) 주문 가져오기 — 조회 전용
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
      { itemNo: 1, type: 'goods', status, goodsNo: 1000701702, name: '포맥스 안내판', option: '3T', textOption: '문구: 화장실', sizeW: 300, sizeH: 150, quantity: 2 },
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
