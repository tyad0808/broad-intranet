// 4-3 쿠팡 문의 (상품별 고객문의 / 고객센터 문의)
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { normalizeInquiry, createCoupangInquirySource, createCoupangInquirySender } = require('../src/inbox/coupangInquiry');
const { createCoupangClient, isAllowed } = require('../src/channels/coupangClient');
const { createInboxCollector } = require('../src/inbox/collector');
const { startServer, addUser, loginAs } = require('./helpers');

const ONLINE = { inquiryId: 3001, sellerProductName: '포맥스 안내판', content: '두께 5T 도 되나요?', inquiryAt: '2026-10-19 10:00:00', orderIds: [910004186321], commentDtoList: [] };
const CALL = { inquiryId: 4001, content: '배송 언제 오나요', inquiryAt: '2026-10-18 09:00:00', orderId: 910004186322, partnerCounselingStatus: 'NO_ANSWER',
  replies: [{ answerId: 777, content: '[쿠팡 상담사] 판매자 확인 요청드립니다' }] };

test('쿠팡 문의 → 문의함: 종류별 번호(p:/c:)·제목·주문번호·답변 여부, 고객센터는 상담 답변 번호를 기억', () => {
  const p = normalizeInquiry(ONLINE, 'p');
  assert.deepStrictEqual([p.external_id, p.subject, p.body, p.order_no, p.answered, p.received_at],
    ['p:3001', '[쿠팡 상품문의] 포맥스 안내판', '두께 5T 도 되나요?', '910004186321', false, '2026-10-19T01:00:00.000Z']);
  assert.strictEqual(normalizeInquiry({ ...ONLINE, commentDtoList: [{ content: '네 됩니다' }] }, 'p').answered, true);
  const c = normalizeInquiry(CALL, 'c');
  assert.deepStrictEqual([c.external_id, c.subject, c.order_no, c.answered], ['c:4001', '[쿠팡 고객센터] 주문 910004186322', '910004186322', false]);
  assert.strictEqual(JSON.parse(c.meta).parentAnswerId, 777);
  assert.match(c.body, /등록된 답변 ──\n\[쿠팡 상담사\]/);
  assert.strictEqual(normalizeInquiry({ ...CALL, partnerCounselingStatus: 'ANSWER' }, 'c').answered, true);
});

test('쿠팡 문의 받기: 7일씩 나눠서 두 종류를 읽고, 처음엔 30일·다음엔 지난번 하루 전부터', async () => {
  const calls = [];
  const client = {
    vendorId: 'A00012345',
    request: async (method, path, { query }) => {
      calls.push([path.split('/').pop(), query.inquiryStartAt, query.inquiryEndAt]);
      return { code: 200, data: { content: path.endsWith('onlineInquiries') ? [ONLINE] : [CALL] } };
    },
  };
  const src = createCoupangInquirySource({ client, now: () => new Date('2026-10-19T03:00:00Z') });
  const first = await src.fetch({ state: {}, openIds: [] });
  assert.deepStrictEqual(first.items.map(i => i.external_id), ['p:3001', 'c:4001'], '경계에서 겹친 것은 하나로');
  assert.deepStrictEqual(calls.filter(c => c[0] === 'onlineInquiries').map(c => [c[1], c[2]]), [
    ['2026-09-19', '2026-09-25'], ['2026-09-26', '2026-10-02'], ['2026-10-03', '2026-10-09'], ['2026-10-10', '2026-10-16'], ['2026-10-17', '2026-10-19'],
  ]);
  calls.length = 0;
  await src.fetch({ state: { lastRun: '2026-10-19T02:00:00.000Z' } });
  assert.deepStrictEqual(calls.map(c => c[0]), ['onlineInquiries', 'callCenterInquiries'], '하루치는 한 번씩');
  assert.strictEqual(calls[0][1], '2026-10-18');
});

