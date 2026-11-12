// 휴가(월차·연차): 1년 미만 매월 1개(최대 11), 1년 이상 입사일마다 14개, 반차 0.5 · 신청 → 관리자·부관리자 승인 → 달력
const test = require('node:test');
const assert = require('node:assert');
const { grantsOf, daysOf, readRequest, addMonths, serviceText, legalDays } = require('../src/leave');
const { startServer, addUser, loginAs } = require('./helpers');

test('휴가 생기는 규칙: 1년 미만 한 달마다 1일(최대 11) · 1년 이상 근로기준법대로 입사일마다 15일, 만 3년부터 2년마다 +1, 최대 25 (또는 관리자가 직접)', () => {
  assert.strictEqual(addMonths('2026-01-31', 1), '2026-02-28', '그 달에 없는 날은 마지막 날');
  assert.deepStrictEqual(grantsOf('2026-03-15', '2026-03-20').grants, [], '한 달 안 됐으면 0');
  assert.deepStrictEqual(grantsOf('2026-03-15', '2026-03-20').next, { date: '2026-04-15', days: 1, label: '입사 1개월' });
  assert.strictEqual(grantsOf('2026-03-15', '2026-09-15').grants.length, 6, '6개월 → 6일');
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 21, 22].map(legalDays), [15, 15, 16, 16, 17, 17, 18, 18, 25, 25]);
  const y1 = grantsOf('2025-11-12', '2026-11-12');
  assert.strictEqual(y1.grants.reduce((s, g) => s + g.days, 0), 11 + 15, '만 1년: 매월 11일 + 15일');
  assert.deepStrictEqual(y1.next, { date: '2027-11-12', days: 15, label: '만 2년' });
  assert.deepStrictEqual(grantsOf('2023-11-12', '2026-11-12').next, { date: '2027-11-12', days: 16, label: '만 4년' }, '만 3년 16일 받은 뒤 다음은 만 4년 16일');
  assert.strictEqual(grantsOf('2025-11-12', '2030-01-01', 'manual').grants.reduce((s, g) => s + g.days, 0), 11, '직접 넣기면 1년 뒤 자동으로 안 더함');
  assert.strictEqual(serviceText('2025-08-11', '2026-11-11'), '1년 3개월');
  assert.deepStrictEqual(grantsOf(null, '2026-11-11'), { grants: [], next: null }, '입사일이 없으면 생기지 않음');
});

test('쓰는 일수: 반차 0.5, 종일은 주말 빼고 평일 수', () => {
  assert.strictEqual(daysOf('am', '2026-11-13', '2026-11-13'), 0.5);
  assert.strictEqual(daysOf('full', '2026-11-13', '2026-11-16'), 2, '금~월 = 금·월 2일');
  assert.match(readRequest({ kind: 'full', start_date: '2026-11-14', end_date: '2026-11-15' }).error, /주말/);
  assert.deepStrictEqual(readRequest({ kind: 'pm', start_date: '2026-11-13', end_date: '2026-11-20' }), { start: '2026-11-13', end: '2026-11-13', kind: 'pm', days: 0.5, reason: '' }, '반차는 하루만');
  assert.match(readRequest({ kind: 'full', start_date: '2026-11-20', end_date: '2026-11-13' }).error, /앞이에요/);
});

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  const { db } = ctx;
  ctx.bossId = addUser(db, { email: 'boss@broad.test', role: 'admin', name: '대표' });
  ctx.subId = addUser(db, { email: 'sub@broad.test', name: '실장' });
  db.prepare('UPDATE users SET sub_admin = 1 WHERE id = ?').run(ctx.subId);
  ctx.kimId = addUser(db, { email: 'kim@broad.test', name: '김디자' });
  ctx.leeId = addUser(db, { email: 'lee@broad.test', name: '이디자' });
  ctx.kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  ctx.sub = await loginAs(ctx.baseUrl, 'sub@broad.test');
  return ctx;
}

