// .env 파일의 값을 process.env 로 읽어온다 (가장 먼저 실행해야 함)
require('dotenv').config({ quiet: true });

const { openDb } = require('./db');
const { createApp } = require('./app');
const { createOrderSource } = require('./channels');
const { createCollector, createMultiCollector } = require('./collector');
const { createCoupangSource, createCoupangWriter } = require('./channels/coupang');
const { createGodoSource, createGodoWriter } = require('./channels/godo');
const { createNotifier } = require('./notifier');
const { createOrderActions } = require('./actions');
const { createSmartstoreWriter } = require('./channels/smartstore');
const { mailAccountsFromEnv, createMailSource, createMailSender, createMailFiles } = require('./inbox/mail');
const { createInboxCollector } = require('./inbox/collector');

const PORT = process.env.PORT || 3000;
// 운영 서버에서는 같은 서버의 Caddy(HTTPS)만 접속할 수 있게 내부 주소에서만 연다
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : undefined);
// 자동 수집 간격은 관리자 화면에서 바꾼다 (처음 값은 .env 의 COLLECT_INTERVAL_MINUTES, 없으면 5분)
const { intervalMinutes, startLoop } = require('./schedule');

const db = openDb();
const notifier = createNotifier({ db });
const source = createOrderSource();
// 채널별 수집기: 스마트스토어(ORDER_SOURCE) + 쿠팡(.env 에 쿠팡 키 3개가 모두 있으면)
const collectors = [];
if (source) collectors.push(createCollector({ db, source, onResult: notifier.afterCollect }));
const coupangReady = ['COUPANG_VENDOR_ID', 'COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY'].every(k => process.env[k]);
if (coupangReady && process.env.COUPANG !== 'off') {
  collectors.push(createCollector({ db, source: createCoupangSource(), onResult: notifier.afterCollect }));
}
// 자사몰: .env 에 GODO_API_KEY 가 있으면. 잠시 끄려면 GODO=off
const godoReady = Boolean(process.env.GODO_API_KEY) && process.env.GODO !== 'off';
if (godoReady) {
  collectors.push(createCollector({ db, source: createGodoSource(), onResult: notifier.afterCollect }));
}
const collector = collectors.length ? createMultiCollector(collectors) : null; // 아무 채널도 없으면 수집 꺼짐
// 발주확인·발송처리를 실제로 네이버에 보내는지: NAVER_WRITE=on 이고 실제 스마트스토어(ORDER_SOURCE=naver)일 때만.
// 그 밖에는 연습 모드 (버튼은 보이지만 네이버로 보내지 않고 기록만 남김)
const liveWrite = process.env.NAVER_WRITE === 'on' && process.env.ORDER_SOURCE === 'naver';
if (process.env.NAVER_WRITE === 'on' && !liveWrite) {
  console.warn('[주의] NAVER_WRITE=on 이지만 ORDER_SOURCE 가 naver 가 아니라서 연습 모드로 실행합니다.');
}
// 쿠팡 상품준비중 처리·송장 업로드: COUPANG_WRITE=on 이고 쿠팡 수집이 켜져 있을 때만 (그 밖에는 연습 모드)
const coupangLive = process.env.COUPANG_WRITE === 'on' && coupangReady && process.env.COUPANG !== 'off';
// 자사몰 발주확인·송장 등록: GODO_WRITE=on 이고 처리용 키(GODO_WRITE_KEY)가 있고 자사몰 수집이 켜져 있을 때만
// 켜면 자사몰 관리자에서 처리한 것과 똑같이 고객에게 알림톡·SMS 가 나간다
const godoLive = process.env.GODO_WRITE === 'on' && Boolean(process.env.GODO_WRITE_KEY) && godoReady;
if (process.env.GODO_WRITE === 'on' && !godoLive) {
  console.warn('[주의] GODO_WRITE=on 이지만 GODO_WRITE_KEY 나 GODO_API_KEY 가 없어서 자사몰은 연습 모드로 실행합니다.');
}
const actions = createOrderActions({
  db,
  writer: liveWrite ? createSmartstoreWriter() : null,
  writers: {
    coupang: coupangLive ? createCoupangWriter() : null,
    godo: godoLive ? createGodoWriter() : null,
  },
});
// 4차 문의함: .env 에 메일 계정(앱 비밀번호)이 있는 것만 받는다. 답장은 MAIL_SEND=on 일 때만 실제로 보냄 (그 밖에는 연습 모드)
const mailAccounts = mailAccountsFromEnv();
const inboxCollector = mailAccounts.length
  ? createInboxCollector({ db, sources: mailAccounts.map(a => createMailSource(a)), notifier })
  : null;
