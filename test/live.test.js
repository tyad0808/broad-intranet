// 6단계: 실시간 반영과 알림
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createNotifier } = require('../src/notifier');
const { applyOrders } = require('../src/collector');
const { startServer, addUser, loginAs, browser } = require('./helpers');

// 보낸 소식을 기록만 하는 가짜 통로
function fakeHub() {
  const sent = [];
  return { sent, send: (event, data, canReceive = () => true) => sent.push({ event, data, canReceive }), disconnectUser() {} };
}

function order(id, extra = {}) {
  return {
    channel: 'smartstore', channel_order_id: `O${id}`, channel_item_id: `P${id}`, product_name: `상품${id}`,
    option_text: null, quantity: 1, buyer_name: null, receiver_name: null, receiver_phone: null,
    receiver_address: null, paid_at: null, channel_status: 'PAYED', channel_confirmed: 0, ...extra,
  };
}
const orders = n => Array.from({ length: n }, (_, i) => order(i + 1));

function setup({ threshold = 5 } = {}) {
  const db = openDb(':memory:');
  db.prepare("UPDATE settings SET value = ? WHERE key = 'unassigned_threshold'").run(String(threshold));
  const hub = fakeHub();
  let clock = 0;
  const notifier = createNotifier({ db, hub, now: () => clock });
  const alerts = () => hub.sent.filter(s => s.event === 'notify' && s.data.type === 'unassigned_over');
  return { db, hub, notifier, alerts, tick: minutes => { clock += minutes * 60 * 1000; } };
}

// ───────── 미지정 초과 ─────────

test('미지정이 기준 건수 이하면 알리지 않고, 넘는 순간 한 번 알린다', () => {
  const { db, notifier, alerts } = setup({ threshold: 5 });
  applyOrders(db, orders(5));
  notifier.checkUnassigned();
  assert.strictEqual(alerts().length, 0, '5건은 기준(5건)을 넘지 않음');

  applyOrders(db, [order(6)]);
  notifier.checkUnassigned();
  notifier.checkUnassigned();
  assert.strictEqual(alerts().length, 1, '6건이 되는 순간 한 번만');
  assert.match(alerts()[0].data.body, /6건/);
});

test('해소될 때까지 30분마다 다시 알리고, 해소되면 처음부터 다시 센다', () => {
  const { db, notifier, alerts, tick } = setup({ threshold: 2 });
  applyOrders(db, orders(3));
  notifier.checkUnassigned();
  tick(29);
  notifier.checkUnassigned();
  assert.strictEqual(alerts().length, 1);
  tick(1);
  notifier.checkUnassigned();
  assert.strictEqual(alerts().length, 2, '30분 지나면 다시');

  // 담당자를 지정해 해소
  const designer = addUser(db, { email: 'd@broad.test' });
  db.prepare('UPDATE orders SET assignee_id = ?').run(designer);
  notifier.checkUnassigned();
  db.prepare("UPDATE orders SET assignee_id = NULL WHERE channel_item_id IN ('P1','P2','P3')").run();
  tick(1);
  notifier.checkUnassigned();
  assert.strictEqual(alerts().length, 3, '해소 후 다시 넘으면 30분을 기다리지 않고 바로');
});

test('마지막 단계(발송)에 있는 주문은 미지정으로 세지 않는다', () => {
  const { db, notifier } = setup();
  applyOrders(db, orders(3));
  const last = db.prepare("SELECT id FROM work_stages WHERE name = '발송'").get().id;
  db.prepare("UPDATE orders SET stage_id = ? WHERE channel_item_id = 'P1'").run(last);
  assert.strictEqual(notifier.unassignedCount(), 2);
});

test('미지정 알림은 관리자와 지정한 직원만 받는다 (정지된 계정 제외)', () => {
  const { db, notifier, alerts } = setup({ threshold: 1 });
  const admin = addUser(db, { email: 'a@broad.test', role: 'admin' });
  const picked = addUser(db, { email: 'p@broad.test' });
  const other = addUser(db, { email: 'o@broad.test' });
  const gone = addUser(db, { email: 'g@broad.test', role: 'admin', status: 'suspended' });
  db.prepare("UPDATE settings SET value = ? WHERE key = 'unassigned_recipients'").run(JSON.stringify([picked]));
  applyOrders(db, orders(2));
  notifier.checkUnassigned();
  const can = alerts()[0].canReceive;
  assert.deepStrictEqual([admin, picked, other, gone].map(can), [true, true, false, false]);
});

