// 5차 채팅: 네이버 톡톡
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { ipAllowed, messageOf, createTalktalkHandler, createTalktalkClient } = require('../src/inbox/talktalk');
const { startServer, addUser, loginAs } = require('./helpers');

const TOKEN = 'a'.repeat(48);
const send = (user, text, extra = {}) => ({ event: 'send', user, textContent: { text, inputType: 'typing' }, ...extra });

test('네이버 톡톡 서버 IP 대역만 받는다', () => {
  assert.ok(ipAllowed('211.249.40.5'));
  assert.ok(ipAllowed('::ffff:103.6.173.31'));
  assert.ok(!ipAllowed('103.6.173.32'));
  assert.ok(!ipAllowed('8.8.8.8'));
  assert.ok(ipAllowed('127.0.0.1'), '서버 안 점검');
  assert.deepStrictEqual(messageOf({ imageContent: { imageUrl: 'https://talk.pstatic.net/a.jpg' } }), { kind: 'image', text: null, image_url: 'https://talk.pstatic.net/a.jpg' });
});

test('고객 말 → 미답변 대화방 + 주도권 넘기기, 파트너센터 답(echo) → 답변완료, 다시 말하면 미답변', async () => {
  const db = openDb(':memory:');
  const passed = [];
  const client = { passThread: async (user, partner) => { passed.push([user, partner]); } };
  const notes = [];
  const notifier = { inboxChanged: () => notes.push('changed'), notify: (type, n) => notes.push(n.title), inboxNew: (box, n) => notes.push(n.title) };
  const handle = createTalktalkHandler({ db, notifier, client, partnerId: 'wc1234', now: () => new Date('2026-10-20T01:00:00Z') });
  handle(send('userAbcd1234', '명함 오늘 출발 되나요?'));
  const row = () => ({ ...db.prepare("SELECT id, status, subject, from_name FROM inquiries WHERE source = 'talktalk'").get() });
  assert.deepStrictEqual(row(), { id: 1, status: 'open', subject: '[톡톡] 명함 오늘 출발 되나요?', from_name: '톡톡 고객 1234' });
  assert.deepStrictEqual(passed, [['userAbcd1234', 'wc1234']]);
  assert.ok(notes.includes('새 톡톡'));
  handle({ event: 'echo', echoedEvent: 'send', user: 'userAbcd1234', textContent: { text: '네 3시 전 결제면 오늘 나가요' } });
  assert.strictEqual(row().status, 'answered');
  handle(send('userAbcd1234', '감사합니다', { options: { standby: true } }));
  assert.strictEqual(row().status, 'open');
  assert.strictEqual(passed.length, 1, '이미 파트너센터에 있으면(standby) 넘기지 않는다');
  handle({ event: 'open', user: 'userAbcd1234', options: { inflow: 'list' } });
  const msgs = db.prepare('SELECT direction, text FROM chat_messages ORDER BY id').all().map(m => [m.direction, m.text]);
  assert.deepStrictEqual(msgs, [['in', '명함 오늘 출발 되나요?'], ['out', '네 3시 전 결제면 오늘 나가요'], ['in', '감사합니다']]);
});

test('톡톡 보내기 API: 주도권 넘기기 요청 모양, 키 없으면 보내지 않음', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push([url, opts.headers.authorization, JSON.parse(opts.body)]); return new Response('{"success":true,"resultCode":"00"}'); };
  await createTalktalkClient({ authKey: 'key', fetchFn }).passThread('u1', 'wc1');
  assert.deepStrictEqual(calls[0], ['https://gw.talk.naver.com/chatbot/v1/event', 'key',
    { event: 'handover', user: 'u1', partner: 'wc1', options: { control: 'passThread', targetId: 1 } }]);
  await assert.rejects(createTalktalkClient({ authKey: '', fetchFn }).passThread('u1'), /TALKTALK_SEND_KEY/);
  const bad = async () => new Response('{"success":false,"resultCode":"01"}');
  await assert.rejects(createTalktalkClient({ authKey: 'k', fetchFn: bad }).passThread('u1'), /코드 01/);
});

