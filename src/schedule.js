// 자동 수집 간격: 관리자가 '관리자 → 주문 수집' 에서 바꾼다 (settings 에 분 단위로 저장)
// 매번 수집이 끝난 뒤 그때의 설정값만큼 기다렸다가 다음을 하므로, 바꾸면 재시작 없이 다음 회차부터 적용된다.
const INTERVALS = {
  order_interval_minutes: '주문 수집',
  inbox_interval_minutes: '메일 받기',
};
const MIN_MINUTES = 1;
const MAX_MINUTES = 60;

const clamp = n => Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)));

function intervalMinutes(db, key, fallback = Number(process.env.COLLECT_INTERVAL_MINUTES) || 5) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const n = Number(row && row.value);
  return clamp(Number.isFinite(n) && n > 0 ? n : fallback);
}

// run 을 끝날 때마다 다시 예약한다 (겹쳐서 돌지 않음). 반환값: 멈추기 함수
function startLoop(run, minutes) {
  let timer = null;
  let stopped = false;
  const next = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await run(); } catch { /* run 이 기록을 남김 */ }
      next();
    }, minutes() * 60 * 1000);
    timer.unref();
  };
  next();
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { INTERVALS, MIN_MINUTES, MAX_MINUTES, intervalMinutes, startLoop };
