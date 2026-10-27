// 로젠 송장 흐름: 계약 불러오기 → 등록(10건씩·차례대로·쉬면서) → 송장번호 가져오기 → 배송 조회
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createLogen } = require('../src/logen');
const { createLogenClient } = require('../src/channels/logen');
const { startServer, addUser, loginAs } = require('./helpers');

// 가짜 로젠: 호출을 기록하고, 동시에 두 개가 돌면 표시한다
function fakeClient(env = 'dev', overrides = {}) {
  const calls = [];
  const slips = {};
  let running = 0;
  let overlapped = false;
  const handlers = {
    contractTotalInfo: () => ({ sttsCd: 'SUCCESS', data: [{ resultCd: 'TRUE', pickSalesNm: '양주 영업소', pickBranNm: '양주', fareTy: '030', fareTyNm: '신용', useYn: 'Y' }] }),
    contPickFares: () => ({ sttsCd: 'SUCCESS', data: [{ fareTy: '030', data1: [{ boxTyCd: 'ZW001', boxTyNm: '소', dlvFare: 3000 }, { boxTyCd: 'ZW002', boxTyNm: '중', dlvFare: 4000 }] }] }),
    registerOrderData: rows => ({ sttsCd: 'SUCCESS', data: rows.map(r => ({ fixTakeNo: r.fixTakeNo, resultCd: 'TRUE' })) }),
    inquirySlipNoMulti: rows => ({ sttsCd: 'SUCCESS', data: rows.map(r => ({ fixTakeNo: r.fixTakeNo, resultCd: 'TRUE', data1: slips[r.fixTakeNo] || [] })) }),
    inquiryCargoTrackingMulti: rows => ({ sttsCd: 'SUCCESS', data: rows.map(r => ({ slipNo: r.slipNo, resultCd: 'TRUE', data1: [
      { scanDt: '20261022', scanTm: '101500', statNm: '집하완료', branNm: '양주' },
      { scanDt: '20261022', scanTm: '183000', statNm: '터미널입고', branNm: '곤지암' },
    ] })) }),
    ...overrides,
  };
  return {
    env, hasKey: true, allowWrite: false, calls, slips, overlapped: () => overlapped,
    async request(name, rows) {
      running += 1;
      if (running > 1) overlapped = true;
      calls.push({ name, rows, at: Date.now() });
      await new Promise(r => setTimeout(r, 5));
      running -= 1;
      return handlers[name](rows);
    },
  };
}

function seedOrders(db, n, { status = 'PAYED' } = {}) {
  const ins = db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, option_text, quantity, receiver_name, receiver_phone, receiver_address, paid_at, channel_status, channel_confirmed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const ids = [];
  for (let i = 1; i <= n; i++) {
    ids.push(Number(ins.run('smartstore', `O${i}`, `O${i}-1`, `현수막 ${i}`, '90x60', 1, `고객${i}`, '010-1111-2222', '서울 마포구 1', '2026-10-20T01:00:00Z', status).lastInsertRowid));
  }
  return ids;
}

const groupsFor = (db, ids) => ids.map(id => {
  const o = db.prepare('SELECT channel, channel_order_id FROM orders WHERE id = ?').get(id);
  return db.prepare('SELECT * FROM orders WHERE channel = ? AND channel_order_id = ? ORDER BY id').all(o.channel, o.channel_order_id);
});

async function ready(db, client, opts = {}) {
  const logen = createLogen({ db, client, gapMs: 40, ...opts });
  await logen.loadContract();
  assert.deepStrictEqual(logen.saveSettings({ name: '브로애드', addr: '경기 양주시 1', tel: '031-000-0000', box: 'ZW002' }), { ok: true });
  return logen;
}

test('설정: 계약정보·운임을 불러오고 보내는 분·박스를 정해야 등록할 수 있다', async () => {
  const db = openDb(':memory:');
  const client = fakeClient();
  const logen = createLogen({ db, client, gapMs: 0 });
  assert.match((await logen.register(groupsFor(db, seedOrders(db, 1)), null)).error, /계약 정보 불러오기, 보내는 분, 기본 박스/);
  assert.strictEqual(client.calls.length, 0, '설정 전에는 로젠에 보내지 않음');
  const c = await logen.loadContract();
  assert.strictEqual(c.salesNm, '양주 영업소');
  assert.deepStrictEqual(client.calls.map(x => x.name), ['contractTotalInfo', 'contPickFares']);
  assert.deepStrictEqual(client.calls[1].rows, [{ fareTy: '030' }]);
  assert.match(logen.saveSettings({ name: '브로애드', addr: '양주', tel: '12' }).error, /전화번호/);
  assert.match(logen.saveSettings({ name: '브로애드', addr: '양주', tel: '0310000000', box: 'NOPE' }).error, /박스/);
  logen.saveSettings({ name: '브로애드', addr: '양주', tel: '0310000000', box: 'ZW002' });
  const s = logen.settings();
  assert.ok(s.ready);
  assert.strictEqual(s.box.fare, 4000);
});