// ───────── 신규 발주, 가입 신청 ─────────

test('수집 결과 새 주문이 있으면 전 직원에게 신규 발주 알림과 목록 갱신 신호를 보낸다', () => {
  const { db, hub, notifier } = setup({ threshold: 99 });
  const staff = addUser(db, { email: 's@broad.test' });
  const result = applyOrders(db, orders(4));
  notifier.afterCollect({ ok: true, ...result });

  const notify = hub.sent.find(s => s.event === 'notify');
  assert.strictEqual(notify.data.type, 'new_order');
  assert.strictEqual(notify.data.title, '신규 발주 4건');
  assert.match(notify.data.body, /상품1, 상품2, 상품3 외 1건/);
  assert.ok(notify.canReceive(staff));
  assert.ok(hub.sent.some(s => s.event === 'orders-changed'));
});

test('수집에 새 주문이 없으면 신규 발주 알림을 보내지 않는다', () => {
  const { hub, notifier } = setup();
  notifier.afterCollect({ ok: true, created: 0, updated: 0, createdIds: [] });
  notifier.afterCollect({ ok: false, error: 'x' });
  assert.strictEqual(hub.sent.filter(s => s.event === 'notify').length, 0);
});

test('가입 신청 알림은 관리자만 받고 기록이 남는다', () => {
  const { db, hub, notifier } = setup();
  const admin = addUser(db, { email: 'a@broad.test', role: 'admin' });
  const staff = addUser(db, { email: 's@broad.test' });
  notifier.signup({ name: '신입', email: 'new@broad.test' });
  const sent = hub.sent.find(s => s.data.type === 'signup');
  assert.deepStrictEqual([admin, staff].map(sent.canReceive), [true, false]);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'signup'").get().n, 1);
});

// ───────── 실제 연결 (SSE) ─────────

// /events 에 연결해서 들어오는 소식을 모은다
async function listen(b, baseUrl) {
  const controller = new AbortController();
  const res = await fetch(baseUrl + '/events', { headers: { cookie: b.cookie() }, signal: controller.signal });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const event = /^event: (.+)$/m.exec(chunk);
          const data = /^data: (.+)$/m.exec(chunk);
          if (event && data) events.push({ event: event[1], data: JSON.parse(data[1]) });
        }
      }
    } catch { /* 연결 종료 */ }
    events.closed = true;
  })();
  const waitFor = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = events.find(pred);
      if (found) return found;
      await new Promise(r => setTimeout(r, 20));
    }
    return null;
  };
  return { res, events, waitFor, close: () => { controller.abort(); return pump; } };
}

async function liveSetup(t) {
  const ctx = await startServer();
  const closers = [];
  t.after(async () => {
    for (const c of closers) await c();
    ctx.server.closeAllConnections();
    ctx.server.close();
  });
  const designerJob = ctx.db.prepare("SELECT id FROM jobs WHERE name = '디자이너'").get().id;
  ctx.kimId = addUser(ctx.db, { email: 'kim@broad.test', name: '김디자' });
  ctx.leeId = addUser(ctx.db, { email: 'lee@broad.test', name: '이디자' });
  ctx.adminId = addUser(ctx.db, { email: 'boss@broad.test', role: 'admin', name: '대표' });
  ctx.db.prepare('UPDATE users SET job_id = ? WHERE id IN (?, ?)').run(designerJob, ctx.kimId, ctx.leeId);
  applyOrders(ctx.db, orders(2));
  ctx.listen = async b => { const l = await listen(b, ctx.baseUrl); closers.push(l.close); return l; };
  return ctx;
}

