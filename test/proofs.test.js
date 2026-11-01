// 시안확정서·작업지시서: 옵션 정리, 시안 올리기, 출력실용 작업지시서
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { applyOrders } = require('../src/collector');
const { cleanLabel, addonLines, guessMaterial, guessSize, customerRequests, dueView, createProofs } = require('../src/proofs');
const { startServer, addUser, loginAs } = require('./helpers');

// 아주 작은 진짜 PNG (1×1)
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

test('옵션 항목 이름에서 번호·★·미선택 안내를 지운다', () => {
  assert.strictEqual(cleanLabel('④ 디자인 작업 의뢰'), '디자인 작업 의뢰');
  assert.strictEqual(cleanLabel('★볼터치 무료옵션★'), '볼터치 무료옵션');
  assert.strictEqual(cleanLabel('모양재단(미선택경우 사각재단)'), '모양재단');
  assert.strictEqual(cleanLabel('문구 변경 및 파일접수 (필수입력)'), '문구 변경 및 파일접수');
  assert.strictEqual(cleanLabel('고급헤라(무료이벤트)'), '고급헤라(무료이벤트)');
});

test('추가옵션은 "값 × 수량 · 항목" 으로, 선택안함은 숨긴다', () => {
  const lines = addonLines([
    { item_type: 'main', product_name: '등신대', option_text: null, quantity: 1 },
    { item_type: 'addon', product_name: '볼터치작업', option_text: '★볼터치 무료옵션★: 볼터치작업', quantity: 1 },
    { item_type: 'addon', product_name: '선택안함', option_text: '거치대 추가: 선택안함', quantity: 1 },
    { item_type: 'addon', product_name: '제공', option_text: '무료 양면테이프(미신청 시 미제공): 제공', quantity: 3 },
  ]);
  assert.deepStrictEqual(lines, [
    { value: '볼터치작업', label: '볼터치 무료옵션', qty: 1 },
    { value: '제공', label: '무료 양면테이프', qty: 3 },
  ]);
});

test('소재는 옵션의 소재 항목 → 상품 이름 순서로 짐작한다', () => {
  assert.strictEqual(guessMaterial({ product_name: '시트지', option_text: '소재 선택: PVC 캘지(백색) / 긴쪽 사이즈 선택: 5~20cm' }), 'PVC 캘지(백색)');
  assert.strictEqual(guessMaterial({ product_name: '실물 등신대 입간판 포맥스3T 1인 120x60cm', option_text: '등신대 키 선택: ~180cm' }), '포맥스 3T');
  assert.strictEqual(guessMaterial({ product_name: '현수막 주문제작', option_text: null }), '현수막');
  assert.strictEqual(guessMaterial({ product_name: '명함', option_text: null }), '');
});

test('사이즈는 단위가 붙은 정확한 크기만 짐작한다 (가격 구간은 건너뜀, mm 는 cm 로)', () => {
  assert.deepStrictEqual(guessSize({ product_name: '출산 현수막', option_text: '디자인선택: 출산세트형 / 사이즈선택: 90x120(cm)' }), { long: '120', short: '90' });
  assert.deepStrictEqual(guessSize({ product_name: 'UV 출력', option_text: '포맥스 선택: 백색 포맥스  3T / 420x594mm' }), { long: '59.4', short: '42' });
  assert.deepStrictEqual(guessSize({ product_name: '시트지', option_text: '긴쪽 사이즈 선택: 81~100cm / 짧은쪽 사이즈 선택: 5~20cm' }), { long: '', short: '' });
  assert.deepStrictEqual(guessSize({ product_name: '전단지 A5(14.8x21cm) 50매', option_text: null }), { long: '21', short: '14.8' });
});

test('고객 요청 = 배송 메시지 + 옵션의 요청 항목', () => {
  const items = [{ ship_memo: '문 앞에 두세요', option_text: '디자인: A03 / 추가 요청사항: 글씨 크게' }, { ship_memo: null, option_text: '추가 요청사항: .' }];
  assert.deepStrictEqual(customerRequests(items), ['문 앞에 두세요', '추가 요청사항: 글씨 크게']);
});

