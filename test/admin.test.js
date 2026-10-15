// 관리자 메뉴: 직원 승인·거절·정지, 작업 단계·직무 편집
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs } = require('./helpers');

// 관리자 화면에서 CSRF 토큰을 얻어 버튼을 누른다
async function press(b, path, fields = {}, page = '/admin/users') {
  return b.submit(page, path, fields);
}

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  ctx.adminId = addUser(ctx.db, { email: 'boss@broad.test', role: 'admin', name: '대표' });
  ctx.admin = await loginAs(ctx.baseUrl, 'boss@broad.test');
  ctx.statusOf = id => ctx.db.prepare('SELECT status FROM users WHERE id = ?').get(id).status;
  return ctx;
}

test('직원은 관리자 메뉴에 들어갈 수 없다', async t => {
  const { db, baseUrl } = await setup(t);
  addUser(db, { email: 'staff@broad.test' });
  const staff = await loginAs(baseUrl, 'staff@broad.test');
  const res = await staff.request('/admin/users');
  assert.strictEqual(res.status, 403);
});

test('가입 신청이 관리자 화면과 배지에 보이고, 승인하면 직원이 홈을 볼 수 있다', async t => {
  const { db, baseUrl, admin, statusOf } = await setup(t);
  const id = addUser(db, { email: 'new@broad.test', status: 'pending', name: '신입' });
  const waiting = await loginAs(baseUrl, 'new@broad.test');
  assert.strictEqual((await waiting.request('/')).location, '/pending');

  const page = await admin.request('/admin/users');
  assert.match(page.text, /신입/);
  assert.match(page.text, /class="badge">1</);

  const res = await press(admin, `/admin/users/${id}/approve`);
  assert.strictEqual(res.location, '/admin/users');
  assert.strictEqual(statusOf(id), 'active');
  assert.strictEqual((await waiting.request('/')).status, 200);
});

test('거절하면 로그인할 수 없다', async t => {
  const { db, baseUrl, admin, statusOf } = await setup(t);
  const id = addUser(db, { email: 'no@broad.test', status: 'pending' });
  await press(admin, `/admin/users/${id}/reject`);
  assert.strictEqual(statusOf(id), 'rejected');
  const b = await loginAs(baseUrl, 'no@broad.test');
  assert.strictEqual((await b.request('/')).location, '/login');
});

test('정지하면 로그인해 있던 직원의 세션이 즉시 지워진다', async t => {
  const { db, baseUrl, admin, statusOf } = await setup(t);
  const id = addUser(db, { email: 'leaver@broad.test' });
  const staff = await loginAs(baseUrl, 'leaver@broad.test');
  assert.strictEqual((await staff.request('/')).status, 200);

  await press(admin, `/admin/users/${id}/suspend`);
  assert.strictEqual(statusOf(id), 'suspended');
  const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(data, '$.userId') = ?").get(id).n;
  assert.strictEqual(sessions, 0);
  assert.strictEqual((await staff.request('/')).location, '/login');

  await press(admin, `/admin/users/${id}/reactivate`);
  assert.strictEqual(statusOf(id), 'active');
});

test('관리자는 자기 자신을 정지하거나 강등할 수 없다', async t => {
  const { db, admin, adminId, statusOf } = await setup(t);
  await press(admin, `/admin/users/${adminId}/suspend`);
  assert.strictEqual(statusOf(adminId), 'active');

  await press(admin, `/admin/users/${adminId}/update`, { role: 'staff', job_id: '' });
  assert.strictEqual(db.prepare('SELECT role FROM users WHERE id = ?').get(adminId).role, 'admin');
});

test('직무와 역할을 바꿀 수 있고, 관리자로 올린 직원은 관리자 메뉴를 쓴다', async t => {
  const { db, baseUrl, admin } = await setup(t);
  const id = addUser(db, { email: 'cs@broad.test' });
  const csJob = db.prepare("SELECT id FROM jobs WHERE name = 'CS'").get().id;

  await press(admin, `/admin/users/${id}/update`, { role: 'admin', job_id: String(csJob) });
  const row = db.prepare('SELECT role, job_id FROM users WHERE id = ?').get(id);
  assert.deepStrictEqual({ ...row }, { role: 'admin', job_id: csJob });

  const promoted = await loginAs(baseUrl, 'cs@broad.test');
  assert.strictEqual((await promoted.request('/admin/users')).status, 200);
});

