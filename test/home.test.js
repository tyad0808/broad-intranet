// 홈 (오늘 할 일): 로그인하면 홈부터, 숫자는 주문·문의 목록과 같은 조건, 관리자·부관리자만 매출·받기 상태
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs, browser } = require('./helpers');
const { kstDay } = require('../src/routes/orders');

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  const { db } = ctx;
  ctx.bossId = addUser(db, { email: 'boss@broad.test', name: '사장', role: 'admin' });
  ctx.subId = addUser(db, { email: 'sub@broad.test', name: '부장' });
  db.prepare('UPDATE users SET sub_admin = 1 WHERE id = ?').run(ctx.subId);
  ctx.kimId = addUser(db, { email: 'kim@broad.test', name: '김직원' });
  return ctx;
}

const addOrder = (db, fields) => {
  const row = {
    channel: 'smartstore', channel_order_id: 'O1', channel_item_id: 'O1-1', product_name: '현수막', channel_status: 'PAYED',
    channel_confirmed: 0, paid_at: new Date().toISOString(), stage_id: db.prepare("SELECT id FROM work_stages WHERE name = '발주'").get().id,
    ...fields,
  };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO orders (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => row[k]));
};

// 칸 하나: 이름 · 숫자 · 누르면 가는 주소
const tileOf = (html, label) => {
  const m = html.match(new RegExp(`<a class="hm-tile[^"]*" href="([^"]*)"><span class="hm-label">${label.replace(/[()]/g, '\\$&')}</span><span class="hm-count">(\\d+)<small>`));
  return m ? { href: m[1].replace(/&amp;/g, '&'), n: Number(m[2]) } : null;
};

test('로그인하면 홈부터 열리고, 그날은 / 가 주문 목록 그대로 (왼쪽 메뉴 맨 위에 홈)', async t => {
  const { baseUrl } = await setup(t);
  const b = browser(baseUrl);
  const res = await b.submit('/login', '/login', { email: 'kim@broad.test', password: 'password123' });
  assert.strictEqual(res.location, '/home');
  const home = await b.request('/home');
  assert.strictEqual(home.status, 200);
  assert.match(home.text, /안녕하세요, 김직원님/);
  assert.match(home.text, /<a href="\/home" class="on">/);
  assert.match(home.text, /<a class="brand" href="\/home">/);
  assert.strictEqual((await b.request('/')).status, 200, '오늘 홈을 봤으면 / 는 주문 목록');
  assert.strictEqual((await b.request('/login')).location, '/home');
  // 로그인 안 했으면 홈도 로그인 화면으로
  assert.strictEqual((await browser(baseUrl).request('/home')).location, '/login');
});

test('지금 처리할 주문·내 담당: 주문 목록의 칸과 같은 건수, 누르면 그 목록', async t => {
  const { db, baseUrl, kimId } = await setup(t);
  addOrder(db, { channel_order_id: 'N1', channel_item_id: 'N1-1' }); // 신규주문, 담당 없음
  addOrder(db, { channel_order_id: 'N2', channel_item_id: 'N2-1', delivery_type: 'TODAY', assignee_id: kimId }); // 신규 + 오늘출발, 내 담당
  addOrder(db, { channel_order_id: 'C1', channel_item_id: 'C1-1', channel_confirmed: 1, claim_type: 'CANCEL', claim_status: 'CANCEL_REQUEST', assignee_id: kimId });
  addOrder(db, { channel_order_id: 'D1', channel_item_id: 'D1-1', channel_status: 'DELIVERED', channel_confirmed: 1 }); // 끝난 주문: 담당 없음에 안 셈
  const mail = db.prepare("INSERT INTO inquiries (source, external_id, subject, body, received_at, assignee_id) VALUES (?, ?, '문의', '내용', '2026-11-08T00:00:00Z', ?)");
  mail.run('naver_mail', 'm1', kimId);
  mail.run('gmail', 'm2', null);
  mail.run('smartstore_qna', 'q1', null);

  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const html = (await kim.request('/home')).text;
  assert.deepStrictEqual(tileOf(html, '신규주문 (발주확인 전)'), { href: '/?st=new', n: 2 });
  assert.deepStrictEqual(tileOf(html, '오늘출발'), { href: '/?alert=today', n: 1 });
  assert.deepStrictEqual(tileOf(html, '취소·반품·교환 요청'), { href: '/?alert=claim', n: 1 });
  assert.deepStrictEqual(tileOf(html, '담당 없는 주문'), { href: '/?view=unassigned', n: 1 });
  assert.deepStrictEqual(tileOf(html, '내 주문 (진행 중)'), { href: '/?view=mine', n: 2 });
  assert.match(html, /발주 2/, '내 주문을 단계별로');
  assert.deepStrictEqual(tileOf(html, '내 메일 미답변'), { href: '/inbox?box=mail&who=mine', n: 1 });
  assert.match(html, /전체 미답변 2건/);
  // 내 담당 문의가 없으면 전체 미답변 목록으로
  assert.deepStrictEqual(tileOf(html, '내 문의 미답변'), { href: '/inbox', n: 0 });

  // 홈 숫자와 주문 목록 건수가 같다 (누른 목록의 주문 수)
  const cards = async url => ((await kim.request(url)).text.match(/class="oi-main"/g) || []).length;
  assert.strictEqual(await cards('/?st=new'), 2);
  assert.strictEqual(await cards('/?alert=claim'), 1);
  assert.strictEqual(await cards('/?view=unassigned'), 1);
  assert.strictEqual(await cards('/?view=mine'), 2);
});

