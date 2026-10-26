// 수기 주문 (계좌이체·전화 주문 직접 등록)
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { startServer, addUser, loginAs } = require('./helpers');

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  const { db } = ctx;
  const designerJob = db.prepare("SELECT id FROM jobs WHERE name = '디자이너'").get().id;
  ctx.kimId = addUser(db, { email: 'kim@broad.test', name: '김디자' });
  db.prepare('UPDATE users SET job_id = ? WHERE id = ?').run(designerJob, ctx.kimId);
  ctx.kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  ctx.rows = () => db.prepare("SELECT * FROM orders WHERE channel = 'manual' ORDER BY id").all().map(r => ({ ...r }));
  ctx.logs = () => db.prepare('SELECT * FROM order_actions ORDER BY id').all().map(r => ({ ...r }));
  return ctx;
}

const FORM = {
  item_name: ['현수막 3000x900', '거치대', ''],
  item_option: ['아일렛', '', ''],
  item_qty: ['2', '1', '1'],
  item_id: ['', '', ''],
  buyer_name: '홍길동',
  buyer_phone: '010-1111-2222',
  receiver_address: '(06236) 서울 강남구 테헤란로 1',
  pay_method: 'BANK',
  amount: '55,000',
  depositor: '홍길동(회사)',
  pay_status: 'waiting',
};

async function create(ctx, fields = {}) {
  return ctx.kim.submit('/orders/new', '/orders/new', { ...FORM, ...fields });
}

test('목록에 수기 주문 버튼이 있고, 등록 화면이 열린다', async t => {
  const { kim, baseUrl } = await setup(t);
  assert.match((await kim.request('/')).text, /＋ 수기 주문/);
  const page = await kim.request('/orders/new');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /수기 주문 등록/);
  // 배송지 주소는 카카오 우편번호 서비스로 검색 (그 스크립트·검색 창만 보안 설정에서 허용)
  assert.match(page.text, /data-addr-search/);
  assert.match(page.text, /src="https:\/\/t1\.daumcdn\.net\/mapjsapi\/bundle\/postcode\/prod\/postcode\.v2\.js"/);
  const csp = (await fetch(`${baseUrl}/login`)).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/\*\.daumcdn\.net https:\/\/\*\.kakaocdn\.net/);
  assert.match(csp, /frame-src 'self' https:\/\/\*\.daum\.net https:\/\/\*\.kakao\.com/);
});

test('수기 주문을 등록하면 상품마다 한 줄씩, 한 주문번호로 묶여 들어가고 기록이 남는다', async t => {
  const ctx = await setup(t);
  const res = await create(ctx);
  const rows = ctx.rows();
  assert.strictEqual(rows.length, 2, '빈 줄은 건너뛴다');
  assert.strictEqual(res.location, `/orders/${rows[0].id}`);
  assert.match(rows[0].channel_order_id, /^M\d{6}-001$/);
  assert.deepStrictEqual(rows.map(r => r.channel_item_id), [`${rows[0].channel_order_id}-1`, `${rows[0].channel_order_id}-2`]);
  assert.deepStrictEqual(
    [rows[0].product_name, rows[0].option_text, rows[0].quantity, rows[0].buyer_name, rows[0].receiver_name, rows[0].receiver_phone],
    ['현수막 3000x900', '아일렛', 2, '홍길동', '홍길동', '010-1111-2222'],
    '받는 분을 비우면 주문자와 같게');
  assert.deepStrictEqual([rows[0].channel_status, rows[0].amount, rows[0].pay_method, rows[0].depositor], ['PAYMENT_WAITING', 55000, 'BANK', '홍길동(회사)']);
  assert.strictEqual(ctx.logs()[0].action, 'create');

  const list = (await ctx.kim.request('/')).text;
  assert.match(list, /class="ch ch-manual"/);
  assert.match(list, /입금대기/);
  assert.match(list, />현수막 3000x900</);
  // 두 번째 등록은 순번이 올라간다
  await create(ctx);
  assert.match(ctx.rows()[2].channel_order_id, /-002$/);
});

