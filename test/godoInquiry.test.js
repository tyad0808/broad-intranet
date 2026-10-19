// 4-4 자사몰 문의 (1:1 문의 · 상품 문의 · 견적 문의)
const test = require('node:test');
const assert = require('node:assert');
const { normalizeInquiry, createGodoInquirySource, createGodoInquirySender } = require('../src/inbox/godoInquiry');
const { createGodoClient, isAllowed } = require('../src/channels/godo');
const { startServer, addUser, loginAs } = require('./helpers');

const ONE = { inquiryNo: '501', board: 'inquiry', subject: '배송 문의', contents: '언제 받을 수 있나요?\n급해요', writerName: '홍길동', writerId: 'hong',
  orderNo: '2610191234567890', goodsNo: null, goodsName: null, secret: true, createdAt: '2026-10-19 10:00:00', modifiedAt: '2026-10-19 10:00:00',
  answered: false, answer: null, files: ['사진.jpg'] };
const GOODS = { inquiryNo: '77', board: 'goodsqa', subject: '두께 문의', contents: '5T 도 되나요', writerName: '김고객', writerId: '',
  orderNo: null, goodsNo: '1000123', goodsName: '포맥스 안내판', secret: false, createdAt: '2026-10-18 09:00:00',
  answered: true, answer: { contents: '네 가능합니다', answeredAt: '2026-10-18 11:00:00' }, files: [] };

test('자사몰 문의 → 문의함: 게시판별 번호·제목·작성자·주문번호·첨부파일 이름·비밀글·답변 여부', () => {
  const a = normalizeInquiry(ONE);
  assert.deepStrictEqual([a.source, a.external_id, a.subject, a.from_name, a.order_no, a.answered, a.received_at],
    ['godo_qna', 'inquiry:501', '[자사몰 1:1문의] 배송 문의 🔒', '홍길동 (hong)', '2610191234567890', false, '2026-10-19T01:00:00.000Z']);
  assert.strictEqual(a.body, '언제 받을 수 있나요?\n급해요\n\n첨부파일: 사진.jpg (자사몰 관리자에서 확인)');
  const g = normalizeInquiry(GOODS);
  assert.deepStrictEqual([g.external_id, g.subject, g.from_name, g.order_no, g.answered], ['goodsqa:77', '[자사몰 상품문의] 포맥스 안내판', '김고객', null, true]);
  assert.match(g.body, /^제목: 두께 문의\n\n5T 도 되나요\n── 등록된 답변 ──\n네 가능합니다$/);
  assert.strictEqual(normalizeInquiry({ ...ONE, board: 'qa', subject: '견적 부탁' }).subject, '[자사몰 견적문의] 견적 부탁 🔒');
  assert.strictEqual(normalizeInquiry({ ...ONE, board: 'notice' }), null, '모르는 게시판은 받지 않음');
});

test('자사몰 문의 받기: 바뀐 시각 기준, 처음엔 30일·다음엔 지난번 하루 전부터, 페이지를 넘겨 읽고, 열린 문의 중 답변된 것은 답변완료로', async () => {
  const calls = [];
  const client = {
    request: async (method, path, { query }) => {
      calls.push([method, path, query]);
      if (query.page === 1) return { total: 101, page: 1, size: 100, items: Array.from({ length: 100 }, (_, i) => ({ ...ONE, inquiryNo: String(1000 + i) })) };
      return { total: 101, page: 2, size: 100, items: [GOODS] };
    },
  };
  const src = createGodoInquirySource({ client, now: () => new Date('2026-10-19T03:00:00Z') });
  const out = await src.fetch({ state: {}, openIds: ['goodsqa:77', 'inquiry:1000'] });
  assert.strictEqual(out.items.length, 101);
  assert.deepStrictEqual(out.answeredIds, ['goodsqa:77']);
  assert.deepStrictEqual(calls.map(c => [c[0], c[1], c[2].from, c[2].to, c[2].dateType, c[2].page]), [
    ['GET', '/inquiries', '2026-09-19', '2026-10-19', 'modified', 1], ['GET', '/inquiries', '2026-09-19', '2026-10-19', 'modified', 2]]);
  calls.length = 0;
  await src.fetch({ state: out.state });
  assert.deepStrictEqual([calls[0][2].from, calls[0][2].to], ['2026-10-18', '2026-10-19']);
  await assert.rejects(createGodoInquirySource({ client: { request: async () => ({ code: 'x' }) } }).fetch({}), /응답 모양/);
});

