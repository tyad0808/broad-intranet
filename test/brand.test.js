// 회사 이름·로고: 관리자만 바꾸고, 왼쪽 위·브라우저 탭·로그인 화면에 보인다
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs, browser } = require('./helpers');
const { imageType, DEFAULT_NAME } = require('../src/brand');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

test('그림 종류는 파일 앞부분으로 확인 (PNG·JPG·WEBP 만, SVG·가짜 이름은 거절)', () => {
  assert.strictEqual(imageType(PNG), 'image/png');
  assert.strictEqual(imageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])), 'image/jpeg');
  assert.strictEqual(imageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.strictEqual(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
});

test('관리자가 이름·로고를 바꾸면 모든 화면에 보이고, 되돌리기로 처음으로', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'boss@broad.test', role: 'admin', name: '대표' });
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const admin = await loginAs(baseUrl, 'boss@broad.test');
  const staff = await loginAs(baseUrl, 'kim@broad.test');

  assert.match((await admin.request('/')).text, new RegExp(`<title>${DEFAULT_NAME.replace(/[()]/g, '\\$&')}</title>`));
  assert.strictEqual((await staff.request('/admin/brand')).status, 403, '직원은 못 바꿈');

  await admin.submit('/admin/brand', '/admin/brand/name', { name: '  브로애드   통합관리 솔루션 ' });
  const home = (await admin.request('/')).text;
  assert.match(home, /<title>브로애드 통합관리 솔루션<\/title>/);
  assert.match(home, /class="brand-mark" aria-hidden="true">B<\/span><span class="brand-name">브로애드 통합관리 솔루션/);
  assert.match((await browser(baseUrl).request('/login')).text, /브로애드 통합관리 솔루션/, '로그인 화면에도');
  await admin.submit('/admin/brand', '/admin/brand/name', { name: 'ㄱ'.repeat(31) });
  assert.match((await admin.request('/')).text, /<title>브로애드 통합관리 솔루션<\/title>/, '31자는 안 바뀜');

  const page = (await admin.request('/admin/brand')).text;
  const token = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const upload = (content, name) => {
    const form = new FormData();
    form.append('_csrf', token);
    form.append('logo', new Blob([content], { type: 'image/png' }), name);
    return fetch(`${baseUrl}/admin/brand/logo`, { method: 'POST', body: form, headers: { cookie: admin.cookie() }, redirect: 'manual' });
  };
  assert.strictEqual((await upload('<svg onload="alert(1)"></svg>', 'logo.png')).status, 302);
  assert.match((await admin.request('/admin/brand')).text, /PNG·JPG·WEBP 그림만/);
  assert.ok(!(await admin.request('/')).text.includes('brand-logo'), '그림이 아니면 거절');
  await upload(Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), 'big.png');
  assert.ok(!(await admin.request('/')).text.includes('brand-logo'), '1MB 넘으면 거절');

  await upload(PNG, 'logo.png');
  const withLogo = (await admin.request('/')).text;
  const src = /<img class="brand-logo" src="([^"]+)"/.exec(withLogo)[1];
  assert.match(withLogo, new RegExp(`<link rel="icon" href="${src.replace('?', '\\?')}" type="image/png">`), '브라우저 탭 아이콘도');
  const logo = await fetch(baseUrl + src);
  assert.strictEqual(logo.headers.get('content-type'), 'image/png');
  assert.match(logo.headers.get('cache-control'), /immutable/);
  assert.ok(Buffer.from(await logo.arrayBuffer()).equals(PNG), '로그인 없이도 (로그인 화면용)');

  await admin.submit('/admin/brand', '/admin/brand/reset', {});
  const back = (await admin.request('/')).text;
  assert.ok(back.includes(`<title>${DEFAULT_NAME}</title>`) && !back.includes('brand-logo'));
  assert.strictEqual((await fetch(baseUrl + '/brand/logo')).status, 404);
});

test('왼쪽 메뉴 순서: 처음엔 주문·메일함·(톡톡)·문의함·일정, 관리자가 바꾸면 모든 직원에게, 관리자 메뉴는 늘 맨 아래', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'boss@broad.test', role: 'admin', name: '대표' });
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const admin = await loginAs(baseUrl, 'boss@broad.test');
  const staff = await loginAs(baseUrl, 'kim@broad.test');
  const menu = text => [...text.slice(text.indexOf('id="main-nav"')).matchAll(/<span>(주문|메일함|문의함|일정|관리자)/g)].map(m => m[1]);
  assert.deepStrictEqual(menu((await admin.request('/')).text), ['주문', '메일함', '문의함', '일정', '관리자']);
  // 톡톡은 연결 전이라 메뉴엔 없지만 순서 목록엔 있다 (관리자 화면에 안내)
  assert.match((await admin.request('/admin/brand')).text, /톡톡<\/strong> <span class="muted small">\(톡톡을 연결하면 보여요\)/);
  for (let n = 0; n < 3; n++) await admin.submit('/admin/brand', '/admin/brand/nav', { key: 'schedule', dir: 'up' });
  await admin.submit('/admin/brand', '/admin/brand/nav', { key: 'orders', dir: 'up' }); // 맨 위에서 위로: 그대로
  assert.deepStrictEqual(menu((await staff.request('/')).text), ['주문', '일정', '메일함', '문의함'], '직원 화면에도 같은 순서 (직원은 관리자 메뉴 없음)');
  assert.deepStrictEqual(menu((await admin.request('/')).text).slice(-1), ['관리자']);
  assert.strictEqual((await staff.submit('/', '/admin/brand/nav', { key: 'inbox', dir: 'up' })).status, 403, '직원은 못 바꿈');
});

test('예전에 저장한 메뉴 순서에 없는 새 메뉴(톡톡)는 기본 순서에서 바로 앞 메뉴(메일함) 뒤에 들어간다', async t => {
  const { db, server } = await startServer();
  t.after(() => server.close());
  const { createBrand } = require('../src/brand');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('nav_order', ?)").run(JSON.stringify(['orders', 'schedule', 'mail', 'inbox']));
  assert.deepStrictEqual(createBrand(db).view().navOrder, ['orders', 'schedule', 'mail', 'chat', 'inbox']);
});