test('주문자 이름이나 상품이 없으면 등록하지 않고 입력값을 그대로 보여준다', async t => {
  const ctx = await setup(t);
  const res = await create(ctx, { buyer_name: '' });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /주문자 이름을 적어 주세요/);
  assert.match(res.text, /value="현수막 3000x900"/);
  const res2 = await create(ctx, { item_name: ['', '', ''] });
  assert.match(res2.text, /상품을 하나 이상/);
  const res3 = await create(ctx, { amount: '오만원' });
  assert.match(res3.text, /금액은 숫자로/);
  assert.strictEqual(ctx.rows().length, 0);
});

test('입금 확인 → 발송 완료 기록: 상태가 바뀌고 진행 중에서 빠진다', async t => {
  const ctx = await setup(t);
  await create(ctx);
  const id = ctx.rows()[0].id;
  const page = (await ctx.kim.request(`/orders/${id}`)).text;
  assert.match(page, /입금 확인/);
  assert.match(page, /55,000원/);

  await ctx.kim.submit(`/orders/${id}`, `/orders/${id}/manual/paid`, {});
  assert.ok(ctx.rows().every(r => r.channel_status === 'PAYED'));
  assert.match((await ctx.kim.request('/')).text, /입금완료/);

  await ctx.kim.submit(`/orders/${id}`, `/orders/${id}/manual/dispatch`, { method: 'DELIVERY', company: 'KGB', tracking: '1234-5678-9012' });
  const rows = ctx.rows();
  assert.ok(rows.every(r => r.channel_status === 'DELIVERED' && r.tracking_no === '123456789012'));
  const list = (await ctx.kim.request('/')).text;
  assert.doesNotMatch(list, />현수막 3000x900</, '진행 중에서 빠진다');
  assert.match((await ctx.kim.request('/?view=all')).text, /발송 · 로젠택배 123456789012/);
  assert.deepStrictEqual(ctx.logs().map(l => [l.action, l.mode]), [['create', 'local'], ['paid', 'local'], ['dispatch', 'local']]);
});

test('퀵·직접전달은 송장번호 없이 발송 기록할 수 있고, 택배는 송장번호가 필요하다', async t => {
  const ctx = await setup(t);
  await create(ctx, { pay_status: 'paid' });
  const id = ctx.rows()[0].id;
  await ctx.kim.submit(`/orders/${id}`, `/orders/${id}/manual/dispatch`, { method: 'DELIVERY', company: 'KGB', tracking: '' });
  assert.strictEqual(ctx.rows()[0].channel_status, 'PAYED');
  await ctx.kim.submit(`/orders/${id}`, `/orders/${id}/manual/dispatch`, { method: 'DIRECT_DELIVERY' });
  assert.deepStrictEqual([ctx.rows()[0].channel_status, ctx.rows()[0].ship_method], ['DELIVERED', 'DIRECT_DELIVERY']);
});

test('수정: 고객·결제 정보와 상품을 고치고 상품을 더할 수 있다 (먼저 저장한 사람이 있으면 막는다)', async t => {
  const ctx = await setup(t);
  await create(ctx);
  const [a, b] = ctx.rows();
  const page = await ctx.kim.request(`/orders/${a.id}/manual-edit`);
  assert.match(page.text, /value="현수막 3000x900"/);
  const fields = {
    version: '0', buyer_name: '홍길동', buyer_phone: '010-9999-8888', receiver_address: '부산',
    pay_method: 'CASH', amount: '60000',
    item_id: [String(a.id), String(b.id), ''], item_name: ['현수막 5000x900', '거치대', '양면테이프'],
    item_option: ['각목', '', ''], item_qty: ['1', '2', '3'],
  };
  await ctx.kim.submit(`/orders/${a.id}/manual-edit`, `/orders/${a.id}/manual-edit`, fields);
  const rows = ctx.rows();
  assert.deepStrictEqual(rows.map(r => [r.product_name, r.quantity]), [['현수막 5000x900', 1], ['거치대', 2], ['양면테이프', 3]]);
  assert.ok(rows.every(r => r.amount === 60000 && r.pay_method === 'CASH' && r.receiver_address === '부산'));
  assert.strictEqual(rows[2].channel_item_id, `${a.channel_order_id}-3`);

  await ctx.kim.submit(`/orders/${a.id}/manual-edit`, `/orders/${a.id}/manual-edit`, { ...fields, amount: '1' });
  assert.strictEqual(ctx.rows()[0].amount, 60000, '옛 version 으로는 덮어쓰지 못한다');
});

