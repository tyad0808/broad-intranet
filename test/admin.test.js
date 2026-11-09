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

test('거절하면 계정이 지워져 로그인할 수 없고, 예전에 거절해 둔 계정은 [삭제]로 지운다', async t => {
  const { db, baseUrl, admin } = await setup(t);
  const id = addUser(db, { email: 'no@broad.test', status: 'pending' });
  const waiting = await loginAs(baseUrl, 'no@broad.test');
  await press(admin, `/admin/users/${id}/reject`);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(id).n, 0, '계정이 지워짐');
  assert.strictEqual((await waiting.request('/')).location, '/login', '로그인해 있던 것도 끊김');
  const b = await loginAs(baseUrl, 'no@broad.test');
  assert.strictEqual((await b.request('/')).location, '/login');

  const old = addUser(db, { email: 'spam@x.info', status: 'rejected', name: '스팸' });
  const active = addUser(db, { email: 'kim@broad.test' });
  const page = (await admin.request('/admin/users')).text;
  assert.match(page, new RegExp(`/admin/users/${old}/delete`));
  await press(admin, `/admin/users/${active}/delete`);
  assert.strictEqual(db.prepare('SELECT status FROM users WHERE id = ?').get(active).status, 'active', '거절한 계정만 지울 수 있음');
  await press(admin, `/admin/users/${old}/delete`);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(old).n, 0);
});

test('정지한 직원 [삭제]: 진행 중 주문·미답변 문의는 미지정, 기록이 있으면 줄은 남기고 목록·로그인에서 빠지며 같은 메일로 다시 가입', async t => {
  const { db, baseUrl, admin, adminId } = await setup(t);
  const kim = addUser(db, { email: 'kim@broad.test', name: '김퇴사' });
  const lee = addUser(db, { email: 'lee@broad.test', name: '이테스트' });
  const stage = db.prepare("SELECT id FROM work_stages WHERE name = '발주'").get().id;
  const add = (oid, status) => db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, channel_status, stage_id, assignee_id) VALUES ('smartstore', ?, ?, '현수막', ?, ?, ?)").run(oid, `${oid}-1`, status, stage, kim);
  add('OPEN1', 'PAYED');
  add('DONE1', 'DELIVERED');
  db.prepare("INSERT INTO inquiries (source, external_id, subject, body, received_at, assignee_id, status) VALUES ('gmail', 'm1', '문의', '내용', '2026-11-09T00:00:00Z', ?, 'open')").run(kim);

  // 일하는 중인 직원은 바로 못 지운다 (먼저 정지)
  await press(admin, `/admin/users/${kim}/delete`);
  assert.strictEqual(db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(kim).deleted_at, null);
  await press(admin, `/admin/users/${kim}/suspend`);
  await press(admin, `/admin/users/${lee}/suspend`);
  const page = (await admin.request('/admin/users')).text;
  assert.match(page, /김퇴사 님을 삭제할까요\?\n담당 중인 진행 중 주문 1건·미답변 문의 1건은 미지정이 됩니다/);

  await press(admin, `/admin/users/${kim}/delete`);
  const row = db.prepare('SELECT name, email, deleted_at FROM users WHERE id = ?').get(kim);
  assert.ok(row.deleted_at, '기록이 있어서 줄은 남기고 삭제 표시');
  assert.strictEqual(row.name, '김퇴사', '지난 기록에 이름은 남는다');
  const assignee = oid => db.prepare('SELECT assignee_id FROM orders WHERE channel_order_id = ?').get(oid).assignee_id;
  assert.strictEqual(assignee('OPEN1'), null, '진행 중 주문은 미지정');
  assert.strictEqual(assignee('DONE1'), kim, '끝난 주문 기록은 그대로');
  assert.strictEqual(db.prepare("SELECT assignee_id FROM inquiries WHERE external_id = 'm1'").get().assignee_id, null);
  const after = (await admin.request('/admin/users')).text;
  assert.match(after, /김퇴사 님을 삭제했어요\. 진행 중 주문 1건·미답변 문의 1건은 미지정이 됐어요\. 지난 처리 기록에는 이름이 그대로 남아요/);
  assert.doesNotMatch(after.replace(/김퇴사 님을 삭제했어요[^<]*/, ''), /김퇴사/, '직원 목록에서 빠짐');
  assert.strictEqual((await loginAs(baseUrl, 'kim@broad.test').then(b => b.request('/'))).location, '/login', '로그인 안 됨');
  // 같은 메일로 다시 가입할 수 있다
  assert.ok(!db.prepare('SELECT 1 FROM users WHERE email = ?').get('kim@broad.test'));

  // 기록이 하나도 없는 계정은 완전히 지운다
  await press(admin, `/admin/users/${lee}/delete`);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(lee).n, 0);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(adminId));
});

