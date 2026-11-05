// 부관리자: 관리자 설정(/admin)만 빼고 관리자 기능을 다 쓴다 (통계·주문 단계·남의 일정·답장 문구 엑셀·관리자 알림 일부)
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs } = require('./helpers');

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  const { db } = ctx;
  ctx.bossId = addUser(db, { email: 'boss@broad.test', name: '사장', role: 'admin' });
  ctx.subId = addUser(db, { email: 'sub@broad.test', name: '부장' });
  ctx.kimId = addUser(db, { email: 'kim@broad.test', name: '김직원' });
  ctx.boss = await loginAs(ctx.baseUrl, 'boss@broad.test');
  // 관리자가 직원 관리에서 '부관리자' 로 바꾼다
  const res = await ctx.boss.submit('/admin/users', `/admin/users/${ctx.subId}/update`, { role: 'sub', job_id: '' });
  assert.strictEqual(res.status, 302);
  ctx.sub = await loginAs(ctx.baseUrl, 'sub@broad.test');
  ctx.kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  return ctx;
}

test('직원 관리: 역할을 직원·부관리자·관리자 중에서 고르고, 부관리자는 role=staff + sub_admin=1 (예전 코드로 되돌려도 직원)', async t => {
  const { db, boss, subId, kimId } = await setup(t);
  assert.deepStrictEqual({ ...db.prepare('SELECT role, sub_admin FROM users WHERE id = ?').get(subId) }, { role: 'staff', sub_admin: 1 });
  const page = (await boss.request('/admin/users')).text;
  assert.match(page, /<option value="sub" selected>부관리자<\/option>/);
  assert.match(page, /<option value="sub" >부관리자<\/option>/, '다른 직원에게도 고를 수 있게');
  // 관리자로 올리면 부관리자 표시는 지운다, 다시 직원으로
  await boss.submit('/admin/users', `/admin/users/${kimId}/update`, { role: 'admin', job_id: '' });
  assert.deepStrictEqual({ ...db.prepare('SELECT role, sub_admin FROM users WHERE id = ?').get(kimId) }, { role: 'admin', sub_admin: 0 });
  await boss.submit('/admin/users', `/admin/users/${kimId}/update`, { role: 'staff', job_id: '' });
  assert.deepStrictEqual({ ...db.prepare('SELECT role, sub_admin FROM users WHERE id = ?').get(kimId) }, { role: 'staff', sub_admin: 0 });
});

test('부관리자: 통계는 열리고 관리자 설정은 모두 막힌다, 왼쪽 메뉴에 통계만', async t => {
  const { sub, kim } = await setup(t);
  assert.strictEqual((await sub.request('/stats')).status, 200);
  assert.strictEqual((await kim.request('/stats')).status, 403, '직원은 통계 못 봄');
  for (const path of ['/admin/users', '/admin/stages', '/admin/notify', '/admin/collect', '/admin/logen', '/admin/actions', '/admin/storage', '/admin/brand', '/admin/mail', '/admin/channels']) {
    assert.strictEqual((await sub.request(path)).status, 403, `${path} 는 관리자만`);
  }
  const home = (await sub.request('/')).text;
  assert.match(home, /href="\/stats"/);
  assert.doesNotMatch(home, /href="\/admin\/users"/, '관리자 메뉴는 안 보임');
  // 관리자 설정을 바꾸는 요청도 막힌다
  const res = await sub.submit('/', '/admin/storage/settings', { hide_done_days: '30' });
  assert.strictEqual(res.status, 403);
});

test('부관리자: 주문 단계 바꾸기·남의 일정 고치기·답장 문구 엑셀 받기 (관리자 탭은 안 보임)', async t => {
  const { db, sub, kim, bossId } = await setup(t);
  db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, stage_id, channel_status) VALUES ('manual', 'M1', 'M1-1', '현수막', (SELECT id FROM work_stages WHERE name = '발주'), 'PAYED')").run();
  const orderId = db.prepare("SELECT id FROM orders WHERE channel_item_id = 'M1-1'").get().id;
  const sendStage = db.prepare("SELECT id FROM work_stages WHERE name = '발송'").get().id;
  assert.match((await sub.request(`/orders/${orderId}`)).text, /<select name="stage_id">/);
  assert.doesNotMatch((await kim.request(`/orders/${orderId}`)).text, /<select name="stage_id">/);
  const version = db.prepare('SELECT version FROM orders WHERE id = ?').get(orderId).version;
  await sub.submit(`/orders/${orderId}`, `/orders/${orderId}`, { stage_id: String(sendStage), version: String(version) });
  assert.strictEqual(db.prepare('SELECT stage_id FROM orders WHERE id = ?').get(orderId).stage_id, sendStage, '부관리자는 주문 단계를 바꿀 수 있다');

  const eventId = Number(db.prepare("INSERT INTO events (title, start_date, created_by) VALUES ('사장님 일정', '2026-11-10', ?)").run(bossId).lastInsertRowid);
  await kim.submit('/', `/calendar/events/${eventId}`, { title: '직원이 고침', start_date: '2026-11-10' });
  assert.strictEqual(db.prepare('SELECT title FROM events WHERE id = ?').get(eventId).title, '사장님 일정', '직원은 남의 일정 못 고침');
  await sub.submit('/', `/calendar/events/${eventId}`, { title: '부관리자가 고침', start_date: '2026-11-10' });
  assert.strictEqual(db.prepare('SELECT title FROM events WHERE id = ?').get(eventId).title, '부관리자가 고침');

  const templates = (await sub.request('/templates')).text;
  assert.match(templates, /href="\/templates\/export\.xlsx"/);
  assert.ok(!templates.includes('admin-chips'), '부관리자에게 관리자 탭은 안 보임');
  assert.strictEqual((await sub.request('/templates/export.xlsx')).status, 200);
  assert.strictEqual((await kim.request('/templates/export.xlsx')).status, 403);
});

test('알림: 담당 없는 주문이 쌓였다는 띠는 관리자·부관리자에게 (직원은 고른 사람만)', async t => {
  const { db, sub, kim } = await setup(t);
  db.prepare("INSERT INTO settings (key, value) VALUES ('unassigned_threshold', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  for (const n of [1, 2, 3]) {
    db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, stage_id, channel_status) VALUES ('manual', ?, ?, '현수막', (SELECT id FROM work_stages WHERE name = '발주'), 'PAYED')").run(`U${n}`, `U${n}-1`);
  }
  assert.match((await sub.request('/')).text, /id="unassigned-bar"/);
  assert.doesNotMatch((await kim.request('/')).text, /id="unassigned-bar"/);
});
