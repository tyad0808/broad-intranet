// 자주 쓰는 답장 문구: 직원 누구나 만들고 고치고, 답장 칸에서 넣을 때 {고객명} 등이 그 문의 값으로
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs } = require('./helpers');
const { fillTemplate } = require('../src/routes/templates');

test('문구 안의 {고객명}{상품명}{주문번호}{회사명} 을 값으로, 모르는 값은 그대로', () => {
  assert.strictEqual(fillTemplate('{고객명}님 {상품명} {주문번호} - {회사명} {기타}', { 고객명: '홍길동', 상품명: '', 주문번호: '123', 회사명: '브로애드' }),
    '홍길동님 {상품명} 123 - 브로애드 {기타}');
});

test('직원이 문구를 만들고 고치고 지우며, 문의 답장 칸에 종류에 맞는 문구만 값이 채워져 나온다', async t => {
  const { db, server, baseUrl } = await startServer({ inbox: { sourceLabels: { naver_mail: '네이버메일', godo_qna: '자사몰' } } });
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test', name: '김상담' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  await kim.submit('/templates', '/templates', { title: '시안 확인', body: '{고객명}님, {상품명} 시안 보내드립니다. (주문 {주문번호})', scope: 'all' });
  await kim.submit('/templates', '/templates', { title: '메일 전용', body: '메일입니다', scope: 'mail' });
  await kim.submit('/templates', '/templates', { title: '', body: 'x', scope: 'all' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM reply_templates').get().n, 2, '이름이 없으면 만들지 않음');

  db.prepare("INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name) VALUES ('godo', 'G100', 'G100-1', '아크릴 명패')").run();
  const add = db.prepare('INSERT INTO inquiries (source, external_id, from_name, subject, body, received_at, order_no) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const shopId = Number(add.run('godo_qna', 'inquiry:1', '홍길동 (hong12)', '[자사몰 1:1문의] 배송', '언제 와요', '2026-10-19T00:00:00Z', 'G100').lastInsertRowid);
  const mailId = Number(add.run('naver_mail', '7:1', '이영희', '견적', '견적 부탁', '2026-10-19T00:00:00Z', null).lastInsertRowid);

  const shop = (await kim.request(`/inbox/${shopId}`)).text;
  assert.match(shop, /data-body="홍길동님, 아크릴 명패 시안 보내드립니다. \(주문 G100\)"[^>]*>\s*<strong>시안 확인<\/strong>/);
  assert.ok(!shop.includes('메일 전용'), '쇼핑몰 문의엔 메일 전용 문구 없음');
  const mail = (await kim.request(`/inbox/${mailId}`)).text;
  assert.match(mail, /data-body="이영희님, \{상품명\} 시안 보내드립니다. \(주문 \{주문번호\}\)"[^>]*>\s*<strong>시안 확인<\/strong>/, '모르는 값은 그대로');
  assert.match(mail, />메일 전용</);

  const id = db.prepare("SELECT id FROM reply_templates WHERE title = '메일 전용'").get().id;
  const page = (await kim.request('/templates')).text;
  const token = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const used = await fetch(`${baseUrl}/templates/${id}/used`, { method: 'POST', headers: { cookie: kim.cookie(), 'x-csrf-token': token } });
  assert.strictEqual(used.status, 204);
  assert.ok((await kim.request(`/inbox/${mailId}`)).text.indexOf('>메일 전용<') < (await kim.request(`/inbox/${mailId}`)).text.indexOf('>시안 확인<'), '많이 쓴 문구가 위로');

  await kim.submit('/templates', `/templates/${id}`, { title: '메일 인사', body: '안녕하세요', scope: 'mail' });
  assert.strictEqual(db.prepare('SELECT title FROM reply_templates WHERE id = ?').get(id).title, '메일 인사');
  await kim.submit('/templates', `/templates/${id}/delete`, {});
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM reply_templates').get().n, 1);
});

const fs = require('fs');
const { parseMacroWorkbook, previewUpload, applyUpload, similarity, groupByCategory } = require('../src/macros');
const { readXlsx, writeXlsx } = require('../src/xlsx');
const { openDb } = require('../src/db');

const HEAD = ['번호', '카테고리', '제목', '언제 쓰나', '답변 (메신저·메일 공용)', '메일 제목', '출처'];
const book = rows => writeXlsx([{ name: 'CS 매크로 v1', header: true, rows: [HEAD, ...rows] }]);

test('엑셀 읽기·쓰기: 글자·줄바꿈·특수문자가 그대로', () => {
  const buf = writeXlsx([{ name: '시트', header: true, rows: [['번호', '답변'], [1, '안녕\n<b>&"x"'], [2, '']] }]);
  const [sheet] = readXlsx(buf);
  assert.strictEqual(sheet.name, '시트');
  assert.deepStrictEqual(sheet.rows[1], ['1', '안녕\n<b>&"x"']);
  assert.throws(() => readXlsx(Buffer.from('그냥 글자 파일입니다 아무거나')), /엑셀 파일이 아니에요/);
});

test('엑셀 → 매크로: 칸 이름으로 찾고, 번호 없음·중복·빈 칸은 이유와 함께 건너뜀', () => {
  const r = parseMacroWorkbook(book([
    [1, '첫 응대', '첫 인사', '새 문의', '안녕하세요', '[브로애드] 감사', '일반'],
    ['', '배송', '번호 없음', '', '내용', '', ''],
    [1, '배송', '중복 번호', '', '내용', '', ''],
    [3, '새 칸', '새 카테고리', '', '본문\n두 줄', '', ''],
    [4, '기타', '제목만', '', '', '', ''],
    ['', '', '', '', '', '', ''],
  ]));
  assert.deepStrictEqual(r.macros.map(m => [m.no, m.category, m.title]), [[1, '첫 응대', '첫 인사'], [3, '새 칸', '새 카테고리']]);
  assert.strictEqual(r.macros[1].body, '본문\n두 줄');
  assert.strictEqual(r.problems.length, 3);
  assert.match(r.problems.join('\n'), /3번째 줄 \(번호 없음\): 번호가 없거나/);
  assert.match(r.problems.join('\n'), /중복 번호\): 번호 1 가 위에 또 있어서/);
  assert.match(parseMacroWorkbook(writeXlsx([{ name: 'x', rows: [['아무', '칸']] }])).error, /시트를 찾지 못했어요/);
  assert.ok(similarity('안녕하세요 브로애드입니다', '안녕하세요, 브로애드입니다!') === 1);
});

test('사용자 엑셀(CS 매크로 v1) 모양 그대로 읽힌다', { skip: !fs.existsSync('/tmp/xl/macros.xlsx') }, () => {
  const r = parseMacroWorkbook(fs.readFileSync('/tmp/xl/macros.xlsx'));
  assert.strictEqual(r.macros.length, 45);
  assert.strictEqual(r.problems.length, 0);
});

test('엑셀 반영: 새 번호는 추가, 같은 번호는 고침(사용 횟수 유지), 엑셀에 없는 번호와 예전 문구는 그대로', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO reply_templates (title, body, scope, use_count) VALUES ('예전 인사', '안녕하세요 반가워요', 'mail', 7)").run();
  db.prepare("INSERT INTO reply_templates (title, body, scope, category, macro_no, origin, use_count, last_used_at) VALUES ('발송 완료', '보냈어요', 'all', '배송', 38, 'cs-v1', 5, '2026-11-01 01:00:00')").run();
  db.prepare("INSERT INTO reply_templates (title, body, scope, category, macro_no, origin) VALUES ('리뷰 요청', '리뷰 부탁', 'all', '사후관리', 45, 'cs-v1')").run();
  const before = db.prepare('SELECT * FROM reply_templates WHERE macro_no IS NULL').all();
  const { macros } = parseMacroWorkbook(book([
    [1, '첫 응대', '첫 인사', '새 문의', '안녕하세요 반가워요!', '', ''],     // 예전 문구와 겹침
    [2, '첫 응대', '점심 안내', '13~14시', '점심시간이에요', '', ''],        // 새것
    [38, '배송', '발송 완료', '출고했을 때', '보냈어요. 송장은 {{송장번호}}', '[브로애드] 발송', ''], // 고침
  ]));
  const p = previewUpload(db, macros);
  assert.deepStrictEqual(p.add.map(a => [a.macro.no, a.overlaps.length]), [[1, 1], [2, 0]]);
  assert.deepStrictEqual(p.change.map(c => [c.macro.no, c.fields]), [[38, ['언제 쓰나', '메일 제목', '답변']]]);
  assert.deepStrictEqual(p.missing, [{ macro_no: 45, title: '리뷰 요청' }]);

  assert.deepStrictEqual(applyUpload(db, macros, { add: [2], update: [38] }), { added: 1, updated: 1 });
  const m38 = db.prepare('SELECT * FROM reply_templates WHERE macro_no = 38').get();
  assert.strictEqual(m38.body, '보냈어요. 송장은 {{송장번호}}');
  assert.strictEqual(m38.use_count, 5, '사용 횟수 그대로');
  assert.strictEqual(m38.last_used_at, '2026-11-01 01:00:00');
  assert.ok(db.prepare('SELECT 1 FROM reply_templates WHERE macro_no = 45').get(), '엑셀에 없어도 안 지움');
  assert.ok(!db.prepare('SELECT 1 FROM reply_templates WHERE macro_no = 1').get(), '체크 안 한 겹치는 것은 안 들어감');
  assert.deepStrictEqual(db.prepare('SELECT * FROM reply_templates WHERE macro_no IS NULL').all(), before, '예전 문구는 한 글자도 안 바뀜');
  const again = previewUpload(db, macros);
  assert.deepStrictEqual([again.add.length, again.change.length, again.same], [1, 0, 2], '같은 엑셀을 또 올리면 바뀐 게 없음');
});

test('카테고리: 정해진 순서 → 엑셀의 새 카테고리 → 기타', () => {
  const g = groupByCategory([{ category: '새 칸' }, { category: null }, { category: '배송' }, { category: '첫 응대' }]);
  assert.deepStrictEqual(g.map(x => x.name), ['첫 응대', '배송', '새 칸', '기타']);
});

test('화면: 엑셀 받기·올리기는 관리자만, 올리면 미리보기 → 체크한 것만 반영, 사용 횟수 순 보기', async t => {
  const { db, server, baseUrl } = await startServer({ inbox: { sourceLabels: { naver_mail: '네이버메일' } } });
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test', name: '김상담' });
  addUser(db, { email: 'boss@broad.test', name: '사장', role: 'admin' });
  db.prepare("INSERT INTO reply_templates (title, body, scope, use_count) VALUES ('예전 문구', '예전에 쓰던 말', 'all', 3)").run();
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  assert.strictEqual((await kim.request('/templates/export.xlsx')).status, 403);
  assert.doesNotMatch((await kim.request('/templates')).text, /엑셀 올리기/);

  const upload = async (b, buf) => {
    const page = (await b.request('/templates')).text;
    const token = /name="_csrf" value="([^"]+)"/.exec(page)[1];
    const form = new FormData();
    form.append('_csrf', token);
    form.append('file', new Blob([buf]), '매크로.xlsx');
    const res = await fetch(`${baseUrl}/templates/upload`, { method: 'POST', body: form, redirect: 'manual', headers: { cookie: b.cookie() } });
    return res;
  };
  const r = await upload(boss, book([
    [1, '첫 응대', '첫 인사', '새 문의가 왔을 때', '안녕하세요, 브로애드입니다 :)', '[브로애드] 감사', '일반'],
    [24, '디자인·시안', '시안 컨펌 대기 독촉', '시안 보낸 뒤 답이 없을 때', '시안 확인 부탁드려요', '[브로애드] 시안 확인 요청드립니다', '신규'],
    [99, '견적', '대량 견적', '100개 넘을 때', '대량 견적 안내', '', '신규'],
  ]));
  assert.strictEqual(r.headers.get('location'), '/templates/upload');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM reply_templates').get().n, 1, '미리보기 전에는 아무것도 안 바뀜');
  const preview = (await boss.request('/templates/upload')).text;
  assert.match(preview, /새로 추가 <span class="count">3/);
  const token = /name="_csrf" value="([^"]+)"/.exec(preview)[1];
  await boss.request('/templates/upload/apply', { method: 'POST', form: { _csrf: token, add: ['1', '24'] } });
  assert.deepStrictEqual(db.prepare('SELECT macro_no FROM reply_templates WHERE macro_no IS NOT NULL ORDER BY macro_no').all().map(x => x.macro_no), [1, 24]);
  assert.strictEqual(db.prepare("SELECT body FROM reply_templates WHERE title = '예전 문구'").get().body, '예전에 쓰던 말');
  assert.strictEqual((await boss.request('/templates/upload')).status, 302, '반영하면 올린 엑셀은 잊음');

  // 직원 화면: 매크로 칸에 제목·언제 쓰나
  const mailId = Number(db.prepare("INSERT INTO inquiries (source, external_id, from_name, subject, body, received_at) VALUES ('naver_mail', '9:1', '이영희', '문의', '내용', '2026-10-19T00:00:00Z')").run().lastInsertRowid);
  const detail = (await kim.request(`/inbox/${mailId}`)).text;
  assert.match(detail, /<div class="macro-cat">첫 응대<\/div>/);
  assert.match(detail, /<strong>시안 컨펌 대기 독촉<\/strong><span class="macro-hint">시안 보낸 뒤 답이 없을 때<\/span>/);
  const id = db.prepare('SELECT id FROM reply_templates WHERE macro_no = 24').get().id;
  const t2 = /name="_csrf" value="([^"]+)"/.exec(detail)[1];
  await fetch(`${baseUrl}/templates/${id}/used`, { method: 'POST', headers: { cookie: kim.cookie(), 'x-csrf-token': t2 } });
  await fetch(`${baseUrl}/templates/${id}/used`, { method: 'POST', headers: { cookie: kim.cookie(), 'x-csrf-token': t2 } });

  // 사용 횟수 순 (관리자)
  const usage = (await boss.request('/templates?sort=usage')).text;
  const table = usage.slice(usage.indexOf('usage-table'));
  assert.ok(table.indexOf('예전 문구') < table.indexOf('시안 컨펌 대기 독촉') && table.indexOf('시안 컨펌 대기 독촉') < table.indexOf('>첫 인사<'), '3번(예전) > 2번 > 0번');
  assert.doesNotMatch((await kim.request('/templates?sort=usage')).text, /usage-table/, '직원은 사용 횟수 순 표 없음');

  // 엑셀 받기: 올리기와 같은 모양 + 사용 횟수·마지막 사용일
  const res = await fetch(`${baseUrl}/templates/export.xlsx`, { headers: { cookie: boss.cookie() } });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const sheets = readXlsx(Buffer.from(await res.arrayBuffer()));
  const rows = sheets[0].rows;
  assert.deepStrictEqual(rows[0], [...HEAD, '사용 횟수', '마지막 사용일']);
  const row24 = rows.find(x => x[0] === '24');
  assert.strictEqual(row24[7], '2');
  assert.match(row24[8], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(rows.some(x => x[2] === '예전 문구' && x[0] === '' && x[1] === '기타'));
  // 받은 엑셀을 그대로 다시 올리면 바뀐 게 없음
  const again = parseMacroWorkbook(Buffer.from(await (await fetch(`${baseUrl}/templates/export.xlsx`, { headers: { cookie: boss.cookie() } })).arrayBuffer()));
  const p = previewUpload(db, again.macros);
  assert.deepStrictEqual([p.add.length, p.change.length, p.same], [0, 0, 2]);
  assert.strictEqual(again.problems.length, 1, '번호 없는 예전 문구 한 줄은 건너뜀으로 알려 줌');
});

