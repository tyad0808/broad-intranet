// 사용 방법(직원 안내서) 화면: 로그인한 직원만, docs/guide.md 내용이 보이고, 위험한 글자는 그대로 글자로
const test = require('node:test');
const assert = require('node:assert');
const { startServer, addUser, loginAs, browser } = require('./helpers');
const { renderGuide } = require('../src/guide');

test('사용 방법은 로그인해야 보이고, 왼쪽 메뉴에 버튼이 있다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  const out = await browser(baseUrl).request('/guide');
  assert.strictEqual(out.status, 302);
  assert.strictEqual(out.location, '/login');

  addUser(db, { email: 'staff@broad.test', name: '직원' });
  const b = await loginAs(baseUrl, 'staff@broad.test');
  const home = await b.request('/');
  assert.match(home.text, /href="\/guide"[^>]*>.*사용 방법/);
  const page = await b.request('/guide');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /직원 사용 안내서/);
  assert.match(page.text, /<h2 id="s1">1\. 시작하기<\/h2>/);
  assert.match(page.text, /<a href="#s1">시작하기<\/a>/);
  assert.match(page.text, /<table>/);
});

test('안내서 글자는 이스케이프하고 http(s) 링크만 만든다', () => {
  const g = renderGuide('# 제목\n\n## 하나\n\n<script>alert(1)</script> **굵게** [좋은](https://a.test) [나쁜](javascript:alert(1))\n\n- 가\n- 나\n\n1. 첫째\n2. 둘째\n\n| 칸 | 뜻 |\n| --- | --- |\n| a | b |');
  assert.strictEqual(g.title, '제목');
  assert.deepStrictEqual(g.toc, [{ id: 's1', text: '하나' }]);
  assert.match(g.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(g.html, /<script>/);
  assert.match(g.html, /<strong>굵게<\/strong>/);
  assert.match(g.html, /<a href="https:\/\/a.test" target="_blank" rel="noopener">좋은<\/a>/);
  assert.doesNotMatch(g.html, /href="javascript/);
  assert.match(g.html, /<ul><li>가<\/li><li>나<\/li><\/ul>/);
  assert.match(g.html, /<ol><li>첫째<\/li><li>둘째<\/li><\/ol>/);
  assert.match(g.html, /<th>칸<\/th><th>뜻<\/th>.*<td>a<\/td><td>b<\/td>/s);
});