test('쿠팡 답변: 상품문의·고객센터 주소와 내용, WING 아이디 필수, 거절은 실패·서버 오류는 확인 필요', async () => {
  const sent = [];
  const client = { vendorId: 'A00012345', request: async (m, p, o) => { sent.push([m, p, o.json]); return { code: 200 }; } };
  const s = createCoupangInquirySender({ client, wingId: 'broad_wing' });
  assert.strictEqual((await s.reply({ external_id: 'p:3001' }, '네 됩니다')).result, 'ok');
  assert.deepStrictEqual(sent[0], ['POST', '/v2/providers/openapi/apis/api/v4/vendors/A00012345/onlineInquiries/3001/replies',
    { vendorId: 'A00012345', content: '네 됩니다', replyBy: 'broad_wing' }]);
  await s.reply({ external_id: 'c:4001', meta: JSON.stringify({ parentAnswerId: 777 }) }, '내일 출고됩니다');
  assert.deepStrictEqual(sent[1], ['POST', '/v2/providers/openapi/apis/api/v4/vendors/A00012345/callCenterInquiries/4001/replies',
    { vendorId: 'A00012345', inquiryId: '4001', content: '내일 출고됩니다', replyBy: 'broad_wing', parentAnswerId: '777' }]);
  assert.match((await createCoupangInquirySender({ client, wingId: '' }).reply({ external_id: 'p:1' }, 'x')).message, /COUPANG_WING_ID/);
  const err = status => createCoupangInquirySender({ client: { vendorId: 'A', request: async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); } }, wingId: 'w' });
  assert.strictEqual((await err(400).reply({ external_id: 'p:1' }, 'x')).result, 'fail');
  assert.strictEqual((await err(500).reply({ external_id: 'p:1' }, 'x')).result, 'unknown');
});

test('쿠팡 연결: 문의 조회는 허용, 답변은 COUPANG_ANSWER 를 켠 연결만, 번호가 숫자가 아니면 막음', async () => {
  const base = '/v2/providers/openapi/apis/api/v4/vendors/A00012345';
  assert.ok(isAllowed('GET', `${base}/onlineInquiries`));
  assert.ok(isAllowed('GET', '/v2/providers/openapi/apis/api/v5/vendors/A00012345/onlineInquiries'));
  assert.ok(isAllowed('GET', `${base}/callCenterInquiries`));
  assert.ok(isAllowed('POST', `${base}/onlineInquiries/3001/replies`));
  assert.ok(!isAllowed('POST', `${base}/onlineInquiries/x/replies`));
  assert.ok(!isAllowed('POST', `${base}/callCenterInquiries/1/confirms`));
  let sent = 0;
  const client = createCoupangClient({ vendorId: 'A00012345', accessKey: 'a', secretKey: 's', fetchFn: async () => { sent++; return new Response('{}'); } });
  await assert.rejects(client.request('POST', `${base}/onlineInquiries/3001/replies`, { json: {} }), /COUPANG_ANSWER=on 이 아님/);
  assert.strictEqual(sent, 0);
});

test('수집하면 주문번호도 함께 저장, 이미 있는 문의는 답변에 필요한 값만 새로', async () => {
  const db = openDb(':memory:');
  let item = normalizeInquiry(CALL, 'c');
  const src = { source: 'coupang_qna', label: '쿠팡', fetch: async () => ({ items: [item], answeredIds: [], state: {} }) };
  const col = createInboxCollector({ db, sources: [src] });
  await col.run();
  const row = () => db.prepare("SELECT order_no, meta FROM inquiries WHERE source = 'coupang_qna'").get();
  assert.strictEqual(row().order_no, '910004186322');
  item = normalizeInquiry({ ...CALL, replies: [...CALL.replies, { answerId: 888, content: '추가 상담' }] }, 'c');
  await col.run();
  assert.strictEqual(JSON.parse(row().meta).parentAnswerId, 888);
});