test('납기 D-day: 오늘·내일은 빨강, 납기가 없으면 채널 발송기한', () => {
  const now = new Date('2026-11-01T03:00:00Z'); // 한국 11/1 낮
  assert.deepStrictEqual(dueView({ due_date: '2026-11-02' }, [], now), { date: '2026-11-02', from: '납기', text: '11/2 (월)', dday: 'D-1', hot: true });
  assert.strictEqual(dueView({ due_date: '2026-11-01' }, [], now).dday, 'D-day');
  assert.strictEqual(dueView({ due_date: '2026-11-05' }, [], now).hot, false);
  assert.strictEqual(dueView({ due_date: '2026-10-30' }, [], now).dday, 'D+2 지남');
  const v = dueView({ due_date: null }, [{ channel_status: 'PAYED', ship_due: '2026-11-03T06:00:00.000Z' }], now);
  assert.strictEqual(v.from, '발송기한');
  assert.strictEqual(v.dday, 'D-2');
  assert.strictEqual(dueView({ due_date: null }, [], now), null);
});

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  const { db } = ctx;
  const designerJob = db.prepare("SELECT id FROM jobs WHERE name = '디자이너'").get().id;
  ctx.kimId = addUser(db, { email: 'kim@broad.test', name: '김디자' });
  db.prepare('UPDATE users SET job_id = ? WHERE id = ?').run(designerJob, ctx.kimId);
  applyOrders(db, [
    { channel: 'smartstore', channel_order_id: 'O1', channel_item_id: 'P1', product_name: '실물 등신대 입간판 포맥스3T 1인 120x60cm 거치대O', item_type: 'main',
      option_text: '등신대 키 선택: ~180cm / 거치대 선택: 거치대O', quantity: 1, buyer_name: '홍길동', receiver_name: '김길동', receiver_phone: '010-0000-0000',
      receiver_address: '서울', paid_at: new Date().toISOString(), channel_status: 'PAYED', channel_confirmed: 0, ship_memo: '거치대는 뒤쪽 가운데로' },
    { channel: 'smartstore', channel_order_id: 'O1', channel_item_id: 'P2', product_name: '볼터치작업', item_type: 'addon',
      option_text: '★볼터치 무료옵션★: 볼터치작업', quantity: 1, buyer_name: '홍길동', receiver_name: '김길동', receiver_phone: '010-0000-0000',
      receiver_address: '서울', paid_at: new Date().toISOString(), channel_status: 'PAYED', channel_confirmed: 0 },
  ]);
  ctx.id = db.prepare("SELECT id FROM orders WHERE channel_item_id = 'P1'").get().id;
  db.prepare('UPDATE orders SET assignee_id = ? WHERE channel_order_id = ?').run(ctx.kimId, 'O1');
  ctx.kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  // 주문 카드에서 CSRF 토큰을 얻어 시안 칸을 multipart 로 보낸다
  ctx.upload = async (fields, file) => {
    const page = await ctx.kim.request(`/orders/${ctx.id}`);
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
    const form = new FormData();
    form.append('_csrf', token);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (file) form.append('image', new Blob([file.data], { type: file.type || 'image/png' }), file.name || 'proof.png');
    const res = await fetch(`${ctx.baseUrl}/orders/${ctx.id}/proof`, { method: 'POST', body: form, redirect: 'manual', headers: { cookie: ctx.kim.cookie() } });
    return { status: res.status, location: res.headers.get('location') };
  };
  ctx.proof = () => db.prepare("SELECT * FROM proof_sheets WHERE channel_order_id = 'O1'").get();
  return ctx;
}

test('주문 카드에 시안 칸이 있다 (수정 횟수·배송방법만, 소재·사이즈 칸은 없음)', async t => {
  const { kim, id } = await setup(t);
  const page = await kim.request(`/orders/${id}`);
  assert.match(page.text, /시안 · 작업지시서/);
  assert.match(page.text, /name="revision"/);
  assert.match(page.text, /name="ship_method"/);
  assert.doesNotMatch(page.text, /name="material"|name="size_long"/);
  assert.doesNotMatch(page.text, /\/work-sheet/); // 시안을 올리기 전에는 작업지시서 버튼 없음
});

