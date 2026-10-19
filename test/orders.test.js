// 주문 현황판: 직접 등록, 단계 이동, 담당자·납기, 완료, 검색, 내 작업
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, addUser, loginAs, browser } = require('./helpers');
const { openDb } = require('../src/db');
const { applyOrders } = require('../src/collector');
const { kstDate } = require('../src/orders');

const today = () => kstDate(new Date());
const dayAfter = n => kstDate(new Date(), n);
const stageId = (db, name) => db.prepare('SELECT id FROM work_stages WHERE name = ?').get(name).id;
const order = (db, id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const events = (db, id) => db.prepare('SELECT message FROM order_events WHERE order_id = ? ORDER BY id').all(id).map(e => e.message);

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  ctx.kimId = addUser(ctx.db, { email: 'kim@broad.test', name: '김디자' });
  ctx.parkId = addUser(ctx.db, { email: 'park@broad.test', name: '박출력' });
  ctx.kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  ctx.park = await loginAs(ctx.baseUrl, 'park@broad.test');
  // 주문 등록 → 새 주문 번호
  ctx.create = async (fields, b = ctx.kim) => {
    const res = await b.submit('/orders/new', '/orders', { channel: 'phone', quantity: '1', ...fields });
    const m = /^\/orders\/(\d+)$/.exec(res.location || '');
    return m ? Number(m[1]) : res;
  };
  ctx.press = (b, id, action, fields = {}) => b.submit(`/orders/${id}`, `/orders/${id}${action}`, fields);
  return ctx;
}

test('로그인하지 않으면 현황판·주문을 볼 수 없다', async t => {
  const { db, baseUrl } = await setup(t);
  const anon = browser(baseUrl);
  assert.strictEqual((await anon.request('/')).location, '/login');
  assert.strictEqual((await anon.request('/orders/new')).location, '/login');
  assert.strictEqual((await anon.request('/orders/1')).location, '/login');
  addUser(db, { email: 'new@broad.test', status: 'pending' });
  const waiting = await loginAs(baseUrl, 'new@broad.test');
  assert.strictEqual((await waiting.request('/orders/new')).location, '/pending');
});

test('전화 주문을 등록하면 첫 단계 칸에 카드가 생기고 기록이 남는다', async t => {
  const { db, kim, kimId, create } = await setup(t);
  const id = await create({
    product_name: '현수막', option_text: '5000×900', quantity: '2', buyer_name: '한빛건설',
    receiver_phone: '010-1234-5678', due_date: dayAfter(1), assignee_id: String(kimId), urgent: '1',
  });
  const o = order(db, id);
  assert.strictEqual(o.channel, 'phone');
  assert.strictEqual(o.stage_id, stageId(db, '발주'));
  assert.strictEqual(o.urgent, 1);
  assert.strictEqual(o.created_by, kimId);
  assert.deepStrictEqual(events(db, id), ['주문 등록 (전화)', '담당자: 김디자']);

  const board = await kim.request('/');
  assert.match(board.text, /<h2>발주 <span>1<\/span>/);
  assert.match(board.text, /class="ob-card soon"/);
  assert.match(board.text, /class="ob-urgent">급<\/span>현수막/);
  assert.match(board.text, /한빛건설 · 2개/);
  assert.match(board.text, /납기 내일/);
});