test('화면: 쿠팡 문의는 쇼핑몰 문의 탭에, 관련 주문 보기 버튼, 답변은 연습 모드 기록', async t => {
  const ctx = await startServer({ inbox: { sourceLabels: { coupang_qna: '쿠팡' } } });
  t.after(() => ctx.server.close());
  addUser(ctx.db, { email: 'kim@broad.test' });
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const id = Number(ctx.db.prepare(`INSERT INTO inquiries (source, external_id, subject, body, attachments, received_at, order_no)
    VALUES ('coupang_qna', 'c:4001', '[쿠팡 고객센터] 주문 910004186322', '배송 언제', '[]', '2026-10-19T01:00:00Z', '910004186322')`).run().lastInsertRowid);
  assert.match((await kim.request('/inbox')).text, /class="src-tag src-coupang_qna">쿠팡</);
  const detail = (await kim.request(`/inbox/${id}`)).text;
  assert.match(detail, /쿠팡에 이 답변을 등록할까요/);
  assert.match(detail, /href="\/\?view=all&q=910004186322"[^>]*>관련 주문 보기/);
  assert.match(detail, /data-confirm="쿠팡에 이 답변을 등록할까요\?\n고객에게/, '확인창 줄바꿈이 글자(&#10;)로 보이지 않게');
  assert.match(detail, /눌러도 쿠팡으로 나가지/);
  const { withRo } = require('../src/routes/inbox');
  assert.deepStrictEqual(['쿠팡', '스마트스토어', '자사몰', 'bro_ad@naver.com'].map(withRo), ['쿠팡으로', '스마트스토어로', '자사몰로', 'bro_ad@naver.com로']);
  await kim.submit(`/inbox/${id}`, `/inbox/${id}/reply`, { body: '내일 출고됩니다', version: '0' });
  assert.strictEqual(ctx.db.prepare('SELECT result FROM inquiry_replies').get().result, 'practice');
});

test('쿠팡 문의에 상품명이 없으면 상품번호로 상품명을 찾아 제목에 넣는다 (한 번 찾으면 기억, 못 찾아도 받기는 계속)', async () => {
  const calls = [];
  const client = {
    vendorId: 'A00012345',
    request: async (method, path) => {
      calls.push(path);
      if (path.includes('/seller-products/')) {
        if (path.endsWith('/999')) throw Object.assign(new Error('없음'), { status: 404 });
        return { code: 'SUCCESS', data: { sellerProductName: '포맥스 안내판 맞춤' } };
      }
      if (path.endsWith('onlineInquiries')) return { code: 200, data: { content: [
        { inquiryId: '1', sellerProductId: '12345', content: '디자인 변경 가능한가요', inquiryAt: '2026-10-19 22:31:00', commentDtoList: [] },
        { inquiryId: '2', sellerProductId: '12345', content: '배송은요', inquiryAt: '2026-10-19 22:32:00', commentDtoList: [] },
        { inquiryId: '3', sellerProductId: '999', content: '?', inquiryAt: '2026-10-19 22:33:00', commentDtoList: [] },
      ] } };
      return { code: 200, data: { content: [] } };
    },
  };
  const src = createCoupangInquirySource({ client, now: () => new Date('2026-10-19T14:00:00Z') });
  const out = await src.fetch({ state: { lastRun: '2026-10-19T13:00:00.000Z' } });
  assert.deepStrictEqual(out.items.map(i => i.subject), ['[쿠팡 상품문의] 포맥스 안내판 맞춤', '[쿠팡 상품문의] 포맥스 안내판 맞춤', '[쿠팡 상품문의] 문의']);
  assert.strictEqual(calls.filter(p => p.endsWith('/seller-products/12345')).length, 1, '같은 상품은 한 번만 찾음');
  assert.ok(isAllowed('GET', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/12345'));
  assert.ok(!isAllowed('PUT', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/12345'), '상품 수정은 안 됨');
});
