// 시안 컨펌: 시안 올리기 → 고객 링크 → 확정 / 수정 요청 → 주문 카드 단계 이동, 알림, 문자
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { createSms, smsBytes, normalizePhone } = require('../src/sms');
const { parsePins } = require('../src/proofs');
const { startServer, addUser, loginAs, browser } = require('./helpers');

// 가장 작은 PNG (1x1)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);

async function setup(t) {
  const db = openDb(':memory:');
  const sms = createSms({ db, env: { SMS_DRIVER: 'mock', PROOF_NOTIFY_PHONES: '010-1111-2222, 잘못된번호' } });
  const ctx = await startServer({ db, sms });
  t.after(() => ctx.server.close());
  ctx.staffId = addUser(db, { email: 'design@broad.test', name: '김디자인' });
  ctx.staff = await loginAs(ctx.baseUrl, 'design@broad.test');
  ctx.stageOf = id => db.prepare(
    'SELECT s.name FROM orders o JOIN work_stages s ON s.id = o.stage_id WHERE o.id = ?'
  ).get(id).name;
  ctx.addOrder = () => Number(db.prepare(`
    INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, buyer_name, receiver_name, receiver_phone, stage_id)
    VALUES ('smartstore', '2026101900001', 'item-1', '현수막 5000x900', '홍길동', '홍길동', '010-9876-5432',
      (SELECT id FROM work_stages WHERE name = '디자인작업'))`).run().lastInsertRowid);
  // 새 시안을 만들고 { id, token, res } 를 돌려준다
  ctx.createProof = async (fields = {}, file = { buffer: PNG, filename: 'sian.png' }) => {
    const res = await ctx.staff.upload('/proofs/new', '/proofs', { title: '○○식당 현수막', send_sms: '1', ...fields }, { file });
    const row = db.prepare('SELECT * FROM proofs ORDER BY id DESC LIMIT 1').get();
    return { res, proof: row };
  };
  return ctx;
}

// 고객 화면을 열어 CSRF 토큰을 얻고 응답을 보낸다
async function customerSubmit(customer, token, action, fields) {
  return customer.submit(`/p/${token}`, `/p/${token}/${action}`, fields);
}

test('문자 길이와 전화번호 정리', () => {
  assert.strictEqual(smsBytes('abc'), 3);
  assert.strictEqual(smsBytes('시안'), 4);
  assert.strictEqual(normalizePhone('010-1234-5678'), '01012345678');
  assert.strictEqual(normalizePhone('02 123 4567'), '021234567');
  assert.strictEqual(normalizePhone('1234'), null);
  assert.strictEqual(normalizePhone(''), null);
});

test('수정 표시는 0~1 범위로 자르고 이상한 값은 버린다', () => {
  assert.deepStrictEqual(parsePins('not json'), []);
  assert.deepStrictEqual(parsePins('{"x":1}'), []);
  assert.deepStrictEqual(parsePins('[{"x":2,"y":-1,"note":" 크게 ","evil":"<b>"}]'), [{ x: 1, y: 0, note: '크게' }]);
  assert.strictEqual(parsePins(JSON.stringify(Array(50).fill({ x: 0.5, y: 0.5 }))).length, 20);
});

test('알리고: 짧으면 SMS, 길면 LMS 로 보내고 결과를 기록한다', async () => {
  const db = openDb(':memory:');
  const calls = [];
  const replies = [
    { result_code: '1', message: 'success', msg_id: '777', msg_type: 'SMS' },
    { result_code: '-101', message: '인증오류입니다.' },
  ];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: new URLSearchParams(opts.body.toString()) });
    return { json: async () => replies[calls.length - 1] };
  };
  const env = { SMS_DRIVER: 'aligo', ALIGO_API_KEY: 'k', ALIGO_USER_ID: 'u', ALIGO_SENDER: '0311234567' };
  const sms = createSms({ db, env, fetchImpl });

  const ok = await sms.sendSms('010-1234-5678', '짧은 문자');
  assert.deepStrictEqual(ok, { ok: true, result: 'msg_id 777 (SMS)' });
  assert.strictEqual(calls[0].url, 'https://apis.aligo.in/send/');
  assert.strictEqual(calls[0].body.get('receiver'), '01012345678');
  assert.strictEqual(calls[0].body.get('sender'), '0311234567');
  assert.strictEqual(calls[0].body.get('msg_type'), 'SMS');

  const fail = await sms.sendSms('01012345678', '긴 문자'.repeat(30));
  assert.strictEqual(fail.ok, false);
  assert.match(fail.result, /인증오류/);
  assert.strictEqual(calls[1].body.get('msg_type'), 'LMS');
  assert.strictEqual(calls[1].body.get('title'), '브로애드');

  const bad = await sms.sendSms('123', '번호 오류');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(calls.length, 2, '잘못된 번호는 알리고에 보내지 않는다');

  const log = db.prepare('SELECT ok, driver FROM sms_log ORDER BY id').all().map(r => ({ ...r }));
  assert.deepStrictEqual(log, [{ ok: 1, driver: 'aligo' }, { ok: 0, driver: 'aligo' }, { ok: 0, driver: 'aligo' }]);

  assert.throws(() => createSms({ db, env: { SMS_DRIVER: 'aligo' } }), /ALIGO_API_KEY/);
});

