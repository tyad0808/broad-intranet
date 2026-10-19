// 4차 문의함: 메일 받기·답장, 문의함 화면
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { parseMail, createMailSource, createMailSender, mailAccountsFromEnv } = require('../src/inbox/mail');
const { createInboxCollector } = require('../src/inbox/collector');
const { startServer, addUser, loginAs } = require('./helpers');

const raw = ({ from = '홍길동 <hong@example.com>', subject = '견적 문의드립니다', body = '현수막 3m 가격 알려주세요', extra = '', html = false } = {}) => Buffer.from([
  `From: ${from}`,
  'To: shop@naver.com',
  `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
  'Message-ID: <abc123@example.com>',
  'References: <prev1@example.com>',
  'Date: Mon, 19 Oct 2026 10:00:00 +0900',
  'MIME-Version: 1.0',
  extra || null,
  `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset=utf-8`,
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(body).toString('base64'),
].filter(l => l !== null).join('\r\n'));

test('메일 한 통 → 문의: 제목·보낸 사람·본문(글자)·답장 주소·대화 묶음 값', async () => {
  const m = await parseMail('naver_mail', raw({ extra: 'Reply-To: 담당자 <reply@example.com>' }), { uidKey: '7:42', flags: new Set(['\\Seen']) });
  assert.deepStrictEqual(
    [m.external_id, m.from_name, m.from_addr, m.reply_to, m.subject, m.body, m.message_id, m.references_hdr, m.answered],
    ['7:42', '홍길동', 'hong@example.com', 'reply@example.com', '견적 문의드립니다', '현수막 3m 가격 알려주세요', '<abc123@example.com>', '<prev1@example.com>', false]);
  assert.strictEqual(m.received_at, '2026-10-19T01:00:00.000Z');

  const h = await parseMail('gmail', raw({ html: true, body: '<p>안녕하세요<br>시안 <b>확인</b></p><script>alert(1)</script>' }), { uidKey: '1:1', flags: new Set(['\\Answered']) });
  assert.ok(!/[<>]/.test(h.body), 'HTML 은 글자로');
  assert.match(h.body, /안녕하세요\n?시안 ?확인/);
  assert.ok(!h.body.includes('alert'));
  assert.strictEqual(h.answered, true, '메일 사이트에서 답장한 메일');
});

test('.env 에 아이디·앱 비밀번호가 둘 다 있는 메일만 연결한다', () => {
  const list = mailAccountsFromEnv({ NAVER_MAIL_USER: 'a@naver.com', NAVER_MAIL_PASS: 'x', GMAIL_USER: 'b@gmail.com' });
  assert.deepStrictEqual(list.map(a => [a.source, a.imap, a.smtp]), [['naver_mail', 'imap.naver.com', 'smtp.naver.com']]);
});

// IMAP 흉내: uid → { raw, flags, size }
function fakeImap(box, { uidValidity = 7 } = {}) {
  const calls = { search: [], logout: 0, flagsAdded: [], appended: [] };
  const client = {
    mailbox: { uidValidity: BigInt(uidValidity) },
    async getMailboxLock() { return { release() {} }; },
    async search(q) {
      calls.search.push(q);
      const uids = Object.keys(box).map(Number);
      if (q.since) return uids;
      const from = Number(String(q.uid).split(':')[0]);
      const max = Math.max(...uids);
      return uids.filter(u => u >= from).concat(from > max ? [max] : []); // IMAP 의 'N:*' 는 N 이 넘어가도 마지막 메일을 준다
    },
    async fetchOne(uid, query) {
      const m = box[uid];
      if (!m) return false;
      if (query.source) return { uid: Number(uid), source: m.raw };
      return { uid: Number(uid), flags: new Set(m.flags || []), size: m.size || m.raw.length, internalDate: new Date('2026-10-19T01:00:00Z'), envelope: { subject: '큰 메일', from: [{ name: '큰', address: 'big@x.com' }] } };
    },
    async *fetch(range) {
      for (const uid of String(range).split(',')) yield { uid: Number(uid), flags: new Set(box[uid].flags || []) };
    },
    async messageFlagsAdd(uid, flags) { calls.flagsAdded.push([String(uid), flags]); },
    async list() { return [{ path: 'INBOX' }, { path: '보낸메일함', specialUse: '\\Sent' }]; },
    async append(path, content) { calls.appended.push(path); },
    async logout() { calls.logout++; },
  };
  return { client, calls, connect: async () => client };
}

test('받은편지함: 처음엔 최근 30일, 다음부터는 지난번 다음 메일만. 큰 메일은 본문 없이', async () => {
  const box = { 41: { raw: raw() }, 42: { raw: raw({ subject: '두 번째' }), flags: ['\\Answered'] }, 43: { raw: raw(), size: 20 * 1024 * 1024 } };
  const { calls, connect } = fakeImap(box);
  const src = createMailSource({ source: 'naver_mail', label: '네이버메일' }, { connect });
  const first = await src.fetch({ state: {} });
  assert.ok(calls.search[0].since, '처음엔 날짜로');
  assert.deepStrictEqual(first.items.map(i => [i.external_id, i.subject, i.answered]), [['7:41', '견적 문의드립니다', false], ['7:42', '두 번째', true], ['7:43', '큰 메일', false]]);
  assert.match(first.items[2].body, /메일이 커서/);
  assert.deepStrictEqual(first.state, { uidValidity: '7', lastUid: 43 });
  assert.strictEqual(calls.logout, 1);

  // 새 메일이 없으면 아무것도 안 가져온다 ('44:*' 가 43 을 돌려줘도 걸러냄)
  const again = await src.fetch({ state: first.state, openIds: ['7:41'] });
  assert.deepStrictEqual(again.items, []);
  assert.deepStrictEqual(again.state, first.state);

  // 41번을 메일 사이트에서 답장 → 답변완료 대상으로
  box[41].flags = ['\\Answered'];
  box[44] = { raw: raw({ subject: '세 번째' }) };
  const third = await src.fetch({ state: first.state, openIds: ['7:41'] });
  assert.deepStrictEqual(third.items.map(i => i.external_id), ['7:44']);
  assert.deepStrictEqual(third.answeredIds, ['7:41']);
});

test('문의함 수집: 새 메일만 넣고, 다시 받아도 중복 없음, 메일 사이트에서 답장하면 답변완료. 알림은 최근 메일만', async () => {
  const db = openDb(':memory:');
  const notes = [];
  const notifier = { notify: (type, data) => notes.push(data), inboxChanged: () => {} };
  let batch = [];
  const src = {
    source: 'gmail', label: '지메일',
    async fetch({ openIds }) { return { items: batch, answeredIds: openIds.filter(id => id === '1:1'), state: { uidValidity: '1', lastUid: 9 } }; },
  };
  const item = (id, receivedAt, answered = false) => ({ source: 'gmail', external_id: id, from_name: '고객', from_addr: 'c@x.com', reply_to: null,
    subject: `문의 ${id}`, body: '내용', attachments: '[]', message_id: null, references_hdr: null, received_at: receivedAt, answered });
  const now = new Date('2026-10-19T02:00:00Z');
  const col = createInboxCollector({ db, sources: [src], notifier, now: () => now });
  batch = [item('1:1', '2026-10-01T00:00:00Z'), item('1:2', '2026-10-19T01:30:00Z'), item('1:3', '2026-10-19T01:40:00Z', true)];
  const r1 = await col.run();
  assert.deepStrictEqual([r1.ok, r1.created], [true, 3]);
  const rows = () => db.prepare('SELECT external_id, status FROM inquiries ORDER BY external_id').all().map(r => [r.external_id, r.status]);
  assert.deepStrictEqual(rows(), [['1:1', 'open'], ['1:2', 'open'], ['1:3', 'answered']]);
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].title, /새 문의 \(지메일\)/, '오래된 메일·이미 답장한 메일은 알리지 않음');
  assert.strictEqual(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'inbox_state_gmail'").get().value).lastUid, 9);

  const r2 = await col.run();
  assert.strictEqual(r2.created, 0);
  assert.strictEqual(r2.answered, 1);
  assert.deepStrictEqual(rows()[0], ['1:1', 'answered']);

  // 한 메일 계정이 실패해도 결과에 남기고 나머지는 계속
  const bad = { source: 'naver_mail', label: '네이버메일', fetch: async () => { throw new Error('로그인 실패'); } };
  const r3 = await createInboxCollector({ db, sources: [bad, src], notifier, now: () => now }).run();
  assert.deepStrictEqual([r3.ok, r3.errors], [false, ['네이버메일: 로그인 실패']]);
});

test('답장: 같은 대화로 묶이게 보내고, 원래 메일에 답장 표시 + 네이버는 보낸메일함에 복사. 실패 구분', async () => {
  const sent = [];
  const okTransport = { sendMail: async m => { sent.push(m); return { accepted: m.envelope.to, rejected: [] }; } };
  const { calls, connect } = fakeImap({});
  const account = { source: 'naver_mail', label: '네이버메일', user: 'shop@naver.com', saveSent: true };
  const sender = createMailSender(account, { transport: okTransport, connect, fromName: '브로애드' });
  const inquiry = { external_id: '7:41', from_addr: 'hong@example.com', reply_to: null, subject: '견적 문의', message_id: '<abc@x>', references_hdr: '<prev@x>' };
  const r = await sender.reply(inquiry, '안녕하세요, 견적 보내드립니다.');
  assert.strictEqual(r.result, 'ok');
  assert.deepStrictEqual(sent[0].envelope, { from: 'shop@naver.com', to: ['hong@example.com'] });
  const text = sent[0].raw.toString();
  assert.match(text, /In-Reply-To: <abc@x>/);
  assert.match(text, /References: <prev@x> <abc@x>/);
  assert.match(text, /Subject: =\?UTF-8\?B\?/);
  assert.deepStrictEqual(calls.flagsAdded, [['41', ['\\Answered']]]);
  assert.deepStrictEqual(calls.appended, ['보낸메일함']);

  const authFail = createMailSender(account, { transport: { sendMail: async () => { throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' }); } }, connect });
  assert.strictEqual((await authFail.reply(inquiry, 'x')).result, 'fail');
  const cut = createMailSender(account, { transport: { sendMail: async () => { throw Object.assign(new Error('Connection closed'), { code: 'ECONNRESET' }); } }, connect });
  const r3 = await cut.reply(inquiry, 'x');
  assert.strictEqual(r3.result, 'unknown');
  assert.match(r3.message, /보낸메일함에서 나갔는지/);
});

// ───────── 화면 ─────────
async function setupInbox(t, { senders = {} } = {}) {
  const sourceLabels = { naver_mail: '네이버메일', gmail: '지메일' };
  const ctx = await startServer({ inbox: { sourceLabels, senders } });
  t.after(() => ctx.server.close());
  const { db } = ctx;
  ctx.kimId = addUser(db, { email: 'kim@broad.test', name: '김상담' });
  ctx.leeId = addUser(db, { email: 'lee@broad.test', name: '이디자' });
  ctx.kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const add = db.prepare(`INSERT INTO inquiries (source, external_id, from_name, from_addr, subject, body, attachments, message_id, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ctx.id1 = Number(add.run('naver_mail', '7:1', '홍길동', 'hong@example.com', '견적 문의', '현수막 가격\n알려주세요 <script>alert(1)</script>', '[{"name":"시안.ai","size":204800}]', '<m1@x>', '2026-10-19T01:00:00Z').lastInsertRowid);
  ctx.id2 = Number(add.run('gmail', '1:1', '광고', 'ad@spam.com', '특가 안내', '광고입니다', '[]', null, '2026-10-19T00:00:00Z').lastInsertRowid);
  ctx.row = id => ({ ...db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id) });
  return ctx;
}

test('문의함 목록: 위쪽 메뉴에 미답변 건수, 출처 칩·탭, 본문은 글자로만', async t => {
  const { kim, id1 } = await setupInbox(t);
  const home = (await kim.request('/')).text;
  assert.match(home, /문의함 <span class="badge">2<\/span>/);
  const list = (await kim.request('/inbox')).text;
  assert.match(list, /미답변 <span class="count">2<\/span>/);
  assert.match(list, /네이버메일 <span class="count">1<\/span>/);
  assert.match(list, /견적 문의/);
  assert.match(list, /연습 모드/);
  const gmailOnly = (await kim.request('/inbox?src=gmail')).text;
  assert.ok(gmailOnly.includes('특가 안내') && !gmailOnly.includes('견적 문의'));
  const found = (await kim.request('/inbox?q=' + encodeURIComponent('현수막'))).text;
  assert.ok(found.includes('견적 문의') && !found.includes('특가 안내'));

  const detail = (await kim.request(`/inbox/${id1}`)).text;
  assert.ok(!detail.includes('<script>alert(1)'));
  assert.match(detail, /&lt;script&gt;alert\(1\)/);
  assert.match(detail, /시안\.ai/);
});

test('연습 모드 답변: 보내지 않고 기록만, 미답변 그대로', async t => {
  const { kim, id1, row, db } = await setupInbox(t);
  const res = await kim.submit(`/inbox/${id1}`, `/inbox/${id1}/reply`, { body: '견적 보내드립니다', version: '0' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(row(id1).status, 'open');
  const rep = db.prepare('SELECT * FROM inquiry_replies').get();
  assert.deepStrictEqual([rep.mode, rep.result, rep.body], ['practice', 'practice', '견적 보내드립니다']);
  assert.match((await kim.request(`/inbox/${id1}`)).text, /연습/);
});

test('실제 답변: 보낸 메일이 성공하면 답변완료, 실패면 미답변 그대로, 다른 직원이 먼저 바꿨으면 막는다', async t => {
  const replies = [];
  let next = { result: 'ok', message: 'hong@example.com 로 답장을 보냈습니다.' };
  const sender = { reply: async (inq, body) => { replies.push([inq.from_addr, body]); return next; } };
  const { kim, kimId, id1, row } = await setupInbox(t, { senders: { naver_mail: sender } });
  assert.ok(!(await kim.request('/inbox?src=naver_mail')).text.includes('네이버메일 답변을 보내도 실제로'));

  const stale = await kim.submit(`/inbox/${id1}`, `/inbox/${id1}/reply`, { body: '답', version: '5' });
  assert.strictEqual(stale.status, 302);
  assert.strictEqual(replies.length, 0, '버전이 다르면 보내지 않음');

  next = { result: 'fail', message: '보내지 못했습니다 — Invalid login' };
  await kim.submit(`/inbox/${id1}`, `/inbox/${id1}/reply`, { body: '첫 시도', version: '0' });
  assert.strictEqual(row(id1).status, 'open');

  next = { result: 'ok', message: '보냄' };
  await kim.submit(`/inbox/${id1}`, `/inbox/${id1}/reply`, { body: '견적 보내드립니다', version: String(row(id1).version) });
  assert.deepStrictEqual(replies[1], ['hong@example.com', '견적 보내드립니다']);
  assert.deepStrictEqual([row(id1).status, row(id1).handled_by], ['answered', kimId]);
  assert.match((await kim.request('/inbox?tab=done')).text, /견적 문의/);
});

test('담당자 지정·처리 완료·다시 열기·여러 건 처리 완료', async t => {
  const { kim, leeId, id1, id2, row } = await setupInbox(t);
  await kim.submit('/inbox', `/inbox/${id1}/assign`, { assignee_id: String(leeId) });
  assert.strictEqual(row(id1).assignee_id, leeId);
  await kim.submit(`/inbox/${id2}`, `/inbox/${id2}/close`, {});
  assert.strictEqual(row(id2).status, 'closed');
  await kim.submit(`/inbox/${id2}`, `/inbox/${id2}/reopen`, {});
  assert.strictEqual(row(id2).status, 'open');
  const res = await kim.submit('/inbox', '/inbox/bulk/close', { ids: [String(id1), String(id2)] });
  assert.strictEqual(res.location, '/inbox');
  assert.deepStrictEqual([row(id1).status, row(id2).status], ['closed', 'closed']);
  assert.ok(!(await kim.request('/')).text.includes('문의함 <span class="badge">'), '미답변이 없으면 숫자 없음');
});