test('비밀 주소로 받은 톡톡이 왼쪽 메뉴 톡톡에 말풍선으로, 답장은 파트너센터 안내, 다른 주소의 사진은 열지 않음', async t => {
  let handle;
  const ctx = await startServer({ inbox: { sourceLabels: { talktalk: '톡톡' }, talktalk: { token: TOKEN, handle: ev => handle(ev) } } });
  t.after(() => ctx.server.close());
  handle = createTalktalkHandler({ db: ctx.db });
  const post = (token, body) => fetch(`${ctx.baseUrl}/hooks/talktalk/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.strictEqual((await post('b'.repeat(48), send('u9999', 'x'))).status, 404, '비밀 주소가 틀리면 없는 주소');
  assert.strictEqual((await post(TOKEN, send('u9999', '현수막 문의요'))).status, 200);
  await post(TOKEN, { event: 'send', user: 'u9999', imageContent: { imageUrl: 'https://evil.example.com/a.jpg' } });
  addUser(ctx.db, { email: 'kim@broad.test' });
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const list = (await kim.request('/inbox?box=chat')).text;
  assert.match(list, /<h1 class="page-title">톡톡<\/h1>/);
  assert.match(list, /href="\/inbox\?box=chat" class="on">.*<span>톡톡 <span class="badge">1<\/span>/, '왼쪽 메뉴 톡톡 칸 + 미답변 숫자');
  assert.doesNotMatch(list, /data-key="chat"/, '문의함 안의 채팅 탭은 없다');
  assert.match(list, /고객 9999/);
  const id = ctx.db.prepare("SELECT id FROM inquiries WHERE source = 'talktalk'").get().id;
  const detail = (await kim.request(`/inbox/${id}`)).text;
  assert.match(detail, /class="chat-msg in">\s*<div class="chat-text">현수막 문의요/);
  assert.match(detail, /톡톡 파트너센터 열기/);
  assert.match(detail, /href="\/inbox\?box=chat" class="btn-back">← 톡톡으로/);
  assert.doesNotMatch(detail, /action="\/inbox\/\d+\/reply"/, '1단계에서는 인트라넷 답장 칸이 없다');
  const mid = ctx.db.prepare("SELECT id FROM chat_messages WHERE kind = 'image'").get().id;
  assert.strictEqual((await kim.request(`/inbox/${id}/chat-image/${mid}`)).status, 404);
  const shop = (await kim.request('/inbox')).text;
  assert.doesNotMatch(shop, /톡톡 고객/, '문의함에는 안 나옴');
  assert.match(shop, /<span>문의함<\/span>/, '문의함 숫자에 톡톡은 세지 않음');
});

test('상품 페이지에서 온 톡톡은 상품을 기억하고, 손님이 말한 주문번호(있는 주문만)로 대화를 주문과 연결한다', () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, paid_at, channel_status)
    VALUES ('smartstore', '2026102726855451', '2026102712345678', '글자스티커', '2026-10-27T00:00:00Z', 'PAYED')`).run();
  const handle = createTalktalkHandler({ db, now: () => new Date('2026-10-27T03:00:00Z') });
  handle(send('u1', '시트지 문의', { textContent: { text: '시트지 문의', inputType: 'product' },
    options: { product: { name: 'UV인쇄 실사출력 시트지', url: 'https://smartstore.naver.com/broad/products/1', thumbUrl: 'https://x' } } }));
  const row = () => db.prepare("SELECT order_no, meta FROM inquiries WHERE external_id = 'u1'").get();
  assert.deepStrictEqual(JSON.parse(row().meta).product, { name: 'UV인쇄 실사출력 시트지', url: 'https://smartstore.naver.com/broad/products/1' });
  handle(send('u1', '전화번호 010-1234-5678 이고 주문번호는 9999999999999 예요'));
  assert.strictEqual(row().order_no, null, '없는 주문번호·전화번호는 연결하지 않음');
  handle(send('u1', '주문번호 2026-1027-2685-5451 입니다'));
  assert.strictEqual(row().order_no, '2026102726855451', '- 로 끊어 써도 찾는다');
  handle(send('u1', '아 상품주문번호는 2026102712345678'));
  assert.strictEqual(row().order_no, '2026102726855451', '상품주문번호로도 같은 주문');
  // 상품 주소는 https 만 (이상한 주소는 버림)
  handle(send('u2', 'x', { options: { product: { name: '명함', url: 'javascript:alert(1)' } } }));
  assert.strictEqual(JSON.parse(db.prepare("SELECT meta FROM inquiries WHERE external_id = 'u2'").get().meta).product.url, null);
});