test('취소하면 진행 중에서 빠지고, 스마트스토어 주문은 수기 수정 화면을 열 수 없다', async t => {
  const ctx = await setup(t);
  await create(ctx);
  const id = ctx.rows()[0].id;
  await ctx.kim.submit(`/orders/${id}`, `/orders/${id}/manual/cancel`, {});
  assert.ok(ctx.rows().every(r => r.channel_status === 'CANCELED'));
  assert.doesNotMatch((await ctx.kim.request('/')).text, />현수막 3000x900</);

  const { applyOrders } = require('../src/collector');
  applyOrders(ctx.db, [{ channel: 'smartstore', channel_order_id: 'O1', channel_item_id: 'P1', product_name: 'x', option_text: null, quantity: 1, buyer_name: null, receiver_name: null, receiver_phone: null, receiver_address: null, paid_at: null, channel_status: 'PAYED', channel_confirmed: 0 }]);
  const sid = ctx.db.prepare("SELECT id FROM orders WHERE channel_item_id = 'P1'").get().id;
  assert.strictEqual((await ctx.kim.request(`/orders/${sid}/manual-edit`)).status, 404);
});

test('승인 대기 직원은 수기 주문을 등록할 수 없다', async t => {
  const ctx = await setup(t);
  addUser(ctx.db, { email: 'wait@broad.test', status: 'pending' });
  const b = await loginAs(ctx.baseUrl, 'wait@broad.test');
  assert.strictEqual((await b.request('/orders/new')).location, '/pending');
});

