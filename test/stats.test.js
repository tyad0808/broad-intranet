// 매출 통계: 채널 주문은 상품별 결제 금액 합, 수기 주문은 주문 금액 한 번, 취소·입금 전은 빼고, 관리자만
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { salesReport, previousRange } = require('../src/stats');
const { startServer, addUser, loginAs } = require('./helpers');

function seed(db) {
  const ins = db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, item_type, quantity, paid_at, channel_status, pay_amount, amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // 10/5 한국 시간 오전 10시 = 01:00Z
  ins.run('smartstore', 'S1', 'S1-1', '현수막', 'main', 2, '2026-10-05T01:00:00Z', 'PAYED', 30000, null);
  ins.run('smartstore', 'S1', 'S1-2', '고리', 'addon', 1, '2026-10-05T01:00:00Z', 'PAYED', 2000, null);
  ins.run('manual', 'M1', 'M1-1', '명함', 'main', 1, '2026-10-06T02:00:00Z', 'PAYED', null, 50000);
  ins.run('manual', 'M1', 'M1-2', '스티커', 'main', 1, '2026-10-06T02:00:00Z', 'PAYED', null, 50000);
  ins.run('coupang', 'C1', 'C1-1', '현수막', 'main', 1, '2026-10-06T03:00:00Z', 'CANCELED', 15000, null);
  ins.run('manual', 'M2', 'M2-1', '배너', 'main', 1, '2026-10-07T03:00:00Z', 'PAYMENT_WAITING', null, 99000);
  ins.run('godo', 'G1', 'G1-1', '아크릴', 'main', 1, '2026-10-07T04:00:00Z', 'PAYED', null, null); // 금액 모름
  ins.run('smartstore', 'S0', 'S0-1', '현수막', 'main', 1, '2026-09-20T01:00:00Z', 'PAYED', 41000, null); // 지난 기간
  // 10월 1일 0시 30분 (한국) = 9/30 15:30Z → 10월에 들어간다
  ins.run('smartstore', 'S2', 'S2-1', '자정 주문', 'main', 1, '2026-09-30T15:30:00Z', 'PAYED', 1000, null);
}

test('합계·비교·채널·일별·상품·요일 시간대', () => {
  const db = openDb(':memory:');
  seed(db);
  const r = salesReport(db, '2026-10-01', '2026-10-21');
  assert.deepStrictEqual([r.totals.sales, r.totals.orders, r.totals.missing, r.totals.canceled], [83000, 4, 1, 1], '현수막+고리 32000 + 수기 50000 한 번 + 자정 1000, 취소·입금 전 제외');
  assert.strictEqual(r.totals.aov, Math.round(83000 / 3), '금액을 아는 주문만으로 객단가');
  assert.deepStrictEqual([r.prev.fromDay, r.prev.toDay], ['2026-09-10', '2026-09-30']);
  assert.strictEqual(r.prevTotals.sales, 41000, '9/30 한국 자정 넘은 주문은 10월로');
  assert.deepStrictEqual(r.channels.map(c => [c.ch, c.sales]), [['manual', 50000], ['smartstore', 33000], ['godo', 0]]);
  assert.strictEqual(r.series.points.length, 21);
  assert.deepStrictEqual(r.series.points.find(p => p.k === '2026-10-05'), { k: '2026-10-05', sales: 32000, orders: 1 });
  assert.deepStrictEqual(r.products.slice(0, 3).map(p => [p.name, p.sales]), [['명함', 25000], ['스티커', 25000], ['현수막', 30000]].sort((a, b) => b[1] - a[1]));
  assert.ok(!r.products.some(p => p.name === '고리'), '추가상품은 상품 순위에서 뺀다');
  assert.strictEqual(r.heatmap[1][10], 1, '10/5(월) 오전 10시');
  assert.strictEqual(salesReport(db, '2026-01-01', '2026-10-21').series.monthly, true, '두 달 넘으면 월별');
  assert.deepStrictEqual(previousRange('2026-10-01', '2026-10-31'), { fromDay: '2026-08-31', toDay: '2026-09-30' });
});