test('등록: 10건씩 차례대로(겹치지 않게) 쉬면서, 같은 주문번호는 한 송장, 테스트 서버엔 연습용 고객 정보', async () => {
  const db = openDb(':memory:');
  const client = fakeClient();
  const logen = await ready(db, client);
  const ids = seedOrders(db, 23);
  // O1 에 추가상품 하나 → 같은 송장으로
  db.prepare(`INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, quantity, item_type, paid_at, channel_status)
    VALUES ('smartstore', 'O1', 'O1-2', '양면테이프', 2, 'addon', '2026-10-20T01:00:00Z', 'PAYED')`).run();
  client.calls.length = 0;
  const r = await logen.register(groupsFor(db, [...ids, ids[0]]), null);
  assert.strictEqual(r.done, 23);
  const regs = client.calls.filter(c => c.name === 'registerOrderData');
  assert.deepStrictEqual(regs.map(c => c.rows.length), [10, 10, 3], '10건씩');
  assert.ok(!client.overlapped(), '동시에 보내지 않음');
  for (let i = 1; i < regs.length; i++) assert.ok(regs[i].at - regs[i - 1].at >= 35, '호출 사이에 쉰다');
  const first = regs[0].rows[0];
  assert.strictEqual(first.fixTakeNo, 'O1');
  assert.strictEqual(first.goodsNm, '현수막 1 외 1건');
  assert.strictEqual(first.inQty, 3);
  assert.strictEqual(first.qty, 1);
  assert.strictEqual(first.dlvFare, 4000);
  assert.strictEqual(first.boxTyCd, 'ZW002');
  assert.strictEqual(first.fareTy, '030');
  assert.strictEqual(first.sndTelNo, '0310000000');
  assert.strictEqual(first.rcvCustNm, '테스트고객', '테스트 서버엔 실제 고객 정보를 보내지 않음');
  assert.ok(!JSON.stringify(regs).includes('고객1') && !JSON.stringify(regs).includes('마포'));
  assert.match(first.takeDt, /^\d{8}$/);

  // 다시 고르면 이미 등록한 주문은 뺀다
  client.calls.length = 0;
  const again = await logen.register(groupsFor(db, [ids[0]]), null);
  assert.strictEqual(again.done, 0);
  assert.strictEqual(again.skipped.length, 1);
  assert.strictEqual(client.calls.length, 0);
});

test('송장번호 가져오기: 출력한 것만 채우고, iLOGEN 에서 지운 주문은 다시 등록할 수 있다(-2)', async () => {
  const db = openDb(':memory:');
  const client = fakeClient();
  const logen = await ready(db, client, { gapMs: 0 });
  const ids = seedOrders(db, 3);
  await logen.register(groupsFor(db, ids), null);
  client.slips.O1 = [{ slipNo: '38010101111', delYn: 'N' }];
  client.slips.O2 = [{ slipNo: '38010102222', delYn: 'Y' }];
  const r = await logen.fetchSlips();
  assert.deepStrictEqual(r, { checked: 3, found: 1, deleted: 1, waiting: 1, foundRows: [{ channel: 'smartstore', orderId: 'O1', slip: '38010101111' }] });
  assert.strictEqual(logen.shipmentOf('smartstore', 'O1').slip_no, '38010101111');
  assert.strictEqual(logen.waiting().length, 1);
  const re = await logen.register(groupsFor(db, [ids[1]]), null);
  assert.strictEqual(re.done, 1);
  assert.strictEqual(logen.shipmentOf('smartstore', 'O2').take_no, 'O2-2');
});