test('필수 칸이 비었거나 날짜가 틀리면 등록하지 않고 안내한다', async t => {
  const { db, kim, create } = await setup(t);
  let res = await create({ product_name: '', buyer_name: '홍길동' });
  assert.strictEqual(res.status, 302);
  assert.match((await kim.request('/orders/new')).text, /상품을\(를\) 입력하세요/);
  res = await create({ product_name: '현수막', buyer_name: '홍길동', due_date: '2026-13-40' });
  assert.match((await kim.request('/orders/new')).text, /납기 날짜가 올바르지 않습니다/);
  res = await create({ product_name: '현수막', buyer_name: '홍길동', channel: 'smartstore' });
  assert.match((await kim.request('/orders/new')).text, /접수 경로를 고르세요/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
});

test('단계를 넘기고 마지막 단계에서 완료하면 현황판에서 빠지고, 다시 열 수 있다', async t => {
  const { db, kim, create, press } = await setup(t);
  const id = await create({ product_name: '배너', buyer_name: '카페' });
  const page = await kim.request(`/orders/${id}`);
  assert.match(page.text, /다음 단계: 발주확인 →/);

  await press(kim, id, '/stage', { stage_id: String(stageId(db, '발송')) });
  assert.strictEqual(order(db, id).stage_id, stageId(db, '발송'));
  // 같은 단계를 두 번 눌러도 기록은 한 번
  await press(kim, id, '/stage', { stage_id: String(stageId(db, '발송')) });
  assert.deepStrictEqual(events(db, id).slice(1), ['단계: 발주 → 발송']);
  assert.match((await kim.request(`/orders/${id}`)).text, /완료 처리/);

  await press(kim, id, '/done');
  assert.ok(order(db, id).done_at);
  assert.doesNotMatch((await kim.request('/')).text, /배너/);
  assert.match((await kim.request('/?view=done')).text, /배너/);
  // 완료한 주문은 단계를 옮길 수 없다
  await press(kim, id, '/stage', { stage_id: String(stageId(db, '제작')) });
  assert.strictEqual(order(db, id).stage_id, stageId(db, '발송'));

  await press(kim, id, '/reopen');
  assert.strictEqual(order(db, id).done_at, null);
  assert.match((await kim.request('/')).text, /배너/);
  assert.deepStrictEqual(events(db, id).slice(-2), ['완료 처리', '다시 열기']);
});

test('담당자·납기·메모를 바꾸면 바뀐 것만 기록되고, 내 작업에는 내 담당만 보인다', async t => {
  const { db, kim, park, kimId, parkId, create, press } = await setup(t);
  const a = await create({ product_name: '메뉴판', buyer_name: '라멘집', assignee_id: String(kimId) });
  const b = await create({ product_name: '스티커', buyer_name: '베이커리' });

  await press(park, b, '', {
    product_name: '스티커', buyer_name: '베이커리', quantity: '500',
    assignee_id: String(parkId), due_date: today(), memo: '원형 50mm',
  });
  const o = order(db, b);
  assert.strictEqual(o.assignee_id, parkId);
  assert.strictEqual(o.quantity, 500);
  assert.strictEqual(o.memo, '원형 50mm');
  assert.deepStrictEqual(events(db, b).slice(1), [
    `담당자: 없음 → 박출력`, `납기: 없음 → ${today()}`, '작업 메모 수정', '주문 내용 수정',
  ]);
  // 그대로 저장하면 기록이 늘지 않는다
  const before = events(db, b).length;
  await press(park, b, '', {
    product_name: '스티커', buyer_name: '베이커리', quantity: '500',
    assignee_id: String(parkId), due_date: today(), memo: '원형 50mm',
  });
  assert.strictEqual(events(db, b).length, before);

  const mine = await park.request('/?view=mine');
  assert.match(mine.text, /스티커/);
  assert.doesNotMatch(mine.text, /메뉴판/);
  assert.match(mine.text, /내 작업 \(1\)/);
  assert.match((await kim.request('/?view=mine')).text, /메뉴판/);
  assert.ok(a);
});

test('요약 칸: 오늘·내일·납기 지남·미배정 건수와 필터', async t => {
  const { db, kim, kimId, create } = await setup(t);
  await create({ product_name: '오늘건', buyer_name: 'A', due_date: today(), assignee_id: String(kimId) });
  await create({ product_name: '내일건', buyer_name: 'B', due_date: dayAfter(1), assignee_id: String(kimId) });
  await create({ product_name: '지난건', buyer_name: 'C', due_date: dayAfter(-2) });
  await create({ product_name: '여유건', buyer_name: 'D', due_date: dayAfter(10) });

  const board = await kim.request('/');
  assert.match(board.text, /오늘 발송 <b>1<\/b>/);
  assert.match(board.text, /내일 발송 <b>1<\/b>/);
  assert.match(board.text, /class="warn" href="\/\?f=late">납기 지남 <b>1<\/b>/);
  assert.match(board.text, /미배정 <b>2<\/b>/);
  assert.match(board.text, /class="ob-card late"/);

  const late = await kim.request('/?f=late');
  assert.match(late.text, /지난건/);
  assert.doesNotMatch(late.text, /오늘건|여유건/);
  const unassigned = await kim.request('/?f=unassigned');
  assert.match(unassigned.text, /지난건/);
  assert.match(unassigned.text, /여유건/);
  assert.doesNotMatch(unassigned.text, /오늘건/);
  assert.ok(db);
});

test('검색은 하이픈 없는 전화번호와 완료한 주문까지 찾는다', async t => {
  const { kim, create, press } = await setup(t);
  const id = await create({ product_name: '족자 배너', buyer_name: '수학학원', receiver_phone: '010-5555-7777' });
  await create({ product_name: '100%_할인 현수막', buyer_name: '마트' });
  await press(kim, id, '/stage', { stage_id: '6' });
  await press(kim, id, '/done');

  let res = await kim.request('/?q=' + encodeURIComponent('55557777'));
  assert.match(res.text, /족자 배너/);
  assert.match(res.text, /검색 결과 1건/);
  res = await kim.request('/?q=' + encodeURIComponent('학원 배너'));
  assert.match(res.text, /족자 배너/);
  // % 와 _ 는 글자 그대로 찾는다
  res = await kim.request('/?q=' + encodeURIComponent('%_'));
  assert.match(res.text, /검색 결과 1건/);
  assert.match(res.text, /100%_할인/);
  res = await kim.request('/?q=' + encodeURIComponent('없는주문'));
  assert.match(res.text, /찾는 주문이 없습니다/);
});

test('스마트스토어 주문은 사내 칸만 고치고, 수집해도 사내 칸은 그대로다', async t => {
  const { db, kim, kimId, press } = await setup(t);
  const sample = {
    channel: 'smartstore', channel_order_id: '2026101900001', channel_item_id: '9001', product_name: '현수막 주문제작',
    option_text: '5000x900', quantity: 1, buyer_name: '이고객', receiver_name: '이고객', receiver_phone: '010-1111-2222',
    receiver_address: '서울', paid_at: '2026-10-19T01:00:00Z', channel_status: 'PAYED', channel_confirmed: 0,
  };
  applyOrders(db, [sample]);
  const id = db.prepare("SELECT id FROM orders WHERE channel_item_id = '9001'").get().id;

  const page = await kim.request(`/orders/${id}`);
  assert.match(page.text, /주문번호 2026101900001/);
  assert.doesNotMatch(page.text, /name="product_name"/);

  await press(kim, id, '', { product_name: '바꿔치기', assignee_id: String(kimId), urgent: '1', memo: '고리 추가' });
  let o = order(db, id);
  assert.strictEqual(o.product_name, '현수막 주문제작');
  assert.strictEqual(o.assignee_id, kimId);

  applyOrders(db, [{ ...sample, channel_status: 'CANCELED' }]);
  o = order(db, id);
  assert.strictEqual(o.urgent, 1);
  assert.strictEqual(o.memo, '고리 추가');
  assert.match((await kim.request(`/orders/${id}`)).text, /<strong>취소<\/strong>된 주문입니다/);
  assert.match((await kim.request('/')).text, /status-suspended">취소</);
});

test('숨긴 단계에 있는 카드는 단계 없음 칸에 보인다', async t => {
  const { db, kim, create } = await setup(t);
  const id = await create({ product_name: '폼보드', buyer_name: '갤러리' });
  db.prepare('UPDATE work_stages SET active = 0 WHERE id = ?').run(order(db, id).stage_id);
  const board = await kim.request('/');
  assert.match(board.text, /<h2>단계 없음 <span>1<\/span>/);
  assert.match((await kim.request(`/orders/${id}`)).text, /다음 단계: 발주확인 →/);
});

test('주문 내용의 HTML 은 실행되지 않고 글자로 보인다', async t => {
  const { kim, create } = await setup(t);
  const id = await create({ product_name: '<script>alert(1)</script>', buyer_name: '<b>x</b>', memo: '<img src=x onerror=1>' });
  for (const page of [await kim.request('/'), await kim.request(`/orders/${id}`)]) {
    assert.doesNotMatch(page.text, /<script>alert|<b>x<\/b>|<img src=x/);
    assert.match(page.text, /&lt;script&gt;/);
  }
});

test('예전 DB 에 현황판 칸이 없으면 추가된다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broad-old-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, channel_order_id TEXT NOT NULL,
    channel_item_id TEXT NOT NULL, product_name TEXT NOT NULL, option_text TEXT, quantity INTEGER NOT NULL DEFAULT 1,
    buyer_name TEXT, receiver_name TEXT, receiver_phone TEXT, receiver_address TEXT, paid_at TEXT, channel_status TEXT,
    channel_confirmed INTEGER NOT NULL DEFAULT 0, stage_id INTEGER, assignee_id INTEGER, due_date TEXT, memo TEXT,
    nas_path TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (channel, channel_item_id));
    INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name) VALUES ('smartstore', '1', '1', '기존 주문');`);
  old.close();
  const db = openDb(file);
  const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  assert.ok(['urgent', 'done_at', 'created_by'].every(c => cols.includes(c)));
  assert.strictEqual(db.prepare('SELECT urgent FROM orders').get().urgent, 0);
  db.close();
});