test('예전 DB 의 알림 표도 시안 알림을 받을 수 있게 바뀐다 (기존 알림 유지)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'broad-db-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('new_order', 'unassigned_over', 'signup')),
    message TEXT NOT NULL, order_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO notifications (type, message) VALUES ('signup', '가입 신청');`);
  old.close();

  const db = openDb(file);
  assert.strictEqual(db.prepare('SELECT message FROM notifications').get().message, '가입 신청');
  db.prepare("INSERT INTO notifications (type, message) VALUES ('proof_approved', '확정')").run();
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 2);
  db.close();
  openDb(file).close(); // 두 번 열어도 문제없음
});

test('주문에 연결한 시안: 고객 문자 → 확정하면 카드가 제작 단계로, 직원에게 알림', async t => {
  const { db, baseUrl, staff, addOrder, stageOf, createProof } = await setup(t);
  const orderId = addOrder();

  // 고객 이름·전화번호를 비우면 주문 정보로 채운다
  const { res, proof } = await createProof({ order_id: String(orderId), note: '5000x900 / 현수막 / 1장' });
  assert.strictEqual(res.location, `/proofs/${proof.id}`);
  assert.strictEqual(proof.customer_name, '홍길동');
  assert.strictEqual(proof.customer_phone, '010-9876-5432');
  assert.strictEqual(proof.status, 'waiting');
  assert.strictEqual(stageOf(orderId), '컨펌');
  assert.ok(proof.token.length >= 16);

  const sent = db.prepare('SELECT * FROM sms_log WHERE proof_id = ?').get(proof.id);
  assert.strictEqual(sent.receiver, '01098765432');
  assert.match(sent.message, /홍길동님, '○○식당 현수막' 시안이 준비되었습니다/);
  assert.ok(sent.message.endsWith(`${baseUrl}/p/${proof.token}`));

  const detail = await staff.request(`/proofs/${proof.id}`);
  assert.match(detail.text, /시안을 만들었습니다\. 고객에게 문자를 보냈습니다/);
  assert.match(detail.text, /가짜 발송/);

  // 고객: 로그인 없이 링크로 연다
  const customer = browser(baseUrl);
  const page = await customer.request(`/p/${proof.token}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /○○식당 현수막/);
  assert.match(page.text, /5000x900 \/ 현수막 \/ 1장/);
  assert.doesNotMatch(page.text, /브로애드 인트라넷/, '고객 화면에는 사내 메뉴가 보이지 않는다');
  const image = await fetch(`${baseUrl}/p/${proof.token}/v/1`);
  assert.strictEqual(image.headers.get('content-type'), 'image/png');
  assert.deepStrictEqual(Buffer.from(await image.arrayBuffer()), PNG);

  // 확인 체크 없이 확정 → 안내 문구
  await customerSubmit(customer, proof.token, 'approve', { version_no: '1', name: '홍길동' });
  assert.match((await customer.request(`/p/${proof.token}`)).text, /규격 확인에 체크해 주세요/);
  assert.strictEqual(db.prepare('SELECT status FROM proofs WHERE id = ?').get(proof.id).status, 'waiting');

  const ok = await customerSubmit(customer, proof.token, 'approve', { version_no: '1', name: '홍길동 실장', agree: '1' });
  assert.strictEqual(ok.location, `/p/${proof.token}`);
  const done = db.prepare('SELECT * FROM proofs WHERE id = ?').get(proof.id);
  assert.strictEqual(done.status, 'approved');
  assert.strictEqual(done.decided_name, '홍길동 실장');
  assert.ok(done.decided_at);
  assert.strictEqual(stageOf(orderId), '제작');
  assert.match((await customer.request(`/p/${proof.token}`)).text, /확정되었습니다/);

  const note = db.prepare("SELECT * FROM notifications WHERE type = 'proof_approved'").get();
  assert.strictEqual(note.message, '[시안확정] ○○식당 현수막 - 홍길동 실장님 확정');
  assert.strictEqual(note.order_id, orderId);
  const toOwner = db.prepare("SELECT receiver, message FROM sms_log WHERE message LIKE '[시안확정]%'").all();
  assert.deepStrictEqual(toOwner.map(r => r.receiver), ['01011112222'], '잘못 적힌 알림 번호는 건너뛴다');

  // 두 번 확정해도 한 번만 처리 (확정 전에 열어 둔 화면에서 한 번 더 누른 경우)
  const csrfToken = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  await customer.request(`/p/${proof.token}/approve`, {
    method: 'POST', form: { _csrf: csrfToken, version_no: '1', name: '홍길동', agree: '1' },
  });
  assert.match((await customer.request(`/p/${proof.token}`)).text, /이미 확정된 시안입니다/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM proof_responses').get().n, 1);
});