test('톡톡 목록: 아이콘 탭(전체·대기·진행중·보류), 마지막 말·안 읽은 수·상품 줄, 열어 보면 읽음, 검색은 대화 내용까지', async t => {
  let handle;
  const ctx = await startServer({ inbox: { sourceLabels: { talktalk: '톡톡' }, talktalk: { token: TOKEN, handle: ev => handle(ev) } } });
  t.after(() => ctx.server.close());
  const { db } = ctx;
  handle = createTalktalkHandler({ db });
  handle(send('u1111', '벽 부착용 스티커 문의요', { options: { product: { name: 'UV인쇄 실사출력 시트지', url: 'https://smartstore.naver.com/broad/products/1' } } }));
  handle(send('u1111', '사이즈는 1m 입니다'));
  handle(send('u2222', '견적 부탁드려요'));
  handle({ event: 'echo', user: 'u2222', textContent: { text: '네 확인해 볼게요' } });
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const page = async (qs = '') => (await kim.request(`/inbox?box=chat${qs}`)).text;
  const list = await page();
  assert.match(list, /대기 <b>1<\/b>/);
  assert.match(list, /진행중 <b>1<\/b>/);
  assert.match(list, /전체 <b>2<\/b>/);
  assert.match(list, /<span class="talk-tag">상품정보 문의<\/span>/);
  assert.match(list, /class="talk-product talk-product-link" href="https:\/\/smartstore.naver.com\/broad\/products\/1"/);
  assert.match(list, /사이즈는 1m 입니다<\/span>\s*<span class="talk-unread" aria-label="안 읽은 메시지 2개">2</, '마지막 말 + 안 읽은 손님 말 2개');
  assert.match(list, /<span class="talk-who">[^<]+<\/span>네 확인해 볼게요/, '우리가 마지막에 말했으면 앞에 우리 이름');
  // 검색: 첫 말이 아니어도 대화 안의 말로 찾는다
  assert.match(await page('&q=부착용'), /고객 1111/);
  assert.doesNotMatch(await page('&q=부착용'), /고객 2222/);
  // 안 읽음만 → 열어 보면 읽음
  assert.match(await page('&read=unread'), /고객 1111/);
  const id = db.prepare("SELECT id FROM inquiries WHERE external_id = 'u1111'").get().id;
  await kim.request(`/inbox/${id}`);
  assert.doesNotMatch(await page('&read=unread'), /고객 1111/);
  assert.doesNotMatch(await page(), /class="talk-unread"/);
  // 대기 탭에는 대기만
  const wait = await page('&tab=wait');
  assert.match(wait, /고객 1111/);
  assert.doesNotMatch(wait, /고객 2222/);
});