test('오늘·내일 일정과 방금 들어온 주문, 비어 있으면 안내 문구', async t => {
  const { db, baseUrl, bossId } = await setup(t);
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  let html = (await kim.request('/home')).text;
  assert.match(html, /오늘·내일 일정이 없어요/);
  assert.match(html, /아직 들어온 주문이 없어요/);

  const ev = db.prepare('INSERT INTO events (title, start_date, end_date, time, created_by) VALUES (?, ?, ?, ?, ?)');
  ev.run('현수막 납품', kstDay(0), null, '10:00', bossId);
  ev.run('박직원 연차', kstDay(1), null, null, bossId);
  ev.run('다음 주 일정', kstDay(7), null, null, bossId);
  addOrder(db, { channel: 'coupang', channel_order_id: 'R1', channel_item_id: 'R1-1', product_name: '아크릴 간판', buyer_name: '이영희' });
  addOrder(db, { channel: 'coupang', channel_order_id: 'R1', channel_item_id: 'R1-2', product_name: '양면테이프', item_type: 'addon' });
  html = (await kim.request('/home')).text;
  assert.match(html, /<span class="hm-ev-day today">오늘<\/span>\s*<span class="hm-ev-time">10:00<\/span>/);
  assert.match(html, /박직원 연차/);
  assert.match(html, /<span class="hm-ev-time">종일<\/span>/);
  assert.doesNotMatch(html, /다음 주 일정/);
  assert.match(html, /아크릴 간판 외 1건/);
  assert.match(html, /이영희 · \d\d:\d\d/);
});

test('매출·받기 상태는 관리자·부관리자만, 받기 실패는 빨간 표시 (관리자는 고치는 화면으로)', async t => {
  const { db, baseUrl } = await setup(t);
  addOrder(db, { channel_order_id: 'S1', channel_item_id: 'S1-1', pay_amount: 25000 });
  const now = new Date().toISOString();
  const run = db.prepare('INSERT INTO collect_runs (channel, started_at, finished_at, ok, error) VALUES (?, ?, ?, ?, ?)');
  run.run('smartstore', now, now, 1, null);
  run.run('coupang', now, now, 0, '키가 틀렸어요');

  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const staffHtml = (await kim.request('/home')).text;
  assert.doesNotMatch(staffHtml, /관리자·부관리자만 보여요/);
  assert.doesNotMatch(staffHtml, /이번 달 매출/);

  const boss = await loginAs(baseUrl, 'boss@broad.test');
  const html = (await boss.request('/home')).text;
  assert.match(html, /이번 달 매출/);
  assert.match(html, /<span class="hm-big">3만원<\/span>/);
  assert.match(html, /스마트스토어<\/span>\s*<span class="hm-sub">\d\d:\d\d 받음/);
  assert.match(html, /href="\/admin\/channels" title="키가 틀렸어요">받기 실패/);

  const sub = await loginAs(baseUrl, 'sub@broad.test');
  const subHtml = (await sub.request('/home')).text;
  assert.match(subHtml, /이번 달 매출/);
  assert.match(subHtml, /받기 실패 · 관리자에게 알려 주세요/, '부관리자는 관리자 설정 화면으로 보내지 않는다');
  assert.doesNotMatch(subHtml, /href="\/admin\/channels"/);
});

test('다음 날 처음 / 로 들어오면 홈을 먼저, 홈을 본 뒤엔 / 가 주문 목록 (주소에 조건이 있으면 바로 목록)', async t => {
  const { baseUrl } = await setup(t);
  const b = browser(baseUrl);
  await b.submit('/login', '/login', { email: 'kim@broad.test', password: 'password123', remember: '1' });
  assert.strictEqual((await b.request('/')).status, 200);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 3600 * 1000 });
  assert.strictEqual((await b.request('/?view=mine')).status, 200, '조건이 있는 주소는 그대로 목록');
  assert.strictEqual((await b.request('/')).location, '/home');
  assert.strictEqual((await b.request('/home')).status, 200);
  assert.strictEqual((await b.request('/')).status, 200);
});
