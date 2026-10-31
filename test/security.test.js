// 보안 점검(2026-10) 뒤 고친 것들: 메일 멈춤·로그인 한 달·개인정보 3개월·돌아갈 주소·500 오류·톡톡 알림 주소
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { startServer, addUser, loginAs, browser } = require('./helpers');
const { htmlToText } = require('../src/inbox/mail');
const { autoPersonalCleanup, lastPersonalCleanup } = require('../src/retention');

const daysAgo = n => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

test('일부러 만든 HTML 메일로 서버가 멈추지 않는다 (예전엔 2MB 에 수십 분)', () => {
  for (const evil of ['<style'.repeat(300000), '<script'.repeat(300000), '<'.repeat(2000000), '<a'.repeat(1000000)]) {
    const t = Date.now();
    htmlToText(evil);
    assert.ok(Date.now() - t < 1000, `${evil.slice(0, 7)}… 는 1초 안에`);
  }
  assert.strictEqual(htmlToText('<p>안녕<br>하세요</p><style>.a{}</style><SCRIPT>x()</SCRIPT>끝 &amp; <b>굵게</b>'), '안녕\n하세요\n끝 & 굵게');
  assert.strictEqual(htmlToText('앞<style>안 닫힘'), '앞');
});

test('로그인은 로그인한 날부터 최대 한 달 (상태 유지를 켜도)', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  assert.strictEqual((await kim.request('/')).status, 200);
  // 로그인한 때를 31일 전으로 돌린다
  const row = db.prepare('SELECT sid, data FROM sessions').get();
  const data = JSON.parse(row.data);
  data.loginAt = Date.now() - 31 * 24 * 3600 * 1000;
  db.prepare('UPDATE sessions SET data = ? WHERE sid = ?').run(JSON.stringify(data), row.sid);
  const res = await kim.request('/');
  assert.strictEqual(res.location, '/login?m=expired');
  assert.match((await kim.request('/login?m=expired')).text, /한 달이 지나 다시 로그인/);
  assert.strictEqual((await kim.request('/')).location, '/login', '세션도 지워짐');
});

test('개인정보 3개월: 끝난 주문은 이름·연락처·주소만 지우고 금액은 남기며, 답변한 문의는 지운다 (하루 한 번)', () => {
  const db = openDb(':memory:');
  const ins = db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, channel_status, paid_at, buyer_name, buyer_phone,
    receiver_name, receiver_phone, receiver_address, ship_memo, amount) VALUES ('smartstore', ?, ?, '명함', ?, ?, '홍길동', '010-1111-2222', '김철수', '010-3333-4444', '서울', '문 앞', 10000)`);
  ins.run('OLD', 'OLD-1', 'DELIVERED', daysAgo(100));    // 끝난 지 3개월 넘음 → 지움
  ins.run('NEW', 'NEW-1', 'DELIVERED', daysAgo(30));     // 아직 3개월 안 됨 → 남김
  ins.run('OPEN', 'OPEN-1', 'PAYED', daysAgo(120));      // 아직 진행 중 → 남김
  db.prepare("INSERT INTO logen_shipments (channel, channel_order_id, env, take_no, track_json) VALUES ('smartstore', 'OLD', 'prod', 'OLD', '[{\"stat\":\"배송완료\"}]')").run();
  const inq = db.prepare('INSERT INTO inquiries (source, external_id, subject, body, received_at, status) VALUES (?, ?, ?, ?, ?, ?)');
  inq.run('naver_qna', 'a', '옛 문의', '내용', daysAgo(100), 'answered');
  inq.run('naver_qna', 'b', '미답변', '내용', daysAgo(100), 'open');
  inq.run('naver_qna', 'c', '최근 문의', '내용', daysAgo(10), 'answered');

  assert.deepStrictEqual(autoPersonalCleanup(db), { orders: 1, inquiries: 1 });
  const get = id => db.prepare('SELECT * FROM orders WHERE channel_order_id = ?').get(id);
  const old = get('OLD');
  for (const c of ['buyer_name', 'buyer_phone', 'receiver_name', 'receiver_phone', 'receiver_address', 'ship_memo']) assert.strictEqual(old[c], null, c);
  assert.strictEqual(old.amount, 10000, '금액은 남김 (통계)');
  assert.strictEqual(old.product_name, '명함');
  assert.ok(old.pii_cleared_at);
  assert.strictEqual(db.prepare("SELECT track_json FROM logen_shipments WHERE take_no = 'OLD'").get().track_json, null);
  assert.strictEqual(get('NEW').buyer_name, '홍길동');
  assert.strictEqual(get('OPEN').buyer_name, '홍길동');
  assert.deepStrictEqual(db.prepare('SELECT subject FROM inquiries ORDER BY id').all().map(r => r.subject), ['미답변', '최근 문의']);
  assert.strictEqual(autoPersonalCleanup(db), null, '같은 날 두 번은 하지 않음');
  assert.strictEqual(lastPersonalCleanup(db).orders, 1);
});

test('알림 종 버튼의 돌아갈 주소: 다른 사이트로 보내지 않는다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  for (const back of ['/\\evil.com', '//evil.com', 'https://evil.com', '/ok\\x']) {
    assert.strictEqual((await kim.submit('/', '/me/notify/mail', { back })).location, '/', back);
  }
  assert.strictEqual((await kim.submit('/', '/me/notify/mail', { back: '/inbox?box=mail' })).location, '/inbox?box=mail');
});

test('이상한 값으로 500 오류가 나지 않는다 (CSRF 한글 토큰, ?tab=constructor)', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const bad = await kim.request('/me/notify/mail', { method: 'POST', form: { _csrf: '가'.repeat(48), back: '/' } });
  assert.strictEqual(bad.status, 403);
  for (const path of ['/inbox?tab=constructor', '/inbox?box=chat&tab=constructor&days=toString', '/?st=constructor&alert=__proto__&view=hasOwnProperty']) {
    assert.strictEqual((await kim.request(path)).status, 200, path);
  }
});

test('톡톡 알림 주소: 비밀 주소가 틀리면 본문을 읽기 전에 404', async t => {
  const handled = [];
  const { server, baseUrl } = await startServer({ inbox: { talktalk: { token: 'a'.repeat(32), handle: b => handled.push(b) } } });
  t.after(() => server.close());
  const wrong = await fetch(`${baseUrl}/hooks/talktalk/${'b'.repeat(32)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: 'not gzip' });
  assert.strictEqual(wrong.status, 404);
  const ok = await fetch(`${baseUrl}/hooks/talktalk/${'a'.repeat(32)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'open' }) });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(handled, [{ event: 'open' }]);
  const zipped = await fetch(`${baseUrl}/hooks/talktalk/${'a'.repeat(32)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: 'x' });
  assert.strictEqual(zipped.status, 415, '압축 본문은 받지 않음');
});
