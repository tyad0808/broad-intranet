// G마켓·옥션(ESM) 1단계: 주문 가져오기·취소/반품/교환 표시 (조회만) — 진짜 ESM 대신 가짜로 확인
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { openDb } = require('../src/db');
const { createCollector } = require('../src/collector');
const { createEsmClient, buildToken, isAllowed } = require('../src/channels/esmClient');
const { createEsmSource, normalize, evenShipFee, claimPatch } = require('../src/channels/esm');
const { productUrl } = require('../src/channels/labels');

// ESM 안내 문서의 주문조회 응답 예시와 같은 모양
function esmOrder(no, extra = {}) {
  return {
    OrderStatus: 1, PayNo: 4454223145, GroupNo: 731875814, OrderNo: no,
    OrderDate: '2026-11-08T17:45:39.727', PayDate: '2026-11-08T17:45:50.507', TransDueDate: '2026-11-11T23:59:59',
    SiteGoodsNo: '1496943317', GoodsName: '포맥스 안내판', SalePrice: '3400.0000', ContrAmount: 2, OrderAmount: '6800.0000',
    SellerDiscountPrice: '200.0000', ShippingFee: '3000.0000', BackwoodsAddDeliveryFee: '0.0000', JejuAddDeliveryFee: '0.0000',
    DeliveryFeeCondition: 'M', OptSelPrice: '1000.0000', OptAddPrice: null,
    BuyerName: '테스터', BuyerMobileTel: '010-1234-5678', ReceiverName: '받는분', HpNo: '010-9999-8888',
    ZipCode: '06236', DelFrontAddress: '서울 강남구 역삼동 804', DelBackAddress: '2층', DelFullAddress: '서울 강남구 역삼동 804 2층', DelMemo: ' 문 앞 ',
    ItemOptionSelectList: [{ ItemOptionValue: '색상:블루', ItemOptionOrderCnt: 1 }], ItemOptionAdditionList: [{ ItemOptionValue: '양면테이프:추가', ItemOptionOrderCnt: 2 }],
    ...extra,
  };
}

test('인증 토큰: HS256 JWT (kid = 마스터 ID, ssi = 옥션·G마켓 ID), 시크릿키로 서명', () => {
  const token = buildToken({ masterId: 'master1', secretKey: 'secret-xyz', gmarketId: 'gm1', auctionId: 'au1', now: new Date('2026-11-09T00:00:00Z') });
  const [h, p, sig] = token.split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT', kid: 'master1' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.strictEqual(payload.ssi, 'A:au1,G:gm1');
  assert.strictEqual(payload.sub, 'sell');
  assert.strictEqual(payload.aud, 'sa.esmplus.com');
  assert.strictEqual(payload.iat, Date.parse("2026-11-09T00:00:00Z") / 1000);
  assert.strictEqual(sig, crypto.createHmac('sha256', 'secret-xyz').update(`${h}.${p}`).digest('base64url'));
  // G마켓만 쓰면 G 만
  const only = JSON.parse(Buffer.from(buildToken({ masterId: 'm', secretKey: 's', gmarketId: 'gm1' }).split('.')[1], 'base64url'));
  assert.strictEqual(only.ssi, 'G:gm1');
});

test('허용 목록 밖(주문확인·발송처리 등)은 보내지 않는다 · 키가 없으면 보내지 않는다', async () => {
  const calls = [];
  const fetchFn = async (...a) => { calls.push(a); return new Response('{}'); };
  const client = createEsmClient({ masterId: 'm', secretKey: 's', gmarketId: 'g', fetchFn, sleep: async () => {} });
  await assert.rejects(client.request('POST', '/shipping/v1/Order/OrderCheck/123', {}), /허용되지 않은/);
  await assert.rejects(client.request('POST', '/shipping/v1/Delivery/ShippingInfo', {}), /허용되지 않은/);
  const none = createEsmClient({ masterId: '', secretKey: '', gmarketId: '', auctionId: '', fetchFn });
  await assert.rejects(none.request('POST', '/shipping/v1/Order/RequestOrders', {}), /\.env 에 없습니다/);
  assert.strictEqual(calls.length, 0);
  assert.ok(isAllowed('POST', '/claim/v1/sa/Cancels'));
  assert.ok(!isAllowed('GET', '/shipping/v1/Order/RequestOrders'));
});

test('요청: 기간 조회는 5초 간격, Bearer 토큰, 실패 코드는 오류로', async () => {
  const calls = [];
  const waits = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(calls.length === 3 ? { ResultCode: 3000, Message: '31일 이하의 범위만 조회 할 수 있습니다.' } : { ResultCode: 0, Data: { RequestOrders: [] } }));
  };
  const client = createEsmClient({ masterId: 'm', secretKey: 's', gmarketId: 'g', fetchFn, sleep: async ms => waits.push(ms) });
  await client.request('POST', '/shipping/v1/Order/RequestOrders', { orderStatus: 1 });
  await client.request('POST', '/shipping/v1/Order/RequestOrders', { orderStatus: 2 });
  assert.ok(waits.some(ms => ms > 4000), '두 번째 기간 조회는 5초 가까이 기다린다');
  assert.strictEqual(calls[0].url, 'https://sa2.esmplus.com/shipping/v1/Order/RequestOrders');
  assert.match(calls[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  await assert.rejects(client.request('POST', '/shipping/v1/Order/RequestOrders', { orderStatus: 1 }), /코드 3000.*31일/);
});

