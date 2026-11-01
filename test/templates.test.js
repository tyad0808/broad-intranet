// 자주 쓰는 답장 문구: 직원 누구나 만들고 고치고, 답장 칸에서 넣을 때 {고객명} 등이 그 문의 값으로
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs } = require('./helpers');
const { fillTemplate } = require('../src/routes/templates');

test('문구 안의 {고객명}{상품명}{주문번호}{회사명} 을 값으로, 모르는 값은 그대로', () => {
  assert.strictEqual(fillTemplate('{고객명}님 {상품명} {주문번호} - {회사명} {기타}', { 고객명: '홍길동', 상품명: '', 주문번호: '123', 회사명: '브로애드' }),
    '홍길동님 {상품명} 123 - 브로애드 {기타}');
});

test('직원이 문구를 만들고 고치고 지우며, 문의 답장 칸에 종류에 맞는 문구만 값이 채워져 나온다', async t => {
  const { db, server, baseUrl } = await startServer({ inbox: { sourceLabels: { naver_mail: '네이버메일', godo_qna: '자사몰' } } });
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test', name: '김상담' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  await kim.submit('/templates', '/templates', { title: '시안 확인', body: '{고객명}님, {상품명} 시안 보내드립니다. (주문 {주문번호})', scope: 'all' });
  await kim.submit('/templates', '/templates', { title: '메일 전용', body: '메일입니다', scope: 'mail' });
  await kim.submit('/templates', '/templates', { title: '', body: 'x', scope: 'all' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM reply_templates').get().n, 2, '이름이 없으면 만들지 않음');

  db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name) VALUES ('godo', 'G100', 'G100-1', '아크릴 명패')").run();
  const add = db.prepare('INSERT INTO inquiries (source, external_id, from_name, subject, body, received_at, order_no) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const shopId = Number(add.run('godo_qna', 'inquiry:1', '홍길동 (hong12)', '[자사몰 1:1문의] 배송', '언제 와요', '2026-10-19T00:00:00Z', 'G100').lastInsertRowid);
  const mailId = Number(add.run('naver_mail', '7:1', '이영희', '견적', '견적 부탁', '2026-10-19T00:00:00Z', null).lastInsertRowid);

  const shop = (await kim.request(`/inbox/${shopId}`)).text;
  assert.match(shop, /data-body="홍길동님, 아크릴 명패 시안 보내드립니다. \(주문 G100\)"[^>]*>\s*<strong>시안 확인<\/strong>/);
  assert.ok(!shop.includes('메일 전용'), '쇼핑몰 문의엔 메일 전용 문구 없음');
  const mail = (await kim.request(`/inbox/${mailId}`)).text;
  assert.match(mail, /data-body="이영희님, \{상품명\} 시안 보내드립니다. \(주문 \{주문번호\}\)"[^>]*>\s*<strong>시안 확인<\/strong>/, '모르는 값은 그대로');
  assert.match(mail, />메일 전용</);

  const id = db.prepare("SELECT id FROM reply_templates WHERE title = '메일 전용'").get().id;
  const page = (await kim.request('/templates')).text;
  const token = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const used = await fetch(`${baseUrl}/templates/${id}/used`, { method: 'POST', headers: { cookie: kim.cookie(), 'x-csrf-token': token } });
  assert.strictEqual(used.status, 204);
  assert.ok((await kim.request(`/inbox/${mailId}`)).text.indexOf('>메일 전용<') < (await kim.request(`/inbox/${mailId}`)).text.indexOf('>시안 확인<'), '많이 쓴 문구가 위로');

  await kim.submit('/templates', `/templates/${id}`, { title: '메일 인사', body: '안녕하세요', scope: 'mail' });
  assert.strictEqual(db.prepare('SELECT title FROM reply_templates WHERE id = ?').get(id).title, '메일 인사');
  await kim.submit('/templates', `/templates/${id}/delete`, {});
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM reply_templates').get().n, 1);
});

const { previewImport, importMacros, similarity, loadV1, CATEGORIES } = require('../src/macros');
const { openDb } = require('../src/db');

test('CS 매크로 v1 파일: 45개, 카테고리 8개, 모두 이름·내용·메일 제목이 있다', () => {
  const { macros } = loadV1();
  assert.strictEqual(macros.length, 45);
  assert.deepStrictEqual([...new Set(macros.map(m => m.category))].sort(), [...CATEGORIES].sort());
  assert.ok(macros.every(m => m.title && m.body && m.mailSubject && m.hint));
  assert.deepStrictEqual(macros.map(m => m.no), Array.from({ length: 45 }, (_, i) => i + 1));
});

test('가져오기: 기존 문구는 그대로, 겹치는 것은 기본으로 건너뛰고, 두 번 눌러도 한 번만 들어간다', () => {
  const db = openDb(':memory:');
  const { macros } = loadV1();
  const add = db.prepare("INSERT INTO reply_templates (title, body, scope, use_count) VALUES (?, ?, 'mail', 7)");
  add.run('첫 인사', '아무 내용');                       // 이름이 같음 (1번)
  add.run('발송 안내', macros[37].body.replace(/\s+/g, ' ') + '!'); // 내용이 거의 같음 (38번)
  add.run('우리끼리 쓰는 말', '전혀 다른 내용입니다');
  const before = db.prepare('SELECT * FROM reply_templates ORDER BY id').all();

  const preview = previewImport(db);
  const overlap = preview.filter(p => p.status === 'overlap').map(p => p.macro.no);
  assert.deepStrictEqual(overlap, [1, 38]);
  assert.match(preview[0].matches[0].reason, /이름이 같아요/);
  assert.match(preview[37].matches[0].reason, /내용이 \d+% 비슷해요/);

  assert.strictEqual(importMacros(db), 43);
  assert.deepStrictEqual(db.prepare('SELECT * FROM reply_templates WHERE id <= 3 ORDER BY id').all(), before, '기존 문구는 한 글자도 안 바뀜');
  const m33 = db.prepare("SELECT * FROM reply_templates WHERE origin = 'cs-v1' AND macro_no = 33").get();
  assert.strictEqual(m33.category, '주문·제작');
  assert.strictEqual(m33.scope, 'all');
  assert.ok(m33.usage_hint && m33.mail_subject);

  assert.strictEqual(importMacros(db), 0, '두 번째는 아무것도 안 들어감');
  assert.strictEqual(importMacros(db, { force: [38] }), 1, '겹치는 것은 체크한 것만');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM reply_templates').get().n, 3 + 44);
  assert.ok(similarity('안녕하세요 브로애드입니다', '안녕하세요, 브로애드입니다!') === 1);
});

test('가져오기 화면은 관리자만, 문구 화면은 카테고리별로 묶이고 매크로 칸에 제목과 언제 쓰나가 보인다', async t => {
  const { db, server, baseUrl } = await startServer({ inbox: { sourceLabels: { naver_mail: '네이버메일' } } });
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test', name: '김상담' });
  addUser(db, { email: 'boss@broad.test', name: '사장', role: 'admin' });
  db.prepare("INSERT INTO reply_templates (title, body, scope) VALUES ('예전 문구', '예전에 쓰던 말', 'all')").run();
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  assert.strictEqual((await kim.request('/templates/import')).status, 403);
  assert.doesNotMatch((await kim.request('/templates')).text, /CS 매크로 v1 가져오기/);
  const page = await boss.request('/templates/import');
  assert.match(page.text, /새로 들어갈 것 <span class="count">45/);
  const r = await boss.submit('/templates/import', '/templates/import', {});
  assert.strictEqual(r.status, 302);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM reply_templates').get().n, 46);
  assert.strictEqual(db.prepare("SELECT body FROM reply_templates WHERE title = '예전 문구'").get().body, '예전에 쓰던 말');

  const list = (await kim.request('/templates')).text;
  assert.ok(list.indexOf('id="cat-첫 응대"') < list.indexOf('id="cat-사후관리"'));
  assert.ok(list.indexOf('id="cat-사후관리"') < list.indexOf('id="cat-기타"'), '예전 문구는 맨 뒤 기타');

  const mailId = Number(db.prepare("INSERT INTO inquiries (source, external_id, from_name, subject, body, received_at) VALUES ('naver_mail', '9:1', '이영희', '문의', '내용', '2026-10-19T00:00:00Z')").run().lastInsertRowid);
  const detail = (await kim.request(`/inbox/${mailId}`)).text;
  assert.match(detail, /＋ 매크로 넣기/);
  assert.match(detail, /<div class="macro-cat">첫 응대<\/div>/);
  assert.match(detail, /<strong>시안 컨펌 대기 독촉<\/strong><span class="macro-hint">시안 보낸 뒤 답이 없을 때<\/span>/);
  assert.match(detail, /data-subject="\[브로애드\] 시안 확인 요청드립니다"/);

  // 사용 기록: 횟수 + 마지막 사용 시각
  const id = db.prepare("SELECT id FROM reply_templates WHERE macro_no = 24").get().id;
  const token = /name="_csrf" value="([^"]+)"/.exec(detail)[1];
  await fetch(`${baseUrl}/templates/${id}/used`, { method: 'POST', headers: { cookie: kim.cookie(), 'x-csrf-token': token } });
  const used = db.prepare('SELECT use_count, last_used_at FROM reply_templates WHERE id = ?').get(id);
  assert.strictEqual(used.use_count, 1);
  assert.ok(used.last_used_at);
});

