// 주간 매출 보고 메일: 금요일 18시, 이번 주 월~금18시 vs 지난주 같은 구간, 매출·객단가·택배 수, 한 주 한 번
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { applyOrders } = require('../src/collector');
const { createWeeklyReporter, buildReport, parseRecipients, weekRange } = require('../src/weeklyReport');
const { startServer, addUser, loginAs } = require('./helpers');

// 2026-10-23 은 금요일. 18:00 한국 = 09:00Z
const FRI_18 = new Date('2026-10-23T09:00:00Z');

function seed(db) {
  const ins = db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, paid_at, channel_status, pay_amount, shipped_at, channel_shipped_at, ship_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // 이번 주 (월 10/19 ~)
  ins.run('smartstore', 'A', 'A1', 'x', '2026-10-19T01:00:00Z', 'DELIVERING', 30000, null, '2026-10-20 02:00:00', null);
  ins.run('coupang', 'B', 'B1', 'y', '2026-10-22T01:00:00Z', 'PAYED', 50000, '2026-10-22 03:00:00', null, 'DELIVERY');
  ins.run('manual', 'C', 'C1', 'z', '2026-10-21T01:00:00Z', 'DELIVERED', null, '2026-10-21 05:00:00', null, 'QUICK');
  ins.run('smartstore', 'L', 'L1', '금요일 밤', '2026-10-23T10:00:00Z', 'PAYED', 99000, null, null, null); // 18시 넘어 → 다음 보고
  // 지난주 같은 구간 (월 10/12 ~ 금 10/16 18시)
  ins.run('smartstore', 'P', 'P1', 'p', '2026-10-13T01:00:00Z', 'DELIVERED', 40000, '2026-10-14 01:00:00', null, 'DELIVERY');
}

test('주소 나누기·검사, 이번 주 구간', () => {
  assert.deepStrictEqual(parseRecipients('a@b.com, c@d.kr\ne@f.com').list, ['a@b.com', 'c@d.kr', 'e@f.com']);
  assert.match(parseRecipients('a@b.com, 이상한주소').error, /이상한주소/);
  const r = weekRange(FRI_18);
  assert.deepStrictEqual([r.start.toISOString(), r.prevStart.toISOString(), r.prevEnd.toISOString(), r.weekKey],
    ['2026-10-18T15:00:00.000Z', '2026-10-11T15:00:00.000Z', '2026-10-16T09:00:00.000Z', '2026-10-19']);
});

test('매출·객단가·택배 수(퀵 제외)·지난주 비교', () => {
  const db = openDb(':memory:');
  seed(db);
  const rep = buildReport(db, FRI_18);
  const v = label => rep.rows.find(x => x.label === label);
  assert.deepStrictEqual([v('매출').now, v('매출').before], [80000, 40000]);
  assert.deepStrictEqual([v('객단가').now, v('객단가').before], [40000, 40000]);
  assert.deepStrictEqual([v('발송된 택배').now, v('발송된 택배').before], [2, 1], '퀵은 빼고, 채널에서 발송한 것도 센다');
});

test('채널에서 배송중으로 바뀐 걸 처음 본 시각을 발송 시각으로 남긴다', () => {
  const db = openDb(':memory:');
  const o = { channel: 'smartstore', channel_order_id: 'O1', channel_item_id: 'P1', product_name: 'x', option_text: null, quantity: 1,
    buyer_name: null, receiver_name: null, receiver_phone: null, receiver_address: null, paid_at: '2026-10-19T01:00:00Z', channel_status: 'PAYED', channel_confirmed: 1 };
  applyOrders(db, [o]);
  applyOrders(db, [{ ...o, channel_status: 'DELIVERING' }]);
  const first = db.prepare('SELECT channel_shipped_at FROM orders').get().channel_shipped_at;
  assert.ok(first);
  applyOrders(db, [{ ...o, channel_status: 'DELIVERED' }]);
  assert.strictEqual(db.prepare('SELECT channel_shipped_at FROM orders').get().channel_shipped_at, first, '처음 본 시각 그대로');
});

test('금요일 18시가 지나면 한 번만 보내고, 실패하면 3번까지 다시, 관리자 화면에서 주소 저장·테스트 발송', async t => {
  const sent = [];
  let fail = false;
  const transport = { sendMail: async m => { if (fail) throw new Error('SMTP 거절'); sent.push(m); } };
  const db = openDb(':memory:');
  seed(db);
  let clock = new Date('2026-10-23T08:55:00Z'); // 금요일 17:55
  const weekly = createWeeklyReporter({ db, account: { user: 'shop@naver.com' }, transport, brandName: () => '브로애드', now: () => clock });
  db.prepare("INSERT INTO settings (key, value) VALUES ('weekly_report_to', '[\"boss@x.com\"]'), ('weekly_report_on', '1')").run();
  assert.strictEqual(await weekly.tick(), null, '18시 전에는 안 보냄');
  clock = new Date('2026-10-23T09:04:00Z');
  const r = await weekly.tick();
  assert.ok(r.ok);
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].to, ['boss@x.com']);
  assert.match(sent[0].subject, /\[브로애드\] 이번 주 매출 80,000원 \(▲ 100%\)/);
  assert.match(sent[0].html, /발송된 택배/);
  assert.ok(!sent[0].html.includes('99,000'), '18시 뒤 주문은 이번 보고에 넣지 않음');
  clock = new Date('2026-10-23T09:30:00Z');
  await weekly.tick();
  assert.strictEqual(sent.length, 1, '한 주에 한 번');

  // 다음 주: 실패하면 3번까지만 다시 시도
  clock = new Date('2026-10-30T09:05:00Z');
  fail = true;
  for (let i = 0; i < 5; i++) await weekly.tick();
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'weekly_report_tries_2026-10-26'").get().value, '3');
  assert.match(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'weekly_report_last'").get().value).message, /SMTP 거절/);

  // 관리자 화면
  const ctx = await startServer({ weeklyAccount: { user: 'shop@naver.com' }, weeklyTransport: transport });
  t.after(() => ctx.server.close());
  fail = false;
  addUser(ctx.db, { email: 'boss@broad.test', role: 'admin' });
  const boss = await loginAs(ctx.baseUrl, 'boss@broad.test');
  await boss.submit('/admin/notify', '/admin/weekly-report', { recipients: 'a@b.com, 틀림', enabled: '1' });
  assert.strictEqual(ctx.db.prepare("SELECT value FROM settings WHERE key = 'weekly_report_to'").get(), undefined, '틀린 주소가 있으면 저장 안 함');
  await boss.submit('/admin/notify', '/admin/weekly-report', { recipients: 'a@b.com, c@d.com', enabled: '1' });
  assert.strictEqual(ctx.db.prepare("SELECT value FROM settings WHERE key = 'weekly_report_to'").get().value, '["a@b.com","c@d.com"]');
  const before = sent.length;
  await boss.submit('/admin/notify', '/admin/weekly-report/test', {});
  assert.strictEqual(sent.length, before + 1);
  assert.match(sent[sent.length - 1].subject, /^\[테스트\]/);
  assert.match((await boss.request('/admin/notify')).text, /마지막 발송: .*\(테스트\) · 2명에게 보냈습니다/);
});
