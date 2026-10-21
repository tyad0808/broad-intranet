// 회사 일정 달력
const test = require('node:test');
const assert = require('node:assert');
const { buildMonth } = require('../src/routes/calendar');
const { startServer, addUser, loginAs } = require('./helpers');

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  ctx.kimId = addUser(ctx.db, { email: 'kim@broad.test', name: '김직원' });
  ctx.leeId = addUser(ctx.db, { email: 'lee@broad.test', name: '이직원' });
  addUser(ctx.db, { email: 'boss@broad.test', name: '사장', role: 'admin' });
  ctx.kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  ctx.events = () => ctx.db.prepare('SELECT * FROM events ORDER BY id').all().map(r => ({ ...r }));
  return ctx;
}

test('달력 칸: 일요일부터 시작하는 주 단위, 이달 일정과 여러 날 일정이 날마다 보인다', () => {
  const { openDb } = require('../src/db');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO events (title, start_date, end_date) VALUES ('워크숍', '2026-10-30', '2026-11-02')").run();
  db.prepare("INSERT INTO events (title, start_date, time) VALUES ('미팅', '2026-10-15', '14:00')").run();
  const cal = buildMonth(db, '2026-10', null);
  assert.strictEqual(cal.label, '2026년 10월');
  assert.strictEqual(cal.weeks[0][0].date, '2026-09-27', '10월 1일(목) 앞은 9월 27일(일)부터');
  assert.strictEqual(cal.weeks.length, 5);
  const day = d => cal.weeks.flat().find(x => x.date === d);
  assert.deepStrictEqual(day('2026-10-31').events.map(e => e.title), ['워크숍']);
  assert.deepStrictEqual(day('2026-10-15').events.map(e => e.title), ['미팅']);
  assert.strictEqual(cal.monthEvents.length, 2);
  assert.deepStrictEqual([cal.prev, cal.next], ['2026-09', '2026-11']);
  assert.strictEqual(buildMonth(db, 'nonsense', null).month.length, 7, '잘못된 달은 이번 달로');
});

test('일정 화면에 달력이 있고, 직원이 일정을 넣으면 그 달로 돌아와 보인다. 주문 목록 위에는 이번 주 출고', async t => {
  const ctx = await setup(t);
  assert.match((await ctx.kim.request('/schedule')).text, /id="calendar-panel"/);
  const list = (await ctx.kim.request('/')).text;
  assert.match(list, /class="week-strip"/);
  assert.match(list, /href="\/schedule"/);
  const res = await ctx.kim.submit('/schedule', '/calendar/events', {
    title: '거래처 미팅', start_date: '2026-12-03', time: '14:30', memo: '샘플 지참', color: 'green', back: '/schedule',
  });
  assert.strictEqual(res.location, '/schedule?cal=2026-12');
  const [ev] = ctx.events();
  assert.deepStrictEqual([ev.title, ev.start_date, ev.time, ev.memo, ev.color, ev.created_by], ['거래처 미팅', '2026-12-03', '14:30', '샘플 지참', 'green', ctx.kimId]);
  const panel = (await ctx.kim.request('/calendar?month=2026-12')).text;
  assert.match(panel, /2026년 12월/);
  assert.match(panel, /class="ev ev-green"[^>]*>거래처 미팅</);
  assert.match((await ctx.kim.request('/schedule?cal=2026-12')).text, /거래처 미팅/);
});

test('잘못된 일정은 넣지 않는다', async t => {
  const ctx = await setup(t);
  for (const bad of [
    { title: '', start_date: '2026-12-03' },
    { title: 'x', start_date: '' },
    { title: 'x', start_date: '2026-12-03', end_date: '2026-12-01' },
    { title: 'x', start_date: '2026-12-03', time: '25:00' },
    { title: 'x', start_date: '2026-01-01', end_date: '2026-06-01' },
  ]) await ctx.kim.submit('/', '/calendar/events', bad);
  assert.strictEqual(ctx.events().length, 0);
});

test('고치기·지우기는 넣은 사람과 관리자만 할 수 있다', async t => {
  const ctx = await setup(t);
  await ctx.kim.submit('/', '/calendar/events', { title: '휴무', start_date: '2026-12-24' });
  const id = ctx.events()[0].id;
  const lee = await loginAs(ctx.baseUrl, 'lee@broad.test');
  await lee.submit('/', `/calendar/events/${id}`, { title: '바꿈', start_date: '2026-12-24' });
  await lee.submit('/', `/calendar/events/${id}/delete`, {});
  assert.strictEqual(ctx.events()[0].title, '휴무');

  await ctx.kim.submit('/', `/calendar/events/${id}`, { title: '전 직원 휴무', start_date: '2026-12-24', end_date: '2026-12-26' });
  assert.deepStrictEqual([ctx.events()[0].title, ctx.events()[0].end_date], ['전 직원 휴무', '2026-12-26']);

  const boss = await loginAs(ctx.baseUrl, 'boss@broad.test');
  await boss.submit('/', `/calendar/events/${id}/delete`, {});
  assert.strictEqual(ctx.events().length, 0);
});

test('승인 대기 직원은 달력을 볼 수 없다', async t => {
  const ctx = await setup(t);
  addUser(ctx.db, { email: 'wait@broad.test', status: 'pending' });
  const b = await loginAs(ctx.baseUrl, 'wait@broad.test');
  assert.strictEqual((await b.request('/calendar')).location, '/pending');
});

test('이달의 일정 목록에는 고칠 수 있는 사람에게만 삭제(×) 버튼이 있다', async t => {
  const ctx = await setup(t);
  await ctx.kim.submit('/', '/calendar/events', { title: '휴무', start_date: '2026-12-24' });
  assert.match((await ctx.kim.request('/calendar?month=2026-12')).text, /data-ev-delete-id=/);
  const lee = await loginAs(ctx.baseUrl, 'lee@broad.test');
  assert.doesNotMatch((await lee.request('/calendar?month=2026-12')).text, /data-ev-delete-id=/);
});