test('자사몰 답변: 게시판·번호로 등록, 거절(ok:false)·4xx 는 실패, 서버 오류는 확인 필요, 파일은 못 붙임', async () => {
  const sent = [];
  const ok = createGodoInquirySender({ client: { request: async (m, p, o) => { sent.push([m, p, o.json]); return { ok: true, message: '', notices: ['메일이 발송되었습니다.'] }; } } });
  const r = await ok.reply({ external_id: 'goodsqa:77' }, '네 가능합니다');
  assert.deepStrictEqual(sent[0], ['POST', '/inquiries/goodsqa/77/answer', { contents: '네 가능합니다' }]);
  assert.deepStrictEqual([r.result, r.message], ['ok', '자사몰에 답변을 등록했습니다. (메일이 발송되었습니다.)']);
  const refused = createGodoInquirySender({ client: { request: async () => ({ ok: false, message: '이미 답변된 문의입니다.' }) } });
  assert.deepStrictEqual(await refused.reply({ external_id: 'inquiry:1' }, 'x'), { result: 'fail', message: '등록하지 못했습니다 — 이미 답변된 문의입니다.' });
  const err = status => createGodoInquirySender({ client: { request: async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); } } });
  assert.strictEqual((await err(403).reply({ external_id: 'inquiry:1' }, 'x')).result, 'fail');
  assert.strictEqual((await err(504).reply({ external_id: 'inquiry:1' }, 'x')).result, 'unknown');
  assert.match((await err(504).reply({ external_id: 'inquiry:1' }, 'x')).message, /자사몰 관리자에서/);
  assert.strictEqual((await ok.reply({ external_id: 'inquiry:1' }, 'x', [{ name: 'a.jpg' }])).result, 'fail');
  assert.strictEqual(sent.length, 1);
});

test('자사몰 연결: 문의 조회는 조회 키로, 답변은 GODO_ANSWER 를 켠 연결만·처리 키로, 게시판 이름이 다르면 막음', async () => {
  assert.ok(isAllowed('GET', '/inquiries'));
  assert.ok(isAllowed('POST', '/inquiries/inquiry/501/answer'));
  assert.ok(isAllowed('POST', '/inquiries/qa/1/answer'));
  assert.ok(!isAllowed('POST', '/inquiries/notice/1/answer'));
  assert.ok(!isAllowed('POST', '/inquiries/inquiry/x/answer'));
  assert.ok(!isAllowed('DELETE', '/inquiries/inquiry/1'));
  const used = [];
  const fetchFn = async (url, opts) => { used.push([url, opts.headers.authorization]); return new Response('{"ok":true,"inquiryNo":12345678901234567}'); };
  const off = createGodoClient({ apiKey: 'read', writeKey: 'write', fetchFn });
  await assert.rejects(off.request('POST', '/inquiries/inquiry/1/answer', { json: { contents: 'x' } }), /GODO_ANSWER=on 이 아님/);
  assert.strictEqual(used.length, 0);
  await off.request('GET', '/inquiries', { query: { from: '2026-10-01', to: '2026-10-19' } });
  const on = createGodoClient({ apiKey: 'read', writeKey: 'write', fetchFn, allowWrite: true });
  const body = await on.request('POST', '/inquiries/inquiry/1/answer', { json: { contents: 'x' } });
  assert.deepStrictEqual(used.map(u => u[1]), ['Bearer read', 'Bearer write']);
  assert.strictEqual(body.inquiryNo, '12345678901234567', '긴 번호는 글자로');
});

test('화면: 자사몰 문의는 쇼핑몰 문의 탭에, 관련 주문 보기 버튼, 답변은 연습 모드 기록', async t => {
  const ctx = await startServer({ inbox: { sourceLabels: { godo_qna: '자사몰' } } });
  t.after(() => ctx.server.close());
  addUser(ctx.db, { email: 'kim@broad.test' });
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const id = Number(ctx.db.prepare(`INSERT INTO inquiries (source, external_id, subject, body, attachments, received_at, order_no)
    VALUES ('godo_qna', 'inquiry:501', '[자사몰 1:1문의] 배송 문의', '언제 받나요', '[]', '2026-10-19T01:00:00Z', '2610191234567890')`).run().lastInsertRowid);
  assert.match((await kim.request('/inbox?box=shop')).text, /class="src-tag src-godo_qna">자사몰</);
  const detail = (await kim.request(`/inbox/${id}`)).text;
  assert.match(detail, /href="\/\?view=all&q=2610191234567890"[^>]*>관련 주문 보기/);
  assert.match(detail, /눌러도 자사몰로 나가지/);
  await kim.submit(`/inbox/${id}`, `/inbox/${id}/reply`, { body: '내일 출고됩니다', version: '0' });
  assert.strictEqual(ctx.db.prepare('SELECT result FROM inquiry_replies').get().result, 'practice');
});