test('실제 서버: LOGEN_WRITE 가 꺼져 있으면 등록을 하나도 보내지 않는다 / 실제 고객 정보는 실제 서버에만', async () => {
  const db = openDb(':memory:');
  let sent = 0;
  const contractClient = fakeClient('prod');
  const real = createLogenClient({ env: 'prod', secretKey: 'k', custCd: '38050660', allowWrite: false, fetchFn: async () => { sent += 1; return new Response('{}'); } });
  const client = { ...real, request: (name, rows) => (name === 'registerOrderData' ? real.request(name, rows) : contractClient.request(name, rows)) };
  const logen = await ready(db, client, { gapMs: 0 });
  const r = await logen.register(groupsFor(db, seedOrders(db, 12)), null);
  assert.strictEqual(sent, 0);
  assert.strictEqual(r.done, 0);
  assert.match(r.failed[0].message, /LOGEN_WRITE=on 이 아님/);
  assert.strictEqual(r.failed.length, 10, '꺼져 있으면 다음 묶음은 보내지 않음');

  const on = fakeClient('prod');
  const db2 = openDb(':memory:');
  const live = await ready(db2, on, { gapMs: 0 });
  await live.register(groupsFor(db2, seedOrders(db2, 1)), null);
  const row = on.calls.find(c => c.name === 'registerOrderData').rows[0];
  assert.strictEqual(row.rcvCustNm, '고객1');
  assert.strictEqual(row.rcvTelNo, '01011112222');
  assert.strictEqual(row.rcvCellNo, '01011112222');
  assert.strictEqual(row.sndMsg, '', '배송 메시지가 없으면 빈칸');

  // 배송 메시지: 실제 서버에는 그대로, 개발 서버에는 연습 문구로
  const on4 = fakeClient('prod');
  const db4 = openDb(':memory:');
  const live4 = await ready(db4, on4, { gapMs: 0 });
  const [id4] = seedOrders(db4, 1);
  db4.prepare("UPDATE orders SET ship_memo = '공동현관 1234# 문 앞'").run();
  await live4.register(groupsFor(db4, [id4]), null);
  assert.strictEqual(on4.calls.find(c => c.name === 'registerOrderData').rows[0].sndMsg, '공동현관 1234# 문 앞');
  const dev = fakeClient();
  const db3 = openDb(':memory:');
  const devLogen = await ready(db3, dev, { gapMs: 0 });
  const [devId] = seedOrders(db3, 1);
  db3.prepare("UPDATE orders SET ship_memo = '공동현관 1234# 문 앞'").run();
  await devLogen.register(groupsFor(db3, [devId]), null);
  assert.strictEqual(dev.calls.find(c => c.name === 'registerOrderData').rows[0].sndMsg, '문 앞 (연습)');
});

test('배송 조회: 단계를 시간 순으로 저장하고, 5분 안에 다시 누르면 로젠에 다시 묻지 않는다', async () => {
  const db = openDb(':memory:');
  const client = fakeClient();
  const logen = await ready(db, client, { gapMs: 0 });
  await logen.register(groupsFor(db, seedOrders(db, 1)), null);
  client.slips.O1 = [{ slipNo: '38010101111', delYn: 'N' }];
  await logen.fetchSlips();
  const r = await logen.track('380-1010-1111');
  assert.deepStrictEqual(r.events.map(e => e.stat), ['집하완료', '터미널입고']);
  assert.strictEqual(r.events[1].at, '2026-10-22 18:30');
  const n = client.calls.length;
  assert.ok((await logen.track('38010101111')).cached);
  assert.strictEqual(client.calls.length, n);
  await assert.rejects(logen.track('123'), /송장번호가 아닙니다/);
});

test('화면: 관리자 로젠 설정, 목록의 [로젠 등록]·[송장번호 가져오기], 발송처리 칸에 송장번호가 미리 채워짐', async t => {
  const db = openDb(':memory:');
  const client = fakeClient();
  const logen = createLogen({ db, client, gapMs: 0 });
  const ctx = await startServer({ db, logen });
  t.after(() => ctx.server.close());
  addUser(db, { email: 'boss@broad.test', role: 'admin' });
  addUser(db, { email: 'kim@broad.test' });
  const boss = await loginAs(ctx.baseUrl, 'boss@broad.test');
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');

  assert.match((await boss.request('/admin/logen')).text, /테스트 서버/);
  await boss.submit('/admin/logen', '/admin/logen/contract', {});
  await boss.submit('/admin/logen', '/admin/logen/settings', { name: '브로애드', addr: '경기 양주시 1', tel: '0310000000', box: 'ZW001' });
  const admin = (await boss.request('/admin/logen')).text;
  assert.match(admin, /양주 영업소/);
  assert.match(admin, /value="ZW001" selected/);
  assert.strictEqual((await kim.request('/admin/logen')).status, 403, '관리자만');

  const ids = seedOrders(db, 2);
  const list = (await kim.request('/')).text;
  assert.match(list, /formaction="\/orders\/bulk\/logen"/);
  assert.match(list, /data-can="dispatch logen"/);
  await kim.submit('/', '/orders/bulk/logen', { ids: ids.map(String), back: '/' });
  const after = (await kim.request('/')).text;
  assert.match(after, /로젠에 2건 등록했습니다/);
  assert.match(after, /로젠 등록 · 출력 대기/);
  assert.match(after, /송장번호를 기다리는 주문 <strong>2건/);
  assert.match(after, /href="https:\/\/logis\.ilogen\.com" target="_blank"/);

  client.slips.O1 = [{ slipNo: '38010101111', delYn: 'N' }];
  await kim.submit('/', '/orders/logen/slips', { back: '/' });
  const got = (await kim.request('/')).text;
  assert.match(got, /송장번호 1건 받음 · 아직 출력 전 1건/);
  assert.match(got, /로젠 송장 38010101111/);

  const form = (await kim.submit('/', '/orders/bulk/dispatch-form', { ids: ids.map(String), back: '/' })).text;
  assert.match(form, /name="tracking_\d+" value="38010101111"/);
  // 아직 출력 전인 주문은 '출력 대기' 로 알려 주고, 출력한 뒤 그 자리에서 송장번호를 가져와 채운다
  assert.match(form, /출력 대기 1건<\/strong>은 아직 송장번호가 없어요/);
  assert.strictEqual((form.match(/로젠 출력 대기 · 송장번호 없음/g) || []).length, 1);
  client.slips.O2 = [{ slipNo: '38010102222', delYn: 'N' }];
  const refreshed = (await kim.submit('/', '/orders/bulk/dispatch-form', { ids: ids.map(String), back: '/', refresh_slips: '1' })).text;
  assert.match(refreshed, /송장번호 1건 받음/);
  assert.match(refreshed, /name="tracking_\d+" value="38010102222"/);
  assert.doesNotMatch(refreshed, /로젠 출력 대기 · 송장번호 없음/);
  const detail = (await kim.request(`/orders/${ids[0]}`)).text;
  assert.match(detail, /name="tracking" value="38010101111"/);
  assert.match(detail, /로젠 송장/);
  await kim.submit(`/orders/${ids[0]}`, `/orders/${ids[0]}/logen/track`, { back: '/' });
  const tracked = (await kim.request(`/orders/${ids[0]}`)).text;
  assert.match(tracked, /배송 조회: 터미널입고/);
  assert.match(tracked, /class="now"><strong>터미널입고/);
});

