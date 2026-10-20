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
  const notifier = { inboxChanged: () => notes.push('changed'), notify: (type, n) => notes.push(n.title) };
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

test('비밀 주소로 받은 톡톡이 💬 채팅 탭에 말풍선으로, 답장은 파트너센터 안내, 다른 주소의 사진은 열지 않음', async t => {
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
  assert.match(list, /💬 채팅/);
  assert.match(list, /톡톡 고객 9999/);
  const id = ctx.db.prepare("SELECT id FROM inquiries WHERE source = 'talktalk'").get().id;
  const detail = (await kim.request(`/inbox/${id}`)).text;
  assert.match(detail, /class="chat-msg in">\s*<div class="chat-text">현수막 문의요/);
  assert.match(detail, /톡톡 파트너센터 열기/);
  assert.doesNotMatch(detail, /action="\/inbox\/\d+\/reply"/, '1단계에서는 인트라넷 답장 칸이 없다');
  const mid = ctx.db.prepare("SELECT id FROM chat_messages WHERE kind = 'image'").get().id;
  assert.strictEqual((await kim.request(`/inbox/${id}/chat-image/${mid}`)).status, 404);
  assert.doesNotMatch((await kim.request('/inbox?box=shop')).text, /톡톡 고객/, '쇼핑몰 문의 탭에는 안 나옴');
});
