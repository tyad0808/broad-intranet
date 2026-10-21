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
const { manualRoutes, PAY_METHODS } = require('./routes/manual');
const { calendarRoutes } = require('./routes/calendar');
const { inboxRoutes } = require('./routes/inbox');
const { replyUpload } = require('./inbox/upload');
const { createBrand } = require('./brand');
const { ipAllowed } = require('./inbox/talktalk');
const { createNotifier } = require('./notifier');
const { createOrderActions } = require('./actions');
const { channelStatusLabel, channelInfo, channelInfoWith, claimLabel, claimLevel } = require('./channels/labels');
const { shipMethodLabel, courierLabel } = require('./channels/shipping');

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET 이 .env 에 없습니다. 서버 운영 시에는 반드시 설정해야 합니다.');
  }
  // 개발 중에만: 임시 비밀값을 만든다 (서버를 다시 켜면 모두 로그아웃됨)
  console.warn('[주의] SESSION_SECRET 이 비어 있어 임시값을 사용합니다. .env 에 값을 넣으면 재시작해도 로그인이 유지됩니다.');
  return crypto.randomBytes(32).toString('hex');
}

function createApp({
  db,
  collector = null,
  // 문의함: { collector, senders: { naver_mail: … }, sourceLabels: { naver_mail: '네이버메일' } }
  inbox = {},
  notifier = createNotifier({ db }),
  actions = createOrderActions({ db }), // 기본은 연습 모드 (네이버로 보내지 않음)
  secret = sessionSecret(),
}) {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';
  const store = new SqliteSessionStore(db);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.locals.channelStatusLabel = channelStatusLabel;
  app.locals.channelInfo = channelInfo;
  app.locals.claimLabel = claimLabel;
  app.locals.claimLevel = claimLevel;
  app.locals.shipMethodLabel = shipMethodLabel;
  app.locals.courierLabel = courierLabel;
  app.locals.actionMode = actions.mode;
  // 채널별 연습/실제 모드 { smartstore: 'live', coupang: 'practice' }
  app.locals.actionModes = actions.modes || { smartstore: actions.mode };
  app.locals.WRITE_CHANNEL_NAMES = { smartstore: '네이버로', coupang: '쿠팡으로', godo: '자사몰로' };
  app.locals.PAY_METHODS = PAY_METHODS;
  // 처리 기록에 보여줄 이름
  app.locals.ACTION_LABELS = { confirm: '발주확인', dispatch: '발송처리', create: '수기 등록', paid: '입금확인', edit: '수정', cancel: '취소' };
  app.locals.RESULT_LABELS = { ok: '완료', partial: '일부', fail: '실패', unknown: '확인 필요', practice: '연습' };
  // 납기 표시: 지났으면 빨강, 오늘·내일이면 주황 (today 는 한국 날짜 YYYY-MM-DD)
  app.locals.dueInfo = (due, today) => {
    if (!due) return { cls: '', text: '' };
    const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    if (due < today) return { cls: 'due-over', text: `${due.slice(5)} 지남` };
    if (due === today) return { cls: 'due-soon', text: '오늘' };
    if (due === tomorrow) return { cls: 'due-soon', text: '내일' };
    return { cls: '', text: due.slice(5) };
  };
  // 채널 발송기한 표시: 지났으면 빨강, 오늘이면 주황 (예: '오늘 15:00까지', '10/22 15:00까지')
  app.locals.shipDueInfo = (shipDue, now = new Date()) => {
    const t = shipDue ? Date.parse(shipDue) : NaN;
    if (!Number.isFinite(t)) return { cls: '', text: '' };
    const kstOf = ms => new Date(ms + 9 * 3600 * 1000).toISOString();
    const due = kstOf(t);
    const today = kstOf(now.getTime()).slice(0, 10);
    const tomorrow = kstOf(now.getTime() + 86400000).slice(0, 10);
    const day = due.slice(0, 10) === today ? '오늘' : due.slice(0, 10) === tomorrow ? '내일' : `${due.slice(5, 7)}/${due.slice(8, 10)}`;
    const time = due.slice(11, 16);
    if (t < now.getTime()) return { cls: 'due-over', text: `발송기한 지남 (${day} ${time})` };
    return { cls: day === '오늘' ? 'due-soon' : '', text: `${day} ${time}까지 발송` };
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
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        // 운영(HTTPS)에서만 http 요청을 https 로 올린다. 개발(http://localhost)에서 켜 두면 팝업 안 저장이 막힌다
        upgradeInsecureRequests: isProd ? [] : null,
      },
    },
  }));
  // 글꼴은 바뀌지 않으므로 브라우저가 오래 저장해 두게 한다
  app.use('/fonts', express.static(path.join(__dirname, '..', 'public', 'fonts'), { maxAge: '365d', immutable: true }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 회사 로고 (로그인 화면에도 보여야 해서 로그인 검사 전에). 주소에 그림 지문(v)이 들어 있어 오래 저장해 둬도 된다
  const brand = createBrand(db);
  app.get('/brand/logo', (req, res) => {
    const logo = brand.logo();
    if (!logo) return res.status(404).end();
    res.set('Cache-Control', req.query.v === logo.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.type(logo.type).send(logo.data);
  });

  // 5차 네이버 톡톡: 네이버가 새 메시지를 알려 주는 비밀 주소 (로그인·CSRF 대신 비밀 주소 + 네이버 서버 IP 로 확인)
  if (inbox.talktalk) {
    const expected = Buffer.from(String(inbox.talktalk.token));
    app.post('/hooks/talktalk/:token', express.json({ limit: '1mb' }), (req, res) => {
      const given = Buffer.from(String(req.params.token));
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return res.status(404).end();
      if (!ipAllowed(req.ip)) {
        console.warn(`[톡톡] 네이버가 아닌 곳에서 온 요청을 막았습니다: ${req.ip}`);
        return res.status(403).end();
      }
      try {
        inbox.talktalk.handle(req.body);
      } catch (e) {
        console.error(`[톡톡] 메시지 처리 실패: ${e.message}`);
      }
      res.status(200).json({ success: true });
    });
  }
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
  const currentChannelInfo = channelInfoWith(db);
  const openInquiriesStmt = db.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'open' AND deleted_at IS NULL");
  app.use((req, res, next) => {
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    // 회사 이름·로고 (관리자 > 회사·로고)
    res.locals.brand = brand.view();
    res.locals.tab = null;
    // 관리자가 바꾼 수기 주문 채널 이름을 반영 (화면은 이 channelInfo 를 쓴다)
    res.locals.channelInfo = currentChannelInfo();
    // 주문 목록 위 팝업(iframe) 안에서 열린 화면이면 위쪽 메뉴 없이 내용만 보여준다
    res.locals.embed = req.get('sec-fetch-dest') === 'iframe' || req.query.embed === '1';
    res.locals.pendingCount =
      req.user && req.user.role === 'admin' && req.user.status === 'active' ? pendingCountStmt.get().n : 0;
    res.locals.unassignedAlert = notifier.unassignedBanner(req.user);
    // 위쪽 메뉴의 문의함 미답변 건수
    res.locals.openInquiries = req.user && req.user.status === 'active' ? openInquiriesStmt.get().n : 0;
    next();
  });

  // 문의 답장에 붙인 파일: 보안 검사가 폼 값을 읽을 수 있도록 그 전에 읽는다 (로그인한 직원만)
  app.use('/inbox/:id/reply', replyUpload);
  app.use('/admin/brand/logo', replyUpload);
  app.use(csrf);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use(authRoutes(db, notifier));

  // 여기부터는 로그인 + 승인된 계정만 접근
  // 실시간 소식 통로 (주문 변경, 알림)
  app.get('/events', requireActive, (req, res) => {
    notifier.hub.add(req, res, req.user.id);
  });

  app.use('/admin', requireAdmin, adminRoutes(db, store, collector, notifier, brand));
  // 수기 주문(/orders/new)을 주문 카드(/orders/:id)보다 먼저 연결한다
  app.use(requireActive, calendarRoutes(db, notifier));
  app.use(requireActive, inboxRoutes(db, { ...inbox, notifier }));
  app.use(requireActive, manualRoutes(db, notifier));
  app.use(requireActive, orderRoutes(db, notifier, actions, collector));

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
