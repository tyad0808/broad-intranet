// 5단계: 주문 목록과 주문 카드
const test = require('node:test');
const assert = require('node:assert');
const { applyOrders } = require('../src/collector');
const { safeBack } = require('../src/routes/orders');
const { startServer, addUser, loginAs } = require('./helpers');

function order(id, extra = {}) {
  return {
    channel: 'smartstore', channel_order_id: `O${id}`, channel_item_id: `P${id}`, product_name: `상품${id}`,
    option_text: null, quantity: 1, buyer_name: '구매자', receiver_name: `수령${id}`, receiver_phone: '010-0000-0000',
    receiver_address: '서울', paid_at: `2026-10-1${id}T01:00:00.000Z`, channel_status: 'PAYED', channel_confirmed: 0, ...extra,
  };
}

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  const { db } = ctx;
  const designerJob = db.prepare("SELECT id FROM jobs WHERE name = '디자이너'").get().id;
  const csJob = db.prepare("SELECT id FROM jobs WHERE name = 'CS'").get().id;
  ctx.kimId = addUser(db, { email: 'kim@broad.test', name: '김디자' });
  ctx.leeId = addUser(db, { email: 'lee@broad.test', name: '이디자' });
  ctx.csId = addUser(db, { email: 'cs@broad.test', name: '최상담' });
  db.prepare('UPDATE users SET job_id = ? WHERE id IN (?, ?)').run(designerJob, ctx.kimId, ctx.leeId);
  db.prepare('UPDATE users SET job_id = ? WHERE id = ?').run(csJob, ctx.csId);
  applyOrders(db, [order(1), order(2), order(3)]);
  ctx.idOf = item => db.prepare('SELECT id FROM orders WHERE channel_item_id = ?').get(item).id;
  ctx.row = item => ({ ...db.prepare('SELECT * FROM orders WHERE channel_item_id = ?').get(item) });
  ctx.stageId = name => db.prepare('SELECT id FROM work_stages WHERE name = ?').get(name).id;
  ctx.kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  return ctx;
}

// 주문 카드 화면을 열어 현재 version 과 CSRF 토큰을 넣어 저장한다
async function save(b, id, fields) {
  const page = await b.request(`/orders/${id}`);
  const version = /name="version" value="(\d+)"/.exec(page.text)[1];
  return b.submit(`/orders/${id}`, `/orders/${id}`, { version, ...fields });
}

test('로그인한 직원은 홈에서 주문 목록을 본다', async t => {
  const { kim } = await setup(t);
  const res = await kim.request('/');
  assert.strictEqual(res.status, 200);
  for (const name of ['상품1', '상품2', '상품3']) assert.match(res.text, new RegExp(name));
});

test('승인 대기 직원은 주문 카드에 들어갈 수 없다', async t => {
  const { db, baseUrl, idOf } = await setup(t);
  addUser(db, { email: 'wait@broad.test', status: 'pending' });
  const b = await loginAs(baseUrl, 'wait@broad.test');
  assert.strictEqual((await b.request(`/orders/${idOf('P1')}`)).location, '/pending');
});

test('담당 디자이너, 작업 단계, 납기, 메모, NAS 경로를 저장한다', async t => {
  const { kim, idOf, row, leeId, stageId } = await setup(t);
  const res = await save(kim, idOf('P1'), {
    assignee_id: String(leeId), stage_id: String(stageId('디자인작업')), due_date: '2026-10-20',
    memo: '금박 추가 요청', nas_path: '\\\\NAS\\작업\\P1',
  });
  assert.strictEqual(res.status, 302);
  const r = row('P1');
  assert.deepStrictEqual(
    [r.assignee_id, r.stage_id, r.due_date, r.memo, r.nas_path, r.version],
    [leeId, stageId('디자인작업'), '2026-10-20', '금박 추가 요청', '\\\\NAS\\작업\\P1', 1]
  );
});

test("'내가 맡기' 버튼은 나를 담당자로 지정한다", async t => {
  const { kim, kimId, idOf, row } = await setup(t);
  const page = await kim.request(`/orders/${idOf('P1')}`);
  assert.match(page.text, /내가 맡기/);
  // 선택 상자(빈 값)와 버튼(me) 값이 함께 전송되는 상황을 그대로 재현
  const version = /name="version" value="(\d+)"/.exec(page.text)[1];
  const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  const body = new URLSearchParams([['_csrf', token], ['version', version], ['assignee_id', ''], ['assignee_id', 'me']]);
  await kim.request(`/orders/${idOf('P1')}`, { method: 'POST', form: body });
  assert.strictEqual(row('P1').assignee_id, kimId);
});

