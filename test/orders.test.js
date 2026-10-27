// 5단계: 주문 목록과 주문 카드
const test = require('node:test');
const assert = require('node:assert');
const { applyOrders } = require('../src/collector');
const { safeBack } = require('../src/routes/orders');
const { startServer, addUser, loginAs } = require('./helpers');

// 결제 시각: 오늘 기준 최근 (번호가 클수록 나중). 고정 날짜는 '끝난 주문 2주 뒤 숨김' 때문에 시간이 지나면 깨진다
const recent = id => new Date(Date.now() - (100 - id) * 60 * 1000).toISOString();

function order(id, extra = {}) {
  return {
    channel: 'smartstore', channel_order_id: `O${id}`, channel_item_id: `P${id}`, product_name: `상품${id}`,
    option_text: null, quantity: 1, buyer_name: '구매자', receiver_name: `수령${id}`, receiver_phone: '010-0000-0000',
    receiver_address: '서울', paid_at: recent(id), channel_status: 'PAYED', channel_confirmed: 0, ...extra,
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
  ctx.designId = name => db.prepare('SELECT id FROM design_stages WHERE name = ?').get(name).id;
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

test('담당 디자이너, 디자인 단계, 납기, 메모, NAS 경로를 저장한다', async t => {
  const { kim, idOf, row, leeId, designId } = await setup(t);
  const res = await save(kim, idOf('P1'), {
    assignee_id: String(leeId), design_stage_id: String(designId('디자인 작업 중')), due_date: '2026-10-20',
    memo: '금박 추가 요청', nas_path: '\\\\NAS\\작업\\P1',
  });
  assert.strictEqual(res.status, 302);
  const r = row('P1');
  assert.deepStrictEqual(
    [r.assignee_id, r.design_stage_id, r.due_date, r.memo, r.nas_path, r.version],
    [leeId, designId('디자인 작업 중'), '2026-10-20', '금박 추가 요청', '\\\\NAS\\작업\\P1', 1]
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
  const { kim, idOf, row, designId } = await groupSetup(t);
  const page = await kim.request(`/orders/${idOf('P1')}`);
  assert.match(page.text, /무료 양면테이프/);
  assert.match(page.text, /상품 2개에 함께 저장돼요/);
  await save(kim, idOf('P1'), { design_stage_id: String(designId('컨펌 후 파일전송')), due_date: '2026-10-22', memo: '같이 작업' });
  for (const p of ['P1', 'P9']) {
    const r = row(p);
    assert.deepStrictEqual([r.design_stage_id, r.due_date, r.memo], [designId('컨펌 후 파일전송'), '2026-10-22', '같이 작업']);
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
  const count = key => new RegExp(`st-${key} [^"]*">\\s*<span class="ship-label">[^<]+(?:<span[^>]*>[^<]*</span>)?</span>\\s*<strong class="ship-count">(\\d+)`).exec(text)[1];
  assert.deepStrictEqual(['new', 'ready', 'shipping', 'delivered'].map(count), ['1', '1', '1', '1']);
  assert.match(text, /주문 1건/);

  const shipping = (await kim.request('/?st=shipping')).text;
  assert.match(shipping, />상품3</);
  assert.doesNotMatch(shipping, />상품1</);
  assert.match(shipping, /배송중<\/strong> 주문을 작업 단계와 상관없이/);
});

test('상태 칸의 큰 숫자는 판매자센터처럼 상품주문 단위로 센다 (추가상품도 1건)', async t => {
  const { db, kim } = await setup(t);
  applyOrders(db, [order(9, { channel_order_id: 'O1', item_type: 'addon', product_name: '추가품' })]);
  const text = (await kim.request('/')).text;
  assert.match(text, /st-new [^"]*">\s*<span class="ship-label">신규주문<\/span>\s*<strong class="ship-count">4<small>건<\/small><\/strong>\s*<span class="ship-sub">주문 3건/);
});



test('납기 날짜로 목록을 거르고, 달력에는 날짜별 출고 예정 건수가 보인다', async t => {
  const { db, kim, idOf } = await setup(t);
  db.prepare("UPDATE orders SET due_date = '2026-12-10' WHERE channel_item_id IN ('P1', 'P2')").run();
  applyOrders(db, [order(2, { channel_status: 'DELIVERING' })]); // 이미 발송된 주문은 세지 않는다
  const list = (await kim.request('/?due=2026-12-10')).text;
  assert.match(list, />상품1</);
  assert.doesNotMatch(list, />상품3</);
  assert.match(list, /납기 2026-12-10<\/strong> 주문만/);
  const panel = (await kim.request('/calendar?month=2026-12')).text;
  assert.match(panel, /href="\/\?due=2026-12-10"[^>]*>출고 1건</);
  assert.ok(idOf('P1'));
});



test('카드에는 구매자 이름을 먼저, 받는 분이 다르면 괄호로 함께 보여준다', async t => {
  const { db, kim } = await setup(t);
  applyOrders(db, [order(4, { buyer_name: '김현진', receiver_name: '이서연' }), order(5, { buyer_name: '박지호', receiver_name: '박지호' })]);
  const text = (await kim.request('/')).text;
  assert.match(text, /<strong class="buyer">김현진<\/strong> \(받는 분 이서연\)/);
  assert.match(text, /<strong class="buyer">박지호<\/strong> ·/);
});


test('주문 단계·디자인 단계 버튼이 따로 있고 건수가 보이며, 누르면 그 단계만 본다', async t => {
  const { kim, idOf, designId, stageId } = await setup(t);
  await save(kim, idOf('P1'), { design_stage_id: String(designId('디자인 작업 중')) });
  const text = (await kim.request('/')).text;
  assert.match(text, /aria-label="주문 단계"[\s\S]*?>발주 3<\/option>/);
  assert.match(text, /aria-label="디자인 단계"[\s\S]*?>디자인 작업 전 2<\/option>/);
  assert.match(text, />디자인 작업 중 1<\/option>/);
  const working = (await kim.request(`/?ds=${designId('디자인 작업 중')}`)).text;
  assert.match(working, />상품1</);
  assert.doesNotMatch(working, />상품2</);
  assert.match(working, />디자인 작업 전 2<\/option>/, '디자인 단계를 골라도 다른 디자인 단계 건수는 그대로');
  const byStage = (await kim.request(`/?stage=${stageId('발주')}`)).text;
  assert.match(byStage, />상품2</);
});

test('새 주문의 디자인 단계는 디자인 작업 전이고, 목록에서 디자이너가 바로 바꾸면 추가상품까지 같이 바뀐다', async t => {
  const { db, kim, idOf, row, designId } = await setup(t);
  applyOrders(db, [order(9, { channel_order_id: 'O1', item_type: 'addon', product_name: '추가품' })]);
  const list = (await kim.request('/')).text;
  const select = list.slice(list.indexOf(`action="/orders/${idOf('P1')}/design"`));
  assert.match(select.slice(0, 900), new RegExp(`value="${designId('디자인 작업 전')}" selected>디자인 작업 전`));
  assert.match(list, /class="pill stage"[^>]*>발주</, '주문 단계는 따로 표시');
  await kim.submit('/', `/orders/${idOf('P1')}/design`, { design_stage_id: String(designId('디자인 작업 중')), back: '/' });
  assert.deepStrictEqual([row('P1').design_stage_id, row('P9').design_stage_id], [designId('디자인 작업 중'), designId('디자인 작업 중')]);
  // 잘못 골랐으면 다시 '디자인 작업 전' 으로
  await kim.submit('/', `/orders/${idOf('P1')}/design`, { design_stage_id: String(designId('디자인 작업 전')), back: '/' });
  assert.strictEqual(row('P1').design_stage_id, designId('디자인 작업 전'));
  assert.strictEqual(row('P1').stage_id, row('P2').stage_id, '디자인 단계를 바꿔도 주문 단계는 그대로');
});

test('디자이너가 아닌 직원은 디자인 단계를, 관리자가 아닌 직원은 주문 단계를 바꿀 수 없다', async t => {
  const { db, baseUrl, kim, idOf, row, designId, stageId } = await setup(t);
  const cs = await loginAs(baseUrl, 'cs@broad.test');
  assert.doesNotMatch((await cs.request('/')).text, /\/design"/);
  await cs.submit('/', `/orders/${idOf('P1')}/design`, { design_stage_id: String(designId('디자인 작업 중')), back: '/' });
  await save(cs, idOf('P1'), { design_stage_id: String(designId('디자인 작업 중')) });
  assert.strictEqual(row('P1').design_stage_id, null);
  await save(cs, idOf('P1'), { memo: 'CS 메모' });
  assert.strictEqual(row('P1').memo, 'CS 메모', '다른 칸은 저장된다');

  await save(kim, idOf('P1'), { stage_id: String(stageId('발송')) });
  assert.strictEqual(row('P1').stage_id, stageId('발주'), '디자이너도 주문 단계는 못 바꾼다');
  addUser(db, { email: 'boss@broad.test', role: 'admin' });
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  await save(boss, idOf('P1'), { stage_id: String(stageId('발송')) });
  assert.strictEqual(row('P1').stage_id, stageId('발송'), '관리자는 주문 단계를 손으로 고칠 수 있다');
});

test('수기 주문 등록 버튼은 화면 제목 오른쪽에 있다', async t => {
  const { kim } = await setup(t);
  const text = (await kim.request('/')).text;
  assert.match(text, /class="page-actions"[\s\S]*?＋ 수기 주문 등록/);
});

test('팝업(iframe) 안에서 열린 주문 카드는 위쪽 메뉴 없이 닫기 버튼과 함께 보인다', async t => {
  const { kim, idOf } = await setup(t);
  const normal = (await kim.request(`/orders/${idOf('P1')}`)).text;
  assert.match(normal, /class="sidebar"/);
  assert.match(normal, /← 목록으로/);
  const embed = (await kim.request(`/orders/${idOf('P1')}?embed=1`)).text;
  assert.doesNotMatch(embed, /class="sidebar"/);
  assert.doesNotMatch(embed, /← 목록으로/);
  assert.match(embed, /\/embed\.js/);
  assert.doesNotMatch(embed, /\/live\.js/, '팝업 안에서는 알림이 두 번 뜨지 않게 실시간 연결을 하지 않는다');
  assert.match((await kim.request('/')).text, /\/modal\.js/);
});

test('관리자 메뉴도 다른 메뉴처럼 같은 화면에서 열린다 (새 탭 아님)', async t => {
  const { db, baseUrl } = await setup(t);
  addUser(db, { email: 'boss@broad.test', role: 'admin' });
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  const home = (await boss.request('/')).text;
  assert.match(home, /href="\/admin\/users" class=""/);
  assert.doesNotMatch(home, /target="_blank"[^>]*>[^<]*<svg[^>]*>[\s\S]{0,1200}관리자/);
});

test('진행 중 탭에서도 발송 단계에는 발송된 주문 수가 나오고, 고르면 전체 탭에서 보여준다', async t => {
  const { db, kim, stageId } = await setup(t);
  db.prepare("UPDATE orders SET stage_id = ? WHERE channel_item_id IN ('P1', 'P2')").run(stageId('발송'));
  const text = (await kim.request('/')).text;
  assert.match(text, new RegExp(`<option value="${stageId('발송')}" >발송 2</option>`));
  const shipped = (await kim.request(`/?stage=${stageId('발송')}`)).text;
  assert.match(shipped, /class="on">\s*전체 /, '발송을 고르면 전체 탭');
  assert.match(shipped, />상품1</);
  assert.doesNotMatch(shipped, />상품3</);
});

test('채널 버튼 순서를 끌어다 바꾸면 내 계정에만 저장되고, 다음에 열어도 그 순서다', async t => {
  const { db, kim, baseUrl } = await setup(t);
  db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, channel_status) VALUES ('coupang', 'C1', 'C1-1', '쿠팡상품', 'PAYED')").run();
  const order = text => [...text.matchAll(/data-channel="(\w+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(order((await kim.request('/')).text), ['coupang', 'smartstore'], '기본은 이름순');

  const page = await kim.request('/');
  const token = /data-csrf="([^"]+)"/.exec(page.text)[1];
  const res = await fetch(baseUrl + '/me/channel-order', {
    method: 'POST',
    headers: { cookie: kim.cookie(), 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': token },
    body: 'order=smartstore,coupang,hacker',
  });
  assert.deepStrictEqual(await res.json(), { ok: true, order: ['smartstore', 'coupang'] }, '모르는 채널은 버린다');
  assert.deepStrictEqual(order((await kim.request('/')).text), ['smartstore', 'coupang']);

  const lee = await loginAs(baseUrl, 'lee@broad.test');
  assert.deepStrictEqual(order((await lee.request('/')).text), ['coupang', 'smartstore'], '다른 직원 순서는 그대로');

  const noToken = await fetch(baseUrl + '/me/channel-order', {
    method: 'POST', headers: { cookie: kim.cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: 'order=coupang',
  });
  assert.strictEqual(noToken.status, 403);
});

test('확인 필요: 취소·반품·교환 요청 중인 주문과 납기 지난 주문만 따로 모아 본다', async t => {
  const { db, kim } = await setup(t);
  applyOrders(db, [order(1, { claim_type: 'CANCEL', claim_status: 'CANCEL_REQUEST' })]);
  applyOrders(db, [order(2, { claim_type: 'CANCEL', claim_status: 'CANCEL_REJECT' })]); // 거부된 요청은 제외
  db.prepare("UPDATE orders SET due_date = '2020-01-01' WHERE channel_item_id = 'P3'").run();
  const text = (await kim.request('/')).text;
  assert.match(text, /취소·반품·교환 요청 <span class="count">1</);
  assert.match(text, /납기 지남 <span class="count">1</);

  const claims = (await kim.request('/?alert=claim')).text;
  assert.match(claims, />상품1</);
  assert.doesNotMatch(claims, />상품2</);
  assert.doesNotMatch(claims, />상품3</);
  assert.match(claims, /주문만 모아 보는 중/);

  const late = (await kim.request('/?alert=late')).text;
  assert.match(late, />상품3</);
  assert.doesNotMatch(late, />상품1</);
});

test('발주서 출력: 체크한 주문을 한 장에 하나씩 (같은 주문번호는 한 장), 옵션은 줄임 없이, 고객 정보·메모·작업 확인 칸', async t => {
  const { db, kim } = await setup(t);
  // setup 의 주문 O1·O2·O3 + O1 에 상품 하나 더 (P4)
  applyOrders(db, [order(4, { channel_order_id: 'O1', option_text: '아주 긴 옵션 '.repeat(20).trim() })]);
  const ids = db.prepare("SELECT id FROM orders WHERE channel_item_id IN ('P1', 'P2', 'P4') ORDER BY id").all().map(r => r.id);
  db.prepare("UPDATE orders SET memo = '양면테이프 꼭' WHERE id = ?").run(ids[0]);
  const page = await kim.request(`/orders/print?ids=${ids.join(',')}`);
  assert.strictEqual(page.status, 200);
  assert.strictEqual((page.text.match(/<article class="sheet[^"]*">/g) || []).length, 2, '같은 주문번호(O1)는 한 장');
  assert.ok(page.text.includes('아주 긴 옵션 '.repeat(20).trim()), '옵션 전체');
  assert.match(page.text, /양면테이프 꼭/);
  assert.match(page.text, /받는 분/);
  assert.match(page.text, /가공·재단/);
  assert.match(page.text, /src="\/print.js"/);
  const one = await kim.request(`/orders/${ids[1]}/print`);
  assert.strictEqual((one.text.match(/<article class="sheet[^"]*">/g) || []).length, 1);
  assert.strictEqual((await kim.request('/orders/print?ids=')).status, 400);
  assert.match((await kim.request(`/orders/${ids[0]}`)).text, new RegExp(`href="/orders/${ids[0]}/print"`));
  assert.match((await kim.request('/')).text, /data-print-selected/);
});

test('최근 주문순: 채널마다 시각 모양이 달라도(+09:00 / Z) 실제 시각으로 정렬 (수기 주문이 아래로 밀리지 않게)', async t => {
  const { db, kim } = await setup(t);
  // (setup 의 주문보다 늦은 시각) 네이버: 한국 시간 15:42 (= 06:42Z) / 수기: 06:51Z (= 한국 15:51, 더 나중)
  applyOrders(db, [order(9, { paid_at: '2099-10-26T15:42:00.000+09:00', product_name: '네이버주문' })]);
  db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, paid_at, channel_status, channel_confirmed) VALUES ('manual', 'M1', 'M1-1', '수기주문', '2099-10-26T06:51:00.000Z', 'PAYED', 1)").run();
  const text = (await kim.request('/?view=all')).text;
  assert.ok(text.indexOf('수기주문') < text.indexOf('네이버주문'), '나중에 들어온 수기 주문이 위');
});

test('주문 상세: 상품 이름을 누르면 손님이 보는 상품 페이지(새 탭), 스마트스토어는 관리자가 저장한 가게 주소로', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  const ins = db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, paid_at, channel_status, product_no)
    VALUES (?, ?, ?, ?, '2026-10-27T01:00:00Z', 'PAYED', ?)`);
  const ss = Number(ins.run('smartstore', 'S1', 'S1-1', '명함', '5551234567').lastInsertRowid);
  const cp = Number(ins.run('coupang', 'C1', 'C1-1', '포맥스 출입금지 안내판', '7012345678').lastInsertRowid);
  const gd = Number(ins.run('godo', 'G1', 'G1-1', '아크릴 명패', '1000701702').lastInsertRowid);
  const none = Number(ins.run('coupang', 'C2', 'C2-1', '예전 주문', null).lastInsertRowid);
  addUser(db, { email: 'boss@broad.test', role: 'admin' });
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  const page = async id => (await boss.request(`/orders/${id}`)).text;
  assert.match(await page(cp), /href="https:\/\/www\.coupang\.com\/vp\/products\/7012345678" target="_blank" rel="noopener noreferrer" class="product-link"/);
  assert.match(await page(gd), /href="https:\/\/broadstore\.co\.kr\/goods\/goods_view\.php\?goodsNo=1000701702"/);
  assert.match(await page(ss), /href="https:\/\/smartstore\.naver\.com\/main\/products\/5551234567"/, '가게 주소를 저장하기 전');
  assert.doesNotMatch(await page(none), /class="product-link"/, '상품 번호를 모르면 링크 없음');

  await boss.submit('/admin/collect', '/admin/store-url', { smartstore_url: 'smartstore.naver.com/broad/' });
  assert.match(await page(ss), /href="https:\/\/smartstore\.naver\.com\/broad\/products\/5551234567"/);
  assert.match((await boss.request('/admin/collect')).text, /value="https:\/\/smartstore\.naver\.com\/broad"/);
  await boss.submit('/admin/collect', '/admin/store-url', { smartstore_url: 'https://evil.example.com/x' });
  assert.match(await page(ss), /smartstore\.naver\.com\/broad\/products/, '이상한 주소는 저장하지 않음');
});
