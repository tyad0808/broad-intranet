// .env 파일의 값을 process.env 로 읽어온다 (가장 먼저 실행해야 함)
require('dotenv').config({ quiet: true });

const { openDb } = require('./db');
const { createApp } = require('./app');
const { createOrderSource } = require('./channels');
const { createCollector } = require('./collector');

const PORT = process.env.PORT || 3000;
const COLLECT_INTERVAL_MINUTES = Math.max(1, Number(process.env.COLLECT_INTERVAL_MINUTES) || 5);

const db = openDb();
const collector = createCollector({ db, source: createOrderSource() });
collector.intervalMinutes = COLLECT_INTERVAL_MINUTES;
const app = createApp({ db, collector });

// 만료된 로그인 정보를 1시간마다 정리
setInterval(() => app.locals.sessionStore.cleanup(), 60 * 60 * 1000).unref();

// 주문 자동 수집: 켜자마자 한 번, 이후 몇 분마다
async function collect() {
  const result = await collector.run();
  const time = new Date().toLocaleTimeString('ko-KR');
  if (result.ok) {
    console.log(`[${time}] 주문 수집: 새 주문 ${result.created}건, 바뀐 주문 ${result.updated}건`);
  } else {
    console.error(`[${time}] 주문 수집 실패: ${result.error}`);
  }
}
setInterval(collect, COLLECT_INTERVAL_MINUTES * 60 * 1000);

app.listen(PORT, () => {
  console.log(`브로애드 인트라넷 실행 중: http://localhost:${PORT}`);
  console.log(`주문 출처: ${collector.source.label}, ${COLLECT_INTERVAL_MINUTES}분마다 자동 수집`);
  collect();
});
