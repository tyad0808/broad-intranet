// 휴가(월차·연차): 1년 미만 매월 1개(최대 11), 1년 이상 입사일마다 14개, 반차 0.5 · 신청 → 관리자·부관리자 승인 → 달력
const test = require('node:test');
const assert = require('node:assert');
const { grantsOf, daysOf, readRequest, addMonths, serviceText } = require('../src/leave');
const { startServer, addUser, loginAs } = require('./helpers');

test('휴가 생기는 규칙: 1년 미만은 한 달마다 1일, 1년이 되면 14일, 그다음도 입사일마다 14일', () => {
  assert.strictEqual(addMonths('2026-01-31', 1), '2026-02-28', '그 달에 없는 날은 마지막 날');
  assert.deepStrictEqual(grantsOf('2026-03-15', '2026-03-20').grants, [], '한 달 안 됐으면 0');
  assert.deepStrictEqual(grantsOf('2026-03-15', '2026-03-20').next, { date: '2026-04-15', days: 1, label: '입사 1개월' });
  const six = grantsOf('2026-03-15', '2026-09-15');
  assert.strictEqual(six.grants.length, 6, '6개월 → 6일');
  assert.strictEqual(six.grants.reduce((s, g) => s + g.days, 0), 6);
  const year = grantsOf('2025-11-11', '2026-11-11');
  assert.strictEqual(year.grants.reduce((s, g) => s + g.days, 0), 11 + 14, '1년: 매월 11일 + 1년 14일');
  assert.deepStrictEqual(year.next, { date: '2027-11-11', days: 14, label: '입사 2년' });
  assert.strictEqual(grantsOf('2023-01-10', '2026-01-10').grants.reduce((s, g) => s + g.days, 0), 11 + 14 * 3);
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
  assert.match(subPage, /김디자 · 2026-11-20/);
  // 직원은 승인 못 함
  assert.strictEqual((await kim.submit('/leave', `/leave/${r.id}/approve`, {})).status, 403);
  await sub.submit('/leave', `/leave/${r.id}/approve`, {});
  const after = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
  assert.strictEqual(after.status, 'approved');
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(after.event_id);
  assert.deepStrictEqual([ev.title, ev.start_date, ev.end_date], ['김디자 오전 반차', '2026-11-20', null]);
  assert.match((await kim.request('/leave')).text, /<strong class="lv-num">7<small>일/, '7.5 - 0.5');
  // 관리자도 볼 수 있고, 승인을 취소하면 일정도 지운다
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  await boss.submit('/leave', `/leave/${r.id}/cancel`, {});
  assert.strictEqual(db.prepare('SELECT status FROM leave_requests WHERE id = ?').get(r.id).status, 'canceled');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('반려·본인 취소: 직원은 승인 대기 중인 것만 취소, 남의 신청은 못 건드린다', async t => {
  const { db, kim, sub, baseUrl } = await setup(t);
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