test('수정 요청 → 디자인작업으로 되돌아가고, 2차 시안을 올리면 같은 링크로 다시 확인', async t => {
  const { db, baseUrl, staff, addOrder, stageOf, createProof } = await setup(t);
  const orderId = addOrder();
  const { proof } = await createProof({ order_id: String(orderId) });
  const customer = browser(baseUrl);

  // 내용 없이 수정 요청 → 거절
  await customerSubmit(customer, proof.token, 'revise', { version_no: '1', comment: ' ', pins: '[]' });
  assert.match((await customer.request(`/p/${proof.token}`)).text, /수정할 내용을 적어 주세요/);

  const pins = JSON.stringify([{ x: 0.25, y: 0.5, note: '전화번호 크게' }, { x: 0.9, y: 0.1, note: '' }]);
  await customerSubmit(customer, proof.token, 'revise', { version_no: '1', comment: '바탕을 진한 파랑으로', pins });
  assert.strictEqual(db.prepare('SELECT status FROM proofs WHERE id = ?').get(proof.id).status, 'revise');
  assert.strictEqual(stageOf(orderId), '디자인작업');
  assert.match(db.prepare("SELECT message FROM notifications WHERE type = 'proof_revise'").get().message,
    /^\[수정요청\] ○○식당 현수막 - 바탕을 진한 파랑으로$/);

  const customerPage = (await customer.request(`/p/${proof.token}`)).text;
  assert.match(customerPage, /수정 요청을 받았습니다/);
  assert.doesNotMatch(customerPage, /시안 확정<\/button>/, '수정 요청 뒤에는 확정 버튼이 없다');

  // 직원 화면: 상단 배지, 수정 요청 내용과 표시 위치
  const detail = await staff.request(`/proofs/${proof.id}`);
  assert.match(detail.text, /title="고객 수정 요청">1</);
  assert.match(detail.text, /바탕을 진한 파랑으로/);
  assert.match(detail.text, /전화번호 크게/);
  assert.match(detail.text, /class="pin" style="left:25.00%;top:50.00%">1</);

  // 2차 시안
  const up = await staff.upload(`/proofs/${proof.id}`, `/proofs/${proof.id}/versions`,
    { message: '전화번호 키우고 바탕 파랑으로 바꿨습니다', send_sms: '1' }, { file: { buffer: JPG, filename: 'v2.jpg' } });
  assert.strictEqual(up.location, `/proofs/${proof.id}`);
  assert.strictEqual(db.prepare('SELECT status FROM proofs WHERE id = ?').get(proof.id).status, 'waiting');
  assert.strictEqual(stageOf(orderId), '컨펌');
  const second = db.prepare('SELECT message FROM sms_log WHERE proof_id = ? ORDER BY id DESC').get(proof.id).message;
  assert.match(second, /수정 시안\(2차\)이 올라왔습니다/);
  assert.ok(second.includes(`/p/${proof.token}`), '같은 링크를 다시 보낸다');

  const page2 = (await customer.request(`/p/${proof.token}`)).text;
  assert.match(page2, /2차 시안입니다/);
  assert.match(page2, /전화번호 키우고 바탕 파랑으로 바꿨습니다/);
  assert.match(page2, /이전 시안 보기 \(1개\)/);
  assert.strictEqual((await fetch(`${baseUrl}/p/${proof.token}/v/2`)).headers.get('content-type'), 'image/jpeg');

  // 1차 화면을 띄워 둔 채로 확정 → 새 시안을 보라고 안내
  await customerSubmit(customer, proof.token, 'approve', { version_no: '1', name: '홍', agree: '1' });
  assert.match((await customer.request(`/p/${proof.token}`)).text, /새 시안이 올라왔습니다/);

  await customerSubmit(customer, proof.token, 'approve', { version_no: '2', name: '홍', agree: '1' });
  assert.strictEqual(stageOf(orderId), '제작');
  assert.match(db.prepare("SELECT message FROM notifications WHERE type = 'proof_approved'").get().message, /\(2차\)/);
});