test('디자이너가 아닌 직원은 담당 디자이너로 지정할 수 없다', async t => {
  const { kim, csId, idOf, row } = await setup(t);
  await save(kim, idOf('P1'), { assignee_id: String(csId) });
  assert.strictEqual(row('P1').assignee_id, null);
  const page = await kim.request(`/orders/${idOf('P1')}`);
  assert.match(page.text, /지정할 수 없는 직원/);
});

test('다른 직원이 먼저 저장했으면 덮어쓰지 않는다', async t => {
  const { baseUrl, kim, idOf, row } = await setup(t);
  const lee = await loginAs(baseUrl, 'lee@broad.test');
  const id = idOf('P1');

  const kimPage = await kim.request(`/orders/${id}`);
  const oldVersion = /name="version" value="(\d+)"/.exec(kimPage.text)[1];

  await save(lee, id, { memo: '이디자가 먼저 씀' });
  const res = await kim.submit(`/orders/${id}`, `/orders/${id}`, { version: oldVersion, memo: '김디자가 나중에 씀' });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(row('P1').memo, '이디자가 먼저 씀');
  assert.match((await kim.request(`/orders/${id}`)).text, /먼저 수정했습니다/);
});

test('수집기가 채널 정보를 갱신해도 직원 저장은 막히지 않는다', async t => {
  const { db, kim, idOf, row } = await setup(t);
  const id = idOf('P1');
  const page = await kim.request(`/orders/${id}`);
  const version = /name="version" value="(\d+)"/.exec(page.text)[1];
  applyOrders(db, [order(1, { channel_confirmed: 1 })]);
  await kim.submit(`/orders/${id}`, `/orders/${id}`, { version, memo: '저장됨' });
  assert.strictEqual(row('P1').memo, '저장됨');
});

test('필터: 내 담당, 미지정, 진행 중(마지막 단계 제외), 단계별, 검색', async t => {
  const { db, kim, kimId, idOf, stageId } = await setup(t);
  db.prepare('UPDATE orders SET assignee_id = ? WHERE id = ?').run(kimId, idOf('P1'));
  db.prepare('UPDATE orders SET stage_id = ? WHERE id = ?').run(stageId('발송'), idOf('P3'));
  db.prepare("UPDATE orders SET memo = '급한 건' WHERE id = ?").run(idOf('P2'));

  const shows = async (url, expected) => {
    const text = (await kim.request(url)).text;
    const seen = ['상품1', '상품2', '상품3'].filter(n => text.includes(`>${n}<`));
    assert.deepStrictEqual(seen, expected, url);
  };
  await shows('/', ['상품1', '상품2']);
  await shows('/?view=mine', ['상품1']);
  await shows('/?view=unassigned', ['상품2']);
  await shows('/?view=all', ['상품1', '상품2', '상품3']);
  await shows(`/?view=all&stage=${stageId('발송')}`, ['상품3']);
  await shows('/?q=' + encodeURIComponent('급한'), ['상품2']);
});

test('납기 임박순 정렬: 납기 없는 주문은 맨 뒤', async t => {
  const { db, kim, idOf } = await setup(t);
  db.prepare("UPDATE orders SET due_date = '2026-10-30' WHERE id = ?").run(idOf('P1'));
  db.prepare("UPDATE orders SET due_date = '2026-10-15' WHERE id = ?").run(idOf('P3'));
  const text = (await kim.request('/?sort=due')).text;
  const pos = n => text.indexOf(`>${n}<`);
  assert.ok(pos('상품3') < pos('상품1') && pos('상품1') < pos('상품2'));
});

test('목록으로 돌아가는 주소는 우리 사이트 목록만 허용한다', () => {
  assert.strictEqual(safeBack('/?view=mine&sort=due'), '/?view=mine&sort=due');
  assert.strictEqual(safeBack('https://evil.example'), '/');
  assert.strictEqual(safeBack('//evil.example'), '/');
  assert.strictEqual(safeBack('/admin/users'), '/');
});

