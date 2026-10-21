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
  assert.match(shop, /data-body="홍길동님, 아크릴 명패 시안 보내드립니다. \(주문 G100\)">시안 확인</);
  assert.ok(!shop.includes('메일 전용'), '쇼핑몰 문의엔 메일 전용 문구 없음');
  const mail = (await kim.request(`/inbox/${mailId}`)).text;
  assert.match(mail, /data-body="이영희님, \{상품명\} 시안 보내드립니다. \(주문 \{주문번호\}\)">시안 확인</, '모르는 값은 그대로');
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