test('ESM 주문 → 인트라넷 주문: 번호 앞에 사이트, 상태, 옵션, 배송 방법, 금액, 배송비', () => {
  const o = normalize(esmOrder(2946269058), 'G');
  assert.strictEqual(o.channel, 'esm');
  assert.strictEqual(o.channel_order_id, 'G-2946269058');
  assert.strictEqual(o.channel_item_id, 'G-2946269058');
  assert.strictEqual(o.channel_status, 'PAYED');
  assert.strictEqual(o.channel_confirmed, 0);
  assert.strictEqual(o.channel_status_label, 'G마켓 신규주문');
  assert.strictEqual(o.option_text, '색상:블루 / 추가: 양면테이프:추가 ×2');
  assert.strictEqual(o.quantity, 2);
  assert.strictEqual(o.receiver_address, '(06236) 서울 강남구 역삼동 804 2층');
  assert.strictEqual(o.receiver_phone, '010-9999-8888');
  assert.strictEqual(o.paid_at, '2026-11-08T17:45:50.507+09:00');
  assert.strictEqual(o.ship_due, '2026-11-11T23:59:59+09:00');
  assert.strictEqual(o.pay_amount, 6800 + 1000 - 200);
  assert.strictEqual(o.ship_fee, 3000);
  assert.strictEqual(o.ship_pkg, 'G-4454223145');
  assert.strictEqual(o.ship_memo, '문 앞');
  assert.strictEqual(o.delivery_method, 'DELIVERY');
  assert.strictEqual(normalize(esmOrder(1, { DeliveryFeeCondition: 'W' }), 'A').delivery_method, 'VISIT_RECEIPT');
  assert.strictEqual(normalize(esmOrder(1, { DeliveryFeeCondition: 'Q' }), 'A').delivery_method, 'QUICK_SVC');
  assert.strictEqual(normalize(esmOrder(1, { OrderStatus: 2 }), 'A').channel_status_label, '옥션 발송대기중');
  assert.strictEqual(normalize(esmOrder(1, { OrderStatus: 2 }), 'A').channel_confirmed, 1);
  // 같은 장바구니: G마켓은 배송비가 한 주문에만 → 묶음마다 같은 값으로
  const rows = evenShipFee([normalize(esmOrder(1), 'G'), normalize(esmOrder(2, { ShippingFee: '0.0000' }), 'G')]);
  assert.deepStrictEqual(rows.map(r => r.ship_fee), [3000, 3000]);
  // 상품 링크
  assert.strictEqual(productUrl({ channel: 'esm', channel_item_id: 'G-1', product_no: '1496943317' }), 'https://item.gmarket.co.kr/Item?goodscode=1496943317');
  assert.strictEqual(productUrl({ channel: 'esm', channel_item_id: 'A-1', product_no: 'B123' }), 'https://itempage3.auction.co.kr/DetailView.aspx?itemno=B123');
});

test('취소·반품·교환 → 요청 표시, 완료는 취소/반품 상태로, 철회는 표시를 지움', () => {
  assert.deepStrictEqual(claimPatch('cancel', { OrderNo: 5, CancelStatus: 1 }, 'G'), { channel_order_id: 'G-5', vendorItemId: '5', shipmentBoxId: 'G', claim_type: 'CANCEL', claim_status: 'CANCEL_REQUEST' });
  const done = claimPatch('cancel', { OrderNo: 5, CancelStatus: 3 }, 'A');
  assert.strictEqual(done.channel_status, 'CANCELED');
  assert.strictEqual(done.channel_status_label, '옥션에서 취소됨');
  assert.strictEqual(claimPatch('return', { OrderNo: 5, ReturnStatus: 2 }, 'G').claim_status, 'COLLECT_DONE');
  assert.strictEqual(claimPatch('return', { OrderNo: 5, ReturnStatus: 4 }, 'G').channel_status, 'RETURNED');
  assert.strictEqual(claimPatch('exchange', { OrderNo: 5, ExchangeStatus: 1 }, 'G').claim_status, 'EXCHANGE_REQUEST');
  assert.deepStrictEqual(claimPatch('cancel', { OrderNo: 5, CancelStatus: 4 }, 'G').claim_status, null);
});

