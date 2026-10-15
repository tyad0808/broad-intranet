// 지난 주문 정리: 처음 수집 때 '발주' 카드로 잘못 쌓인 오래된 주문을 마지막 단계(발송)로 옮긴다.
//
// 실행 (미리보기, 아무것도 바꾸지 않음):  npm run tidy-orders
// 실제로 옮기기:                          npm run tidy-orders -- --apply
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
  const { byStatus, total, moved } = tidyOrders(db, { apply });
  const remaining = db.prepare(`
    SELECT COUNT(*) AS n FROM orders
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
