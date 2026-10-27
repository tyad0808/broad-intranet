// 5차 채팅: 네이버 톡톡
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { ipAllowed, messageOf, createTalktalkHandler, createTalktalkClient, createTalktalkSender, createTalkImages, imageKind } = require('../src/inbox/talktalk');
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

test('비밀 주소로 받은 톡톡이 왼쪽 메뉴 톡톡에 말풍선으로, 답장 칸과 파트너센터 링크, 다른 주소의 사진은 열지 않음', async t => {
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
  assert.match(detail, /파트너센터 ↗/);
  assert.match(detail, /href="\/inbox\?box=chat" class="btn-back">← 톡톡으로/);
  assert.match(detail, /action="\/inbox\/\d+\/reply"/, '인트라넷에서도 답장할 수 있다');
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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-png')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);

test('톡톡 답장 보내기: 대화 가져오기 → 사진(네이버가 1분짜리 주소에서 가져감) → 글 → 파트너센터로 다시 넘기기', async () => {
  assert.deepStrictEqual([imageKind(PNG), imageKind(JPG), imageKind(Buffer.from('GIF89a...')), imageKind(Buffer.from('%PDF-1.4 abc'))],
    ['image/png', 'image/jpeg', 'image/gif', null]);
  const images = createTalkImages();
  const calls = [];
  const client = {
    takeThread: async (user, partner) => calls.push(['take', user, partner]),
    uploadImage: async url => {
      const token = url.split('/').pop();
      const img = images.get(token);
      calls.push(['upload', url.replace(token, 'TOKEN'), img && img.type, img && img.content.length]);
      return `img-${calls.length}`;
    },
    send: async (user, content) => calls.push(['send', user, content]),
    passThread: async (user, partner) => calls.push(['pass', user, partner]),
  };
  const sender = createTalktalkSender({ client, images, publicUrl: 'https://intra.test/', partnerId: 'wc1', log: { warn() {} } });
  const out = await sender.reply({ external_id: 'u1' }, '시안 보내드려요', [{ name: 'a.png', content: PNG }, { name: 'b.jpg', content: JPG }]);
  assert.strictEqual(out.result, 'ok');
  assert.deepStrictEqual(out.sent, [{ kind: 'image', name: 'a.png' }, { kind: 'image', name: 'b.jpg' }, { kind: 'text', text: '시안 보내드려요' }]);
  assert.deepStrictEqual(calls, [
    ['take', 'u1', 'wc1'],
    ['upload', 'https://intra.test/talk-img/TOKEN', 'image/png', PNG.length],
    ['send', 'u1', { imageContent: { imageId: 'img-2' } }],
    ['upload', 'https://intra.test/talk-img/TOKEN', 'image/jpeg', JPG.length],
    ['send', 'u1', { imageContent: { imageId: 'img-4' } }],
    ['send', 'u1', { textContent: { text: '시안 보내드려요' } }],
    ['pass', 'u1', 'wc1'],
  ]);
  // 네이버가 가져간 뒤에는 그 주소가 사라진다
  const token = images.put(PNG, 'image/png');
  images.remove(token);
  assert.strictEqual(images.get(token), null);

  // 중간에 실패하면: 보낸 것까지만 알려 주고, 대화는 그래도 파트너센터로 넘긴다. 가져오기 실패는 그냥 보내 본다
  calls.length = 0;
  const failing = { ...client, takeThread: async () => { throw new Error('이미 챗봇'); }, send: async (u, c) => { if (c.textContent) throw new Error('톡톡 API 오류 (코드 99)'); calls.push(['send']); } };
  const bad = await createTalktalkSender({ client: failing, images, publicUrl: 'https://intra.test', log: { warn() {} } }).reply({ external_id: 'u1' }, '글', [{ name: 'a.png', content: PNG }]);
  assert.strictEqual(bad.result, 'error');
  assert.match(bad.message, /앞의 1개는 보냄.*코드 99/);
  assert.deepStrictEqual(bad.sent, [{ kind: 'image', name: 'a.png' }]);
  assert.deepStrictEqual(calls.map(c => c[0]), ['upload', 'send', 'pass']);
});

test('사진 주소(/talk-img): 1분 동안 로그인 없이 그 사진만, 그 밖에는 없음', async t => {
  const images = createTalkImages();
  const ctx = await startServer({ inbox: { sourceLabels: { talktalk: '톡톡' }, talktalk: { token: TOKEN, handle: () => {}, images } } });
  t.after(() => ctx.server.close());
  const token = images.put(PNG, 'image/png');
  const r = await fetch(`${ctx.baseUrl}/talk-img/${token}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/png');
  assert.strictEqual(Buffer.from(await r.arrayBuffer()).length, PNG.length);
  assert.strictEqual((await fetch(`${ctx.baseUrl}/talk-img/${'0'.repeat(48)}`)).status, 404);
  const old = createTalkImages({ ttlMs: 60_000, now: () => 0 });
  const k = old.put(PNG, 'image/png');
  assert.ok(old.get(k));
  const later = createTalkImages({ ttlMs: -1 });
  assert.strictEqual(later.get(later.put(PNG, 'image/png')), null, '시간이 지나면 없음');
});

test('인트라넷 톡톡 답장: 글·사진(끌어다 놓기·첨부) 보내면 대화에 우리 말풍선, 되돌아온 echo 는 하나로 합침, 사진 아닌 파일은 막음, 연습 모드는 기록만', async t => {
  let handle;
  const got = [];
  const sender = { reply: async (inq, body, files) => {
    got.push([inq.external_id, body, files.map(f => f.name)]);
    return { result: 'ok', message: '톡톡으로 보냈습니다.', sent: [...files.map(f => ({ kind: 'image', name: f.name })), ...(body ? [{ kind: 'text', text: body }] : [])] };
  } };
  const ctx = await startServer({ inbox: { sourceLabels: { talktalk: '톡톡' }, senders: { talktalk: sender }, talktalk: { token: TOKEN, handle: ev => handle(ev) } } });
  t.after(() => ctx.server.close());
  const { db, baseUrl } = ctx;
  handle = createTalktalkHandler({ db });
  handle(send('u1111', '이런걸 제작하고 싶은데, 개당 단가가 어떻게 되나요?'));
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const id = db.prepare("SELECT id FROM inquiries WHERE external_id = 'u1111'").get().id;
  const page = (await kim.request(`/inbox/${id}`)).text;
  assert.match(page, /action="\/inbox\/\d+\/reply"/, '인트라넷 답장 칸이 있다');
  assert.match(page, /data-drop-zone data-images/);
  assert.match(page, /accept="image\/jpeg,image\/png,image\/gif"/);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const reply = (body, files) => {
    const form = new FormData();
    form.append('_csrf', csrf);
    form.append('version', '0'); // 톡톡은 버전 검사를 하지 않는다 (손님 말이 오면 바뀜)
    form.append('body', body);
    for (const [name, content, type] of files) form.append('files', new Blob([content], { type }), name);
    return fetch(`${baseUrl}/inbox/${id}/reply`, { method: 'POST', body: form, headers: { cookie: kim.cookie() }, redirect: 'manual' });
  };
  await reply('개당 3,000원입니다', [['시안.png', PNG, 'image/png']]);
  assert.deepStrictEqual(got, [['u1111', '개당 3,000원입니다', ['시안.png']]]);
  const thread = () => db.prepare("SELECT direction, kind, text, image_url, sender, echoed FROM chat_messages WHERE inquiry_id = ? ORDER BY id").all(id).map(r => ({ ...r }));
  assert.deepStrictEqual(thread().slice(1).map(m => [m.direction, m.kind, m.text, m.echoed]), [['out', 'image', '📷 시안.png', 0], ['out', 'text', '개당 3,000원입니다', 0]]);
  assert.strictEqual(db.prepare('SELECT status FROM inquiries WHERE id = ?').get(id).status, 'answered');
  assert.match((await kim.request(`/inbox/${id}`)).text, /김직원 · /, '보낸 직원 이름');

  // 네이버가 되돌려 준 echo: 새로 쌓지 않고 확인만 (사진은 네이버 주소를 받아 둠)
  handle({ event: 'echo', user: 'u1111', imageContent: { imageUrl: 'https://talk.pstatic.net/x.png' } });
  handle({ event: 'echo', user: 'u1111', textContent: { text: '개당 3,000원입니다' } });
  assert.strictEqual(thread().length, 3);
  assert.deepStrictEqual(thread().slice(1).map(m => [m.echoed, m.image_url]), [[1, 'https://talk.pstatic.net/x.png'], [1, null]]);
  // 파트너센터에서 직접 보낸 말은 그대로 쌓인다
  handle({ event: 'echo', user: 'u1111', textContent: { text: '파트너센터에서 보냄' } });
  assert.strictEqual(thread().length, 4);

  // 사진만 보내도 된다 / 사진이 아닌 파일은 막는다
  await reply('', [['b.jpg', JPG, 'image/jpeg']]);
  assert.deepStrictEqual(got[1], ['u1111', '', ['b.jpg']]);
  await reply('', [['견적서.pdf', Buffer.from('%PDF-1.4'), 'application/pdf']]);
  assert.strictEqual(got.length, 2);
  assert.match((await kim.request(`/inbox/${id}`)).text, /사진\(JPG·PNG·GIF\)만/);
  await reply('', []);
  assert.strictEqual(got.length, 2, '빈 답장은 안 보냄');
});

test('톡톡 답장 연습 모드: 손님에게 안 나가고 기록만 (대화 말풍선도 안 생김)', async t => {
  let handle;
  const ctx = await startServer({ inbox: { sourceLabels: { talktalk: '톡톡' }, talktalk: { token: TOKEN, handle: ev => handle(ev) } } });
  t.after(() => ctx.server.close());
  const { db } = ctx;
  handle = createTalktalkHandler({ db });
  handle(send('u1111', '안녕하세요'));
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const id = db.prepare("SELECT id FROM inquiries WHERE external_id = 'u1111'").get().id;
  assert.match((await kim.request(`/inbox/${id}`)).text, /<strong>연습 모드<\/strong> 보내기를 눌러도 손님에게 나가지 않고/);
  await kim.submit(`/inbox/${id}`, `/inbox/${id}/reply`, { body: '네 안녕하세요', version: '0' });
  assert.strictEqual(db.prepare("SELECT result FROM inquiry_replies WHERE inquiry_id = ?").get(id).result, 'practice');
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE inquiry_id = ? AND direction = 'out'").get(id).n, 0);
  assert.match((await kim.request(`/inbox/${id}`)).text, /TALKTALK_ANSWER=on/);
});
