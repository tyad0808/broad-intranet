// 자사몰 증빙(세금계산서·현금영수증): 자사몰 API evidence → order_evidence → 주문 목록 꼬리표·모아보기·상세 칸·홈
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createGodoSource, evidenceOf, normalize } = require('../src/channels/godo');
const { createCollector } = require('../src/collector');
const { startServer, addUser, loginAs } = require('./helpers');

const QUOTE = 'https://quote.broadstore.co.kr';

function mallOrder(no, evidence) {
  return {
    orderNo: `26110812000${no}`, status: 'g1', statusName: '상품준비중',
    orderedAt: '2026-11-08 10:00:00', paidAt: '2026-11-08 10:01:00', modifiedAt: '2026-11-08 10:01:00',
    orderer: { name: `손님${no}` }, receiver: { name: `손님${no}` },
    items: [{ itemNo: 1, type: 'goods', status: 'g1', goodsNo: 1, name: `포맥스 안내판 ${no}`, quantity: 1, amount: 50000 }],
    ...(evidence === undefined ? {} : { evidence }),
  };
}
const taxRequested = { type: 'tax_invoice', requestedAt: '2026-11-08T14:20:00+09:00', taxInvoice: { status: 'requested', issuedAt: null, url: `${QUOTE}/?mallOrder=261108120001` }, cashReceipt: null };

test('evidence 칸 정리: 상태 값만, 견적 도구 주소가 아닌 링크는 버림, 칸이 없으면 건드리지 않음(undefined)', () => {
  assert.deepStrictEqual(evidenceOf(mallOrder(1, taxRequested)), {
    type: 'tax_invoice', requested_at: '2026-11-08T14:20:00+09:00', tax_status: 'requested', tax_issued_at: null,
    tax_url: `${QUOTE}/?mallOrder=261108120001`, cash_use: null, cash_status: null, cash_issued_at: null,
  });
  const bad = u => evidenceOf(mallOrder(1, { ...taxRequested, taxInvoice: { status: 'requested', url: u } })).tax_url;
  assert.strictEqual(bad('https://evil.example.com/?mallOrder=1'), null, '다른 사이트');
  assert.strictEqual(bad('http://quote.broadstore.co.kr/?mallOrder=1'), null, 'https 만');
  assert.strictEqual(bad('javascript:alert(1)'), null);
  const cash = evidenceOf(mallOrder(2, { type: 'cash_receipt', requestedAt: '2026-11-08 09:00:00', taxInvoice: null, cashReceipt: { use: 'income', status: 'issued', issuedAt: '2026-11-08 09:30:00' } }));
  assert.deepStrictEqual([cash.type, cash.cash_use, cash.cash_status, cash.cash_issued_at, cash.requested_at], ['cash_receipt', 'income', 'issued', '2026-11-08T09:30:00+09:00', '2026-11-08T09:00:00+09:00']);
  assert.strictEqual(evidenceOf(mallOrder(3, { type: '???', cashReceipt: { status: 'weird' } })).type, null, '모르는 값은 버림');
  assert.strictEqual(evidenceOf(mallOrder(3)), undefined, '예전 API (칸 없음)');
  assert.strictEqual(evidenceOf(mallOrder(3, null)).type, null, '신청 안 함');
  assert.ok(!('evidence' in normalize(mallOrder(3))[0]), '칸이 없으면 주문 줄에도 안 붙인다');
});

async function collectInto(db, orders) {
  const fetchFn = async () => new Response(JSON.stringify({ total: orders.length, page: 1, size: 100, items: orders }), { status: 200 });
  const collector = createCollector({ db, source: createGodoSource({ apiKey: 'k', fetchFn }) });
  const r = await collector.run();
  assert.strictEqual(r.ok, true, r.error);
}