test('시안을 올리면 수정 0회, 다시 올리면 +1 되고 두 번 전 그림 파일은 지운다', async t => {
  const ctx = await setup(t);
  const r1 = await ctx.upload({ revision: '0', material: '포맥스 3T', size_long: '63', size_short: '160', ship_method: '택배' }, { data: PNG });
  assert.strictEqual(r1.status, 302);
  assert.match(r1.location, /#proof$/);
  const p1 = ctx.proof();
  assert.strictEqual(p1.revision, 0);
  assert.deepStrictEqual([p1.size_long, p1.size_short], ['160', '63']); // 긴 쪽 먼저로 바로잡음
  assert.ok(fs.existsSync(path.join(ctx.proofDir, p1.image_file)));

  const img = await fetch(`${ctx.baseUrl}/orders/${ctx.id}/proof/image`, { headers: { cookie: ctx.kim.cookie() } });
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');

  await ctx.upload({ revision: '0', material: '포맥스 3T', size_long: '160', size_short: '63', ship_method: '퀵서비스' }, { data: PNG });
  const p2 = ctx.proof();
  assert.strictEqual(p2.revision, 1);
  assert.strictEqual(p2.ship_method, '퀵서비스');
  assert.notStrictEqual(p2.image_file, p1.image_file);
  assert.ok(fs.existsSync(path.join(ctx.proofDir, p1.image_file))); // 바로 전 시안은 취소용으로 남김
  await ctx.upload({ revision: '1', material: '포맥스 3T', size_long: '160', size_short: '63', ship_method: '퀵서비스' }, { data: PNG });
  assert.strictEqual(ctx.proof().revision, 2);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!fs.existsSync(path.join(ctx.proofDir, p1.image_file)));
  const p2b = ctx.proof();

  // 그림 없이 저장하면 수정 횟수는 적은 그대로
  await ctx.upload({ revision: '3', material: '포맥스 5T', size_long: '160', size_short: '63', ship_method: '택배' });
  assert.strictEqual(ctx.proof().revision, 3);
  assert.strictEqual(ctx.proof().image_file, p2b.image_file);
});

test('그림이 아닌 파일·이상한 사이즈는 저장하지 않는다', async t => {
  const ctx = await setup(t);
  await ctx.upload({ revision: '0' }, { data: Buffer.from('%PDF-1.4 hello world'), type: 'application/pdf', name: 'a.pdf' });
  assert.strictEqual(ctx.proof(), undefined);
  await ctx.upload({ revision: '0', size_long: '큰거' }, { data: PNG });
  assert.strictEqual(ctx.proof(), undefined);
});

test('로그인하지 않으면 시안 그림·작업지시서를 볼 수 없다', async t => {
  const ctx = await setup(t);
  await ctx.upload({ revision: '0', size_long: '160', size_short: '63', material: '포맥스 3T', ship_method: '택배' }, { data: PNG });
  for (const p of [`/orders/${ctx.id}/proof/image`, `/orders/${ctx.id}/work-sheet`]) {
    const res = await fetch(ctx.baseUrl + p, { redirect: 'manual' });
    assert.notStrictEqual(res.status, 200);
  }
});

test('작업지시서: 고객이 주문한 그대로(상품·수량·옵션)·추가옵션·고객 요청, 빠진 값은 확인 필요', async t => {
  const ctx = await setup(t);
  await ctx.upload({ revision: '0', ship_method: '택배' }, { data: PNG });
  const res = await ctx.kim.request(`/orders/${ctx.id}/work-sheet`);
  assert.strictEqual(res.status, 200);
  for (const text of ['작업지시서', '스마트스토어', '홍길동', '김길동', 'O1', '김디자', '0회', '실물 등신대 입간판 포맥스3T 1인 120x60cm 거치대O <span class="qty">× 1</span>',
    '등신대 키 선택: ~180cm · 거치대 선택: 거치대O', '볼터치작업 × 1', '볼터치 무료옵션', '거치대는 뒤쪽 가운데로', '택배', '치수단위 cm', '/proof/image']) {
    assert.ok(res.text.includes(text), text);
  }
  assert.doesNotMatch(res.text, /소재·두께|사이즈 \(긴 쪽/); // 따로 모아 적는 칸은 없음
  assert.match(res.text, /납기일<\/div><div class="v"><span class="need">확인 필요/); // 납기·발송기한 없음
  const card = await ctx.kim.request(`/orders/${ctx.id}`);
  assert.match(card.text, /\/orders\/\d+\/work-sheet/);
});

test('지워진 주문·개인정보를 지운 주문의 시안은 정리한다', async t => {
  const ctx = await setup(t);
  await ctx.upload({ revision: '0' }, { data: PNG });
  const file = path.join(ctx.proofDir, ctx.proof().image_file);
  const proofs = createProofs({ db: ctx.db, dir: ctx.proofDir });
  assert.strictEqual(proofs.sweep(), 0);
  ctx.db.prepare("UPDATE orders SET pii_cleared_at = datetime('now') WHERE channel_order_id = 'O1'").run();
  assert.strictEqual(proofs.sweep(), 1);
  assert.strictEqual(ctx.proof(), undefined);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!fs.existsSync(file));
});

