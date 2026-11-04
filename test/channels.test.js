// 관리자 › 판매처 연결: 스마트스토어·쿠팡 키를 화면에서 (DB 에 암호화), 바로 수집·처리·문의에 반영, '실제로 보내기' 스위치
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createSecretBox } = require('../src/secretBox');
const { createChannelRegistry } = require('../src/channelRegistry');
const { createChannelCollector } = require('../src/collector');
const { createOrderActions } = require('../src/actions');
const { startServer, addUser, loginAs } = require('./helpers');

const KEY = 'e'.repeat(64);
// 가짜 판매처: 비밀 키가 'good…' 로 시작하면 연결 시험 성공
const fake = ch => ({
  client: (k, write) => ({ k, write }),
  source: k => ({ channel: ch, label: ch, keys: k }),
  writer: k => ({ writer: ch, keys: k }),
  qnaSource: k => ({ source: `${ch}_qna`, label: `${ch} 문의`, keys: k }),
  qnaSender: k => ({ sender: ch, keys: k }),
  test: async client => {
    const secret = client.k.clientSecret || client.k.secretKey;
    if (!String(secret).startsWith('good')) throw Object.assign(new Error('401 Unauthorized'), { status: 401 });
  },
});
function setup({ env = {}, db = openDb(':memory:'), key = KEY } = {}) {
  const adminId = addUser(db, { email: `boss${Math.random()}@broad.test`, role: 'admin' });
  const collectors = [{ source: { channel: 'godo', label: '자사몰' } }];
  const actions = createOrderActions({ db });
  const inbox = { sourceLabels: {}, senders: { godo_qna: {} }, collectorSources: [{ source: 'godo_qna' }] };
  const registry = createChannelRegistry({
    db, box: createSecretBox(key), env, collectors, actions, inbox,
    makeCollector: source => ({ source }),
    factories: { smartstore: fake('smartstore'), coupang: fake('coupang') },
  });
  registry.apply();
  return { db, registry, collectors, actions, inbox, admin: { id: adminId } };
}

