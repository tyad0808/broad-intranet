// 화면 밝기(다크모드): 자동 → 밝게 → 어둡게, 직원마다 계정에 저장, 인쇄물은 늘 밝게
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs, browser } = require('./helpers');

test('화면 밝기: 처음은 자동(컴퓨터 설정), 버튼으로 밝게·어둡게 저장, 다른 기기에서도 같게, 잘못된 값은 자동', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'kim@broad.test', name: '김직원' });
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const page = async b => (await b.request('/home')).text;

  let html = await page(kim);
  assert.match(html, /<html lang="ko" data-theme="auto">/);
  assert.match(html, /<link rel="stylesheet" href="\/dark\.css" id="dark-css" media="\(prefers-color-scheme: dark\)">/, '자동: 컴퓨터가 다크모드일 때만');
  assert.match(html, /<input type="hidden" name="theme" value="light">/, '누르면 밝게');
  assert.match(html, /<script src="\/theme\.js"><\/script>/);

  await kim.submit('/home', '/me/theme', { theme: 'dark', back: '/home' });
  assert.strictEqual(db.prepare('SELECT theme FROM users').get().theme, 'dark');
  html = await page(kim);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /id="dark-css" media="all"/);
  // 다른 기기(새로 로그인)에서도 어둡게
  assert.match(await page(await loginAs(baseUrl, 'kim@broad.test')), /id="dark-css" media="all"/);

  await kim.submit('/home', '/me/theme', { theme: 'light' });
  assert.match(await page(kim), /id="dark-css" media="not all"/);
  const res = await kim.submit('/home', '/me/theme', { theme: '<script>', back: '//evil.example' });
  assert.strictEqual(res.location, '/', '바깥 주소로는 안 돌아감');
  assert.strictEqual(db.prepare('SELECT theme FROM users').get().theme, null, '모르는 값은 자동');

  // 로그인 전 화면도 컴퓨터 설정을 따른다 (버튼은 없음)
  const login = (await browser(baseUrl).request('/login')).text;
  assert.match(login, /media="\(prefers-color-scheme: dark\)"/);
  assert.doesNotMatch(login, /data-theme-form/);
});