test('문구 만들기·고치기: 카테고리·언제 쓰나·메일 제목도 저장된다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test', name: '김상담' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  await kim.submit('/templates', '/templates', { title: '새 매크로', body: '내용', scope: 'all', category: '배송', usage_hint: '배송 물을 때', mail_subject: '[브로애드] 배송 안내' });
  const row = db.prepare("SELECT * FROM reply_templates WHERE title = '새 매크로'").get();
  assert.deepStrictEqual([row.category, row.usage_hint, row.mail_subject], ['배송', '배송 물을 때', '[브로애드] 배송 안내']);
  await kim.submit('/templates', `/templates/${row.id}`, { title: '새 매크로', body: '내용', scope: 'all', category: '없는 칸', usage_hint: '', mail_subject: '' });
  const after = db.prepare('SELECT * FROM reply_templates WHERE id = ?').get(row.id);
  assert.deepStrictEqual([after.category, after.usage_hint, after.mail_subject], [null, null, null], '없는 카테고리는 기타');
});

test('관리자 메뉴에 답장 문구·매크로 바로가기가 있다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'boss@broad.test', name: '사장', role: 'admin' });
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  assert.match((await boss.request('/admin/users')).text, /<a href="\/templates" class="chip">답장 문구·매크로<\/a>/);
});