test('시안 취소: 바로 전 시안으로 되돌리고, 처음 올린 시안이면 지운다', async t => {
  const ctx = await setup(t);
  const cancel = async () => {
    const page = await ctx.kim.request(`/orders/${ctx.id}`);
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
    return ctx.kim.request(`/orders/${ctx.id}/proof/cancel`, { method: 'POST', form: { _csrf: token } });
  };
  await ctx.upload({ revision: '0', material: '포맥스 3T' }, { data: PNG });
  const first = ctx.proof().image_file;
  await ctx.upload({ revision: '0', material: '포맥스 3T' }, { data: PNG });
  const second = ctx.proof();
  assert.strictEqual(second.revision, 1);
  assert.strictEqual(second.prev_file, first);
  assert.ok(fs.existsSync(path.join(ctx.proofDir, first))); // 취소할 수 있게 남겨 둠
  assert.match((await ctx.kim.request(`/orders/${ctx.id}`)).text, /시안 취소 \(이전 시안으로\)/);

  const r = await cancel();
  assert.strictEqual(r.status, 302);
  const back = ctx.proof();
  assert.strictEqual(back.image_file, first);
  assert.strictEqual(back.revision, 0);
  assert.strictEqual(back.prev_file, null);
  await new Promise(res => setTimeout(res, 50));
  assert.ok(!fs.existsSync(path.join(ctx.proofDir, second.image_file)));

  await cancel(); // 이제 이전 시안이 없으니 지운다
  assert.strictEqual(ctx.proof().image_file, null);
  assert.strictEqual(ctx.proof().material, '포맥스 3T');
  const page = await ctx.kim.request(`/orders/${ctx.id}`);
  assert.doesNotMatch(page.text, /시안 취소/);
});

test('고객용 시안확정서 만들기: 빈 양식과 주문으로 미리 채운 양식', async t => {
  const ctx = await setup(t);
  const blank = await ctx.kim.request('/proof-maker');
  assert.strictEqual(blank.status, 200);
  assert.match(blank.text, /시안확정서 만들기/);
  assert.match(blank.text, /data-maker-canvas/);
  assert.match(blank.text, /031-822-7815/);
  assert.match(blank.text, /수정 횟수는 템플릿에 기재된 횟수입니다/); // 약관
  await ctx.upload({ revision: '2', material: '포맥스 3T', size_long: '160', size_short: '63', ship_method: '택배' }, { data: PNG });
  const filled = await ctx.kim.request(`/orders/${ctx.id}/proof-maker`);
  for (const text of ['value="홍길동"', 'value="김길동"', 'value="O1"', 'value="김디자"', 'value="2"', '실물 등신대 입간판 포맥스3T 1인 120x60cm 거치대O × 1\n등신대 키 선택: ~180cm · 거치대 선택: 거치대O', '볼터치작업 × 1 (볼터치 무료옵션)', '거치대는 뒤쪽 가운데로', '/proof/image']) {
    assert.ok(filled.text.includes(text), text);
  }
  // 데이터 칸에 < 가 그대로 들어가 스크립트가 끊기지 않게
  ctx.db.prepare("UPDATE orders SET ship_memo = '</script><b>x' WHERE channel_order_id = 'O1'").run();
  const evil = await ctx.kim.request(`/orders/${ctx.id}/proof-maker`);
  assert.ok(!evil.text.includes('</script><b>x'));
});

test('관리자: 시안확정서 연락처·약관을 바꾸고 처음 문구로 되돌린다', async t => {
  const ctx = await setup(t);
  addUser(ctx.db, { email: 'boss@broad.test', role: 'admin', name: '사장' });
  const boss = await loginAs(ctx.baseUrl, 'boss@broad.test');
  const page = await boss.request('/admin/brand');
  assert.match(page.text, /고객용 시안확정서/);
  const r = await boss.submit('/admin/brand', '/admin/brand/proof', {
    phone: '02-123-4567', term_title_0: '수정 안내', term_lines_0: '- 첫째 줄\n둘째 줄\n\n', term_title_1: '환불', term_lines_1: '환불 줄', term_title_2: '오탈자', term_lines_2: '',
  });
  assert.strictEqual(r.status, 302);
  const maker = await ctx.kim.request('/proof-maker');
  assert.match(maker.text, /02-123-4567/);
  assert.match(maker.text, /"title":"수정 안내","lines":\["첫째 줄","둘째 줄"\]/);
  const bad = await boss.submit('/admin/brand', '/admin/brand/proof', { phone: 'x'.repeat(40) });
  assert.strictEqual(bad.status, 302);
  assert.match((await ctx.kim.request('/proof-maker')).text, /02-123-4567/); // 잘못된 값은 저장 안 함
  await boss.submit('/admin/brand', '/admin/brand/proof/reset', {});
  assert.match((await ctx.kim.request('/proof-maker')).text, /031-822-7815/);
});

test('시안확정서 화면 스크립트에 문법 오류가 없다', () => {
  const vm = require('vm');
  for (const file of ['public/proof-maker.js', 'public/print.js']) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { filename: file }), file);
  }
});
