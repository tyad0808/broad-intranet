// .env 파일의 값을 process.env 로 읽어온다 (가장 먼저 실행해야 함)
require('dotenv').config({ quiet: true });

const { openDb } = require('./db');
const { createApp } = require('./app');
const { createOrderSource } = require('./channels');
const { createCollector } = require('./collector');
const { createNotifier } = require('./notifier');
const { createOrderActions } = require('./actions');
const { createSmartstoreWriter } = require('./channels/smartstore');

const PORT = process.env.PORT || 3000;
// 운영 서버에서는 같은 서버의 Caddy(HTTPS)만 접속할 수 있게 내부 주소에서만 연다
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : undefined);
const COLLECT_INTERVAL_MINUTES = Math.max(1, Number(process.env.COLLECT_INTERVAL_MINUTES) || 5);

const db = openDb();
const notifier = createNotifier({ db });
const source = createOrderSource();
const collector = source
  ? createCollector({ db, source, onResult: notifier.afterCollect })
  : null; // ORDER_SOURCE=off
if (collector) collector.intervalMinutes = COLLECT_INTERVAL_MINUTES;
// 발주확인·발송처리를 실제로 네이버에 보내는지: NAVER_WRITE=on 이고 실제 스마트스토어(ORDER_SOURCE=naver)일 때만.
// 그 밖에는 연습 모드 (버튼은 보이지만 네이버로 보내지 않고 기록만 남김)
const liveWrite = process.env.NAVER_WRITE === 'on' && process.env.ORDER_SOURCE === 'naver';
if (process.env.NAVER_WRITE === 'on' && !liveWrite) {
  console.warn('[주의] NAVER_WRITE=on 이지만 ORDER_SOURCE 가 naver 가 아니라서 연습 모드로 실행합니다.');
}
const actions = createOrderActions({ db, writer: liveWrite ? createSmartstoreWriter() : null });
const app = createApp({ db, collector, notifier, actions });

// 미지정 초과 알림: 1분마다 확인 (해소될 때까지 정해진 간격으로 다시 알림)
setInterval(() => notifier.checkUnassigned(), 60 * 1000).unref();

// 만료된 로그인 정보를 1시간마다 정리
setInterval(() => app.locals.sessionStore.cleanup(), 60 * 60 * 1000).unref();

// 주문 자동 수집: 켜자마자 한 번, 이후 몇 분마다
async function collect() {
  const result = await collector.run();
  const time = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' });
  if (result.ok) {
    console.log(`[${time}] 주문 수집: 새 주문 ${result.createdOrders}건, 바뀐 상품주문 ${result.updated}건, 지난 주문 보관 ${result.archived || 0}건`);
  } else {
    console.error(`[${time}] 주문 수집 실패: ${result.error}`);
  }
}
if (collector) setInterval(collect, COLLECT_INTERVAL_MINUTES * 60 * 1000);

app.listen(PORT, HOST, () => {
  console.log(`브로애드 인트라넷 실행 중: http://${HOST || 'localhost'}:${PORT}`);
  console.log(`발주확인·발송처리: ${actions.mode === 'live' ? '실제로 네이버에 보냄 (NAVER_WRITE=on)' : '연습 모드 (네이버로 보내지 않음)'}`);
  if (collector) {
    console.log(`주문 출처: ${collector.source.label}, ${COLLECT_INTERVAL_MINUTES}분마다 자동 수집`);
    collect();
  } else {
    console.log('주문 수집: 꺼짐 (ORDER_SOURCE=off)');
  }
});