test('직원 이름에 넣은 HTML 은 실행되지 않고 글자로 보인다', async t => {
  const { db, admin } = await setup(t);
  addUser(db, { email: 'x@broad.test', status: 'pending', name: '<img src=x onerror=alert(1)>' });
  const page = await admin.request('/admin/users');
  assert.ok(!page.text.includes('<img src=x'));
  assert.match(page.text, /&lt;img src=x/);
});

test('작업 단계를 추가·이름변경·순서변경·숨기기 할 수 있다', async t => {
  const { db, admin } = await setup(t);
  const names = () => db.prepare('SELECT name FROM work_stages WHERE active = 1 ORDER BY sort_order').all().map(r => r.name);
  const idOf = name => db.prepare('SELECT id FROM work_stages WHERE name = ?').get(name).id;
  const page = '/admin/stages';

  await press(admin, '/admin/stages', { name: '후가공' }, page);
  assert.deepStrictEqual(names(), ['발주', '발주확인', '발송', '후가공']);

  await press(admin, `/admin/stages/${idOf('후가공')}/move`, { dir: 'up' }, page);
  assert.deepStrictEqual(names().slice(-2), ['후가공', '발송']);

  await press(admin, `/admin/stages/${idOf('발주')}/rename`, { name: '접수' }, page);
  assert.ok(names().includes('접수'));

  await press(admin, `/admin/stages/${idOf('후가공')}/toggle`, {}, page);
  assert.ok(!names().includes('후가공'));
});

test('디자인 단계도 같은 화면에서 추가·이름변경·순서변경·숨기기 할 수 있다', async t => {
  const { db, admin } = await setup(t);
  const names = () => db.prepare('SELECT name FROM design_stages WHERE active = 1 ORDER BY sort_order').all().map(r => r.name);
  const idOf = name => db.prepare('SELECT id FROM design_stages WHERE name = ?').get(name).id;
  const page = '/admin/stages';
  assert.match((await admin.request(page)).text, /디자인 단계/);
  await press(admin, '/admin/design-stages', { name: '시안 수정' }, page);
  await press(admin, `/admin/design-stages/${idOf('시안 수정')}/move`, { dir: 'up' }, page);
  assert.deepStrictEqual(names(), ['디자인 작업 전', '디자인 작업 중', '시안 수정', '컨펌 후 파일전송']);
  await press(admin, `/admin/design-stages/${idOf('디자인 작업 중')}/rename`, { name: '작업 중' }, page);
  await press(admin, `/admin/design-stages/${idOf('시안 수정')}/toggle`, {}, page);
  assert.deepStrictEqual(names(), ['디자인 작업 전', '작업 중', '컨펌 후 파일전송']);
});

test('이미 있는 이름으로 바꾸면 거부하고 안내한다', async t => {
  const { db, admin } = await setup(t);
  const id = db.prepare("SELECT id FROM work_stages WHERE name = '발주확인'").get().id;
  await press(admin, `/admin/stages/${id}/rename`, { name: '발송' }, '/admin/stages');
  const page = await admin.request('/admin/stages');
  assert.match(page.text, /이미 있는 이름/);
  assert.strictEqual(db.prepare('SELECT name FROM work_stages WHERE id = ?').get(id).name, '발주확인');
});

test('작업 단계는 최소 1개는 남아야 한다', async t => {
  const { db, admin } = await setup(t);
  const ids = db.prepare('SELECT id FROM work_stages ORDER BY sort_order').all().map(r => r.id);
  for (const id of ids) {
    await press(admin, `/admin/stages/${id}/toggle`, {}, '/admin/stages');
  }
  const active = db.prepare('SELECT COUNT(*) AS n FROM work_stages WHERE active = 1').get().n;
  assert.strictEqual(active, 1);
});

test('직무를 담당 디자이너 목록에 넣고 뺄 수 있다', async t => {
  const { db, admin } = await setup(t);
  const id = db.prepare("SELECT id FROM jobs WHERE name = '출력·후가공'").get().id;
  await press(admin, `/admin/jobs/${id}/designer`, {}, '/admin/jobs');
  assert.strictEqual(db.prepare('SELECT is_designer FROM jobs WHERE id = ?').get(id).is_designer, 1);
});

test('숨긴 직무는 회원가입 화면에 나오지 않는다', async t => {
  const { db, baseUrl, admin } = await setup(t);
  const id = db.prepare("SELECT id FROM jobs WHERE name = 'CS'").get().id;
  await press(admin, `/admin/jobs/${id}/toggle`, {}, '/admin/jobs');
  const { browser } = require('./helpers');
  const signup = await browser(baseUrl).request('/signup');
  assert.ok(!signup.text.includes('>CS<'));
});
