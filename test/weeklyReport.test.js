// 주간 매출 보고 메일: 금요일 18시, 이번 주 월~금18시 vs 지난주 같은 구간, 매출·객단가·택배 수, 한 주 한 번
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { applyOrders } = require('../src/collector');
const { createWeeklyReporter, buildReport, parseRecipients, weekRange, fillSubject } = require('../src/weeklyReport');
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
    ['2026-10-18T15:00:00.000Z', '2026-10-11T15:00:00.000Z', '2026-10-16T09:00:00.000Z', '2026-10-23']);
  // 월요일 0시에 끝나면 지난주 월~일 전체
  const mon = weekRange(new Date('2026-10-25T15:00:00Z'));
  assert.deepStrictEqual([mon.start.toISOString(), mon.end.toISOString()], ['2026-10-18T15:00:00.000Z', '2026-10-25T15:00:00.000Z']);
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
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'weekly_report_tries_2026-10-30'").get().value, '3');
  assert.match(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'weekly_report_last'").get().value).message, /SMTP 거절/);

  // 관리자 화면
  const ctx = await startServer({ weeklyAccount: { user: 'shop@naver.com' }, weeklyTransport: transport });
  t.after(() => ctx.server.close());
  fail = false;
  addUser(ctx.db, { email: 'boss@broad.test', role: 'admin' });
  const boss = await loginAs(ctx.baseUrl, 'boss@broad.test');
  await boss.submit('/admin/notify', '/admin/weekly-report', { recipients: 'a@b.com, 틀림', enabled: '1', day: '5', hour: '18' });
  assert.strictEqual(ctx.db.prepare("SELECT value FROM settings WHERE key = 'weekly_report_to'").get(), undefined, '틀린 주소가 있으면 저장 안 함');
  await boss.submit('/admin/notify', '/admin/weekly-report', { recipients: 'a@b.com, c@d.com', enabled: '1', day: '5', hour: '18' });
  assert.strictEqual(ctx.db.prepare("SELECT value FROM settings WHERE key = 'weekly_report_to'").get().value, '["a@b.com","c@d.com"]');
  const before = sent.length;
  await boss.submit('/admin/notify', '/admin/weekly-report/test', {});
  assert.strictEqual(sent.length, before + 1);
  assert.match(sent[sent.length - 1].subject, /^\[테스트\]/);
  assert.match((await boss.request('/admin/notify')).text, /마지막 발송: .*\(테스트\) · 2명에게 보냈습니다/);
});

test('제목 틀: 칸 채우기, 암호화면 금액을 빼고 빈 괄호도 정리', () => {
  const v = { 회사명: '브로애드', 기간: '10/19 ~ 10/23', 매출: '80,000원', 변화: '▲ 9%' };
  assert.strictEqual(fillSubject('', v), '[브로애드] 이번 주 매출 80,000원 (▲ 9%)');
  assert.strictEqual(fillSubject('{회사명} 주간 {매출} ({변화})', v, { encrypt: true }), '브로애드 주간');
  assert.strictEqual(fillSubject('', v, { encrypt: true }), '[브로애드] 주간 매출 보고 (10/19 ~ 10/23)');
});

test('정한 요일·시각에 보내고, 암호화면 본문에 숫자 없이 비밀번호 PDF 를 붙인다', async () => {
  const sent = [];
  const transport = { sendMail: async m => { sent.push(m); } };
  const db = openDb(':memory:');
  seed(db);
  const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  [['weekly_report_to', '["boss@x.com"]'], ['weekly_report_on', '1'], ['weekly_report_day', '4'], ['weekly_report_hour', '9'],
    ['weekly_report_subject', '{회사명} 매출 {매출}'], ['weekly_report_encrypt', '1']].forEach(([k, v]) => set.run(k, v));
  let clock = new Date('2026-10-22T00:30:00Z'); // 목요일 09:30
  const weekly = createWeeklyReporter({ db, account: { user: 'shop@naver.com' }, transport, brandName: () => '브로애드', now: () => clock });
  const noPw = await weekly.tick();
  assert.match(noPw.message, /비밀번호가 없어요/, '암호화인데 비밀번호가 없으면 보내지 않음');
  set.run('weekly_report_pw', 'secret77');
  db.prepare("DELETE FROM settings WHERE key LIKE 'weekly_report_tries_%'").run();
  const r = await weekly.tick();
  assert.ok(r.ok, r.message);
  const m = sent[0];
  assert.strictEqual(m.subject, '브로애드 매출', '암호화면 제목에서 금액을 뺀다');
  assert.ok(!/\d{2},\d{3}원/.test(m.html) && !/\d{2},\d{3}원/.test(m.text), '본문에 금액 없음');
  assert.match(m.attachments[0].filename, /^주간매출보고_2026-10-22\.pdf$/);
  const pdf = m.attachments[0].content;
  assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-');
  assert.ok(pdf.includes('/Encrypt'), 'PDF 가 잠겨 있다');
  clock = new Date('2026-10-23T09:30:00Z'); // 금요일: 정한 요일이 아님
  assert.strictEqual(await weekly.tick(), null);
});

test('관리자 화면: 요일·시각·제목·암호화 저장, 비밀번호는 다시 보이지 않음', async t => {
  const sent = [];
  const ctx = await startServer({ weeklyAccount: { user: 'shop@naver.com' }, weeklyTransport: { sendMail: async m => { sent.push(m); } } });
  t.after(() => ctx.server.close());
  addUser(ctx.db, { email: 'boss@broad.test', role: 'admin' });
  const boss = await loginAs(ctx.baseUrl, 'boss@broad.test');
  const save = fields => boss.submit('/admin/notify', '/admin/weekly-report', { recipients: 'a@b.com', enabled: '1', day: '1', hour: '9', subject: '주간 {매출}', ...fields });
  const get = k => (ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value;
  await save({ encrypt: '1' });
  assert.strictEqual(get('weekly_report_day'), undefined, '비밀번호 없이 암호화를 켜면 저장 안 함');
  await save({ encrypt: '1', password: 'abc', password2: 'abc' });
  assert.strictEqual(get('weekly_report_pw'), undefined, '6자 미만');
  await save({ encrypt: '1', password: 'abcdef12', password2: 'abcdef13' });
  assert.strictEqual(get('weekly_report_pw'), undefined, '두 칸이 다름');
  await save({ encrypt: '1', password: 'abcdef12', password2: 'abcdef12' });
  assert.deepStrictEqual([get('weekly_report_day'), get('weekly_report_hour'), get('weekly_report_subject'), get('weekly_report_encrypt'), get('weekly_report_pw')],
    ['1', '9', '주간 {매출}', '1', 'abcdef12']);
  await save({ encrypt: '1' });
  assert.strictEqual(get('weekly_report_pw'), 'abcdef12', '비워 두면 비밀번호 그대로');
  const page = (await boss.request('/admin/notify')).text;
  assert.ok(!page.includes('abcdef12'), '비밀번호는 화면에 나오지 않음');
  assert.match(page, /설정됨/);
  assert.match(page, /<option value="1" selected>월요일/);
  await boss.submit('/admin/notify', '/admin/weekly-report/test', {});
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].attachments[0].content.includes('/Encrypt'));
});
