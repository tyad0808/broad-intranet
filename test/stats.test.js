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
