// 테스트 공통 도우미: 메모리 DB 로 서버를 띄우고, 브라우저처럼 요청을 보낸다
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
      // 값이 배열이면 같은 이름으로 여러 번 보낸다 (체크박스 여러 개 = ids=1&ids=2)
      body: form instanceof URLSearchParams
        ? form.toString()
        : form
          ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => [k, x]))).toString()
          : undefined,
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
  return { request, submit, cookie: () => cookie };
}

async function startServer({ db = openDb(':memory:'), collector = null, actions, notifier, inbox, weeklyAccount, weeklyTransport, logen } = {}) {
  const app = createApp({ db, collector, secret: 'test-secret', ...(actions ? { actions } : {}), ...(notifier ? { notifier } : {}), ...(inbox ? { inbox } : {}),
    ...(weeklyAccount ? { weeklyAccount, weeklyTransport } : {}), ...(logen ? { logen } : {}) });
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { db, server, baseUrl };
}

function addUser(db, { email, password = 'password123', role = 'staff', status = 'active', name }) {
  const result = db.prepare('INSERT INTO users (email, password_hash, name, role, status) VALUES (?, ?, ?, ?, ?)')
    .run(email, hashPassword(password), name || email.split('@')[0], role, status);
  return Number(result.lastInsertRowid);
}

// 로그인까지 마친 브라우저를 돌려준다
async function loginAs(baseUrl, email, password = 'password123') {
  const b = browser(baseUrl);
  await b.submit('/login', '/login', { email, password });
  return b;
}

module.exports = { browser, startServer, addUser, loginAs };