test('별명: 가입할 때 넣고, 관리자 화면에서 고치고 비울 수 있다', async t => {
  const { db, baseUrl, admin } = await setup(t);
  const { browser } = require('./helpers');
  const b = browser(baseUrl);
  await b.submit('/signup', '/signup', { email: 'new@broad.test', name: '박실명', nickname: '  디자이너 하늘 ', password: 'password123', password_confirm: 'password123' });
  const id = db.prepare('SELECT id FROM users WHERE email = ?').get('new@broad.test').id;
  assert.strictEqual(db.prepare('SELECT nickname FROM users WHERE id = ?').get(id).nickname, '디자이너 하늘');
  assert.match((await admin.request('/admin/users')).text, /별명 디자이너 하늘/, '가입 신청 줄에 별명');
  await press(admin, `/admin/users/${id}/approve`);
  assert.match((await admin.request('/admin/users')).text, /name="nickname" value="디자이너 하늘"/);
  await press(admin, `/admin/users/${id}/update`, { nickname: '바다', role: 'staff', job_id: '' });
  assert.strictEqual(db.prepare('SELECT nickname FROM users WHERE id = ?').get(id).nickname, '바다');
  assert.match((await admin.request('/admin/users')).text, /name="nickname" value="바다"/);
  await press(admin, `/admin/users/${id}/update`, { nickname: '  ', role: 'staff', job_id: '' });
  assert.strictEqual(db.prepare('SELECT nickname FROM users WHERE id = ?').get(id).nickname, null);
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

test('수기 주문 출처를 추가·이름변경·순서변경·숨기기 하고, 수기 주문 채널 이름을 바꿀 수 있다', async t => {
  const { db, admin } = await setup(t);
  const names = () => db.prepare('SELECT name FROM order_sources WHERE active = 1 ORDER BY sort_order').all().map(r => r.name);
  const idOf = name => db.prepare('SELECT id FROM order_sources WHERE name = ?').get(name).id;
  const page = '/admin/sources';
  assert.deepStrictEqual(names(), ['계좌·전화 주문', 'G마켓', '옥션', '기타'], '처음 목록');
  assert.match((await admin.request(page)).text, /수기 주문 출처/);

  await press(admin, '/admin/sources', { name: '11번가' }, page);
  await press(admin, `/admin/sources/${idOf('11번가')}/move`, { dir: 'up' }, page);
  await press(admin, `/admin/sources/${idOf('계좌·전화 주문')}/rename`, { name: '계좌 주문' }, page);
  await press(admin, `/admin/sources/${idOf('기타')}/toggle`, {}, page);
  assert.deepStrictEqual(names(), ['계좌 주문', 'G마켓', '옥션', '11번가']);

  // 채널 이름·한 글자 표시 → 주문 목록 칩과 카드에 반영, 비우면 처음 이름으로
  db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, quantity, channel_status, channel_confirmed)
    VALUES ('manual', 'M261017-001', 'M261017-001-1', '명함', 1, 'PAYED', 1)`).run();
  await press(admin, '/admin/manual-channel', { name: '직접 주문', mark: '직접' }, page);
  const list = (await admin.request('/')).text;
  assert.match(list, /<span class="ch ch-manual">직<\/span>직접 주문/);
  await press(admin, '/admin/manual-channel', { name: '', mark: '' }, page);
  assert.match((await admin.request('/')).text, /<span class="ch ch-manual">수<\/span>수기 주문/);
});

test('저장 공간: 디스크·DB·백업 크기를 보여주고, 80% 를 넘으면 관리자에게 하루 한 번만 알린다', async t => {
  const { db, admin } = await setup(t);
  const page = (await admin.request('/admin/storage')).text;
  assert.match(page, /서버 디스크/);
  assert.match(page, /인트라넷 데이터/);

  const { storageInfo, humanSize } = require('../src/storage');
  const statfs = () => ({ bsize: 1024, blocks: 100, bfree: 15, bavail: 10 });
  const info = storageInfo({ dbPath: '/nonexistent/x.db', backupDir: '/nonexistent', statfs });
  assert.deepStrictEqual([info.disk.percent, info.alert, info.disk.free], [85, true, 10240]);
  assert.strictEqual(humanSize(1536 * 1024 * 1024), '1.5GB');

  const { createNotifier } = require('../src/notifier');
  const sent = [];
  const notifier = createNotifier({ db, hub: { send: (event, data) => sent.push(data) } });
  assert.strictEqual(notifier.checkStorage(info, '2026-10-19'), true);
  assert.strictEqual(notifier.checkStorage(info, '2026-10-19'), false, '같은 날은 한 번만');
  assert.strictEqual(notifier.checkStorage(info, '2026-10-20'), true);
  assert.strictEqual(notifier.checkStorage({ ...info, alert: false }, '2026-10-21'), false);
  assert.match(sent[0].body, /85%/);
});

test('자동 수집 간격: 관리자가 주문·메일 따로 정하고, 범위를 벗어나면 막는다. 수집은 끝날 때마다 그때의 간격으로 다음을 예약', async t => {
  const { db, admin } = await setup(t);
  const { intervalMinutes, startLoop } = require('../src/schedule');
  assert.strictEqual(intervalMinutes(db, 'order_interval_minutes', 5), 5, '처음엔 기본값');
  const page = (await admin.request('/admin/collect')).text;
  assert.match(page, /자동 수집 간격/);
  await press(admin, '/admin/collect-interval', { order_interval_minutes: '3', inbox_interval_minutes: '10' }, '/admin/collect');
  assert.deepStrictEqual([intervalMinutes(db, 'order_interval_minutes'), intervalMinutes(db, 'inbox_interval_minutes')], [3, 10]);
  await press(admin, '/admin/collect-interval', { order_interval_minutes: '0', inbox_interval_minutes: '10' }, '/admin/collect');
  await press(admin, '/admin/collect-interval', { order_interval_minutes: '61', inbox_interval_minutes: '10' }, '/admin/collect');
  assert.strictEqual(intervalMinutes(db, 'order_interval_minutes'), 3, '0분·61분은 저장 안 됨');
  assert.match((await admin.request('/admin/collect')).text, /value="3"/);

  // 예약: 매번 그때의 간격을 다시 읽는다
  let runs = 0;
  let minutes = 0.0005; // 30ms
  const stop = startLoop(async () => { runs++; if (runs === 2) minutes = 10; }, () => minutes);
  await new Promise(r => setTimeout(r, 150));
  stop();
  assert.strictEqual(runs, 2, '두 번째 뒤에는 10분으로 바뀌어 더 돌지 않음');
});

test('주문 목록 칸: 관리자가 순서를 바꾸고 숨기면 목록 표 머리·칸 자리가 바뀌고, 주문 칸은 못 숨기며, 처음 순서로 되돌린다', async t => {
  const { db, baseUrl, admin } = await setup(t);
  // 목록에 주문이 있어야 표 머리가 보인다
  db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, channel_status, paid_at) VALUES ('smartstore', 'O1', 'P1', '현수막', 'PAYED', ?)").run(new Date().toISOString());
  const page = (await admin.request('/admin/columns')).text;
  assert.match(page, /주문 목록 칸/);
  await press(admin, '/admin/columns/memo/move', { dir: 'down' }, '/admin/columns'); // 메모를 상태 뒤로
  await press(admin, '/admin/columns/assign/move', { dir: 'up' }, '/admin/columns'); // 담당을 디자인 앞으로
  await press(admin, '/admin/columns/ship/show', { show: '0' }, '/admin/columns');
  await press(admin, '/admin/columns/main/show', { show: '0' }, '/admin/columns');
  const list = (await admin.request('/')).text;
  assert.match(list, /<span class="">주문<\/span><span class="">상태<\/span><span class="head-memo">메모<\/span><span class="">납기 · 발송<\/span><span class="head-pick">담당<\/span><span class="head-pick">디자인<\/span>/);
  assert.match(list, /--oc-main: 2; --oc-status: 3; --oc-memo: 4; --oc-due: 5; --oc-assign: 6; --oc-design: 7;/);
  assert.match(list, /\.order-list:not\(\.inbox-list\) \.c-ship \{ display: none !important; \}/, '숨긴 칸');
  await press(admin, '/admin/columns/reset', {}, '/admin/columns');
  assert.match((await admin.request('/')).text, /<span class="">주문<\/span><span class="head-memo">메모<\/span><span class="">상태<\/span><span class="">배송 · 금액<\/span>/);
  // 직원은 못 바꾼다
  addUser(db, { email: 'staff2@broad.test' });
  const staff = await loginAs(baseUrl, 'staff2@broad.test');
  assert.strictEqual((await staff.request('/admin/columns')).status, 403);
});
