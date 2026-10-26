// 4-2 스마트스토어 상품문의(Q&A)
const test = require('node:test');
const assert = require('node:assert');
const { normalizeQna, listFrom, createNaverQnaSource, createNaverQnaSender } = require('../src/inbox/naverQna');
const { createNaverClient, isAllowed } = require('../src/channels/naverClient');
const { startServer, addUser, loginAs } = require('./helpers');

const QNA = { questionId: 123456, productName: '포맥스 안내판', question: '사이즈 맞춤 되나요?', answered: false, createDate: '2026-10-19T10:00:00.000+09:00', maskedWriterId: 'abc***' };

test('상품문의 1건 → 문의함: 번호·상품명·질문·작성자(가려진 ID)·시각, 답변 여부', () => {
  const n = normalizeQna(QNA);
  assert.deepStrictEqual(
    [n.source, n.external_id, n.subject, n.body, n.from_name, n.received_at, n.answered],
    ['smartstore_qna', '123456', '[상품문의] 포맥스 안내판', '사이즈 맞춤 되나요?', 'abc***', '2026-10-19T01:00:00.000Z', false]);
  const a = normalizeQna({ id: 7, question: '배송?', answer: '내일 출고됩니다', createDate: '2026-10-19 10:00:00' });
  assert.strictEqual(a.answered, true, '답변 글이 있으면 답변완료');
  assert.match(a.body, /등록된 답변 ──\n내일 출고됩니다/);
  assert.strictEqual(normalizeQna({ question: '번호 없음' }), null);
  // 응답 모양이 조금 달라도 목록을 찾는다
  assert.strictEqual(listFrom({ contents: [QNA] }).length, 1);
  assert.strictEqual(listFrom({ data: { content: [QNA] } }).length, 1);
  assert.strictEqual(listFrom({ something: 1 }), null);
});

test('상품문의 받기: 처음 30일, 다음부터는 지난번 하루 전부터. 판매자센터에서 답변한 건 답변완료로', async () => {
  const calls = [];
  let reply = { contents: [QNA, { ...QNA, questionId: 2, answered: true }] };
  const client = { request: async (method, path, { query }) => { calls.push([method, path, query]); return reply; } };
  const t = new Date('2026-10-19T03:00:00Z');
  const src = createNaverQnaSource({ client, now: () => t });
  const first = await src.fetch({ state: {}, openIds: [] });
  assert.deepStrictEqual(first.items.map(i => [i.external_id, i.answered]), [['123456', false], ['2', true]]);
  assert.strictEqual(calls[0][1], '/v1/contents/qnas');
  assert.strictEqual(calls[0][2].fromDate, '2026-09-19T12:00:00.000+09:00');
  assert.strictEqual(calls[0][2].toDate, '2026-10-19T12:00:00.000+09:00');

  reply = { contents: [{ ...QNA, answered: true }] };
  const second = await src.fetch({ state: { lastRun: '2026-10-19T02:00:00.000Z' }, openIds: ['123456'] });
  assert.strictEqual(calls[1][2].fromDate, '2026-10-18T11:00:00.000+09:00', '지난번 하루 전부터');
  assert.deepStrictEqual(second.answeredIds, ['123456']);

  // 미답변 문의가 사흘 전 것이면 그때부터 다시 읽는다 (판매자센터에서 나중에 단 답변을 알아채기 위해)
  await src.fetch({ state: { lastRun: '2026-10-19T02:00:00.000Z' }, openIds: ['123456'], openSince: new Date('2026-10-16T03:00:00Z') });
  assert.strictEqual(calls[2][2].fromDate, '2026-10-16T11:00:00.000+09:00');
  // 아주 오래된 미답변이 있어도 30일 전까지만
  await src.fetch({ state: { lastRun: '2026-10-19T02:00:00.000Z' }, openIds: ['123456'], openSince: new Date('2026-08-01T00:00:00Z') });
  assert.strictEqual(calls[3][2].fromDate, '2026-09-19T12:00:00.000+09:00');

  reply = { weird: [] };
  await assert.rejects(src.fetch({ state: {} }), /응답 모양을 알 수 없습니다 \(항목: weird\)/);
});

test('답변 등록: PUT 으로 commentContent, 거절은 실패, 서버 오류는 확인 필요, 파일은 못 붙임', async () => {
  const sent = [];
  const ok = createNaverQnaSender({ client: { request: async (m, p, o) => { sent.push([m, p, o.json]); return null; } } });
  assert.strictEqual((await ok.reply({ external_id: '123456' }, '네 가능합니다')).result, 'ok');
  assert.deepStrictEqual(sent[0], ['PUT', '/v1/contents/qnas/123456', { commentContent: '네 가능합니다' }]);
  assert.strictEqual((await ok.reply({ external_id: '1' }, 'x', [{ name: 'a.png' }])).result, 'fail');
  const err = status => createNaverQnaSender({ client: { request: async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); } } });
  assert.strictEqual((await err(400).reply({ external_id: '1' }, 'x')).result, 'fail');
  assert.strictEqual((await err(503).reply({ external_id: '1' }, 'x')).result, 'unknown');
});

test('네이버 연결: 상품문의 조회는 허용, 답변은 NAVER_ANSWER 를 켠 연결만, 이상한 주소는 막음', async () => {
  assert.ok(isAllowed('GET', '/v1/contents/qnas'));
  assert.ok(isAllowed('PUT', '/v1/contents/qnas/123'));
  assert.ok(!isAllowed('PUT', '/v1/contents/qnas/123/../x'));
  assert.ok(!isAllowed('DELETE', '/v1/contents/qnas/123'));
  let sent = 0;
  const client = createNaverClient({ clientId: 'id', clientSecret: '$2a$04$abcdefghijklmnopqrstuu', fetchFn: async () => { sent++; return new Response('{}'); } });
  await assert.rejects(client.request('PUT', '/v1/contents/qnas/1', { json: {} }), /NAVER_ANSWER=on 이 아님/);
  assert.strictEqual(sent, 0);
});

test('화면: 스마트스토어 문의는 출처 칩에 나오고, 답변 칸에 파일 상자·받는 사람 없이 등록 안내', async t => {
  const ctx = await startServer({ inbox: { sourceLabels: { smartstore_qna: '스마트스토어' } } });
  t.after(() => ctx.server.close());
  addUser(ctx.db, { email: 'kim@broad.test' });
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const id = Number(ctx.db.prepare(`INSERT INTO inquiries (source, external_id, from_name, subject, body, attachments, received_at)
    VALUES ('smartstore_qna', '123456', 'abc***', '[상품문의] 포맥스 안내판', '사이즈 맞춤 되나요?', '[]', '2026-10-19T01:00:00Z')`).run().lastInsertRowid);
  const list = (await kim.request('/inbox')).text;
  assert.match(list, /class="src-tag src-smartstore_qna">스마트스토어</);
  const detail = (await kim.request(`/inbox/${id}`)).text;
  assert.match(detail, /스마트스토어에 이 답변을 등록할까요/);
  assert.ok(!detail.includes('data-drop-zone'), '파일 첨부 없음');
  assert.ok(!detail.includes('이 이름으로 주문 찾기'));
  await kim.submit(`/inbox/${id}`, `/inbox/${id}/reply`, { body: '네 가능합니다', version: '0' });
  assert.strictEqual(ctx.db.prepare('SELECT result FROM inquiry_replies').get().result, 'practice');
});
