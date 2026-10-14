// 웹 서버 구성: 어떤 주소로 오면 무엇을 보여줄지 정한다.
// server.js 와 분리해 두면 테스트에서 실제 포트를 열지 않고도 이 앱을 불러 쓸 수 있다.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const { SqliteSessionStore } = require('./sessionStore');
const { loadUser, requireActive, requireAdmin, csrf } = require('./auth');
const { authRoutes } = require('./routes/auth');
const { adminRoutes } = require('./routes/admin');
const { orderRoutes } = require('./routes/orders');
const { createNotifier } = require('./notifier');
const { channelStatusLabel } = require('./channels/labels');

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET 이 .env 에 없습니다. 서버 운영 시에는 반드시 설정해야 합니다.');
  }
  // 개발 중에만: 임시 비밀값을 만든다 (서버를 다시 켜면 모두 로그아웃됨)
  console.warn('[주의] SESSION_SECRET 이 비어 있어 임시값을 사용합니다. .env 에 값을 넣으면 재시작해도 로그인이 유지됩니다.');
  return crypto.randomBytes(32).toString('hex');
}

function createApp({ db, collector = null, notifier = createNotifier({ db }), secret = sessionSecret() }) {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';
  const store = new SqliteSessionStore(db);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.locals.channelStatusLabel = channelStatusLabel;
  // 납기 표시: 지났으면 빨강, 오늘·내일이면 주황 (today 는 한국 날짜 YYYY-MM-DD)
  app.locals.dueInfo = (due, today) => {
    if (!due) return { cls: '', text: '' };
    const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    if (due < today) return { cls: 'due-over', text: `${due.slice(5)} 지남` };
    if (due === today) return { cls: 'due-soon', text: '오늘' };
    if (due === tomorrow) return { cls: 'due-soon', text: '내일' };
    return { cls: '', text: due.slice(5) };
  };
  // 화면에 시각을 한국 시간으로 보여준다 (DB 에는 UTC 로 저장)
  app.locals.kst = value => {
    if (!value) return '-';
    const text = String(value);
    const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return text;
    return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  };
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
  // 화면 공통 값: 처리 결과 안내 문구(한 번만 표시), 관리자에게 보이는 가입 신청 건수
  const pendingCountStmt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'");
  app.use((req, res, next) => {
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.tab = null;
    res.locals.pendingCount =
      req.user && req.user.role === 'admin' && req.user.status === 'active' ? pendingCountStmt.get().n : 0;
    res.locals.unassignedAlert = notifier.unassignedBanner(req.user);
    next();
  });

  app.use(csrf);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use(authRoutes(db, notifier));

  // 여기부터는 로그인 + 승인된 계정만 접근
  // 실시간 소식 통로 (주문 변경, 알림)
  app.get('/events', requireActive, (req, res) => {
    notifier.hub.add(req, res, req.user.id);
  });

  app.use('/admin', requireAdmin, adminRoutes(db, store, collector, notifier));
  app.use(requireActive, orderRoutes(db, notifier));

  app.use((req, res) => {
    res.status(404).render('error', { title: '없는 페이지', message: '주소를 다시 확인하세요.' });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: '오류', message: '잠시 후 다시 시도하세요.' });
  });

  app.locals.sessionStore = store;
  app.locals.notifier = notifier;
  return app;
}

module.exports = { createApp };
