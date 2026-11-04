// 관리자 › 메일 계정: 앱 비밀번호를 관리자 화면에서 넣기 (DB 에 암호화), 바로 메일함·답장·첨부에 반영
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createSecretBox } = require('../src/secretBox');
const { createMailRegistry } = require('../src/inbox/mailRegistry');
const { startServer, addUser, loginAs } = require('./helpers');

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

// 메일 서버 흉내: 비밀번호가 'goodpass' 이면 로그인 성공
const fakeConnect = async acc => {
  if (acc.pass !== 'goodpass') throw Object.assign(new Error('Command failed'), { responseText: '[AUTHENTICATIONFAILED] Invalid credentials (Failure)' });
  return { logout: async () => {} };
};
function setup({ live = false, env = [], key = KEY, db = openDb(':memory:') } = {}) {
  if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) addUser(db, { email: 'first@broad.test', role: 'admin' }); // 기록에 남는 직원 1번
  const inbox = { sourceLabels: { smartstore_qna: '스마트스토어' }, senders: { smartstore_qna: { reply() {} } }, files: {} };
  const sources = [{ source: 'smartstore_qna', label: '스마트스토어' }];
  const registry = createMailRegistry({
    db, box: createSecretBox(key), inbox, collectorSources: sources, live, envAccounts: env, connect: fakeConnect,
    makeSource: acc => ({ source: acc.source, label: acc.label, pass: acc.pass }),
    makeSender: acc => ({ source: acc.source }),
    makeFiles: acc => ({ source: acc.source }),
  });
  inbox.mailRegistry = registry;
  registry.apply();
  return { db, inbox, sources, registry };
}

test('비밀 상자: 열쇠로 잠그고 풀기, 다른 열쇠·망가진 값은 못 풂, 열쇠가 없거나 모양이 틀리면 저장 안 함', () => {
  const box = createSecretBox(KEY);
  const sealed = box.seal('abcd efgh');
  assert.ok(sealed.startsWith('v1:') && !sealed.includes('abcd'));
  assert.notStrictEqual(box.seal('abcd efgh'), sealed, '같은 값도 매번 다르게 잠김');
  assert.strictEqual(box.open(sealed), 'abcd efgh');
  assert.strictEqual(createSecretBox(OTHER_KEY).open(sealed), null);
  assert.strictEqual(box.open(sealed.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))), null);
  assert.strictEqual(createSecretBox('').ready, false);
  assert.match(createSecretBox('짧은값').keyProblem, /64자리/);
  assert.throws(() => createSecretBox('').seal('x'), /SETTINGS_KEY/);
});