test('한 직원이 담당자를 바꾸면 다른 직원 화면에 실시간으로 알려진다', async t => {
  const { db, baseUrl, listen, leeId } = await liveSetup(t);
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const lee = await loginAs(baseUrl, 'lee@broad.test');
  const leeLive = await listen(lee);
  assert.strictEqual(leeLive.res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const id = db.prepare("SELECT id FROM orders WHERE channel_item_id = 'P1'").get().id;
  await kim.submit('/', `/orders/${id}/assign`, { assignee_id: String(leeId), back: '/' });

  const got = await leeLive.waitFor(e => e.event === 'orders-changed');
  assert.ok(got, '이디자 화면에 소식이 와야 한다');
  assert.deepStrictEqual(got.data.ids, [id]);
});

test('가입 신청이 들어오면 관리자 화면에만 알림이 뜬다', async t => {
  const { baseUrl, listen } = await liveSetup(t);
  const adminLive = await listen(await loginAs(baseUrl, 'boss@broad.test'));
  const staffLive = await listen(await loginAs(baseUrl, 'kim@broad.test'));

  await browser(baseUrl).submit('/signup', '/signup', {
    email: 'new@broad.test', name: '신입', password: 'password123', password_confirm: 'password123',
  });

  assert.ok(await adminLive.waitFor(e => e.data.type === 'signup'));
  assert.strictEqual(await staffLive.waitFor(e => e.data.type === 'signup', 300), null);
});

test('승인 대기 계정은 실시간 통로에 연결할 수 없다', async t => {
  const { db, baseUrl } = await liveSetup(t);
  addUser(db, { email: 'wait@broad.test', status: 'pending' });
  const b = await loginAs(baseUrl, 'wait@broad.test');
  const res = await fetch(baseUrl + '/events', { headers: { cookie: b.cookie() }, redirect: 'manual' });
  assert.strictEqual(res.status, 302);
});

test('계정을 정지하면 실시간 연결도 바로 끊긴다', async t => {
  const { baseUrl, listen, kimId } = await liveSetup(t);
  const kimLive = await listen(await loginAs(baseUrl, 'kim@broad.test'));
  const admin = await loginAs(baseUrl, 'boss@broad.test');
  await admin.submit('/admin/users', `/admin/users/${kimId}/suspend`, {});
  const end = Date.now() + 2000;
  while (!kimLive.events.closed && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.ok(kimLive.events.closed);
});

test('관리자가 미지정 기준 건수·간격·받는 사람을 바꿀 수 있다', async t => {
  const { db, baseUrl, kimId } = await liveSetup(t);
  const admin = await loginAs(baseUrl, 'boss@broad.test');
  const page = await admin.request('/admin/notify');
  assert.match(page.text, /지금 미지정 주문은 <strong>2건/);

  await admin.submit('/admin/notify', '/admin/notify', { threshold: '8', repeat_minutes: '15', recipients: String(kimId) });
  const value = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key).value;
  assert.deepStrictEqual([value('unassigned_threshold'), value('unassigned_repeat_minutes'), value('unassigned_recipients')], ['8', '15', `[${kimId}]`]);

  await admin.submit('/admin/notify', '/admin/notify', { threshold: '0', repeat_minutes: '15' });
  assert.strictEqual(value('unassigned_threshold'), '8', '0건은 거부');
});

test('미지정이 기준을 넘으면 받는 사람 화면 위쪽에 배너가 계속 보인다', async t => {
  const { db, baseUrl } = await liveSetup(t);
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'unassigned_threshold'").run();
  const admin = await loginAs(baseUrl, 'boss@broad.test');
  const staff = await loginAs(baseUrl, 'kim@broad.test');
  assert.match((await admin.request('/')).text, /담당 디자이너가 없는 주문이 <strong>2건/);
  assert.ok(!(await staff.request('/')).text.includes('unassigned-bar'), '받는 사람으로 지정되지 않은 직원에게는 안 보임');

  db.prepare("UPDATE settings SET value = '5' WHERE key = 'unassigned_threshold'").run();
  assert.ok(!(await admin.request('/')).text.includes('unassigned-bar'), '기준 아래로 내려가면 사라짐');
});