// 가짜 ESM: 사이트·상태별 주문과 클레임
function fakeClient(sites = ['G']) {
  const calls = [];
  const data = { G: { 1: [esmOrder(1001)], 2: [esmOrder(1002, { OrderStatus: 2, PayDate: '2026-10-20T10:00:00' })], 3: [], 4: [] }, A: { 1: [esmOrder(2001)], 2: [], 3: [], 4: [] } };
  const cancels = { G: [], A: [] };
  return {
    calls, data, cancels,
    sites: sites.map(key => ({ key, code: key === 'G' ? 2 : 1 })),
    async request(method, path, json) {
      calls.push({ path, json });
      const site = json.siteType === 1 || json.SiteType === 1 ? 'A' : 'G';
      if (path.endsWith('RequestOrders')) {
        if (json.orderStatus === 0) return { ResultCode: 0, Data: { RequestOrders: Object.values(data[site]).flat().filter(o => o.OrderNo === json.orderNo) } };
        const rows = data[site][json.orderStatus] || [];
        return { ResultCode: 0, Data: { TotalCount: rows.length, RequestOrders: rows } };
      }
      if (path.endsWith('Cancels')) return { ResultCode: 0, Data: json.Type === 2 ? cancels[site] : [] };
      return { ResultCode: 0, Data: [] };
    },
  };
}

test('수집: 사이트마다 상태 4번 조회(결제일 기준, 오늘까지), 켠 날 전 주문은 건너뜀, 취소 요청 표시', async () => {
  const db = openDb(':memory:');
  const client = fakeClient(['G', 'A']);
  let t = new Date('2026-11-09T03:00:00Z');
  const source = createEsmSource({ client, now: () => t, startDate: '2026-11-01' });
  const collector = createCollector({ db, source, now: () => t });

  const r1 = await collector.run();
  assert.ok(r1.ok, r1.error);
  const range = client.calls.filter(c => c.path.endsWith('RequestOrders'));
  assert.deepStrictEqual(range.map(c => `${c.json.siteType}:${c.json.orderStatus}`), ['2:1', '2:2', '2:3', '2:4', '1:1', '1:2', '1:3', '1:4']);
  assert.strictEqual(range[0].json.requestDateType, 2);
  assert.strictEqual(range[0].json.requestDateTo, '2026-11-10', '오늘까지 보려면 끝 날짜는 내일');
  assert.strictEqual(range[0].json.requestDateFrom, '2026-10-12');
  const ids = db.prepare("SELECT channel_item_id FROM orders WHERE channel = 'esm' ORDER BY channel_item_id").all().map(r => r.channel_item_id);
  assert.deepStrictEqual(ids, ['A-2001', 'G-1001'], '켠 날(11/1) 전에 결제한 G-1002 는 가져오지 않음');
  const row = db.prepare("SELECT * FROM orders WHERE channel_item_id = 'G-1001'").get();
  assert.strictEqual(row.product_name, '포맥스 안내판');
  assert.strictEqual(row.channel_status, 'PAYED');

  // 고객이 취소 요청 → 다음 클레임 조회(15분 뒤)에서 빨간 표시. 주문조회에는 더 이상 안 나온다
  client.data.G[1] = [];
  client.cancels.G = [{ OrderNo: 1001, PayNo: 4454223145, CancelStatus: 1 }];
  t = new Date(t.getTime() + 5 * 60e3);
  await collector.run();
  assert.strictEqual(db.prepare("SELECT claim_status FROM orders WHERE channel_item_id = 'G-1001'").get().claim_status, null, '15분이 안 지나면 클레임은 다시 묻지 않음');
  t = new Date(t.getTime() + 15 * 60e3);
  await collector.run();
  const after = db.prepare("SELECT claim_type, claim_status, channel_status FROM orders WHERE channel_item_id = 'G-1001'").get();
  assert.deepStrictEqual({ ...after }, { claim_type: 'CANCEL', claim_status: 'CANCEL_REQUEST', channel_status: 'PAYED' });
  // 다른 주문은 그대로
  assert.strictEqual(db.prepare("SELECT claim_status FROM orders WHERE channel_item_id = 'A-2001'").get().claim_status, null);
  // 바꾸는 요청은 하나도 없다
  assert.ok(client.calls.every(c => /RequestOrders|Cancels|Returns|Exchanges$/.test(c.path)));
});

test('7일 지난 배송중 주문은 주문번호로 다시 물어 배송완료로', async () => {
  const client = fakeClient(['G']);
  client.data.G[4] = [esmOrder(1003, { OrderStatus: 4 })];
  const source = createEsmSource({ client });
  const rows = await source.refreshOrders(['G-1003', 'X-1', 'G-999']);
  assert.deepStrictEqual(rows.map(r => [r.channel_item_id, r.channel_status]), [['G-1003', 'DELIVERED']]);
  assert.deepStrictEqual(client.calls.map(c => c.json), [{ siteType: 2, orderStatus: 0, orderNo: 1003 }, { siteType: 2, orderStatus: 0, orderNo: 999 }]);
});
