// 웹 서버 구성: 어떤 주소로 오면 무엇을 보여줄지 정한다.
// server.js 와 분리해 두면 테스트에서 실제 포트를 열지 않고도 이 앱을 불러 쓸 수 있다.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const { SqliteSessionStore } = require('./sessionStore');
const { loadUser, requireActive, csrf } = require('./auth');
const { authRoutes } = require('./routes/auth');

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET 이 .env 에 없습니다. 서버 운영 시에는 반드시 설정해야 합니다.');
  }
  // 개발 중에만: 임시 비밀값을 만든다 (서버를 다시 켜면 모두 로그아웃됨)
  console.warn('[주의] SESSION_SECRET 이 비어 있어 임시값을 사용합니다. .env 에 값을 넣으면 재시작해도 로그인이 유지됩니다.');
  return crypto.randomBytes(32).toString('hex');
}

function createApp({ db, secret = sessionSecret() }) {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';
  const store = new SqliteSessionStore(db);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  // HTTPS 프록시(Nginx 등) 뒤에서 실행될 때 실제 접속 정보를 믿도록 설정
  if (isProd) app.set('trust proxy', 1);

  // 보안 관련 HTTP 헤더 자동 설정 (클릭재킹, 스크립트 주입 등 방어)
  app.use(helmet());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: false }));

  app.use(session({
    name: 'broad.sid',
    secret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true, // 사용 중이면 로그인 유지 시간을 계속 연장
    cookie: {
      httpOnly: true,  // 자바스크립트로 쿠키를 훔쳐 갈 수 없게
      sameSite: 'lax',
      secure: isProd,  // 운영 서버에서는 HTTPS 로만 쿠키 전송
      maxAge: 12 * 60 * 60 * 1000, // 12시간 동안 사용하지 않으면 자동 로그아웃
    },
  }));

  app.use(loadUser(db));
  app.use(csrf);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use(authRoutes(db));

  // 여기부터는 로그인 + 승인된 계정만 접근
  app.get('/', requireActive, (req, res) => {
    res.render('home', { title: '홈' });
  });

  app.use((req, res) => {
    res.status(404).render('error', { title: '없는 페이지', message: '주소를 다시 확인하세요.' });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: '오류', message: '잠시 후 다시 시도하세요.' });
  });

  app.locals.sessionStore = store;
  return app;
}

module.exports = { createApp };