const mailLive = process.env.MAIL_SEND === 'on';
const inbox = {
  collector: inboxCollector,
  sourceLabels: Object.fromEntries(mailAccounts.map(a => [a.source, a.label])),
  senders: mailLive ? Object.fromEntries(mailAccounts.map(a => [a.source, createMailSender(a)])) : {},
  // 첨부파일 열기는 연습 모드여도 된다 (읽기만)
  files: Object.fromEntries(mailAccounts.map(a => [a.source, createMailFiles(a)])),
};
const app = createApp({ db, collector, notifier, actions, inbox });

// 미지정 초과 알림: 1분마다 확인 (해소될 때까지 정해진 간격으로 다시 알림)
setInterval(() => notifier.checkUnassigned(), 60 * 1000).unref();

// 저장 공간: 1시간마다 확인해 80% 를 넘으면 관리자에게 하루 한 번 알림
const { storageInfo } = require('./storage');
const kstDay = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
setInterval(() => notifier.checkStorage(storageInfo(), kstDay()), 60 * 60 * 1000).unref();

// 만료된 로그인 정보를 1시간마다 정리
setInterval(() => app.locals.sessionStore.cleanup(), 60 * 60 * 1000).unref();

// 주문 자동 수집: 켜자마자 한 번, 이후 몇 분마다
async function collect() {
  const result = await collector.run();
  const time = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' });
  if (result.ok) {
    console.log(`[${time}] 주문 수집: 새 주문 ${result.createdOrders}건, 바뀐 상품주문 ${result.updated}건, 지난 주문 보관 ${result.archived || 0}건`);
  } else {
    const counts = result.createdOrders !== undefined ? ` (나머지 채널: 새 주문 ${result.createdOrders}건, 바뀐 상품주문 ${result.updated}건)` : '';
    console.error(`[${time}] 주문 수집 실패: ${result.error}${counts}`);
  }
}
if (collector) startLoop(collect, () => intervalMinutes(db, 'order_interval_minutes'));

// 문의함 자동 받기: 간격은 따로 정한다
async function collectInbox() {
  let result;
  try {
    result = await inboxCollector.run();
  } catch (e) {
    console.error(`문의함 받기 오류: ${e.message}`);
    return;
  }
  const time = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' });
  if (result.ok) console.log(`[${time}] 문의함: 새 문의 ${result.created}건${result.answered ? `, 메일 사이트에서 답장 ${result.answered}건` : ''}`);
  else console.error(`[${time}] 문의함 받기 실패: ${result.errors.join(' / ')}`);
}
if (inboxCollector) startLoop(collectInbox, () => intervalMinutes(db, 'inbox_interval_minutes'));

app.listen(PORT, HOST, () => {
  console.log(`브로애드 인트라넷 실행 중: http://${HOST || 'localhost'}:${PORT}`);
  console.log(`발주확인·발송처리: ${actions.mode === 'live' ? '실제로 네이버에 보냄 (NAVER_WRITE=on)' : '연습 모드 (네이버로 보내지 않음)'}`);
  if (coupangReady) console.log(`쿠팡 상품준비중·송장: ${coupangLive ? '실제로 쿠팡에 보냄 (COUPANG_WRITE=on)' : '연습 모드 (쿠팡으로 보내지 않음)'}`);
  if (godoReady) console.log(`자사몰 발주확인·송장: ${godoLive ? '실제로 자사몰에 보냄 (GODO_WRITE=on)' : '연습 모드 (자사몰로 보내지 않음)'}`);
  if (inboxCollector) {
    console.log(`문의함: ${mailAccounts.map(a => a.label).join(' + ')}, ${intervalMinutes(db, 'inbox_interval_minutes')}분마다, 답장 ${mailLive ? '실제로 보냄 (MAIL_SEND=on)' : '연습 모드 (보내지 않음)'}`);
    collectInbox();
  }
  if (collector) {
    console.log(`주문 출처: ${collector.source.label}, ${intervalMinutes(db, 'order_interval_minutes')}분마다 자동 수집`);
    collect();
  } else {
    console.log('주문 수집: 꺼짐 (ORDER_SOURCE=off)');
  }
});