test('키 저장: 연결 시험이 되어야 저장, 비밀 키는 암호화·끝 4자리만, 바로 주문 수집·문의 받기에 들어가고 처리는 연습 모드', async () => {
  const { db, registry, collectors, actions, inbox } = setup();
  const bad = await registry.save('smartstore', { clientId: 'app1', clientSecret: 'wrong' }, 1);
  assert.match(bad.error, /키를 거절/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM channel_keys').get().n, 0);
  assert.match((await registry.save('smartstore', { clientId: 'app1' }, 1)).error, /시크릿을\(를\) 넣어/);
  assert.match((await registry.save('nope', {}, 1)).error, /찾을 수 없/);

  assert.deepStrictEqual(await registry.save('smartstore', { clientId: ' app1 ', clientSecret: 'goodSecret1234' }, 1), { ok: true });
  const row = db.prepare("SELECT * FROM channel_keys WHERE channel = 'smartstore'").get();
  assert.ok(!row.secret_sealed.includes('goodSecret') && !row.public_json.includes('goodSecret'), '비밀 키는 암호로만');
  const v = registry.view().find(c => c.channel === 'smartstore');
  assert.deepStrictEqual([v.values.clientId, v.tails.clientSecret, v.saved, v.enabled, Boolean(v.testOkAt)], ['app1', '1234', true, true, true]);
  assert.deepStrictEqual(collectors.map(c => c.source.channel), ['godo', 'smartstore'], '자사몰은 그대로, 스마트스토어 더함');
  assert.strictEqual(collectors[1].source.keys.clientSecret, 'goodSecret1234');
  assert.deepStrictEqual(inbox.collectorSources.map(s => s.source), ['godo_qna', 'smartstore_qna'], '문의 받기도');
  assert.strictEqual(inbox.sourceLabels.smartstore_qna, '스마트스토어');
  assert.ok(!inbox.senders.smartstore_qna, '답변은 연습 모드');
  assert.strictEqual(actions.modes.smartstore, 'practice');

  // 비밀 키 칸을 비우고 저장하면 저장된 값 그대로 (ID 만 바꾸기)
  assert.deepStrictEqual(await registry.save('smartstore', { clientId: 'app2', clientSecret: '' }, 1), { ok: true });
  assert.strictEqual(collectors.find(c => c.source.channel === 'smartstore').source.keys.clientSecret, 'goodSecret1234');
  assert.strictEqual(collectors.filter(c => c.source.channel === 'smartstore').length, 1, '바꿔도 하나만');
});

test('실제로 보내기: 연결 시험 성공 + 관리자 비밀번호가 맞아야 켜지고, 끄기는 바로, 기록이 남는다', async () => {
  const { registry, actions, inbox, admin, db } = setup();
  assert.match(registry.switchOn('smartstore', 'write', 'password123', admin).error, /먼저 키를/);
  await registry.save('smartstore', { clientId: 'app1', clientSecret: 'goodSecret1234' }, admin.id);
  db.prepare("UPDATE channel_keys SET test_ok_at = NULL WHERE channel = 'smartstore'").run();
  assert.match(registry.switchOn('smartstore', 'write', 'password123', admin).error, /연결 시험에 성공/);
  db.prepare("UPDATE channel_keys SET test_ok_at = datetime('now') WHERE channel = 'smartstore'").run();
  assert.match(registry.switchOn('smartstore', 'write', 'wrongpass', admin).error, /비밀번호가 맞지 않/);
  assert.match(registry.switchOn('smartstore', 'write', 'password123', { id: 999 }).error, /비밀번호가 맞지 않/, '다른 사람·없는 사람');
  assert.strictEqual(actions.modes.smartstore, 'practice');

  assert.deepStrictEqual(registry.switchOn('smartstore', 'write', 'password123', admin), { ok: true });
  assert.strictEqual(actions.modes.smartstore, 'live', '발주확인·발송처리 실제로');
  assert.deepStrictEqual(registry.switchOn('smartstore', 'answer', 'password123', admin), { ok: true });
  assert.strictEqual(inbox.senders.smartstore_qna.sender, 'smartstore', '문의 답변 실제로');

  registry.switchOff('smartstore', 'write', admin.id);
  assert.strictEqual(actions.modes.smartstore, 'practice');
  // 수집을 끄면 실제로 보내기도 함께 꺼지고, 다시 켜도 꺼진 채
  registry.setEnabled('smartstore', false, admin.id);
  assert.ok(!inbox.senders.smartstore_qna);
  registry.setEnabled('smartstore', true, admin.id);
  assert.deepStrictEqual(registry.view().find(c => c.channel === 'smartstore').on, { write: false, answer: false });
  assert.deepStrictEqual(registry.history().map(h => h.action).slice(0, 4), ['수집 켬', '수집 끔', '연습 모드로: 발주확인 · 발송처리', '실제로 켬: 상품 문의 답변']);
});

test('쿠팡: WING 아이디가 있어야 문의 답변을 켤 수 있다, 지우면 수집·처리에서 빠진다(가져온 것은 그대로)', async () => {
  const { registry, collectors, actions, inbox, admin } = setup();
  await registry.save('coupang', { vendorId: 'A001', accessKey: 'ak12', secretKey: 'goodsk5678' }, admin.id);
  assert.match(registry.switchOn('coupang', 'answer', 'password123', admin).error, /WING/);
  assert.deepStrictEqual(registry.switchOn('coupang', 'write', 'password123', admin), { ok: true });
  assert.strictEqual(actions.modes.coupang, 'live');
  registry.remove('coupang', admin.id);
  assert.ok(!collectors.some(c => c.source.channel === 'coupang'));
  assert.ok(!inbox.collectorSources.some(s => s.source === 'coupang_qna'));
  assert.strictEqual(actions.modes.coupang, 'practice');
  assert.ok(!registry.view().find(c => c.channel === 'coupang').saved);
});

test('.env 에 키가 있는 판매처는 서버 설정: 화면에서 못 바꾸고 수집기를 건드리지 않음, 열쇠가 바뀌면 다시 넣으라고', async () => {
  const env = { ORDER_SOURCE: 'naver', NAVER_CLIENT_ID: 'x', NAVER_CLIENT_SECRET: 'y', NAVER_WRITE: 'on' };
  const { registry, collectors, admin } = setup({ env });
  assert.match((await registry.save('smartstore', { clientId: 'a', clientSecret: 'goodS' }, admin.id)).error, /서버 설정/);
  assert.match(registry.switchOn('smartstore', 'write', 'password123', admin).error, /바꿀 수 없는/);
  const v = registry.view().find(c => c.channel === 'smartstore');
  assert.deepStrictEqual([v.fromEnv, v.on.write, v.on.answer], [true, true, false]);
  assert.deepStrictEqual(collectors.map(c => c.source.channel), ['godo']);

  const db = openDb(':memory:');
  const first = setup({ db });
  await first.registry.save('coupang', { vendorId: 'A001', accessKey: 'ak12', secretKey: 'goodsk5678' }, first.admin.id);
  const moved = setup({ db, key: 'f'.repeat(64) });
  const c = moved.registry.view().find(x => x.channel === 'coupang');
  assert.strictEqual(c.locked, true);
  assert.ok(!moved.collectors.some(x => x.source.channel === 'coupang'), '못 푸는 키로는 수집하지 않음');
  assert.match((await moved.registry.test('coupang', 1)).error, /풀 수 없/);
});

test('수집기 묶음: 판매처가 없으면 안내만, 목록을 바꾸면 다음 수집부터 · 처리 모드는 화면이 보는 같은 물건에서 바뀐다', async () => {
  const list = [];
  const multi = createChannelCollector(list);
  assert.strictEqual(multi.isEmpty(), true);
  assert.match((await multi.run()).error, /판매처가 없어요/);
  assert.strictEqual(multi.source.label, '연결된 판매처 없음');
  list.push({ source: { label: '쿠팡' }, run: async () => ({ ok: true, created: 2, createdOrders: 1, updated: 0, archived: 0, createdIds: [1], claims: [] }) });
  assert.strictEqual(multi.source.label, '쿠팡');
  assert.strictEqual((await multi.run()).created, 2);

  const actions = createOrderActions({ db: openDb(':memory:') });
  const modes = actions.modes;
  actions.setWriter('coupang', { confirm() {} });
  assert.strictEqual(modes.coupang, 'live');
  actions.setWriter('coupang', null);
  assert.strictEqual(modes.coupang, 'practice');
});

test('관리자 › 판매처 연결 화면: 관리자만, 키 넣기·끝 4자리, 켤 때 비밀번호 칸, 틀리면 안내', async t => {
  const s = setup();
  const ctx = await startServer({ db: s.db, actions: s.actions, channelRegistry: s.registry });
  t.after(() => ctx.server.close());
  addUser(s.db, { email: 'boss@broad.test', role: 'admin', name: '사장' });
  addUser(s.db, { email: 'kim@broad.test', name: '김직원' });
  const boss = await loginAs(ctx.baseUrl, 'boss@broad.test');
  const kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  assert.notStrictEqual((await kim.request('/admin/channels')).status, 200, '직원은 못 봄');

  const page = (await boss.request('/admin/channels')).text;
  assert.match(page, /href="\/admin\/channels" class="chip on">판매처 연결/);
  assert.match(page, /● 연결 안 됨/);
  assert.match(page, /먼저 키를 넣고 수집을 켜 주세요/);

  await boss.submit('/admin/channels', '/admin/channels/smartstore/save', { clientId: 'app1', clientSecret: 'goodSecret1234' });
  const saved = (await boss.request('/admin/channels')).text;
  assert.match(saved, /끝 4자리 1234/);
  assert.ok(!saved.includes('goodSecret'), '비밀 키는 화면에 없음');
  assert.match(saved, /<summary class="btn-sm sw-on">실제로 켜기<\/summary>/);
  assert.match(saved, /name="password" required/);

  await boss.submit('/admin/channels', '/admin/channels/smartstore/switch', { kind: 'write', on: '1', password: 'nope' });
  assert.match((await boss.request('/admin/channels')).text, /관리자 비밀번호가 맞지 않아요/);
  await boss.submit('/admin/channels', '/admin/channels/smartstore/switch', { kind: 'write', on: '1', password: 'password123' });
  const live = (await boss.request('/admin/channels')).text;
  assert.match(live, /<span class="sw-state live">실제로 보냄<\/span>/);
  assert.match(live, /<strong>실제로 켬: 발주확인 · 발송처리<\/strong>/);
  assert.strictEqual(s.actions.modes.smartstore, 'live');
});

test('개발용 가짜 주문 수집기는 키가 없으면 그대로, 화면에서 키를 넣으면 실제 스마트스토어로 바뀐다', async () => {
  const s = setup();
  const mock = { source: { channel: 'smartstore', label: '스마트스토어 (가짜 주문)', isMock: true } };
  s.collectors.push(mock);
  s.registry.apply();
  assert.ok(s.collectors.includes(mock), '키가 없으면 건드리지 않음');
  await s.registry.save('smartstore', { clientId: 'app1', clientSecret: 'goodSecret1234' }, s.admin.id);
  assert.ok(!s.collectors.includes(mock));
  assert.strictEqual(s.collectors.filter(c => c.source.channel === 'smartstore').length, 1);
});
