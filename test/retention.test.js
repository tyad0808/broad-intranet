// 오래된 자료: 끝난 주문·답변한 문의는 2주 지나면 목록에서 숨기고(월별 보기·검색으로는 보임), 보관 기간이 지나면 관리자가 정리
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs } = require('./helpers');
const { monthRange, previewCleanup } = require('../src/retention');

const daysAgo = n => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
const kstMonth = iso => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 7);

async function setup(t) {
  const ctx = await startServer({ inbox: { sourceLabels: { naver_mail: '네이버메일', naver_qna: '스마트스토어' } } });
  t.after(() => ctx.server.close());
  const { db } = ctx;
  ctx.adminId = addUser(db, { email: 'boss@broad.test', role: 'admin', name: '대표' });
  ctx.admin = await loginAs(ctx.baseUrl, 'boss@broad.test');
  const order = db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, channel_status, paid_at, claim_status)
    VALUES ('smartstore', ?, ?, ?, ?, ?, ?)`);
  ctx.order = (id, name, status, paid, claim = null) => order.run(id, `${id}-1`, name, status, paid, claim);
  const inq = db.prepare(`INSERT INTO inquiries (source, external_id, subject, body, received_at, status) VALUES (?, ?, ?, ?, ?, ?)`);
  ctx.inquiry = (source, id, subject, status, at) => Number(inq.run(source, id, subject, '내용', at, status).lastInsertRowid);
  return ctx;
}

test('월 범위는 한국 시간 기준 (8월 = 7/31 15:00Z ~ 8/31 15:00Z)', () => {
  assert.deepStrictEqual(monthRange('2026-08'), ['2026-07-31 15:00:00', '2026-08-31 15:00:00']);
  assert.strictEqual(monthRange('2026-13'), null);
  assert.strictEqual(monthRange('x'), null);
});

test('주문: 끝난 지 2주 지난 주문은 전체·배송완료에서 숨기고, 월별 보기·검색으로는 보인다', async t => {
  const { admin, order } = await setup(t);
  const old = daysAgo(30);
  order('OLD', '작년현수막', 'DELIVERED', old);
  order('NEW', '최근명함', 'DELIVERED', daysAgo(3));
  order('WAIT', '오래된진행중', 'PAYED', old);

  const all = (await admin.request('/?view=all')).text;
  assert.ok(all.includes('최근명함') && all.includes('오래된진행중'));
  assert.ok(!all.includes('작년현수막'), '끝난 지 2주 지난 주문은 숨김');
  assert.match(all, /14일이 지나면 여기서 숨겨요/);
  assert.match(all, /전체 <span class="count">2<\/span>/);
  assert.ok(!(await admin.request('/?st=delivered')).text.includes('작년현수막'));

  const month = kstMonth(old);
  const byMonth = (await admin.request(`/?month=${month}`)).text;
  assert.ok(byMonth.includes('작년현수막') && byMonth.includes('오래된진행중'), '월별 보기는 끝난 것까지');
  assert.match(byMonth, new RegExp(`<option value="${month}" selected>`));
  assert.ok((await admin.request('/?view=all&q=' + encodeURIComponent('작년현수막'))).text.includes('작년현수막'), '검색은 지난 주문까지');
});

test('문의: 답변한 지 2주 지난 문의는 답변완료·전체에서 숨기고, 월별 보기·검색으로는 보인다. 미답변은 계속', async t => {
  const { admin, inquiry } = await setup(t);
  const old = daysAgo(30);
  inquiry('naver_mail', '7:1', '지난달견적', 'closed', old);
  inquiry('naver_mail', '7:2', '오래된미답변', 'open', old);
  inquiry('naver_mail', '7:3', '최근처리', 'answered', daysAgo(2));

  const all = (await admin.request('/inbox?box=mail&tab=all')).text;
  assert.ok(all.includes('오래된미답변') && all.includes('최근처리') && !all.includes('지난달견적'));
  assert.ok(!(await admin.request('/inbox?box=mail&tab=done')).text.includes('지난달견적'));
  const month = (await admin.request(`/inbox?box=mail&month=${kstMonth(old)}`)).text;
  assert.ok(month.includes('지난달견적') && month.includes('오래된미답변'), '월별 보기는 전체 탭에서 모두');
  assert.ok((await admin.request('/inbox?box=mail&q=' + encodeURIComponent('지난달견적'))).text.includes('지난달견적'));
});

test('정리: 보관 기간 지난 끝난 주문·답변한 문의만 지우고(메일은 표시만 남김), 진행 중·클레임·미답변은 남기며, 기록을 남긴다', async t => {
  const { db, admin, order, inquiry, adminId } = await setup(t);
  const old = daysAgo(400);
  order('GONE', '지울주문', 'DELIVERED', old);
  db.prepare(`INSERT INTO order_actions (action, channel, channel_order_id, item_ids, mode, result) VALUES ('dispatch', 'smartstore', 'GONE', '[]', 'live', 'ok')`).run();
  order('KEEP1', '진행중', 'PAYED', old);
  order('KEEP2', '반품요청', 'DELIVERED', old, 'RETURN_REQUEST');
  order('KEEP3', '반년전', 'DELIVERED', daysAgo(200));
  const mail = inquiry('naver_mail', '7:9', '옛메일', 'answered', old);
  inquiry('naver_qna', 'Q1', '옛상품문의', 'closed', old);
  inquiry('naver_qna', 'Q2', '옛미답변', 'open', old);

  const page = (await admin.request('/admin/storage')).text;
  assert.match(page, /끝난 주문 1건/);
  assert.match(page, /답변한 문의 2건/);

  // 미리보기와 숫자가 다르면 지우지 않는다
  await admin.submit('/admin/storage', '/admin/storage/cleanup', { orders: '5', inquiries: '2' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 4);

  await admin.submit('/admin/storage', '/admin/storage/cleanup', { orders: '1', inquiries: '2' });
  assert.deepStrictEqual(db.prepare('SELECT channel_order_id FROM orders ORDER BY channel_order_id').all().map(r => r.channel_order_id), ['KEEP1', 'KEEP2', 'KEEP3']);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM order_actions WHERE channel_order_id = 'GONE'").get().n, 0);
  const m = db.prepare('SELECT subject, deleted_at, deleted_by FROM inquiries WHERE id = ?').get(mail);
  assert.deepStrictEqual([m.subject, Boolean(m.deleted_at), m.deleted_by], [null, true, adminId], '메일은 표시만 남김');
  assert.deepStrictEqual(db.prepare("SELECT external_id FROM inquiries WHERE source = 'naver_qna'").all().map(r => r.external_id), ['Q2']);
  assert.match((await admin.request('/admin/storage')).text, /대표 · 주문 1건, 문의 2건/);

  // 보관 기간을 6개월로 줄이면 반년 전 주문도 대상
  await admin.submit('/admin/storage', '/admin/storage/settings', { hide_done_days: '14', keep_orders_months: '6', keep_inquiries_months: '12' });
  assert.strictEqual(previewCleanup(db).orders, 1);
  await admin.submit('/admin/storage', '/admin/storage/settings', { hide_done_days: '3', keep_orders_months: '6', keep_inquiries_months: '12' });
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'hide_done_days'").get().value, '14', '정해진 값만');
});
