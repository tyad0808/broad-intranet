// 회원가입 → 승인 대기 → 승인 → 로그인 → 정지 흐름을 실제 HTTP 요청으로 검사한다
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

// 브라우저처럼 쿠키를 기억하며 요청을 보내는 작은 도우미
function browser(baseUrl) {
  let cookie = '';
  async function request(path, { method = 'GET', form } = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text };
  }
  // 폼 화면을 먼저 열어 CSRF 토큰을 얻은 뒤 제출한다
  async function submit(pagePath, actionPath, fields) {
    const page = await request(pagePath);
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
    return request(actionPath, { method: 'POST', form: { ...fields, _csrf: token } });
  }
  return { request, submit };
}

async function startServer() {
  const db = openDb(':memory:');
  const app = createApp({ db, secret: 'test-secret' });
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { db, server, baseUrl };
}

function addUser(db, { email, password = 'password123', role = 'staff', status = 'active' }) {
  db.prepare('INSERT INTO users (email, password_hash, name, role, status) VALUES (?, ?, ?, ?, ?)')
    .run(email, hashPassword(password), email.split('@')[0], role, status);
}

test('로그인하지 않으면 홈 대신 로그인 화면으로 보낸다', async t => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());
  const res = await browser(baseUrl).request('/');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.location, '/login');
});

test('가입하면 승인 대기 상태가 되고, 로그인해도 홈을 볼 수 없다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  const b = browser(baseUrl);

  const signup = await b.submit('/signup', '/signup', {
    email: 'new@broad.test', name: '신입', password: 'password123', password_confirm: 'password123', job_id: '',
  });
  assert.strictEqual(signup.location, '/login?m=signedup');

  const user = db.prepare("SELECT status, password_hash FROM users WHERE email = 'new@broad.test'").get();
  assert.strictEqual(user.status, 'pending');
  assert.notStrictEqual(user.password_hash, 'password123', '비밀번호 원문이 저장되면 안 된다');

  const signupAlert = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'signup'").get();
  assert.strictEqual(signupAlert.n, 1, '가입 신청 알림 기록이 남아야 한다');

  const login = await b.submit('/login', '/login', { email: 'new@broad.test', password: 'password123' });
  assert.strictEqual(login.location, '/pending');

  const home = await b.request('/');
  assert.strictEqual(home.location, '/pending');
});

test('관리자가 승인하면 홈을 볼 수 있다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'staff@broad.test', status: 'pending' });
  const b = browser(baseUrl);
  await b.submit('/login', '/login', { email: 'staff@broad.test', password: 'password123' });

  db.prepare("UPDATE users SET status = 'active' WHERE email = 'staff@broad.test'").run();

  const home = await b.request('/');
  assert.strictEqual(home.status, 200);
  assert.match(home.text, /로그인되었습니다/);
});

test('계정을 정지하면 이미 로그인한 창도 바로 쫓겨난다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'leaver@broad.test' });
  const b = browser(baseUrl);
  await b.submit('/login', '/login', { email: 'leaver@broad.test', password: 'password123' });
  assert.strictEqual((await b.request('/')).status, 200);

  db.prepare("UPDATE users SET status = 'suspended' WHERE email = 'leaver@broad.test'").run();

  const after = await b.request('/');
  assert.strictEqual(after.location, '/login?m=blocked');
  const again = await b.submit('/login', '/login', { email: 'leaver@broad.test', password: 'password123' });
  assert.strictEqual(again.status, 401);
});

test('비밀번호를 5번 틀리면 맞는 비밀번호로도 15분간 로그인할 수 없다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'lock@broad.test' });
  const b = browser(baseUrl);

  for (let i = 0; i < 5; i++) {
    const res = await b.submit('/login', '/login', { email: 'lock@broad.test', password: 'wrong-password' });
    assert.strictEqual(res.status, 401);
  }
  const res = await b.submit('/login', '/login', { email: 'lock@broad.test', password: 'password123' });
  assert.strictEqual(res.status, 401);
  assert.match(res.text, /잠겼습니다/);
});

test('CSRF 토큰 없이 보낸 폼은 거부한다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'csrf@broad.test' });
  const res = await browser(baseUrl).request('/login', {
    method: 'POST', form: { email: 'csrf@broad.test', password: 'password123' },
  });
  assert.strictEqual(res.status, 403);
});

test('같은 이메일로 두 번 가입할 수 없다', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'dup@broad.test' });
  const res = await browser(baseUrl).submit('/signup', '/signup', {
    email: 'DUP@broad.test', name: '중복', password: 'password123', password_confirm: 'password123',
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /이미 가입된 이메일/);
});