test('5분마다: 기다리는 주문이 있을 때만 묻고, 자동 발송처리는 켰을 때만 (기본 꺼짐)', async () => {
  const db = openDb(':memory:');
  const client = fakeClient();
  const logen = await ready(db, client, { gapMs: 0 });
  const dispatched = [];
  const found = [];
  const opts = { onFound: r => found.push(r.slip), dispatch: async r => dispatched.push(r) };
  client.calls.length = 0;
  assert.strictEqual(await logen.tick(opts), null, '기다리는 주문이 없으면 로젠에 묻지 않음');
  assert.strictEqual(client.calls.length, 0);

  await logen.register(groupsFor(db, seedOrders(db, 2)), null);
  client.slips.O1 = [{ slipNo: '38010101111', delYn: 'N' }];
  const r = await logen.tick(opts);
  assert.strictEqual(r.found, 1);
  assert.deepStrictEqual(found, ['38010101111']);
  assert.strictEqual(dispatched.length, 0, '기본은 자동 발송처리 꺼짐');
  assert.strictEqual(logen.lastTick().found, 1);

  logen.setAutoDispatch(true);
  client.slips.O2 = [{ slipNo: '38010102222', delYn: 'N' }];
  await logen.tick(opts);
  assert.deepStrictEqual(dispatched, [{ channel: 'smartstore', orderId: 'O2', slip: '38010102222' }]);
  client.calls.length = 0;
  assert.strictEqual(await logen.tick(opts), null, '다 받았으면 더 묻지 않음');
  assert.strictEqual(client.calls.length, 0);
});

test('자동 발송처리: 켜면 송장번호가 들어온 주문을 로젠택배·그 송장번호로 발송처리 (연습 모드면 기록만)', async t => {
  const db = openDb(':memory:');
  const client = fakeClient();
  const logen = await ready(db, client, { gapMs: 0 });
  const ctx = await startServer({ db, logen });
  t.after(() => ctx.server.close());
  addUser(db, { email: 'boss@broad.test', role: 'admin' });
  const boss = await loginAs(ctx.baseUrl, 'boss@broad.test');
  assert.match((await boss.request('/admin/logen')).text, /③ 자동 발송처리[\s\S]*꺼짐/);
  await boss.submit('/admin/logen', '/admin/logen/auto-dispatch', { on: '1' });
  assert.match((await boss.request('/admin/logen')).text, /자동 발송처리를 켰습니다/);
  assert.ok(logen.autoDispatch());

  const ids = seedOrders(db, 1);
  await logen.register(groupsFor(db, ids), null);
  client.slips.O1 = [{ slipNo: '38010101111', delYn: 'N' }];
  // server.js 가 5분마다 부르는 것과 같은 함수
  const { createApp } = require('../src/app');
  const app = createApp({ db, logen, secret: 'x' });
  await app.locals.logenTick();
  const a = db.prepare("SELECT * FROM order_actions WHERE action = 'dispatch'").get();
  assert.ok(a, '발송처리 기록');
  assert.deepStrictEqual(JSON.parse(a.detail), { method: 'DELIVERY', company: 'KGB', tracking: '38010101111' });
  assert.strictEqual(a.user_id, null);
});