test('잘못된 납기 형식은 거부한다', async t => {
  const { kim, idOf, row } = await setup(t);
  await save(kim, idOf('P1'), { due_date: '10월 20일' });
  assert.strictEqual(row('P1').due_date, null);
});

test('목록에서 바로 담당 디자이너를 지정하고, 같은 목록 위치로 돌아온다', async t => {
  const { kim, leeId, idOf, row } = await setup(t);
  const id = idOf('P2');
  const res = await kim.submit('/?view=unassigned', `/orders/${id}/assign`, { assignee_id: String(leeId), back: '/?view=unassigned' });
  assert.strictEqual(res.location, `/?view=unassigned#o${id}`);
  assert.strictEqual(row('P2').assignee_id, leeId);
  assert.strictEqual(row('P2').version, 1, '주문 카드를 열어 둔 사람이 덮어쓰지 못하게 version 이 오른다');
  assert.match((await kim.request('/?view=all')).text, /이디자 님으로 지정했습니다/);
});

test('목록에서 담당자를 미지정으로 되돌릴 수 있다', async t => {
  const { db, kim, kimId, idOf, row } = await setup(t);
  db.prepare('UPDATE orders SET assignee_id = ? WHERE id = ?').run(kimId, idOf('P1'));
  await kim.submit('/', `/orders/${idOf('P1')}/assign`, { assignee_id: '', back: '/' });
  assert.strictEqual(row('P1').assignee_id, null);
});

test('목록에서도 디자이너가 아닌 직원은 지정할 수 없다', async t => {
  const { kim, csId, idOf, row } = await setup(t);
  await kim.submit('/', `/orders/${idOf('P1')}/assign`, { assignee_id: String(csId), back: '/' });
  assert.strictEqual(row('P1').assignee_id, null);
});

test('목록의 담당자 선택 상자에는 디자이너만 나온다', async t => {
  const { kim } = await setup(t);
  const text = (await kim.request('/')).text;
  assert.match(text, />이디자</);
  assert.match(text, />김디자 \(나\)</);
  assert.ok(!text.includes('>최상담<'));
});

// ───────── 같은 주문번호 묶기, 채널 ─────────

async function groupSetup(t) {
  const ctx = await setup(t);
  // O1 주문에 추가상품이 붙어 있는 상황 (P1 본상품 + P9 추가상품)
  applyOrders(ctx.db, [order(9, { channel_order_id: 'O1', item_type: 'addon', product_name: '무료 양면테이프' })]);
  return ctx;
}

test('같은 주문번호의 본상품과 추가상품은 카드 하나로 묶여 보인다', async t => {
  const { kim } = await groupSetup(t);
  const text = (await kim.request('/')).text;
  const cards = text.split('class="order-item"').length - 1;
  assert.strictEqual(cards, 3, '상품은 4개지만 주문은 3건');
  assert.match(text, /진행 중 <span class="count">3</);
  const card = text.slice(text.indexOf('>상품1<') - 600, text.indexOf('>상품1<') + 900);
  assert.match(card, /상품 2개/);
  assert.match(card, /<span class="tag">추가<\/span>\s*<span class="oi-name">무료 양면테이프</);
});

test('목록에서 담당자를 지정하면 추가상품까지 같이 지정된다', async t => {
  const { kim, leeId, idOf, row } = await groupSetup(t);
  await kim.submit('/', `/orders/${idOf('P9')}/assign`, { assignee_id: String(leeId), back: '/' });
  assert.deepStrictEqual([row('P1').assignee_id, row('P9').assignee_id], [leeId, leeId]);
});

test('주문 카드에서 저장하면 같은 주문의 상품 모두에 적용되고, 카드에 상품이 모두 보인다', async t => {
  const { kim, idOf, row, stageId } = await groupSetup(t);
  const page = await kim.request(`/orders/${idOf('P1')}`);
  assert.match(page.text, /무료 양면테이프/);
  assert.match(page.text, /상품 2개에 함께 저장됩니다/);
  await save(kim, idOf('P1'), { stage_id: String(stageId('디자인작업')), due_date: '2026-10-22', memo: '같이 작업' });
  for (const p of ['P1', 'P9']) {
    const r = row(p);
    assert.deepStrictEqual([r.stage_id, r.due_date, r.memo], [stageId('디자인작업'), '2026-10-22', '같이 작업']);
  }
});