test('문구 만들기·고치기: 카테고리·언제 쓰나·메일 제목도 저장된다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test', name: '김상담' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  await kim.submit('/templates', '/templates', { title: '새 매크로', body: '내용', scope: 'all', category: '배송', usage_hint: '배송 물을 때', mail_subject: '[브로애드] 배송 안내' });
  const row = db.prepare("SELECT * FROM reply_templates WHERE title = '새 매크로'").get();
  assert.deepStrictEqual([row.category, row.usage_hint, row.mail_subject], ['배송', '배송 물을 때', '[브로애드] 배송 안내']);
  await kim.submit('/templates', `/templates/${row.id}`, { title: '새 매크로', body: '내용', scope: 'all', category: '없는 칸', usage_hint: '', mail_subject: '' });
  const after = db.prepare('SELECT * FROM reply_templates WHERE id = ?').get(row.id);
  assert.deepStrictEqual([after.category, after.usage_hint, after.mail_subject], [null, null, null], '없는 카테고리는 기타');
});

test('관리자 메뉴에 답장 문구·매크로 바로가기가 있다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'boss@broad.test', name: '사장', role: 'admin' });
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  assert.match((await boss.request('/admin/stages')).text, /<a href="\/templates" class="chip ">답장 문구·매크로<\/a>/, '주문 묶음 안에');
  // 답장 문구 화면으로 가도 관리자 탭이 그대로 (그 칸이 선택된 채), 직원에게는 관리자 탭이 없다
  const page = (await boss.request('/templates')).text;
  assert.match(page, /<a href="\/templates" class="chip on">답장 문구·매크로<\/a>/);
  assert.match(page, /class="page-title sub-title">답장 문구 · 매크로/);
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const staffPage = (await kim.request('/templates')).text;
  assert.ok(!staffPage.includes('admin-chips'));
  assert.match(staffPage, /<h1 class="page-title">답장 문구 · 매크로/);
});