test('주문 없이 만든 시안, 문자 안 보내기, 잘못된 파일', async t => {
  const { db, staff, createProof } = await setup(t);

  const txt = await createProof({ title: '명함' }, { buffer: Buffer.from('hello, not an image'), filename: 'a.jpg' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM proofs').get().n, 0);
  assert.match((await staff.request('/proofs/new')).text, /JPG, PNG, WEBP 이미지만/);
  assert.ok(txt.res.location);

  await createProof({ title: '명함', customer_phone: '12' });
  assert.match((await staff.request('/proofs/new')).text, /전화번호 형식이 올바르지 않습니다/);

  const { proof } = await createProof({ title: '매장 손님 명함', customer_name: '이순신', send_sms: '' });
  assert.strictEqual(proof.order_id, null);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sms_log').get().n, 0);

  // 전화번호 없이 만들고 문자 보내기를 켜면, 시안은 만들고 문자 못 보냈다고 안내
  const { proof: p2 } = await createProof({ title: '전화번호 없음' });
  assert.ok(p2);
  assert.match((await staff.request(`/proofs/${p2.id}`)).text, /문자는 보내지 못했습니다: 고객 전화번호가 없어/);

  const list = await staff.request('/proofs');
  assert.match(list.text, /매장 손님 명함/);
  assert.match(list.text, /확인 대기 2/);
});

test('고객 링크: 없는 주소, 종료, 기간 지남 / 직원 화면은 로그인 필요', async t => {
  const { db, baseUrl, staff, createProof } = await setup(t);
  const { proof } = await createProof({ customer_phone: '010-2222-3333' });
  const customer = browser(baseUrl);

  assert.strictEqual((await customer.request('/p/nope-not-a-token')).status, 404);
  assert.strictEqual((await customer.request('/proofs')).location, '/login');
  assert.strictEqual((await customer.request(`/proofs/${proof.id}/v/1`)).location, '/login');

  // 로그인하지 않은 사람이 파일을 올리려 하면 막는다
  const form = new FormData();
  form.append('title', 'x');
  form.append('file', new Blob([PNG]), 'x.png');
  assert.strictEqual((await fetch(`${baseUrl}/proofs`, { method: 'POST', body: form, redirect: 'manual' })).status, 403);

  db.prepare("UPDATE proofs SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(proof.id);
  const expired = await customer.request(`/p/${proof.token}`);
  assert.strictEqual(expired.status, 410);
  assert.match(expired.text, /사용 기간이 지났습니다/);
  assert.strictEqual((await customer.request(`/p/${proof.token}/v/1`)).status, 410);

  // 수정 시안을 올리면 기간이 다시 늘어난다
  await staff.upload(`/proofs/${proof.id}`, `/proofs/${proof.id}/versions`, { send_sms: '' }, { file: { buffer: PNG, filename: 'v2.png' } });
  assert.strictEqual((await customer.request(`/p/${proof.token}`)).status, 200);

  await staff.submit(`/proofs/${proof.id}`, `/proofs/${proof.id}/close`, {});
  const closed = await customer.request(`/p/${proof.token}`);
  assert.strictEqual(closed.status, 410);
  assert.match(closed.text, /종료된 시안입니다/);

  // 문자 다시 보내기는 종료 전까지만 버튼이 보인다
  assert.doesNotMatch((await staff.request(`/proofs/${proof.id}`)).text, /문자 다시 보내기/);
});

test('시안 이름·고객 메모의 HTML 은 글자로만 보인다', async t => {
  const { baseUrl, createProof } = await setup(t);
  const { proof } = await createProof({ title: '<script>alert(1)</script>' });
  const customer = browser(baseUrl);
  await customerSubmit(customer, proof.token, 'revise', { version_no: '1', comment: '<img src=x onerror=alert(1)>', pins: '[]' });
  const page = (await customer.request(`/p/${proof.token}`)).text;
  assert.doesNotMatch(page, /<script>alert/);
  assert.doesNotMatch(page, /<img src=x/);
  assert.match(page, /&lt;script&gt;/);
});
