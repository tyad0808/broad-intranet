// 회사 공지 팝업 · 업무 매뉴얼 버튼 · 관리자 메뉴 묶음
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs } = require('./helpers');

async function setup(t) {
  const ctx = await startServer();
  t.after(() => ctx.server.close());
  ctx.adminId = addUser(ctx.db, { email: 'boss@broad.test', role: 'admin', name: '대표' });
  ctx.kimId = addUser(ctx.db, { email: 'kim@broad.test', name: '김디자' });
  ctx.leeId = addUser(ctx.db, { email: 'lee@broad.test', name: '이디자' });
  ctx.admin = await loginAs(ctx.baseUrl, 'boss@broad.test');
  ctx.kim = await loginAs(ctx.baseUrl, 'kim@broad.test');
  return ctx;
}

test('공지를 올리면 직원 화면에 팝업이 뜨고, [확인했어요] 를 누르면 그 직원에게는 다시 안 뜬다', async t => {
  const { db, admin, kim, baseUrl } = await setup(t);
  assert.doesNotMatch((await kim.request('/home')).text, /class="notice-pop"/, '공지가 없으면 팝업 없음');
  await admin.submit('/admin/notices', '/admin/notices', { title: '토요일 휴무 안내', body: '이번 주 토요일은 쉽니다.\n월요일에 봬요.', important: '1' });
  const home = (await kim.request('/home')).text;
  assert.match(home, /class="notice-pop"/);
  assert.match(home, /<h2 id="notice-pop-title">토요일 휴무 안내<\/h2>/);
  assert.match(home, /class="notice-pop-box important"/);
  assert.match(home, /class="hm-notice" href="\/notices">/, '홈 맨 위에도 한 줄');
  assert.match((await kim.request('/')).text, /class="notice-pop"/, '다른 화면에서도 뜬다');
  const id = db.prepare('SELECT id FROM notices').get().id;
  const res = await kim.submit('/home', `/notices/${id}/read`, { back: '/inbox' });
  assert.strictEqual(res.location, '/inbox', '보던 화면으로 돌아간다');
  assert.doesNotMatch((await kim.request('/home')).text, /class="notice-pop"/, '확인한 직원에게는 다시 안 뜬다');
  const lee = await loginAs(baseUrl, 'lee@broad.test');
  assert.match((await lee.request('/home')).text, /class="notice-pop"/, '다른 직원에게는 그대로');
  // 관리자: 누가 확인했는지
  const page = (await admin.request('/admin/notices')).text;
  assert.match(page, /확인 <strong>1<\/strong> \/ 3명/);
  assert.match(page, /<strong>확인함<\/strong> · 김디자/);
  assert.match(page, /<strong>아직<\/strong> · 대표, 이디자/);
  // 지난 공지 목록
  assert.match((await kim.request('/notices')).text, /토요일 휴무 안내[\s\S]*확인함/);
  // 고치면서 다시 띄우기
  await admin.submit('/admin/notices', `/admin/notices/${id}`, { title: '토요일 휴무 (바뀜)', body: '', starts_on: '2026-01-01', reshow: '1' });
  assert.match((await kim.request('/home')).text, /notice-pop-title">토요일 휴무 \(바뀜\)</);
  // 지우기
  await admin.submit('/admin/notices', `/admin/notices/${id}/delete`, {});
  assert.doesNotMatch((await kim.request('/home')).text, /class="notice-pop"/);
});

test('공지 기간: 시작 전·끝난 공지는 팝업이 안 뜨고, 직원은 공지 관리에 못 들어간다', async t => {
  const { db, kim } = await setup(t);
  db.prepare("INSERT INTO notices (title, starts_on) VALUES ('다음 주 공지', '2999-01-01')").run();
  db.prepare("INSERT INTO notices (title, starts_on, ends_on) VALUES ('지난 공지', '2000-01-01', '2000-01-02')").run();
  assert.doesNotMatch((await kim.request('/home')).text, /class="notice-pop"/);
  assert.strictEqual((await kim.request('/admin/notices')).status, 403);
  const res = await kim.submit('/home', '/notices/1/read', { back: 'https://evil.example' });
  assert.strictEqual(res.location, '/home', '바깥 주소로는 안 돌아간다');
});

test('업무 매뉴얼: 관리자가 노션 주소를 넣으면 모든 직원 왼쪽 메뉴에 버튼, 비우면 사라진다', async t => {
  const { admin, kim } = await setup(t);
  assert.doesNotMatch((await kim.request('/home')).text, /업무 매뉴얼/);
  const bad = await admin.submit('/admin/brand', '/admin/brand/manual', { url: 'javascript:alert(1)' });
  assert.strictEqual(bad.location, '/admin/brand#manual');
  assert.doesNotMatch((await kim.request('/home')).text, /업무 매뉴얼/, 'https 가 아니면 저장 안 함');
  await admin.submit('/admin/brand', '/admin/brand/manual', { url: 'https://www.notion.so/broad/manual-123' });
  assert.match((await kim.request('/home')).text, /<a href="https:\/\/www.notion.so\/broad\/manual-123" target="_blank" rel="noopener" class="nav-help nav-ext nav-manual"/);
  await admin.submit('/admin/brand', '/admin/brand/manual', { url: '' });
  assert.doesNotMatch((await kim.request('/home')).text, /업무 매뉴얼/);
});

test('관리자 메뉴는 4묶음: 지금 화면이 든 묶음의 메뉴만 아래 줄에', async t => {
  const { admin } = await setup(t);
  const page = (await admin.request('/admin/logen')).text;
  assert.match(page, /<nav class="admin-groups"[\s\S]*직원·회사[\s\S]*주문[\s\S]*판매처·메일 연결[\s\S]*기록·서버/);
  assert.match(page, /class="on" aria-current=true>판매처·메일 연결/);
  assert.match(page, /href="\/admin\/logen" class="chip on">로젠 설정/);
  assert.doesNotMatch(page, /class="chip [^"]*">직원 관리/, '다른 묶음 메뉴는 안 보임');
});
