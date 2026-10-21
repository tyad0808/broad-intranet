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

test('.env 에 아이디·앱 비밀번호가 둘 다 있는 메일만 연결하고, 같은 종류 여러 개(…2)도 되며 화면 이름은 메일 주소', () => {
  const list = mailAccountsFromEnv({
    NAVER_MAIL_USER: 'a@naver.com', NAVER_MAIL_PASS: 'x', GMAIL_USER: 'b@gmail.com',
    NAVER_MAIL2_USER: ' bro_ad@naver.com ', NAVER_MAIL2_PASS: 'y', NAVER_MAIL3_USER: 'c@naver.com',
  });
  assert.deepStrictEqual(list.map(a => [a.source, a.label, a.imap, a.smtp]), [
    ['naver_mail', 'a@naver.com', 'imap.naver.com', 'smtp.naver.com'],
    ['naver_mail2', 'bro_ad@naver.com', 'imap.naver.com', 'smtp.naver.com'],
  ]);
  const { isMailSource } = require('../src/inbox/mail');
  assert.ok(isMailSource('naver_mail2') && isMailSource('gmail') && !isMailSource('smartstore_qna'));
});

test('메일 계정이 여러 개면 메일 탭에 주소별로 칩이 나오고 각각 거를 수 있다', async t => {
  const ctx = await startServer({ inbox: { sourceLabels: { naver_mail: 'a@naver.com', naver_mail2: 'bro_ad@naver.com' } } });
  t.after(() => ctx.server.close());
  addUser(ctx.db, { email: 'kim@broad.test' });
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const add = ctx.db.prepare(`INSERT INTO inquiries (source, external_id, subject, body, attachments, received_at) VALUES (?, ?, ?, '', '[]', '2026-10-19T01:00:00Z')`);
  add.run('naver_mail', '1:1', '첫 번째 계정 메일');
  add.run('naver_mail2', '1:1', '두 번째 계정 메일');
  const mail = (await kim.request('/inbox?box=mail')).text;
  assert.match(mail, /네이버메일 · a <span class="count">1<\/span>/, '같은 종류가 둘이면 칩에 아이디를 붙여 구분');
  assert.match(mail, /네이버메일 · bro_ad <span class="count">1<\/span>/);
  assert.match(mail, /class="src-tag src-naver_mail2">bro_ad@naver\.com</);
  const second = (await kim.request('/inbox?src=naver_mail2')).text;
  assert.ok(second.includes('두 번째 계정 메일') && !second.includes('첫 번째 계정 메일'));
  assert.ok(!(await kim.request('/inbox')).text.includes('계정 메일'), '쇼핑몰 탭엔 안 나옴');
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
    // 여러 통을 한 번에 묻기 (제목·구조 / 본문 / 표시)
    async *fetch(range, query) {
      calls.fetches = (calls.fetches || 0) + 1;
      for (const uid of String(range).split(',')) {
        const m = box[uid];
        if (query.source) yield { uid: Number(uid), source: m.raw };
        else yield { uid: Number(uid), flags: new Set(m.flags || []), size: m.size || m.raw.length, internalDate: new Date('2026-10-19T01:00:00Z'), envelope: { subject: '큰 메일', from: [{ name: '큰', address: 'big@x.com' }] } };
      }
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
  assert.strictEqual(calls.fetches, 2, '메일마다 따로 묻지 않고 한 번에 (제목·구조 1번 + 본문 1번)');
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
  await r.followUp; // '답장함' 표시·보낸메일함 복사는 화면을 돌려준 뒤에
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
  const list = (await kim.request('/inbox?box=mail')).text;
  assert.match(list, /미답변 <span class="count">2<\/span>/);
  assert.match(list, /네이버메일 <span class="count">1<\/span>/);
  assert.match(list, /견적 문의/);
  assert.match(list, /연습 모드/);
  const gmailOnly = (await kim.request('/inbox?src=gmail')).text;
  assert.ok(gmailOnly.includes('특가 안내') && !gmailOnly.includes('견적 문의'));
  const found = (await kim.request('/inbox?box=mail&q=' + encodeURIComponent('현수막'))).text;
  assert.ok(found.includes('견적 문의') && !found.includes('특가 안내'));

  const detail = (await kim.request(`/inbox/${id1}`)).text;
  assert.ok(!detail.includes('<script>alert(1)'));
  assert.match(detail, /&lt;script&gt;alert\(1\)/);
  assert.match(detail, /시안\.ai/);
});

test('문의함 검색: 처음엔 전체 탭, 띄어쓰기 단어 모두 포함, 주문번호, 찾은 단어 칠하기, 다른 큰 탭 결과 안내', async t => {
  const { kim, db, id2 } = await setupInbox(t);
  db.prepare("UPDATE inquiries SET status = 'closed' WHERE id = ?").run(id2);
  db.prepare(`INSERT INTO inquiries (source, external_id, from_name, subject, body, order_no, received_at)
    VALUES ('naver_qna', '9', '박고객', '아크릴 상품문의', '특가 언제까지인가요 100%', '2026102012345', '2026-10-19T00:00:00Z')`).run();
  const q = text => kim.request('/inbox?box=mail&q=' + encodeURIComponent(text)).then(r => r.text);

  const done = await q('특가');
  assert.ok(done.includes('광고입니다'), '이미 처리한 메일도 찾는다 (전체 탭)');
  assert.match(done, /<a href="[^"]*" class="on">전체 /);
  assert.match(done, /<mark>특가<\/mark> 안내/);
  assert.match(done, /다른 곳에도 있어요:[\s\S]*쇼핑몰 문의 1건/);
  assert.match(done, /href="\/inbox\?box=mail&amp;tab=open&amp;q=%ED%8A%B9%EA%B0%80"/, '검색 중 미답변 탭은 tab=open 으로');
  assert.match(done, /✕ 지우기/);

  const both = await q('현수막 알려주세요');
  assert.ok(both.includes('견적 문의'), '두 단어가 다른 줄에 있어도');
  assert.ok(!(await q('현수막 광고')).includes('견적 문의'), '단어가 모두 있어야');

  const shop = (await kim.request('/inbox?q=2026102012345')).text;
  assert.ok(shop.includes('아크릴 상품문의'), '주문번호로');
  assert.ok((await kim.request('/inbox?q=' + encodeURIComponent('100%'))).text.includes('아크릴 상품문의'));
  assert.ok(!(await kim.request('/inbox?q=' + encodeURIComponent('0%0'))).text.includes('아크릴 상품문의'), '% 는 글자 그대로');
  assert.ok(!(await kim.request('/inbox?q=' + encodeURIComponent('<b>'))).text.includes('<mark><b>'), '칠할 때도 HTML 은 글자로');
});

test('메일 삭제: 여러 통·한 통, 내용·답변 기록은 지우고 표시만 남김, 어디에도 안 보이고, 쇼핑몰 문의는 못 지움, 다시 가져와도 안 들어옴', async t => {
  const { kim, db, id1, id2, kimId } = await setupInbox(t);
  const shopId = Number(db.prepare(`INSERT INTO inquiries (source, external_id, subject, body, received_at)
    VALUES ('naver_qna', '9', '아크릴 상품문의', '견적', '2026-10-19T00:00:00Z')`).run().lastInsertRowid);
  await kim.submit(`/inbox/${id1}`, `/inbox/${id1}/reply`, { body: '견적 보내드립니다', version: '0' });

  const list = (await kim.request('/inbox?box=mail')).text;
  assert.match(list, /모두 선택/);
  assert.match(list, /formaction="\/inbox\/bulk\/delete"/);
  assert.ok(!(await kim.request('/inbox')).text.includes('bulk/delete'), '쇼핑몰 문의 탭엔 삭제 버튼 없음');

  const res = await kim.submit('/inbox?box=mail', '/inbox/bulk/delete', { ids: [String(id1), String(shopId)], back: '/inbox?box=mail' });
  assert.strictEqual(res.status, 302);
  const gone = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id1);
  assert.deepStrictEqual([gone.subject, gone.body, gone.from_addr, gone.deleted_by, Boolean(gone.deleted_at)], [null, null, null, kimId, true]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM inquiry_replies WHERE inquiry_id = ?').get(id1).n, 0);
  assert.strictEqual(db.prepare('SELECT deleted_at FROM inquiries WHERE id = ?').get(shopId).deleted_at, null, '쇼핑몰 문의는 그대로');
  assert.strictEqual((await kim.request(`/inbox/${id1}`)).status, 404);
  const after = (await kim.request('/inbox?box=mail&tab=all')).text;
  assert.match(after, /전체 <span class="count">1<\/span>/);
  assert.match((await kim.request('/')).text, /문의함 <span class="badge">2<\/span>/, '위쪽 미답변 건수에서도 빠짐 (특가 안내 + 쇼핑몰 1)');

  assert.strictEqual((await kim.submit(`/inbox/${shopId}`, `/inbox/${shopId}/delete`, {})).status, 302);
  assert.strictEqual(db.prepare('SELECT deleted_at FROM inquiries WHERE id = ?').get(shopId).deleted_at, null);
  await kim.submit(`/inbox/${id2}`, `/inbox/${id2}/delete`, {});
  assert.ok(db.prepare('SELECT deleted_at FROM inquiries WHERE id = ?').get(id2).deleted_at, '상세 화면에서 한 통');

  // 예전 메일 가져오기를 다시 해도 지운 메일은 안 들어온다
  const { importOldMail } = require('../scripts/mail-backfill');
  const { backfillMail } = require('../src/inbox/mail');
  const { connect } = fakeImap({ 1: { raw: raw() } });
  const out = await importOldMail(db, { source: 'naver_mail', label: '네이버메일' }, { apply: true, backfill: (acc, o) => backfillMail(acc, { ...o, connect }) });
  assert.deepStrictEqual(out, { found: 1, todo: 0, added: 0 });
});

test('예전 메일 가져오기: 미리보기는 세기만, 가져오면 처리 완료(답장한 메일은 답변완료)로 넣고 알림·읽은 위치는 그대로, 두 번 해도 한 번만', async () => {
  const { importOldMail } = require('../scripts/mail-backfill');
  const { backfillMail } = require('../src/inbox/mail');
  const db = openDb(':memory:');
  const box = { 5: { raw: raw({ subject: '작년 견적' }) }, 6: { raw: raw({ subject: '작년 답장함' }), flags: ['\\Answered'] }, 41: { raw: raw() } };
  const { connect } = fakeImap(box);
  db.prepare("INSERT INTO inquiries (source, external_id, subject, received_at) VALUES ('naver_mail', '7:41', '이미 있음', '2026-10-19T00:00:00Z')").run();
  const account = { source: 'naver_mail', label: '네이버메일' };
  const backfill = (acc, opts) => backfillMail(acc, { ...opts, connect });

  const preview = await importOldMail(db, account, { backfill });
  assert.deepStrictEqual(preview, { found: 3, todo: 2, added: 0 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM inquiries').get().n, 1);

  const out = await importOldMail(db, account, { backfill, apply: true });
  assert.deepStrictEqual(out, { found: 3, todo: 2, added: 2 });
  assert.deepStrictEqual(db.prepare("SELECT subject, status FROM inquiries WHERE external_id != '7:41' ORDER BY external_id").all().map(r => [r.subject, r.status]),
    [['작년 견적', 'closed'], ['작년 답장함', 'answered']]);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'inbox_state_%'").get().n, 0);
  assert.deepStrictEqual(await importOldMail(db, account, { backfill, apply: true }), { found: 3, todo: 0, added: 0 });
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
  assert.match((await kim.request('/inbox?box=mail&tab=done')).text, /견적 문의/);
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

test('메일 받기가 멈추면 시간 제한으로 끊고 실패로 남긴다 (다음 받기를 막지 않음)', async () => {
  let closed = 0;
  const stuck = {
    mailbox: { uidValidity: 1n },
    getMailboxLock: () => new Promise(() => {}), // 영원히 응답 없음
    close() { closed++; },
    async logout() {},
  };
  const src = createMailSource({ source: 'gmail', label: '지메일' }, { connect: async () => stuck, limitMs: 50 });
  await assert.rejects(src.fetch({ state: {} }), /시간 초과/);
  assert.strictEqual(closed, 1, '멈춘 연결은 끊는다');

  const db = openDb(':memory:');
  const col = createInboxCollector({ db, sources: [src] });
  const r = await col.run();
  assert.deepStrictEqual([r.ok, r.errors[0]], [false, '지메일: 시간 초과 (0분 안에 끝나지 않음)']);
  assert.strictEqual(col.isRunning(), false);
});

// ───────── 첨부파일 ─────────
const { attachmentParts, createMailFiles, previewType } = require('../src/inbox/mail');
const { Readable } = require('stream');

const STRUCTURE = {
  type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'multipart/alternative', childNodes: [{ part: '1.1', type: 'text/plain' }, { part: '1.2', type: 'text/html' }] },
    { part: '2', type: 'image/jpeg', disposition: 'attachment', dispositionParameters: { filename: '시안.jpg' }, size: 2048 },
    { part: '3', type: 'application/postscript', parameters: { name: 'logo.ai' }, size: 5000 },
  ],
};

test('첨부 목록은 메일 구조에서: 이름·크기·종류·위치 (본문은 제외), 미리보기는 안전한 그림만', () => {
  assert.deepStrictEqual(attachmentParts(STRUCTURE), [
    { part: '2', name: '시안.jpg', size: 2048, type: 'image/jpeg' },
    { part: '3', name: 'logo.ai', size: 5000, type: 'application/postscript' },
  ]);
  assert.strictEqual(previewType({ name: 'a.PNG' }), 'image/png', '예전 기록은 확장자로');
  assert.strictEqual(previewType({ name: 'x.svg', type: 'image/svg+xml' }), null, 'SVG 는 미리보기 안 함');
});

test('첨부 열기: 그 부분만 메일함에서 가져와 넘겨주고 연결을 정리한다', async () => {
  const log = [];
  const client = {
    mailbox: { uidValidity: 7n },
    async getMailboxLock() { return { release: () => log.push('release') }; },
    async fetchOne(uid) { log.push(`structure ${uid}`); return { bodyStructure: STRUCTURE }; },
    async download(uid, part) { log.push(`download ${uid} ${part}`); return { content: Readable.from([Buffer.from('JPEG')]) }; },
    async logout() { log.push('logout'); },
  };
  const files = createMailFiles({ source: 'gmail' }, { connect: async () => client });
  const f = await files.open({ external_id: '7:41' }, 0);
  assert.deepStrictEqual([f.name, f.type], ['시안.jpg', 'image/jpeg']);
  let data = '';
  for await (const chunk of f.stream) data += chunk;
  await f.done();
  assert.strictEqual(data, 'JPEG');
  assert.deepStrictEqual(log, ['structure 41', 'download 41 2', 'release', 'logout']);
  await assert.rejects(files.open({ external_id: '8:41' }, 0), /메일함이 바뀌어/);
  await assert.rejects(files.open({ external_id: '7:41' }, 5), /찾을 수 없습니다/);
});

test('화면: 첨부를 누르면 내려받기(그림은 미리보기), 다른 직원 아닌 사람은 못 받음', async t => {
  const opened = [];
  const files = {
    naver_mail: {
      async open(inq, n) {
        opened.push(n);
        const list = [{ name: '시안 "최종".jpg', type: 'image/jpeg', size: 4 }, { name: 'logo.ai', type: 'application/postscript', size: 3 }];
        if (!list[n]) throw Object.assign(new Error('첨부파일을 찾을 수 없습니다.'), { status: 404 });
        return { ...list[n], stream: Readable.from([Buffer.from('DATA')]), done: async () => {} };
      },
    },
  };
  const sourceLabels = { naver_mail: '네이버메일' };
  const ctx = await startServer({ inbox: { sourceLabels, files } });
  t.after(() => ctx.server.close());
  addUser(ctx.db, { email: 'kim@broad.test' });
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  const id = Number(ctx.db.prepare(`INSERT INTO inquiries (source, external_id, subject, body, attachments, received_at)
    VALUES ('naver_mail', '7:1', '시안', '첨부합니다', ?, '2026-10-19T01:00:00Z')`)
    .run(JSON.stringify([{ part: '2', name: '시안 "최종".jpg', size: 4, type: 'image/jpeg' }, { part: '3', name: 'logo.ai', size: 3, type: 'application/postscript' }])).lastInsertRowid);

  const detail = (await kim.request(`/inbox/${id}`)).text;
  assert.match(detail, new RegExp(`href="/inbox/${id}/files/1">📎 logo.ai`));
  assert.match(detail, new RegExp(`<img src="/inbox/${id}/files/0\\?view=1"`), '그림은 미리보기');
  assert.ok(!detail.includes(`files/1?view=1`), 'ai 파일은 미리보기 없음');

  const res = await fetch(`${ctx.baseUrl}/inbox/${id}/files/1`, { headers: { cookie: kim.cookie() } });
  assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment; .*filename\*=UTF-8''logo\.ai/);
  assert.strictEqual(await res.text(), 'DATA');
  const img = await fetch(`${ctx.baseUrl}/inbox/${id}/files/0?view=1`, { headers: { cookie: kim.cookie() } });
  assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('content-disposition'), /^inline; filename="__.*_\.jpg"|^inline; filename="/);
  assert.ok(!img.headers.get('content-disposition').includes('"최종"'), '이름 속 따옴표는 바꿔서');
  assert.strictEqual((await fetch(`${ctx.baseUrl}/inbox/${id}/files/9`, { headers: { cookie: kim.cookie() } })).status, 404);
  const anon = await fetch(`${ctx.baseUrl}/inbox/${id}/files/1`, { redirect: 'manual' });
  assert.notStrictEqual(anon.status, 200, '로그인 안 하면 못 받음');
});

test('답장에 파일 첨부: 메일로 함께 보내고 기록엔 이름만, 20MB 넘으면 막는다', async t => {
  const got = [];
  const sender = { reply: async (inq, body, files) => { got.push(files); return { result: 'ok', message: '보냄' }; } };
  const { kim, id1, db, baseUrl } = await setupInbox(t, { senders: { naver_mail: sender } });
  const page = (await kim.request(`/inbox/${id1}`)).text;
  assert.match(page, /enctype="multipart\/form-data"/);
  const token = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const send = async (files, version) => {
    const form = new FormData();
    form.append('_csrf', token);
    form.append('version', String(version));
    form.append('body', '시안 보내드립니다');
    for (const [name, content] of files) form.append('files', new Blob([content], { type: 'image/png' }), name);
    return fetch(`${baseUrl}/inbox/${id1}/reply`, { method: 'POST', body: form, headers: { cookie: kim.cookie() }, redirect: 'manual' });
  };
  const r = await send([['시안1.png', 'AAAA'], ['시안2.png', 'BB']], 0);
  assert.strictEqual(r.status, 302);
  assert.deepStrictEqual(got[0].map(f => [f.name, f.type, f.content.toString()]), [['시안1.png', 'image/png', 'AAAA'], ['시안2.png', 'image/png', 'BB']]);
  const rec = db.prepare('SELECT attachments FROM inquiry_replies').get();
  assert.deepStrictEqual(JSON.parse(rec.attachments), [{ name: '시안1.png', size: 4 }, { name: '시안2.png', size: 2 }]);
  assert.match((await kim.request(`/inbox/${id1}`)).text, /📎 시안1\.png, 시안2\.png/);

  const big = await send([['큰파일.png', Buffer.alloc(21 * 1024 * 1024)]], 1);
  assert.strictEqual(big.status, 302);
  assert.strictEqual(got.length, 1, '한도를 넘으면 보내지 않음');

  // CSRF 토큰 없이 파일을 보내면 막힌다
  const form = new FormData();
  form.append('body', 'x');
  const noToken = await fetch(`${baseUrl}/inbox/${id1}/reply`, { method: 'POST', body: form, headers: { cookie: kim.cookie() }, redirect: 'manual' });
  assert.strictEqual(noToken.status, 403);
});

test('메일 계정 두 개는 동시에 받는다 (하나씩 기다리지 않음)', async () => {
  const db = openDb(':memory:');
  const slow = (source, label) => ({
    source, label,
    fetch: () => new Promise(resolve => setTimeout(() => resolve({ items: [], answeredIds: [], state: { lastUid: 1 } }), 300)),
  });
  const col = createInboxCollector({ db, sources: [slow('naver_mail', '네이버메일'), slow('gmail', '지메일')] });
  const t0 = Date.now();
  const r = await col.run();
  assert.strictEqual(r.ok, true);
  assert.ok(Date.now() - t0 < 550, `걸린 시간 ${Date.now() - t0}ms — 동시에 받으면 300ms 남짓`);
});

test('문의함은 쇼핑몰 문의 / 메일 탭으로 나뉜다 (섞이지 않음, 탭마다 미답변 숫자)', async t => {
  const { kim, db } = await setupInbox(t);
  db.prepare(`INSERT INTO inquiries (source, external_id, from_name, subject, body, attachments, received_at)
    VALUES ('smartstore_qna', '99', 'abc***', '[상품문의] 명함', '사이즈?', '[]', '2026-10-19T02:00:00Z')`).run();
  const shop = (await kim.request('/inbox')).text;
  assert.match(shop, /class="on"[^>]*data-key="shop"[^>]*>\s*쇼핑몰 문의 <span class="badge">1<\/span>/);
  assert.match(shop, /메일 <span class="badge">2<\/span>/);
  assert.ok(shop.includes('[상품문의] 명함') && !shop.includes('견적 문의'), '쇼핑몰 탭엔 메일 없음');
  const mail = (await kim.request('/inbox?box=mail')).text;
  assert.ok(mail.includes('견적 문의') && !mail.includes('[상품문의] 명함'), '메일 탭엔 쇼핑몰 문의 없음');
  assert.match((await kim.request('/inbox?src=gmail')).text, /class="on"[^>]*data-key="mail"/, '출처를 고르면 그 탭으로');
});

test('문의함 큰 탭 순서는 직원마다 바꿀 수 있고, 맨 앞 탭이 처음 열린다', async t => {
  const { kim, kimId, db } = await setupInbox(t);
  const first = (await kim.request('/inbox')).text;
  assert.ok(first.indexOf('data-key="shop"') < first.indexOf('data-key="mail"'), '처음엔 쇼핑몰 문의가 앞');
  assert.match(first, /data-sortable data-url="\/me\/inbox-order"/);
  await kim.submit('/inbox', '/me/inbox-order', { order: 'mail,shop,zzz' });
  assert.strictEqual(db.prepare('SELECT inbox_order FROM users WHERE id = ?').get(kimId).inbox_order, '["mail","shop"]');
  const after = (await kim.request('/inbox')).text;
  assert.ok(after.indexOf('data-key="mail"') < after.indexOf('data-key="shop"'), '메일이 앞으로');
  assert.ok(after.includes('견적 문의'), '메일 탭이 처음 열림');
  assert.match(after, /href="\/inbox\?box=shop"/, '쇼핑몰 탭 링크엔 box=shop');
});
