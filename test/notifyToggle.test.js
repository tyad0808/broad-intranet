// 왼쪽 메뉴 종 버튼: 메일함·문의함 알림을 직원마다 끄고 켠다
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createNotifier } = require('../src/notifier');
const { createInboxCollector } = require('../src/inbox/collector');
const { startServer, addUser, loginAs } = require('./helpers');

test('끈 칸은 왼쪽 메뉴 숫자가 사라지고 종이 꺼진 모양, 다시 누르면 켜짐 (직원마다 따로)', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test' });
  addUser(db, { email: 'lee@broad.test' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const lee = await loginAs(baseUrl, 'lee@broad.test');
  const q = db.prepare('INSERT INTO inquiries (source, external_id, subject, body, received_at) VALUES (?, ?, ?, ?, ?)');
  q.run('naver_mail', '1:1', '메일', '', '2026-10-23T00:00:00Z');
  q.run('naver_mail', '1:2', '메일', '', '2026-10-23T00:00:00Z');
  q.run('coupang_qna', 'p:1', '문의', '', '2026-10-23T00:00:00Z');
  const badges = text => [...text.matchAll(/<span>(메일함|문의함) <span class="badge">(\d+)<\/span>/g)].map(m => `${m[1]}${m[2]}`);
  assert.deepStrictEqual(badges((await kim.request('/')).text), ['메일함2', '문의함1']);

  const r = await kim.submit('/', '/me/notify/mail', { back: '/schedule' });
  assert.strictEqual(r.location, '/schedule');
  const page = (await kim.request('/')).text;
  assert.deepStrictEqual(badges(page), ['문의함1'], '메일함 숫자가 사라짐');
  assert.match(page, /class="nav-row off"[\s\S]*?메일함 알림 꺼짐/);
  assert.deepStrictEqual(badges((await lee.request('/')).text), ['메일함2', '문의함1'], '다른 직원은 그대로');

  await kim.submit('/', '/me/notify/mail', { back: '/' });
  assert.deepStrictEqual(badges((await kim.request('/')).text), ['메일함2', '문의함1']);
  assert.strictEqual((await kim.submit('/', '/me/notify/orders', {})).status, 400);
});

test('새 메일·새 문의 알림은 따로, 그 칸을 끈 직원에게는 보내지 않는다', async () => {
  const db = openDb(':memory:');
  const add = (name, off) => Number(db.prepare("INSERT INTO users (email, password_hash, name, role, status, notify_off) VALUES (?, 'x', ?, 'staff', 'active', ?)")
    .run(`${name}@x`, name, off).lastInsertRowid);
  const all = add('all', null);
  const noMail = add('nomail', '["mail"]');
  const sent = [];
  const hub = { send: (event, data, canReceive) => sent.push({ type: data.type, to: [all, noMail].filter(id => canReceive(id)) }), add() {} };
  const notifier = createNotifier({ db, hub });
  const now = new Date('2026-10-23T02:00:00Z');
  const it = (source, id) => ({ source, external_id: id, from_name: '고객', from_addr: null, reply_to: null, subject: id, body: '', attachments: '[]',
    message_id: null, references_hdr: null, received_at: '2026-10-23T01:50:00Z' });
  const items = [it('naver_mail', '1:1'), it('coupang_qna', 'p:1')];
  const col = createInboxCollector({ db, notifier, now: () => now, sources: [
    { source: 'naver_mail', label: '네이버메일', fetch: async () => ({ items: [items[0]], state: {} }) },
    { source: 'coupang_qna', label: '쿠팡', fetch: async () => ({ items: [items[1]], state: {} }) },
  ] });
  await col.run();
  const notes = sent.filter(s => s.type);
  assert.deepStrictEqual(notes, [{ type: 'new_mail', to: [all] }, { type: 'new_inquiry', to: [all, noMail] }]);
});