test('화면에서 지운 번호는 엑셀을 다시 올려도 기본으로 다시 넣지 않는다 (체크하면 다시 넣음)', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'boss@broad.test', name: '사장', role: 'admin' });
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  const ins = db.prepare("INSERT INTO reply_templates (title, body, scope, macro_no, origin) VALUES (?, ?, 'all', ?, 'cs-v1')");
  ins.run('첫 인사', '안녕하세요', 1);
  const id2 = Number(ins.run('점심시간 자동응답', '점심시간이에요', 2).lastInsertRowid);
  await boss.submit('/templates', `/templates/${id2}/delete`, {});
  const { macros } = parseMacroWorkbook(book([[1, '', '첫 인사', '', '안녕하세요', '', ''], [2, '', '점심시간 자동응답', '', '점심시간이에요', '', '']]));
  const p = previewUpload(db, macros);
  assert.deepStrictEqual(p.add.map(a => [a.macro.no, a.deleted]), [[2, true]]);
  applyUpload(db, macros, { add: [2] });
  assert.ok(db.prepare('SELECT 1 FROM reply_templates WHERE macro_no = 2').get(), '체크하면 다시 들어감');
  assert.strictEqual(previewUpload(db, macros).add.length, 0);
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'macro_deleted_nos'").get().value, '[]');
});

test('이 기능 전에 지운 CS 매크로 v1 번호(빈 번호)도 지운 것으로 본다', () => {
  const db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO reply_templates (title, body, scope, macro_no, origin) VALUES (?, ?, 'all', ?, 'cs-v1')");
  for (const n of [1, 4, 5]) ins.run(`매크로 ${n}`, `내용 ${n}`, n);
  const { macros } = parseMacroWorkbook(book([1, 2, 3, 4, 5, 6].map(n => [n, '', `매크로 ${n}`, '', `내용 ${n}`, '', ''])));
  assert.deepStrictEqual(previewUpload(db, macros).add.map(a => [a.macro.no, a.deleted]), [[2, true], [3, true], [6, false]]);
});
