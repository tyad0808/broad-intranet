// 테스트 공통 도우미: 메모리 DB 로 서버를 띄우고, 브라우저처럼 요청을 보낸다
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

// 브라우저처럼 쿠키를 기억하며 요청을 보내는 작은 도우미
function browser(baseUrl) {
  let cookie = '';
  async function request(path, { method = 'GET', form, multipart } = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : multipart, // multipart: FormData (파일 올리기)
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
  // 파일이 있는 폼 제출. files: { 이름: { buffer, filename } }
  async function upload(pagePath, actionPath, fields, files = {}) {
    const page = await request(pagePath);
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
    const data = new FormData();
    data.append('_csrf', token);
    Object.entries(fields).forEach(([k, v]) => data.append(k, v));
    Object.entries(files).forEach(([k, f]) => data.append(k, new Blob([f.buffer]), f.filename));
    return request(actionPath, { method: 'POST', multipart: data });
  }
  return { request, submit, upload };
}

async function startServer({ db = openDb(':memory:'), collector = null, sms, proofDir, proofsEnabled = false } = {}) {
  // 시안 이미지는 테스트마다 새 임시 폴더에 (실제 data 폴더를 건드리지 않게)
  proofDir = proofDir || fs.mkdtempSync(path.join(os.tmpdir(), 'broad-proofs-'));
  const app = createApp({ db, collector, secret: 'test-secret', proofDir, proofsEnabled, sms });
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { db, server, baseUrl, app, proofDir };
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