test('톡톡 대화 화면: 보류·보류 풀기, 고객 메모, 주문번호로 연결·연결 풀기 (문의함·메일 문의에는 안 됨)', async t => {
  let handle;
  const ctx = await startServer({ inbox: { sourceLabels: { talktalk: '톡톡' }, talktalk: { token: TOKEN, handle: ev => handle(ev) } } });
  t.after(() => ctx.server.close());
  const { db } = ctx;
  handle = createTalktalkHandler({ db });
  handle(send('u1111', '안녕하세요'));
  db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, buyer_name, paid_at, channel_status)
    VALUES ('smartstore', '2026102726855451', 'P1', '글자스티커 시트컷팅', '김대성', '2026-10-27T00:00:00Z', 'PAYED')`).run();
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const id = db.prepare("SELECT id FROM inquiries WHERE external_id = 'u1111'").get().id;
  const url = `/inbox/${id}`;
  const status = () => db.prepare('SELECT status FROM inquiries WHERE id = ?').get(id).status;

  assert.match((await kim.request(url)).text, /⏸ 보류/);
  await kim.submit(url, `${url}/hold`, {});
  assert.strictEqual(status(), 'closed');
  assert.match(await (await kim.request('/inbox?box=chat&tab=hold')).text, /고객 1111/);
  await kim.submit(url, `${url}/unhold`, {});
  assert.strictEqual(status(), 'open', '답한 적이 없으면 대기로');
  await kim.submit(url, `${url}/hold`, {});
  handle(send('u1111', '혹시 확인되셨나요?'));
  assert.strictEqual(status(), 'open', '보류 중에 손님이 말하면 다시 대기');

  await kim.submit(url, `${url}/memo`, { cust_memo: '  실사-김대성 ' });
  assert.match((await kim.request('/inbox?box=chat')).text, /<span class="talk-memo">실사-김대성<\/span>/);

  await kim.submit(url, `${url}/link-order`, { order_no: '1234567890' });
  assert.match((await kim.request(url)).text, /찾지 못했어요/);
  await kim.submit(url, `${url}/link-order`, { order_no: '2026-1027-2685-5451' });
  assert.strictEqual(db.prepare('SELECT order_no FROM inquiries WHERE id = ?').get(id).order_no, '2026102726855451');
  const detail = (await kim.request(url)).text;
  assert.match(detail, /연결된 주문/);
  assert.match(detail, /글자스티커 시트컷팅/);
  assert.match((await kim.request('/inbox?box=chat')).text, /주문 연결<\/span>/);
  await kim.submit(url, `${url}/unlink-order`, {});
  assert.strictEqual(db.prepare('SELECT order_no FROM inquiries WHERE id = ?').get(id).order_no, null);

  // 대화에 예전에 말한 주문번호: 주문이 나중에 들어와도 대화를 열면 연결
  handle(send('u3333', '주문번호 2026103000000001 확인 부탁해요'));
  const id3 = db.prepare("SELECT id FROM inquiries WHERE external_id = 'u3333'").get().id;
  assert.strictEqual(db.prepare('SELECT order_no FROM inquiries WHERE id = ?').get(id3).order_no, null);
  db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, paid_at, channel_status)
    VALUES ('smartstore', '2026103000000001', 'P9', '현수막', '2026-10-30T00:00:00Z', 'PAYED')`).run();
  await kim.request(`/inbox/${id3}`);
  assert.strictEqual(db.prepare('SELECT order_no FROM inquiries WHERE id = ?').get(id3).order_no, '2026103000000001');

  // 톡톡이 아닌 문의에는 이 처리들이 안 된다
  db.prepare(`INSERT INTO inquiries (source, external_id, subject, body, received_at) VALUES ('naver_qna', 'q1', '상품문의', '', '2026-10-27T00:00:00Z')`).run();
  const qid = db.prepare("SELECT id FROM inquiries WHERE external_id = 'q1'").get().id;
  await kim.submit(`/inbox/${qid}`, `/inbox/${qid}/hold`, {});
  assert.strictEqual(db.prepare('SELECT status FROM inquiries WHERE id = ?').get(qid).status, 'open');
});