test('통계 화면은 관리자만, 왼쪽 메뉴에도 관리자에게만', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  seed(db);
  addUser(db, { email: 'boss@broad.test', role: 'admin', name: '대표' });
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const page = (await boss.request('/stats?from=2026-10-01&to=2026-10-21')).text;
  assert.match(page, /83,000원/);
  assert.match(page, /금액을 모르는 주문 1건/);
  assert.match(page, /href="\/stats" class="on"/);
  assert.strictEqual((await kim.request('/stats')).status, 403);
  assert.ok(!(await kim.request('/')).text.includes('href="/stats"'));
});

test('직원별 처리 현황: 담당·디자인 단계 바뀐 기록이 남고, 디자이너별·직원별·응답 속도를 센다', async t => {
  const { applyOrders } = require('../src/collector');
  const { staffReport } = require('../src/stats');
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  const { db } = ctx;
  const designerJob = db.prepare("SELECT id FROM jobs WHERE name = '디자이너'").get().id;
  const kimId = addUser(db, { email: 'kim@broad.test', name: '김디자' });
  db.prepare('UPDATE users SET job_id = ? WHERE id = ?').run(designerJob, kimId);
  const now = new Date();
  const paid = new Date(now.getTime() - 5 * 3600 * 1000).toISOString();
  applyOrders(db, [1, 2].map(n => ({
    channel: 'smartstore', channel_order_id: `O${n}`, channel_item_id: `P${n}`, product_name: `상품${n}`, quantity: 1, option_text: null,
    buyer_name: '구매자', receiver_name: '수령', receiver_phone: null, receiver_address: null,
    paid_at: paid, channel_status: 'PAYED', channel_confirmed: 0,
  })));
  const id = n => db.prepare('SELECT id FROM orders WHERE channel_item_id = ?').get(`P${n}`).id;
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  await kim.submit('/', `/orders/${id(1)}/assign`, { assignee_id: String(kimId), back: '/' });
  await kim.submit('/', `/orders/${id(2)}/assign`, { assignee_id: String(kimId), back: '/' });
  const last = db.prepare('SELECT id FROM design_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1').get().id;
  await kim.submit('/', `/orders/${id(1)}/design`, { design_stage_id: String(last), back: '/' });
  assert.deepStrictEqual(db.prepare('SELECT kind, user_id, to_value FROM order_events ORDER BY id').all().map(e => [e.kind, e.user_id, e.to_value]),
    [['assign', kimId, kimId], ['assign', kimId, kimId], ['design', kimId, last]]);
  await kim.submit('/', `/orders/${id(1)}/assign`, { assignee_id: String(kimId), back: '/' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n, 3, '값이 그대로면 기록하지 않는다');

  // 문의: 3시간 전에 들어와 지금 답변
  const qid = Number(db.prepare("INSERT INTO inquiries (source, external_id, subject, body, received_at) VALUES ('naver_mail', '7:1', '견적', '', ?)")
    .run(new Date(now.getTime() - 3 * 3600 * 1000).toISOString()).lastInsertRowid);
  db.prepare("INSERT INTO inquiry_replies (inquiry_id, user_id, body, mode, result) VALUES (?, ?, '답변', 'practice', 'practice')").run(qid, kimId);

  const today = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() + 9 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  const r = staffReport(db, yesterday, today).rows.find(x => x.id === kimId);
  assert.deepStrictEqual([r.open, r.assigned, r.designCount, r.replies], [2, 2, 1, 1]);
  assert.ok(r.designHours > 4.9 && r.designHours < 5.2, `결제→디자인 끝 약 5시간 (${r.designHours})`);
  assert.ok(r.replyHours > 2.9 && r.replyHours < 3.2, `첫 답변까지 약 3시간 (${r.replyHours})`);

  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(kimId);
  const page = (await kim.request(`/stats?tab=staff&from=${yesterday}&to=${today}`)).text;
  assert.match(page, /디자이너별/);
  assert.match(page, /김디자/);
  assert.match(page, /네이버메일/);
});

test('빠른 기간: 오늘·어제가 맨 앞, 기본은 이번 달', () => {
  const { quickRanges } = require('../src/routes/stats');
  const q = quickRanges(new Date('2026-10-22T03:00:00Z')); // 한국 10/22 낮
  assert.deepStrictEqual(q.slice(0, 3).map(x => [x.label, x.from, x.to]), [
    ['오늘', '2026-10-22', '2026-10-22'], ['어제', '2026-10-21', '2026-10-21'], ['이번 달', '2026-10-01', '2026-10-22'],
  ]);
});
