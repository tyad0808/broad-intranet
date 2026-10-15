// 주문 수집기: 채널(스마트스토어 등)에서 바뀐 주문을 가져와 DB 에 반영한다.
// 몇 분마다 자동으로, 또는 관리자가 "지금 수집" 버튼을 누를 때 실행된다.
const { transaction } = require('./db');

const UNPAID = new Set(['PAYMENT_WAITING', 'CANCELED_BY_NOPAYMENT']); // 결제 전 주문은 카드로 만들지 않는다
// 처음 보는 주문인데 이미 취소된 것 → 작업할 일이 없으므로 카드를 만들지 않는다
const CANCELED = new Set(['CANCELED']);
// 처음 보는 주문인데 이미 배송이 시작됐거나 끝난 것 → 지난 주문이므로 마지막 단계(발송)로 바로 넣는다.
// (최근 며칠 동안 '구매확정' 등으로 상태만 바뀐 오래된 주문이 새 주문처럼 쌓이는 것을 막는다)
const ALREADY_DONE = new Set(['DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED', 'RETURNED']);
const OVERLAP_MS = 10 * 60 * 1000; // 경계에서 빠지는 주문이 없도록 지난 수집 끝 시각보다 10분 앞부터 다시 본다

// 마지막 작업 단계 (보통 '발송'): 여기 있는 주문은 끝난 것으로 본다
function lastStageId(db) {
  const row = db.prepare('SELECT id FROM work_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1').get();
  return row ? row.id : null;
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// 가져온 주문들을 DB 에 반영하고, 몇 건이 새로 생겼고 몇 건이 바뀌었는지 돌려준다
function applyOrders(db, orders) {
  const stageNew = Number(getSetting(db, 'stage_new')) || null;
  const stageConfirmed = Number(getSetting(db, 'stage_confirmed')) || null;
  const lastStage = lastStageId(db);

  const find = db.prepare('SELECT id, stage_id, channel_confirmed FROM orders WHERE channel = ? AND channel_item_id = ?');
  const insert = db.prepare(`
    INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, option_text, quantity,
      buyer_name, receiver_name, receiver_phone, receiver_address, paid_at, channel_status, channel_confirmed, stage_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // 채널에서 온 칸만 고친다. 담당자·작업 단계·메모 같은 사내 칸은 건드리지 않는다.
  const update = db.prepare(`
    UPDATE orders SET product_name = ?, option_text = ?, quantity = ?, buyer_name = ?, receiver_name = ?,
      receiver_phone = ?, receiver_address = ?, paid_at = ?, channel_status = ?, channel_confirmed = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);
  const moveStage = db.prepare("UPDATE orders SET stage_id = ?, updated_at = datetime('now') WHERE id = ?");
  const notify = db.prepare("INSERT INTO notifications (type, message, order_id) VALUES ('new_order', ?, ?)");

  const result = { created: 0, updated: 0, createdIds: [], archived: 0 };

  transaction(db, () => {
    for (const o of orders) {
      const existing = find.get(o.channel, o.channel_item_id);

      if (!existing) {
        if (UNPAID.has(o.channel_status) || CANCELED.has(o.channel_status)) continue;
        if (ALREADY_DONE.has(o.channel_status)) {
          insert.run(
            o.channel, o.channel_order_id, o.channel_item_id, o.product_name, o.option_text, o.quantity,
            o.buyer_name, o.receiver_name, o.receiver_phone, o.receiver_address, o.paid_at,
            o.channel_status, o.channel_confirmed, lastStage
          );
          result.archived += 1; // 알림 없이 '전체' 탭에서만 보인다
          continue;
        }
        const stage = o.channel_confirmed && stageConfirmed ? stageConfirmed : stageNew;
        const info = insert.run(
          o.channel, o.channel_order_id, o.channel_item_id, o.product_name, o.option_text, o.quantity,
          o.buyer_name, o.receiver_name, o.receiver_phone, o.receiver_address, o.paid_at,
          o.channel_status, o.channel_confirmed, stage
        );
        const id = Number(info.lastInsertRowid);
        notify.run(`새 주문: ${o.product_name}${o.option_text ? ` (${o.option_text})` : ''} × ${o.quantity}`, id);
        result.created += 1;
        result.createdIds.push(id);
        continue;
      }

      update.run(
        o.product_name, o.option_text, o.quantity, o.buyer_name, o.receiver_name, o.receiver_phone,
        o.receiver_address, o.paid_at, o.channel_status, o.channel_confirmed, existing.id
      );
      // 판매자센터에서 발주확인됨 → 카드가 아직 '발주' 단계면 '발주확인' 으로 옮긴다.
      // 직원이 이미 다음 단계로 옮겼다면 그대로 둔다 (뒤로 되돌리지 않음).
      if (o.channel_confirmed && stageConfirmed && existing.stage_id === stageNew) {
        moveStage.run(stageConfirmed, existing.id);
      }
      result.updated += 1;
    }
  });

  return result;
}

function createCollector({ db, source, now = () => new Date(), initialHours = 72, onResult = () => {} }) {
  const lastKey = `collect_last_to_${source.channel}`;
  let running = null;

  async function runOnce() {
    const to = now();
    const last = getSetting(db, lastKey);
    const from = last
      ? new Date(new Date(last).getTime() - OVERLAP_MS)
      : new Date(to.getTime() - initialHours * 60 * 60 * 1000); // 처음에는 최근 3일치

    const run = db.prepare(
      'INSERT INTO collect_runs (channel, started_at, range_from, range_to) VALUES (?, ?, ?, ?)'
    ).run(source.channel, to.toISOString(), from.toISOString(), to.toISOString());
    const runId = Number(run.lastInsertRowid);

    try {
      const orders = await source.fetchChanges({ from, to });
      const result = applyOrders(db, orders);
      setSetting(db, lastKey, to.toISOString());
      db.prepare(
        "UPDATE collect_runs SET finished_at = datetime('now'), ok = 1, fetched = ?, created = ?, updated = ? WHERE id = ?"
      ).run(orders.length, result.created, result.updated, runId);
      return { ok: true, fetched: orders.length, ...result };
    } catch (err) {
      db.prepare("UPDATE collect_runs SET finished_at = datetime('now'), ok = 0, error = ? WHERE id = ?")
        .run(String(err.message).slice(0, 500), runId);
      return { ok: false, error: err.message };
    }
  }

  return {
    source,
    // 이미 수집 중이면 새로 시작하지 않고 진행 중인 결과를 같이 기다린다 (중복 실행 방지)
    run() {
      if (!running) {
        running = runOnce()
          .then(result => {
            // 수집이 끝나면 알림·화면 갱신 (실패해도 수집 결과는 그대로 돌려준다)
            try { onResult(result); } catch (err) { console.error('수집 후 알림 실패:', err); }
            return result;
          })
          .finally(() => { running = null; });
      }
      return running;
    },
  };
}

module.exports = { createCollector, applyOrders, getSetting, setSetting, lastStageId, ALREADY_DONE, CANCELED };
