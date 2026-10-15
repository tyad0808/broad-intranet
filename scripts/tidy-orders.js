// 지난 주문 정리: 처음 수집 때 '발주' 카드로 잘못 쌓인 오래된 주문을 마지막 단계(발송)로 옮긴다.
//
// 실행 (미리보기, 아무것도 바꾸지 않음):  npm run tidy-orders
// 실제로 옮기기:                          npm run tidy-orders -- --apply
// 최근 3일 주문 다시 읽기(추가상품 표시 갱신): npm run tidy-orders -- --refetch
// 지난 N일(최대 30일) 주문 다시 읽기:         npm run tidy-orders -- --days 30
//   (인트라넷을 켜기 전부터 진행 중이던 주문을 가져와 판매자센터 건수와 맞춘다)
//
// 직원이 손댄 카드(담당자 지정, 저장 이력 있음)는 절대 건드리지 않는다.
require('dotenv').config({ quiet: true });

const { openDb } = require('../src/db');
const { getSetting, lastStageId, ALREADY_DONE, CANCELED } = require('../src/collector');
const { channelStatusLabel } = require('../src/channels/labels');

function tidyOrders(db, { apply = false } = {}) {
  const early = [Number(getSetting(db, 'stage_new')), Number(getSetting(db, 'stage_confirmed'))].filter(Boolean);
  const last = lastStageId(db);
  const statuses = [...ALREADY_DONE, ...CANCELED];
  const marks = arr => arr.map(() => '?').join(',');

  // 아직 아무도 손대지 않은 초기 단계 카드 중, 채널에서 이미 끝났거나 취소된 주문
  const where = `
    channel_status IN (${marks(statuses)})
    AND stage_id IN (${marks(early)})
    AND assignee_id IS NULL AND version = 0
  `;
  const params = [...statuses, ...early];
  const byStatus = db.prepare(
    `SELECT channel_status, COUNT(*) AS n FROM orders WHERE ${where} GROUP BY channel_status ORDER BY n DESC`
  ).all(...params).map(r => ({ status: r.channel_status, n: r.n }));
  const total = byStatus.reduce((sum, r) => sum + r.n, 0);

  let moved = 0;
  if (apply && total > 0) {
    moved = Number(db.prepare(
      `UPDATE orders SET stage_id = ?, updated_at = datetime('now') WHERE ${where}`
    ).run(last, ...params).changes);
  }
  return { byStatus, total, moved };
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const db = openDb();

  const daysAt = process.argv.indexOf('--days');
  if (daysAt !== -1) {
    const days = Number(process.argv[daysAt + 1]);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      console.log('일수는 1~30 사이 숫자로 적어 주세요. 예: npm run tidy-orders -- --days 30');
      db.close();
      return;
    }
    // 마지막 수집 시각을 N일 전으로 돌리면, 다음 수집 때 그동안 바뀐 주문을 모두 다시 읽는다.
    // 이미 있는 주문은 채널 정보만 고쳐지고, 사내 칸(담당자·단계·메모)은 그대로 남는다.
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const keys = db.prepare("SELECT key FROM settings WHERE key LIKE 'collect_last_to_%'").all().map(r => r.key);
    for (const key of keys.length ? keys : ['collect_last_to_smartstore']) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, from);
    }
    console.log(`다음 수집 때 최근 ${days}일 동안 바뀐 주문을 다시 읽습니다.`);
    console.log('인트라넷 주문 화면에서 [↻ 지금 수집] 을 누르세요 (1~2분 걸릴 수 있음).');
    console.log('수집이 "실패"로 나오면: sudo -u intranet npm run tidy-orders -- --refetch  (최근 3일만 다시 읽기로 되돌림)');
    db.close();
    return;
  }

  if (process.argv.includes('--refetch')) {
    // 마지막 수집 시각을 지우면 다음 수집 때 최근 3일치를 처음처럼 다시 읽는다.
    // 이미 있는 주문은 채널 정보(추가상품 여부 등)만 새로 고쳐지고, 사내 칸은 그대로 남는다.
    db.prepare("DELETE FROM settings WHERE key LIKE 'collect_last_to_%'").run();
    console.log('다음 수집 때 최근 3일 주문을 다시 읽습니다. 인트라넷 관리자 → 주문 수집 → 지금 수집 을 누르세요.');
    db.close();
    return;
  }

  const { byStatus, total, moved } = tidyOrders(db, { apply });
  const remaining = db.prepare(`
    SELECT COUNT(DISTINCT channel || ':' || channel_order_id) AS n FROM orders
    WHERE stage_id IS NULL OR stage_id != (SELECT id FROM work_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1)
  `).get().n;

  console.log(`정리 대상: ${total}건`);
  for (const r of byStatus) console.log(`  - ${channelStatusLabel(r.status)}(${r.status}): ${r.n}건`);
  if (apply) {
    console.log(`\n✔ ${moved}건을 마지막 단계로 옮겼습니다. 남은 진행 중 주문: ${remaining}건`);
  } else {
    console.log(`\n(미리보기입니다. 실제로 옮기려면: npm run tidy-orders -- --apply)`);
  }
  db.close();
}

module.exports = { tidyOrders };