test('신청 → 부관리자도 승인 → 회사 일정에 저절로, 남은 휴가에서 빠진다', async t => {
  const { db, kim, sub, kimId, baseUrl } = await setup(t);
  // 부관리자가 입사일과 시작 일수를 넣는다
  await sub.submit('/leave', `/leave/hire/${kimId}`, { hire_date: '2026-05-11' });
  assert.strictEqual(db.prepare('SELECT hire_date FROM users WHERE id = ?').get(kimId).hire_date, '2026-05-11');
  await sub.submit('/leave', '/leave/adjust', { user_id: String(kimId), days: '1.5', note: '시작할 때 맞추기' });
  const before = (await kim.request('/leave')).text;
  assert.match(before, /내 남은 휴가<\/span>\s*<strong class="lv-num">7\.5<small>일/, '6개월(6일) + 조정 1.5일');
  assert.doesNotMatch(before, /승인 대기 <span/, '직원에게는 관리 칸이 없다');
  // 신청
  const res = await kim.submit('/leave', '/leave', { kind: 'am', start_date: '2026-11-20', reason: '병원' });
  assert.strictEqual(res.location, '/leave');
  const r = db.prepare('SELECT * FROM leave_requests').get();
  assert.deepStrictEqual([r.kind, r.days, r.status], ['am', 0.5, 'pending']);
  assert.match((await kim.submit('/leave', '/leave', { kind: 'full', start_date: '2026-11-20' })).location, /\/leave/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM leave_requests').get().n, 1, '같은 날 또 신청하면 막는다');
  // 왼쪽 메뉴 숫자 (관리자·부관리자)
  const subPage = (await sub.request('/leave')).text;
  assert.match(subPage, /<span>휴가 <span class="badge">1<\/span>/);
  assert.match(subPage, /href="\/admin\/leave"><span><strong>휴가 관리<\/strong>[\s\S]*?<span class="badge">1<\/span> 승인 대기/, '내 휴가 화면에는 휴가 관리로 가는 줄만');
  assert.doesNotMatch(subPage, /김디자 · 2026-11-20/, '승인은 휴가 관리 화면에서');
  const manage = await sub.request('/admin/leave');
  assert.strictEqual(manage.status, 200, '부관리자도 휴가 관리 화면에 들어간다');
  assert.match(manage.text, /김디자 · 2026-11-20/);
  assert.doesNotMatch(manage.text, /class="admin-groups"/, '부관리자에게는 다른 관리자 메뉴 묶음이 안 보인다');
  assert.strictEqual((await sub.request('/admin/users')).status, 403, '다른 관리자 화면은 그대로 관리자만');
  assert.strictEqual((await kim.request('/admin/leave')).status, 403, '직원은 못 들어간다');
  assert.doesNotMatch((await kim.request('/leave')).text, /휴가 관리<\/strong>/);
  // 직원은 승인 못 함
  assert.strictEqual((await kim.submit('/leave', `/leave/${r.id}/approve`, {})).status, 403);
  assert.strictEqual((await sub.submit('/admin/leave', `/leave/${r.id}/approve`, {})).location, '/admin/leave');
  const after = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
  assert.strictEqual(after.status, 'approved');
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(after.event_id);
  assert.deepStrictEqual([ev.title, ev.start_date, ev.end_date], ['김디자 오전 반차', '2026-11-20', null]);
  assert.match((await kim.request('/leave')).text, /<strong class="lv-num">7<small>일/, '7.5 - 0.5');
  // 관리자도 볼 수 있고, 승인을 취소하면 일정도 지운다
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  assert.match((await boss.request('/admin/leave')).text, /class="admin-groups"[\s\S]*href="\/admin\/leave" class="chip on">휴가 관리/, '관리자에게는 관리자 › 직원·회사 › 휴가 관리');
  await boss.submit('/admin/leave', `/leave/${r.id}/cancel`, {});
  assert.strictEqual(db.prepare('SELECT status FROM leave_requests WHERE id = ?').get(r.id).status, 'canceled');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('반려·본인 취소: 직원은 승인 대기 중인 것만 취소, 남의 신청은 못 건드린다', async t => {
  const { db, kim, sub, baseUrl, kimId } = await setup(t);
  await sub.submit('/admin/leave', `/leave/left/${kimId}`, { left: '5' });
  await kim.submit('/leave', '/leave', { kind: 'full', start_date: '2026-12-01', end_date: '2026-12-02' });
  await kim.submit('/leave', '/leave', { kind: 'full', start_date: '2026-12-10' });
  const [a, b] = db.prepare('SELECT id FROM leave_requests ORDER BY id').all().map(r => r.id);
  assert.strictEqual(db.prepare('SELECT days FROM leave_requests WHERE id = ?').get(a).days, 2);
  await sub.submit('/leave', `/leave/${a}/reject`, { note: '마감 주간이라 어려워요' });
  assert.deepStrictEqual({ ...db.prepare('SELECT status, decide_note FROM leave_requests WHERE id = ?').get(a) }, { status: 'rejected', decide_note: '마감 주간이라 어려워요' });
  assert.match((await kim.request('/leave')).text, /실장: 마감 주간이라 어려워요/);
  const lee = await loginAs(baseUrl, 'lee@broad.test');
  await lee.submit('/leave', `/leave/${b}/cancel`, {});
  assert.strictEqual(db.prepare('SELECT status FROM leave_requests WHERE id = ?').get(b).status, 'pending', '남의 신청은 취소 안 됨');
  await kim.submit('/leave', `/leave/${b}/cancel`, {});
  assert.strictEqual(db.prepare('SELECT status FROM leave_requests WHERE id = ?').get(b).status, 'canceled');
  // 직원은 입사일·조정 못 함
  assert.strictEqual((await kim.submit('/leave', '/leave/adjust', { user_id: '1', days: '5', note: 'x' })).status, 403);
});

test('관리자가 지금 남은 일수를 직접 맞추고(그 뒤로 다시 셈), 직원은 남은 일수 안에서만 신청한다', async t => {
  const { db, kim, sub, kimId } = await setup(t);
  db.prepare("UPDATE users SET hire_date = '2020-08-10' WHERE id = ?").run(kimId);
  assert.match((await sub.request('/admin/leave')).text, /name="left" value="107"/, '11 + 만1·2년 15×2 + 만3·4년 16×2 + 만5·6년 17×2 (2020-08-10 입사, 만 6년)');
  const res = await sub.submit('/admin/leave', `/leave/left/${kimId}`, { left: '2' });
  assert.strictEqual(res.location, '/admin/leave#staff');
  const page = (await sub.request('/admin/leave')).text;
  assert.match(page, /name="left" value="2"/);
  assert.match(page, /\(2일\)/, '맞춘 날과 일수');
  assert.match((await kim.request('/leave')).text, /<strong class="lv-num">2<small>일/);
  // 남은 2일: 1 + 0.5 + 0.5 까지 되고, 넘으면 막는다 (승인 대기도 센다)
  for (const [kind, day] of [['full', '2026-12-01'], ['am', '2026-12-02'], ['pm', '2026-12-03'], ['pm', '2026-12-04']]) {
    await kim.submit('/leave', '/leave', { kind, start_date: day });
  }
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM leave_requests').get().n, 3, '네 번째(2.5일째)는 막힘');
  // 1년 이상 방식 바꾸기 (부관리자도)
  assert.match((await kim.request('/leave')).text, /입사일마다 15일부터/);
  await sub.submit('/admin/leave', '/leave/yearly', { mode: 'manual' });
  assert.match((await kim.request('/leave')).text, /1년 이상은 관리자가 매년 넣어요/);
  assert.strictEqual((await kim.submit('/leave', `/leave/left/${kimId}`, { left: '30' })).status, 403, '직원은 못 고친다');
});
