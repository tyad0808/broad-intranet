// 고객 이력: 전화번호가 같은 주문(확실), 이름만 같은 주문·문의(참고), 문의에서 이어진 주문
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs } = require('./helpers');
const { phoneKey, nameKey } = require('../src/customer');

test('전화번호는 숫자만 비교하고 050 안심번호는 쓰지 않으며, 가려진 이름은 비교하지 않는다', () => {
  assert.strictEqual(phoneKey('010-1234-5678'), '01012345678');
  assert.strictEqual(phoneKey('0504-1234-5678'), null);
  assert.strictEqual(phoneKey('123'), null);
  assert.strictEqual(nameKey('홍길동 (hong12)'), '홍길동');
  assert.strictEqual(nameKey('abc***'), null);
});

test('주문 상세에 같은 고객의 다른 주문·문의, 재주문 표시 / 문의 상세에 그 고객의 주문', async t => {
  const { db, server, baseUrl } = await startServer({ inbox: { sourceLabels: { naver_mail: '네이버메일', godo_qna: '자사몰' } } });
  t.after(() => server.close());
  const o = db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, buyer_name, receiver_phone, paid_at, channel_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  o.run('smartstore', 'S1', 'S1-1', '첫 현수막', '홍길동', '010-1234-5678', '2026-08-01T00:00:00Z', 'PURCHASE_DECIDED');
  o.run('godo', 'G2', 'G2-1', '두번째 명함', '홍길동', '01012345678', '2026-09-01T00:00:00Z', 'DELIVERED');
  const now = Number(o.run('coupang', 'C3', 'C3-1', '이번 아크릴', '홍길동', '010 1234 5678', '2026-10-20T00:00:00Z', 'PAYED').lastInsertRowid);
  o.run('smartstore', 'S9', 'S9-1', '다른 사람 주문', '홍길동', '010-9999-0000', '2026-07-01T00:00:00Z', 'DELIVERED');
  o.run('coupang', 'C8', 'C8-1', '안심번호 주문', '김철수', '0504-1234-5678', '2026-07-01T00:00:00Z', 'DELIVERED');
  const q = db.prepare('INSERT INTO inquiries (source, external_id, from_name, subject, body, received_at, order_no) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const qid = Number(q.run('godo_qna', 'inquiry:1', '홍길동 (hong12)', '[자사몰 1:1문의] 명함 배송', '', '2026-09-02T00:00:00Z', 'G2').lastInsertRowid);
  q.run('naver_mail', '7:1', '홍길동', '견적 문의 메일', '', '2026-07-02T00:00:00Z', null);

  addUser(db, { email: 'kim@broad.test' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const page = (await kim.request(`/orders/${now}`)).text;
  const card = page.slice(page.indexOf('이 고객의 이력'));
  assert.match(card, /재주문 고객 · 이번이 3번째 주문/);
  const sure = card.slice(card.indexOf('다른 주문'), card.indexOf('이름이 같은 주문'));
  assert.ok(sure.includes('첫 현수막') && sure.includes('두번째 명함') && !sure.includes('다른 사람 주문'), '전화번호가 같은 주문만');
  assert.ok(card.slice(card.indexOf('이름이 같은 주문')).includes('다른 사람 주문'), '이름만 같은 주문은 따로');
  assert.ok(card.includes('[자사몰 1:1문의] 명함 배송'), '고객 주문번호로 온 문의');
  assert.ok(card.slice(card.indexOf('이름이 같은 문의')).includes('견적 문의 메일'), '이름이 같은 메일은 따로');

  const inq = (await kim.request(`/inbox/${qid}`)).text;
  const icard = inq.slice(inq.indexOf('이 고객의 이력'));
  assert.ok(icard.includes('두번째 명함') && icard.includes('첫 현수막') && icard.includes('이번 아크릴'), '문의 주문번호 → 그 고객의 주문 모두');
});