test('계정 추가: 로그인 시험이 되어야 저장, 비밀번호는 암호화, 바로 메일함 받기·첨부에 들어가고 답장은 MAIL_SEND 일 때만', async () => {
  const { db, inbox, sources, registry } = setup();
  const bad = await registry.add({ kind: 'gmail', address: 'new@gmail.com', pass: 'wrong' }, 1);
  assert.match(bad.error, /로그인을 거절/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM mail_accounts').get().n, 0, '실패하면 저장 안 함');

  const ok = await registry.add({ kind: 'gmail', address: ' new@gmail.com ', pass: 'good pass' }, 1);
  assert.deepStrictEqual(ok, { id: 1, source: 'gmail101' }, '띄어쓰기를 뺀 앱 비밀번호로 로그인');
  const row = db.prepare('SELECT * FROM mail_accounts').get();
  assert.strictEqual(row.address, 'new@gmail.com');
  assert.ok(!row.pass_sealed.includes('goodpass'), 'DB 에는 암호로만');
  assert.strictEqual(inbox.sourceLabels.gmail101, 'new@gmail.com');
  assert.deepStrictEqual(sources.map(s => s.source), ['smartstore_qna', 'gmail101'], '다른 출처는 그대로, 메일 계정 더함');
  assert.strictEqual(sources[1].pass, 'goodpass');
  assert.ok(inbox.files.gmail101, '첨부 열기');
  assert.ok(!inbox.senders.gmail101, '연습 모드면 답장 보내기 없음');
  assert.ok(inbox.senders.smartstore_qna, '다른 출처의 답장은 그대로');

  const live = setup({ live: true });
  await live.registry.add({ kind: 'naver_mail', address: 'bro@naver.com', pass: 'goodpass' }, 1);
  assert.ok(live.inbox.senders.naver_mail101, 'MAIL_SEND=on 이면 답장도');

  assert.match((await registry.add({ kind: 'gmail', address: 'NEW@gmail.com', pass: 'goodpass' }, 1)).error, /이미 연결된/);
  assert.match((await registry.add({ kind: 'gmail', address: 'not-mail', pass: 'goodpass' }, 1)).error, /메일 주소/);
  assert.match((await registry.add({ kind: 'yahoo', address: 'a@b.com', pass: 'goodpass' }, 1)).error, /종류/);
});

test('비밀번호 바꾸기·끄기·켜기·지우기: 출처 이름은 그대로(받은 메일 이어짐), 지우면 비밀번호도 지우고 이름만 남김, 기록', async () => {
  const { db, inbox, sources, registry } = setup();
  await registry.add({ kind: 'gmail', address: 'new@gmail.com', pass: 'goodpass' }, 1);
  assert.match((await registry.changePassword(1, 'wrong', 1)).error, /로그인을 거절/, '틀린 새 비밀번호는 저장 안 함');
  assert.deepStrictEqual(await registry.changePassword(1, 'goodpass', 1), { ok: true });
  assert.strictEqual(db.prepare('SELECT source FROM mail_accounts').get().source, 'gmail101');

  registry.setEnabled(1, false, 1);
  assert.deepStrictEqual(sources.map(s => s.source), ['smartstore_qna'], '끄면 받지 않음');
  assert.ok(inbox.files.gmail101 && inbox.sourceLabels.gmail101, '받은 메일의 이름·첨부는 그대로');
  assert.strictEqual(registry.list()[0].enabled, 0);
  registry.setEnabled(1, true, 1);
  assert.deepStrictEqual(sources.map(s => s.source), ['smartstore_qna', 'gmail101']);

  registry.remove(1, 1);
  const row = db.prepare('SELECT * FROM mail_accounts').get();
  assert.ok(row.deleted_at && row.pass_sealed === null);
  assert.deepStrictEqual(sources.map(s => s.source), ['smartstore_qna']);
  assert.strictEqual(inbox.sourceLabels.gmail101, 'new@gmail.com', '지운 계정의 받은 메일에도 이름이 보임');
  assert.ok(!inbox.files.gmail101);
  assert.deepStrictEqual(registry.list(), []);
  assert.deepStrictEqual(registry.history().map(h => h.action), ['지움', '켬', '끔', '비밀번호 바꿈', '추가']);
  // 지운 뒤 같은 주소를 다시 넣을 수 있다 (새 출처 이름)
  assert.deepStrictEqual(await registry.add({ kind: 'gmail', address: 'new@gmail.com', pass: 'goodpass' }, 1), { id: 2, source: 'gmail102' });
});

test('.env 계정은 목록에 같이 보이고(바꿀 수 없음), 열쇠가 바뀌면 저장한 비밀번호를 못 풀어 받지 않고 다시 넣으라고 알린다', async () => {
  const db = openDb(':memory:');
  const env = [{ source: 'naver_mail', kind: 'naver_mail', kindLabel: '네이버메일', label: 'bro@naver.com', user: 'bro@naver.com', pass: 'x' }];
  const first = setup({ db, env });
  await first.registry.add({ kind: 'gmail', address: 'new@gmail.com', pass: 'goodpass' }, 1);
  assert.match((await first.registry.add({ kind: 'naver_mail', address: 'bro@naver.com', pass: 'goodpass' }, 1)).error, /이미 연결된/);
  assert.deepStrictEqual(first.registry.list().map(a => [a.address, a.fromEnv]), [['bro@naver.com', true], ['new@gmail.com', false]]);

  const moved = setup({ db, env, key: OTHER_KEY });
  assert.deepStrictEqual(moved.sources.map(s => s.source), ['smartstore_qna', 'naver_mail']);
  assert.strictEqual(moved.inbox.sourceLabels.gmail101, 'new@gmail.com');
  assert.strictEqual(moved.registry.list()[1].locked, true);
  assert.match((await moved.registry.test(1, 1)).error, /풀 수 없어요/);

  const nokey = setup({ db: openDb(':memory:'), key: '' });
  assert.match((await nokey.registry.add({ kind: 'gmail', address: 'a@gmail.com', pass: 'goodpass' }, 1)).error, /SETTINGS_KEY/);
});

test('관리자 › 메일 계정 화면: 관리자만, 추가·실패 안내, 비밀번호는 화면에 나오지 않음, 열쇠가 없으면 넣는 법 안내', async t => {
  const { db, inbox } = setup();
  const ctx = await startServer({ db, inbox });
  t.after(() => ctx.server.close());
  addUser(db, { email: 'boss@broad.test', role: 'admin', name: '사장' });
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const boss = await loginAs(ctx.baseUrl, 'boss@broad.test');
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  assert.notStrictEqual((await kim.request('/admin/mail')).status, 200, '직원은 못 봄');

  const page = (await boss.request('/admin/mail')).text;
  assert.match(page, /href="\/admin\/mail" class="chip on">메일 계정/);
  assert.match(page, /아직 연결된 메일이 없어요/);
  assert.match(page, /연습 모드/);

  await boss.submit('/admin/mail', '/admin/mail/add', { kind: 'gmail', address: 'new@gmail.com', pass: 'wrong' });
  assert.match((await boss.request('/admin/mail')).text, /로그인을 거절했어요/);
  const res = await boss.submit('/admin/mail', '/admin/mail/add', { kind: 'gmail', address: 'new@gmail.com', pass: 'goodpass' });
  assert.strictEqual(res.location, '/admin/mail');
  const after = (await boss.request('/admin/mail')).text;
  assert.match(after, /new@gmail\.com/);
  assert.match(after, /● 연결됨/);
  assert.ok(!after.includes('goodpass'), '비밀번호는 화면에 없음');
  assert.match(after, /<strong>추가<\/strong> · new@gmail\.com/);
  assert.strictEqual(inbox.sourceLabels.gmail101, 'new@gmail.com');

  // 받기에서 로그인이 실패하면 빨갛게 + 비밀번호 바꾸기 칸이 펼쳐진다
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('inbox_status_gmail101', ?)").run(JSON.stringify({ ok: false, at: new Date().toISOString(), error: 'Command failed / [AUTHENTICATIONFAILED] Invalid credentials' }));
  const failed = (await boss.request('/admin/mail')).text;
  assert.match(failed, /● 로그인 실패/);
  assert.match(failed, /<details class="acct-pw" open>/);

  await boss.submit('/admin/mail', '/admin/mail/1/delete', {});
  assert.match((await boss.request('/admin/mail')).text, /아직 연결된 메일이 없어요/);

  const plain = await startServer({ db: openDb(':memory:'), inbox: setup({ key: '' }).inbox });
  t.after(() => plain.server.close());
  addUser(plain.db, { email: 'boss@broad.test', role: 'admin' });
  const boss2 = await loginAs(plain.baseUrl, 'boss@broad.test');
  const nokey = (await boss2.request('/admin/mail')).text;
  assert.match(nokey, /openssl rand -hex 32/);
  assert.match(nokey, /<button type="submit" disabled>연결 시험하고 저장/);
});
