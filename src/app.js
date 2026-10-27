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
const { templateRoutes } = require('./routes/templates');
const { statsRoutes } = require('./routes/stats');
const { replyUpload } = require('./inbox/upload');
const { createBrand } = require('./brand');
const { createSounds } = require('./sounds');
const { createWeeklyReporter } = require('./weeklyReport');
const { createLogen } = require('./logen');
const { ipAllowed } = require('./inbox/talktalk');
const { createNotifier, notifyOff } = require('./notifier');
const { createOrderActions, canDispatch, DELAY_REASONS } = require('./actions');
const { channelStatusLabel, channelInfo, channelInfoWith, claimLabel, claimLevel, productUrl } = require('./channels/labels');
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
  // 주간 매출 보고: 보낼 회사 메일 계정 (테스트는 weeklyTransport 로 가짜 발송)
  weeklyAccount = null,
  weeklyTransport = null,
  logen = null, // 로젠 송장 (없으면 .env 로 만든다)
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
  app.locals.ACTION_LABELS = { confirm: '발주확인', dispatch: '발송처리', delay: '발송지연', create: '수기 등록', paid: '입금확인', edit: '수정', cancel: '취소' };
  app.locals.RESULT_LABELS = { ok: '완료', partial: '일부', fail: '실패', unknown: '확인 필요', practice: '연습' };
  // 납기 표시: 지났으면 빨강, 오늘·내일이면 연한 빨강 (today 는 한국 날짜 YYYY-MM-DD)
  app.locals.dueInfo = (due, today) => {
    if (!due) return { cls: '', text: '' };
    const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    if (due < today) return { cls: 'due-over', text: `${due.slice(5)} 지남` };
    if (due === today) return { cls: 'due-soon', text: '오늘' };
    if (due === tomorrow) return { cls: 'due-soon', text: '내일' };
    return { cls: '', text: due.slice(5) };
  };
  // 채널 발송기한 표시: 지났으면 빨강, 오늘이면 연한 빨강 (예: '오늘 15:00까지', '10/22 15:00까지')
  // 발송지연 처리 표시: '발송지연 처리됨 · 10/24까지' (남색). 미룬 새 기한마저 지났으면 '발송지연 기한도 지남' (빨강). 사유는 마우스를 올리면
  app.locals.delayInfo = (reason, shipDue, now = new Date()) => {
    const t = shipDue ? Date.parse(shipDue) : NaN;
    const kst = Number.isFinite(t) ? new Date(t + 9 * 3600 * 1000) : null;
    const title = `발송지연 처리됨 (사유: ${DELAY_REASONS[reason] || reason})`;
    const md = kst ? `${kst.getUTCMonth() + 1}/${kst.getUTCDate()}` : '';
    if (kst && t <= now.getTime()) return { text: `발송지연 기한도 지남 (${md})`, cls: 'due-over', title };
    return { text: `발송지연 처리됨${md ? ` · ${md}까지` : ''}`, cls: 'delayed', title };
  };
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
  // 직원마다 고유 색 (담당자 칸·이름 표시). 직원 번호로 정해서 늘 같은 색, 미지정은 색 없음
  app.locals.staffColor = id => (id ? `staff-c${Number(id) % 10}` : '');
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
        // 주소 검색(카카오 우편번호 서비스, 수기 주문 화면): 그 스크립트와 검색 창만 허용
        scriptSrc: ["'self'", 'https://*.daumcdn.net', 'https://*.kakaocdn.net'],
        frameSrc: ["'self'", 'https://*.daum.net', 'https://*.kakao.com'],
        // blob: = 톡톡 답장에 붙인 사진을 보내기 전에 화면에서 미리 보기
        imgSrc: ["'self'", 'data:', 'blob:'],
        // blob: = 관리자가 알림 소리를 올리기 전에 들어보기
        mediaSrc: ["'self'", 'blob:'],
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
  // 알림 소리 (관리자 › 알림 에서 종류마다 바꾼다)
  const sounds = createSounds(db);
  const weekly = createWeeklyReporter({ db, account: weeklyAccount, transport: weeklyTransport, brandName: () => brand.view().name });
  app.locals.weekly = weekly;
  const logenSvc = logen || createLogen({ db });
  app.locals.logen = logenSvc;
  // 5분마다 (server.js): 출력한 송장번호를 가져와 주문에 넣고, 자동 발송처리가 켜져 있으면 발송처리까지
  const groupOf = (channel, orderId) => db.prepare('SELECT * FROM orders WHERE channel = ? AND channel_order_id = ? ORDER BY id').all(channel, orderId);
  app.locals.logenTick = () => logenSvc.tick({
    onFound: row => notifier.ordersChanged(groupOf(row.channel, row.orderId).map(i => i.id), null),
    dispatch: async row => {
      const target = groupOf(row.channel, row.orderId).find(canDispatch);
      if (!target) return; // 수기 주문·발주확인 전 주문은 직원이 직접
      const r = await actions.dispatch(target.id, null, { method: 'DELIVERY', company: 'KGB', tracking: row.slip });
      if (r.itemIds && r.itemIds.length) notifier.ordersChanged(r.itemIds, null);
    },
  });
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
    // 톡톡 답장 사진: 네이버가 가져가는 1분 동안만 있는 주소 (로그인 없이 — 주소가 추측할 수 없는 긴 글자)
    if (inbox.talktalk.images) {
      app.get('/talk-img/:token', (req, res) => {
        const img = /^[0-9a-f]{48}$/.test(req.params.token) ? inbox.talktalk.images.get(req.params.token) : null;
        if (!img) return res.status(404).end();
        res.set({ 'Content-Type': img.type, 'Cache-Control': 'no-store' }).send(img.content);
      });
    }
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
  // 왼쪽 메뉴의 미답변 건수: 문의함(쇼핑몰 문의·채팅)과 메일함을 따로
  const smartstoreUrlStmt = db.prepare("SELECT value FROM settings WHERE key = 'smartstore_url'");
  const openCountsStmt = db.prepare(`
    SELECT COALESCE(SUM(NOT (source GLOB 'naver_mail*' OR source GLOB 'gmail*') AND source != 'talktalk'), 0) AS inquiries,
      COALESCE(SUM(source GLOB 'naver_mail*' OR source GLOB 'gmail*'), 0) AS mails,
      COALESCE(SUM(source = 'talktalk'), 0) AS chats
    FROM inquiries WHERE status = 'open' AND deleted_at IS NULL
  `);
  app.use((req, res, next) => {
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    // 회사 이름·로고 (관리자 > 회사·로고)
    res.locals.brand = brand.view();
    res.locals.tab = null;
    // 관리자가 바꾼 수기 주문 채널 이름을 반영 (화면은 이 channelInfo 를 쓴다)
    res.locals.channelInfo = currentChannelInfo();
    // 상품 페이지 링크 (스마트스토어는 관리자가 저장한 가게 주소로)
    const storeRow = smartstoreUrlStmt.get();
    res.locals.productUrl = order => productUrl(order, { smartstoreUrl: storeRow ? storeRow.value : null });
    // 주문 목록 위 팝업(iframe) 안에서 열린 화면이면 위쪽 메뉴 없이 내용만 보여준다
    res.locals.embed = req.get('sec-fetch-dest') === 'iframe' || req.query.embed === '1';
    res.locals.pendingCount =
      req.user && req.user.role === 'admin' && req.user.status === 'active' ? pendingCountStmt.get().n : 0;
    res.locals.unassignedAlert = notifier.unassignedBanner(req.user);
    // 위쪽 메뉴의 문의함 미답변 건수
    const open = req.user && req.user.status === 'active' ? openCountsStmt.get() : { inquiries: 0, mails: 0, chats: 0 };
    res.locals.openInquiries = open.inquiries;
    res.locals.openMails = open.mails;
    res.locals.openChats = open.chats;
    // 왼쪽 메뉴 '톡톡' 은 톡톡을 연결했을 때만 보인다
    res.locals.chatOn = Boolean(inbox.talktalk);
    // 이 직원이 끈 알림 칸 (끈 칸은 왼쪽 메뉴 숫자를 숨긴다)
    res.locals.notifyOff = req.user ? notifyOff(req.user) : [];
    // 관리자가 바꾼 알림 소리 (화면이 알림 종류마다 이 소리를 낸다)
    res.locals.soundMap = req.user ? sounds.clientMap() : {};
    next();
  });

  // 문의 답장에 붙인 파일: 보안 검사가 폼 값을 읽을 수 있도록 그 전에 읽는다 (로그인한 직원만)
  app.use('/inbox/:id/reply', replyUpload);
  app.use('/admin/brand/logo', replyUpload);
  app.use('/admin/sounds', replyUpload);
  app.use(csrf);

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use(authRoutes(db, notifier));

  // 여기부터는 로그인 + 승인된 계정만 접근
  // 실시간 소식 통로 (주문 변경, 알림)
  // 관리자가 올린 알림 소리 파일 (주소 끝의 v 가 같으면 브라우저가 오래 저장해 둔다)
  app.get('/sounds/:kind', requireActive, (req, res) => {
    const file = sounds.file(req.params.kind);
    if (!file) return res.status(404).end();
    res.set('Cache-Control', req.query.v === file.v ? 'private, max-age=31536000, immutable' : 'no-cache');
    res.type(file.type).send(file.data);
  });

  app.get('/events', requireActive, (req, res) => {
    notifier.hub.add(req, res, req.user.id);
  });

  // 왼쪽 메뉴의 종 버튼: 메일함·톡톡·문의함 알림 켜기/끄기 (직원마다 따로)
  app.post('/me/notify/:box', requireActive, (req, res) => {
    const box = ['mail', 'chat', 'inbox'].includes(req.params.box) ? req.params.box : null;
    if (!box) return res.status(400).json({ error: '알 수 없는 칸' });
    const off = new Set(notifyOff(req.user));
    if (off.has(box)) off.delete(box);
    else off.add(box);
    db.prepare('UPDATE users SET notify_off = ? WHERE id = ?').run(JSON.stringify([...off]), req.user.id);
    if (req.accepts(['html', 'json']) === 'json') return res.json({ box, off: off.has(box) });
    const back = String(req.body.back || '/');
    res.redirect(/^\/(?!\/)/.test(back) ? back : '/');
  });

  app.use('/admin', requireAdmin, adminRoutes(db, store, collector, notifier, brand, weekly, logenSvc, sounds));
  app.use('/stats', requireAdmin, statsRoutes(db, { staffReport: require('./stats').staffReport }));
  // 수기 주문(/orders/new)을 주문 카드(/orders/:id)보다 먼저 연결한다
  app.use(requireActive, calendarRoutes(db, notifier));
  app.use(requireActive, inboxRoutes(db, { ...inbox, notifier, brandName: () => brand.view().name }));
  app.use(requireActive, templateRoutes(db));
  app.use(requireActive, manualRoutes(db, notifier));
  app.use(requireActive, orderRoutes(db, notifier, actions, collector, logenSvc));

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