test('수집하면 주문번호마다 저장되고, 견적 도구에서 발행하면 다음 수집에 발행됨으로 (예전 API 는 값을 지우지 않음)', async () => {
  const db = openDb(':memory:');
  await collectInto(db, [mallOrder(1, taxRequested), mallOrder(2, null)]);
  const ev = no => db.prepare('SELECT type, tax_status, tax_url FROM order_evidence WHERE channel = ? AND channel_order_id = ?').get('godo', `26110812000${no}`);
  assert.deepStrictEqual({ ...ev(1) }, { type: 'tax_invoice', tax_status: 'requested', tax_url: `${QUOTE}/?mallOrder=261108120001` });
  assert.strictEqual(ev(2).type, null);
  await collectInto(db, [mallOrder(1, { ...taxRequested, taxInvoice: { ...taxRequested.taxInvoice, status: 'issued', issuedAt: '2026-11-08T15:00:00+09:00' } })]);
  assert.strictEqual(ev(1).tax_status, 'issued');
  await collectInto(db, [mallOrder(1)]);
  assert.strictEqual(ev(1).tax_status, 'issued', 'evidence 칸이 없는 응답은 저장된 값을 그대로 둔다');
});

test('화면: 목록 꼬리표·계산서 발행 대기 모아보기·상세 [계산서 발행하기]·홈 줄, 발행되면 [계산서 보기]', async t => {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  const { db, baseUrl } = ctx;
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const cash = { type: 'cash_receipt', requestedAt: '2026-11-08T09:00:00+09:00', taxInvoice: null, cashReceipt: { use: 'income', status: 'issued', issuedAt: '2026-11-08T09:30:00+09:00' } };
  await collectInto(db, [mallOrder(1, taxRequested), mallOrder(2, cash), mallOrder(3, null)]);
  const kim = await loginAs(baseUrl, 'kim@broad.test');

  const list = (await kim.request('/?view=all')).text;
  assert.match(list, /<span class="ev-badge req">세금계산서 · 발행 전<\/span>/);
  assert.match(list, /<span class="ev-badge cash">현금영수증 · 소득공제 발급됨<\/span>/);
  assert.match(list, /계산서 발행 대기 <span class="count">1<\/span>/);
  const pending = (await kim.request('/?alert=evidence')).text;
  assert.strictEqual((pending.match(/class="oi-main"/g) || []).length, 1);
  assert.match(pending, /포맥스 안내판 1/);

  const id = no => db.prepare("SELECT id FROM orders WHERE channel_order_id = ? AND item_type = 'main'").get(`26110812000${no}`).id;
  const detail = (await kim.request(`/orders/${id(1)}`)).text;
  assert.match(detail, /세금계산서 <span class="ev-badge req">발행 전<\/span>/);
  assert.match(detail, /href="https:\/\/quote\.broadstore\.co\.kr\/\?mallOrder=261108120001" target="_blank" rel="noopener">계산서 발행하기 ↗/);
  assert.match((await kim.request(`/orders/${id(2)}`)).text, /현금영수증 <span class="ev-badge cash">발급됨<\/span>[\s\S]*<dd>소득공제<\/dd>/);
  assert.doesNotMatch((await kim.request(`/orders/${id(3)}`)).text, /ev-card/, '신청 안 한 주문은 칸이 없다');
  assert.match((await kim.request('/home')).text, /href="\/\?alert=evidence">세금계산서 발행 대기 <strong>1<\/strong>건/);

  await collectInto(db, [mallOrder(1, { ...taxRequested, taxInvoice: { ...taxRequested.taxInvoice, status: 'issued', issuedAt: '2026-11-08T15:00:00+09:00' } })]);
  const after = (await kim.request(`/orders/${id(1)}`)).text;
  assert.match(after, /세금계산서 <span class="ev-badge done">발행됨<\/span>/);
  assert.match(after, />계산서 보기 ↗/);
  assert.doesNotMatch((await kim.request('/?view=all')).text, /계산서 발행 대기/, '0건이면 칩을 숨긴다');
  assert.doesNotMatch((await kim.request('/home')).text, /세금계산서 발행 대기/);
});