test('주문 앞에 채널 표시가 붙고, 채널별로 골라 볼 수 있다', async t => {
  const { db, kim } = await groupSetup(t);
  db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, stage_id) VALUES ('coupang', 'C1', 'CP1', '쿠팡상품', (SELECT id FROM work_stages WHERE name = '발주'))").run();
  const all = (await kim.request('/')).text;
  assert.match(all, /class="ch ch-naver"[^>]*>N</);
  assert.match(all, /class="ch ch-coupang"[^>]*>C</);
  assert.match(all, />쿠팡상품</);

  const naverOnly = (await kim.request('/?ch=smartstore')).text;
  assert.ok(!naverOnly.includes('>쿠팡상품<'));
  assert.match(naverOnly, /진행 중 <span class="count">3</);
  const coupangOnly = (await kim.request('/?ch=coupang')).text;
  assert.ok(coupangOnly.includes('>쿠팡상품<'));
  assert.ok(!coupangOnly.includes('>상품1<'));
});

test('채널에서 취소되거나 배송이 시작된 주문은 진행 중·미지정에서 빠지고 전체에만 보인다', async t => {
  const { db, kim } = await setup(t);
  applyOrders(db, [order(1, { channel_status: 'CANCELED' }), order(2, { channel_status: 'DELIVERING' })]);
  const active = (await kim.request('/')).text;
  assert.doesNotMatch(active, />상품1</);
  assert.doesNotMatch(active, />상품2</);
  assert.match(active, />상품3</);
  assert.match(active, /진행 중 <span class="count">1</);
  assert.match(active, /미지정 <span class="count">1</);
  assert.match(active, /전체 <span class="count">3</);
  const all = (await kim.request('/?view=all')).text;
  assert.match(all, />상품1</);
  assert.match(all, />상품2</);
  const { createNotifier } = require('../src/notifier');
  assert.strictEqual(createNotifier({ db }).unassignedCount(), 1, '미지정 알림도 끝난 주문은 세지 않는다');
});

test('추가상품만 남아 있고 본상품이 배송 중이어도, 하나라도 안 끝났으면 진행 중에 남는다', async t => {
  const { db, kim } = await setup(t);
  applyOrders(db, [
    order(1, { channel_status: 'DELIVERING' }),
    order(9, { channel_order_id: 'O1', item_type: 'addon', product_name: '추가품' }),
  ]);
  assert.match((await kim.request('/')).text, />상품1</);
});

test('판매자센터처럼 신규주문·배송준비·배송중·배송완료 건수를 보여주고, 누르면 그 주문만 본다', async t => {
  const { db, kim } = await setup(t);
  // 1: 신규주문, 2: 배송준비(발주확인됨), 3: 배송중, 4: 배송완료
  applyOrders(db, [order(2, { channel_confirmed: 1 }), order(3, { channel_confirmed: 1, channel_status: 'DELIVERING' })]);
  applyOrders(db, [order(4, { channel_confirmed: 1, channel_status: 'DELIVERED' })]);
  const text = (await kim.request('/')).text;
  const count = key => new RegExp(`st-${key} [^"]*">\\s*<span class="ship-label">[^<]+</span>\\s*<strong class="ship-count">(\\d+)`).exec(text)[1];
  assert.deepStrictEqual(['new', 'ready', 'shipping', 'delivered'].map(count), ['1', '1', '1', '1']);

  const shipping = (await kim.request('/?st=shipping')).text;
  assert.match(shipping, />상품3</);
  assert.doesNotMatch(shipping, />상품1</);
  assert.match(shipping, /배송중<\/strong> 주문을 작업 단계와 상관없이/);
});

test('탭 아래 단계 버튼에 단계별 건수가 보이고, 누르면 그 단계만 본다', async t => {
  const { kim, idOf, stageId } = await setup(t);
  await save(kim, idOf('P1'), { stage_id: String(stageId('디자인작업')) });
  const text = (await kim.request('/')).text;
  assert.match(text, /모든 단계 <span class="count">3</);
  assert.match(text, /디자인작업 <span class="count">1</);
  assert.match(text, /발주 <span class="count">2</);
  const design = (await kim.request(`/?stage=${stageId('디자인작업')}`)).text;
  assert.match(design, />상품1</);
  assert.doesNotMatch(design, />상품2</);
  assert.match(design, /모든 단계 <span class="count">3</, '단계를 골라도 다른 단계 건수는 그대로 보인다');
});