test('예전 처리 기록 표는 기록을 지키면서 새 종류(수기 등록 등)를 받을 수 있게 바뀐다', () => {
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'old.db');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE order_actions (
    id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), user_id INTEGER,
    action TEXT NOT NULL CHECK (action IN ('confirm', 'dispatch')), channel TEXT NOT NULL, channel_order_id TEXT NOT NULL,
    item_ids TEXT NOT NULL, detail TEXT, mode TEXT NOT NULL CHECK (mode IN ('live', 'practice')),
    result TEXT NOT NULL CHECK (result IN ('ok', 'partial', 'fail', 'practice', 'unknown')), message TEXT);
    INSERT INTO order_actions (action, channel, channel_order_id, item_ids, mode, result) VALUES ('confirm', 'smartstore', 'O1', '[]', 'live', 'ok');`);
  old.close();
  const db = openDb(file);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM order_actions').get().n, 1);
  db.prepare("INSERT INTO order_actions (action, channel, channel_order_id, item_ids, mode, result) VALUES ('create', 'manual', 'M1', '[]', 'local', 'ok')").run();
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM order_actions').get().n, 2);
  db.close();
});

test('상태 칸(판매자센터 비교용)은 전체 채널에서 수기 주문을 빼고 센다', async t => {
  const ctx = await setup(t);
  await create(ctx, { pay_status: 'paid' });
  const ready = text => /st-ready [^"]*">\s*<span class="ship-label">[^<]+<\/span>\s*<strong class="ship-count">(\d+)/.exec(text)[1];
  assert.strictEqual(ready((await ctx.kim.request('/')).text), '0');
  assert.strictEqual(ready((await ctx.kim.request('/?ch=manual')).text), '2');
});

test('주문 출처·판매처 주문번호를 함께 등록하고, 수기 주문 칩 아래 출처 칩으로 거르고, 번호로 검색한다', async t => {
  const ctx = await setup(t);
  const { db } = ctx;
  const idOf = name => db.prepare('SELECT id FROM order_sources WHERE name = ?').get(name).id;
  const page = (await ctx.kim.request('/orders/new')).text;
  assert.match(page, /name="source_id"/);
  assert.match(page, new RegExp(`value="${idOf('계좌·전화 주문')}" selected`), '처음엔 맨 위 출처');

  await create(ctx, { source_id: String(idOf('G마켓')), source_order_no: '4123456789', buyer_name: '김지마' });
  await create(ctx, { source_id: String(idOf('옥션')), buyer_name: '이옥션' });
  await create(ctx, { source_id: '', buyer_name: '박미정' });
  const rows = ctx.rows();
  assert.deepStrictEqual([rows[0].source_id, rows[0].source_order_no], [idOf('G마켓'), '4123456789']);
  assert.strictEqual(rows[1].source_id, idOf('G마켓'), '같은 주문의 상품 모두');

  const all = (await ctx.kim.request('/?ch=manual')).text;
  assert.match(all, /aria-label="주문 출처"/);
  assert.match(all, /G마켓 <span class="count">1<\/span>/);
  assert.match(all, /출처 미지정 <span class="count">1<\/span>/);
  assert.match(all, /class="src-tag src-c\d">G마켓</);
  assert.match(all, /주문번호 4123456789/);

  const gm = (await ctx.kim.request(`/?ch=manual&src=${idOf('G마켓')}`)).text;
  assert.match(gm, /김지마/);
  assert.ok(!gm.includes('이옥션') && !gm.includes('박미정'));
  const none = (await ctx.kim.request('/?ch=manual&src=none')).text;
  assert.ok(none.includes('박미정') && !none.includes('김지마'));
  // 다른 채널을 보면 출처 칩·필터는 쓰지 않는다
  assert.ok(!(await ctx.kim.request('/')).text.includes('aria-label="주문 출처"'));

  const found = (await ctx.kim.request('/?q=4123456789')).text;
  assert.ok(found.includes('김지마') && !found.includes('이옥션'));
  assert.ok((await ctx.kim.request('/?q=' + encodeURIComponent('옥션'))).text.includes('이옥션'), '출처 이름으로도 찾는다');

  // 상세·수정: 출처를 바꾸고, 숨긴 출처는 새로 고를 수 없다
  const detail = (await ctx.kim.request(`/orders/${rows[0].id}`)).text;
  assert.match(detail, /주문 출처<\/dt><dd>G마켓/);
  db.prepare("UPDATE order_sources SET active = 0 WHERE name = '기타'").run();
  const bad = await create(ctx, { source_id: String(idOf('기타')) });
  assert.match(bad.text, /고를 수 없는 주문 출처/);
  const edit = await ctx.kim.submit(`/orders/${rows[0].id}/manual-edit`, `/orders/${rows[0].id}/manual-edit`, {
    ...FORM, item_id: [String(rows[0].id), String(rows[1].id), ''], version: '0',
    source_id: String(idOf('옥션')), source_order_no: '', buyer_name: '김지마',
  });
  assert.strictEqual(edit.status, 302);
  assert.deepStrictEqual(ctx.rows().filter(r => r.channel_order_id === rows[0].channel_order_id).map(r => [r.source_id, r.source_order_no]),
    [[idOf('옥션'), null], [idOf('옥션'), null]]);
});

test('수기 주문 등록은 목록 위 팝업으로 열린다: 버튼에 팝업 표시, 팝업 안 화면엔 목록으로 대신 취소(닫기)', async t => {
  const { kim } = await setup(t);
  assert.match((await kim.request('/')).text, /class="btn-sm primary new-order" data-modal-link>/);
  const popup = (await kim.request('/orders/new?embed=1')).text;
  assert.match(popup, /data-close-modal>취소</);
  assert.ok(!popup.includes('← 목록으로'));
  const full = (await kim.request('/orders/new')).text;
  assert.match(full, /← 목록으로/);
  assert.ok(!full.includes('data-close-modal'));
});

test('배송지: 기본주소(검색) + 상세주소를 한 줄로 저장하고, 고칠 때는 다시 두 칸으로', async t => {
  const ctx = await setup(t);
  await create(ctx, { receiver_address: '(11407) 경기 양주시 평화로 1552-7 (옥정센트럴)', receiver_address_detail: '101동 1004호' });
  const row = ctx.rows()[0];
  assert.strictEqual(row.receiver_address, '(11407) 경기 양주시 평화로 1552-7 (옥정센트럴) 101동 1004호');
  assert.strictEqual(row.receiver_address_detail, '101동 1004호');
  const page = (await ctx.kim.request(`/orders/${row.id}/manual-edit`)).text;
  assert.match(page, /name="receiver_address" value="\(11407\) 경기 양주시 평화로 1552-7 \(옥정센트럴\)"/);
  assert.match(page, /name="receiver_address_detail" value="101동 1004호"/);
  // 상세주소 없이(단독주택)도 저장된다
  await create(ctx, { receiver_address: '(11407) 경기 양주시 평화로 1', receiver_address_detail: '' });
  assert.strictEqual(ctx.rows().find(r => r.receiver_address === '(11407) 경기 양주시 평화로 1').receiver_address_detail, null);
});
