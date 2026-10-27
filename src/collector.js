// 주문 수집기: 채널(스마트스토어 등)에서 바뀐 주문을 가져와 DB 에 반영한다.
// 몇 분마다 자동으로, 또는 관리자가 "지금 수집" 버튼을 누를 때 실행된다.
const { transaction } = require('./db');

const UNPAID = new Set(['PAYMENT_WAITING', 'CANCELED_BY_NOPAYMENT']); // 결제 전 주문은 카드로 만들지 않는다
// 처음 보는 주문인데 이미 취소된 것 → 작업할 일이 없으므로 카드를 만들지 않는다
const CANCELED = new Set(['CANCELED']);
// 처음 보는 주문인데 이미 배송이 시작됐거나 끝난 것 → 지난 주문이므로 마지막 단계(발송)로 바로 넣는다.
// (최근 며칠 동안 '구매확정' 등으로 상태만 바뀐 오래된 주문이 새 주문처럼 쌓이는 것을 막는다)
const ALREADY_DONE = new Set(['DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED', 'RETURNED']);
const SHIPPED_STATUSES = new Set(['DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED']);
// 채널에서 끝난 주문 (배송 시작·완료, 취소, 반품 등) → '진행 중' 목록과 미지정 알림에서 뺀다
const ENDED = [...new Set([...ALREADY_DONE, ...CANCELED, 'CANCELED_BY_NOPAYMENT'])];
// SQL 에 바로 넣는 목록 (코드에 적힌 상수라 안전)
const ENDED_SQL = ENDED.map(s => `'${s}'`).join(', ');
const OVERLAP_MS = 10 * 60 * 1000; // 경계에서 빠지는 주문이 없도록 지난 수집 끝 시각보다 10분 앞부터 다시 본다

// 마지막 작업 단계 (보통 '발송'): 여기 있는 주문은 끝난 것으로 본다
function lastStageId(db) {
  const row = db.prepare('SELECT id FROM work_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1').get();
  return row ? row.id : null;
}

// 고객이 취소·반품·교환을 '요청'한 상태 (알림을 보낼 시점)
const CLAIM_REQUESTS = new Set(['CANCEL_REQUEST', 'RETURN_REQUEST', 'EXCHANGE_REQUEST']);
function isClaimRequest(status) {
  return CLAIM_REQUESTS.has(status);
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

  const find = db.prepare('SELECT id, stage_id, channel_status, channel_confirmed, claim_status, option_text, channel_status_label, delivery_type, ship_due, ship_delayed, pay_amount, ship_memo, product_no FROM orders WHERE channel = ? AND channel_item_id = ?');
  const insertRow = db.prepare(`
    INSERT INTO orders (channel, channel_order_id, channel_item_id, item_type, product_name, option_text, quantity,
      buyer_name, receiver_name, receiver_phone, receiver_address, paid_at, channel_status, channel_confirmed,
      claim_type, claim_status, channel_status_label, stage_id, assignee_id, due_date, memo, nas_path, delivery_type, ship_due, ship_delayed, pay_amount, ship_memo, product_no)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // 같은 주문번호의 다른 상품이 이미 카드로 있으면 그 카드의 사내 칸(단계·담당자·납기·메모)을 이어받는다
  const groupSibling = db.prepare(
    'SELECT stage_id, assignee_id, due_date, memo, nas_path, design_stage_id FROM orders WHERE channel = ? AND channel_order_id = ? ORDER BY id LIMIT 1'
  );
  const insert = (o, stage) => {
    const sib = groupSibling.get(o.channel, o.channel_order_id);
    const result = insertRow.run(
      o.channel, o.channel_order_id, o.channel_item_id, o.item_type || 'main', o.product_name, o.option_text, o.quantity,
      o.buyer_name, o.receiver_name, o.receiver_phone, o.receiver_address, o.paid_at, o.channel_status, o.channel_confirmed,
      o.claim_type || null, o.claim_status || null, o.channel_status_label || null,
      sib && sib.stage_id ? sib.stage_id : stage, sib ? sib.assignee_id : null,
      sib ? sib.due_date : null, sib ? sib.memo : null, sib ? sib.nas_path : null,
      o.delivery_type || null, o.ship_due || null, o.ship_delayed || null, o.pay_amount ?? null, o.ship_memo || null, o.product_no || null
    );
    // 같은 주문의 디자인 단계도 이어받는다
    if (sib && sib.design_stage_id) {
      db.prepare('UPDATE orders SET design_stage_id = ? WHERE id = ?').run(sib.design_stage_id, result.lastInsertRowid);
    }
    return result;
  };
  // 채널에서 온 칸만 고친다. 담당자·작업 단계·메모 같은 사내 칸은 건드리지 않는다.
  const update = db.prepare(`
    UPDATE orders SET product_name = ?, option_text = ?, quantity = ?, buyer_name = ?, receiver_name = ?,
      receiver_phone = ?, receiver_address = ?, paid_at = ?, channel_status = ?, channel_confirmed = ?,
      item_type = ?, claim_type = ?, claim_status = ?, channel_status_label = ?, delivery_type = ?, ship_due = ?,
      ship_delayed = ?, pay_amount = COALESCE(?, pay_amount), ship_memo = COALESCE(?, ship_memo), product_no = COALESCE(?, product_no), updated_at = datetime('now')
    WHERE id = ?
  `);
  // 발주확인은 주문 단위로 본다: 같은 주문번호에서 아직 '발주' 단계인 상품을 모두 '발주확인'으로
  const moveGroupStage = db.prepare(
    "UPDATE orders SET stage_id = ?, updated_at = datetime('now') WHERE channel = ? AND channel_order_id = ? AND stage_id = ?"
  );
  const notify = db.prepare("INSERT INTO notifications (type, message, order_id) VALUES ('new_order', ?, ?)");
  const markChannelShipped = db.prepare("UPDATE orders SET channel_shipped_at = COALESCE(channel_shipped_at, datetime('now')) WHERE id = ?");
  const endedList = [...ALREADY_DONE, ...CANCELED, 'CANCELED_BY_NOPAYMENT'].map(x => `'${x}'`).join(', ');
  const moveShippedGroup = db.prepare(`
    UPDATE orders SET stage_id = ? WHERE channel = ? AND channel_order_id = ? AND (stage_id IS NULL OR stage_id != ?)
      AND NOT EXISTS (
        SELECT 1 FROM orders x WHERE x.channel = ? AND x.channel_order_id = ?
          AND (x.channel_status IS NULL OR x.channel_status NOT IN (${endedList}))
      )
  `);

  // claims: 이번 수집에서 새로 생긴 취소·반품·교환 요청 (알림용)
  const result = { created: 0, updated: 0, createdIds: [], archived: 0, claims: [] };

  const shippedGroups = new Set();
  transaction(db, () => {
    for (const o of orders) {
      const existing = find.get(o.channel, o.channel_item_id);

      if (!existing) {
        if (UNPAID.has(o.channel_status) || CANCELED.has(o.channel_status)) continue;
        if (ALREADY_DONE.has(o.channel_status)) {
          insert(o, lastStage);
          result.archived += 1; // 알림 없이 '전체' 탭에서만 보인다
          continue;
        }
        const stage = o.channel_confirmed && stageConfirmed ? stageConfirmed : stageNew;
        const info = insert(o, stage);
        if (o.channel_confirmed && stageConfirmed && stageNew) {
          moveGroupStage.run(stageConfirmed, o.channel, o.channel_order_id, stageNew);
        }
        const id = Number(info.lastInsertRowid);
        notify.run(`새 주문: ${o.product_name}${o.option_text ? ` (${o.option_text})` : ''} × ${o.quantity}`, id);
        result.created += 1;
        result.createdIds.push(id);
        continue;
      }

      // 다시 읽기만 한 주문은 상태가 그대로면 건드리지 않는다
      if (o.refreshOnly && existing.channel_status === o.channel_status
        && Number(existing.channel_confirmed) === Number(o.channel_confirmed) && existing.claim_status === (o.claim_status || null)
        && existing.option_text === (o.option_text || null) && existing.channel_status_label === (o.channel_status_label || null)
        && existing.delivery_type === (o.delivery_type || null) && existing.ship_due === (o.ship_due || null)
        && existing.ship_delayed === (o.ship_delayed || null)
        && (o.pay_amount == null || existing.pay_amount === o.pay_amount)
        && (!o.ship_memo || existing.ship_memo === o.ship_memo)
        && (!o.product_no || existing.product_no === o.product_no)) {
        continue;
      }
      update.run(
        o.product_name, o.option_text, o.quantity, o.buyer_name, o.receiver_name, o.receiver_phone,
        o.receiver_address, o.paid_at, o.channel_status, o.channel_confirmed, o.item_type || 'main',
        o.claim_type || null, o.claim_status || null, o.channel_status_label || null,
        o.delivery_type || null, o.ship_due || null, o.ship_delayed || null, o.pay_amount ?? null, o.ship_memo || null, o.product_no || null, existing.id
      );
      // 채널에서 발송됨(배송중·배송완료·구매확정)을 처음 본 때를 발송 시각으로 (주간 보고의 택배 수)
      if (SHIPPED_STATUSES.has(o.channel_status) && !SHIPPED_STATUSES.has(existing.channel_status)) {
        markChannelShipped.run(existing.id);
      }
      if (isClaimRequest(o.claim_status) && o.claim_status !== existing.claim_status) {
        result.claims.push({ id: existing.id, claim_status: o.claim_status });
      }
      // 판매자센터에서 발주확인됨 → 카드가 아직 '발주' 단계면 '발주확인' 으로 옮긴다.
      // 직원이 이미 다음 단계로 옮겼다면 그대로 둔다 (뒤로 되돌리지 않음).
      if (o.channel_confirmed && stageConfirmed && stageNew) {
        moveGroupStage.run(stageConfirmed, o.channel, o.channel_order_id, stageNew);
      }
      if (ALREADY_DONE.has(o.channel_status)) shippedGroups.add(JSON.stringify([o.channel, o.channel_order_id]));
      result.updated += 1;
    }
    // 판매자센터에서 바로 발송처리한 주문: 묶음이 모두 끝났고(발송·취소 등) 하나라도 발송됐으면 '발송' 단계로.
    // 같은 수집에 들어온 추가상품까지 다 넣은 뒤에 판단한다
    for (const key of shippedGroups) {
      const [channel, orderId] = JSON.parse(key);
      if (lastStage) moveShippedGroup.run(lastStage, channel, orderId, lastStage, channel, orderId);
    }
  });

  // 새로 생긴 '주문' 수 (본상품 + 추가상품은 1건)
  result.createdOrders = result.createdIds.length
    ? db.prepare(
      `SELECT COUNT(DISTINCT channel || ':' || channel_order_id) AS n FROM orders WHERE id IN (${result.createdIds.map(() => '?').join(',')})`
    ).get(...result.createdIds).n
    : 0;
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
      let orders = await source.fetchChanges({ from, to });
      // 발주확인 전 주문은 지금 상태를 따로 다시 읽는다 (판매자센터에서 바로 발주확인한 것을 알아내기 위해).
      // 오늘출발·발송기한을 아직 모르는 발송 전 주문(이 기능 전에 받은 주문)도 한 번 다시 읽는다.
      // 발송기한이 지났거나 하루 안에 다가오는 발송 전 주문도 다시 읽는다 (판매자센터에서 '발송지연 처리' 했으면 새 기한으로).
      // 바뀐 게 없으면 '바뀐 주문' 건수에는 넣지 않는다
      if (source.fetchByIds) {
        const seen = new Set(orders.map(o => o.channel_item_id));
        const soon = new Date(to.getTime() + 24 * 3600 * 1000).toISOString();
        const open = db.prepare(
          `SELECT channel_item_id FROM orders WHERE channel = ? AND channel_status = 'PAYED'
             AND (channel_confirmed = 0 ${source.fillsDeliveryType ? 'OR delivery_type IS NULL OR ship_due < ?' : ''})`
        ).all(source.channel, ...(source.fillsDeliveryType ? [soon] : [])).map(r => r.channel_item_id).filter(id => !seen.has(id));
        if (open.length) {
          const fresh = await source.fetchByIds(open);
          orders = orders.concat(fresh.map(o => ({ ...o, refreshOnly: true })));
        }
      }
      // 인트라넷에선 진행 중인데 이번에 안 나온 주문 다시 확인 (자사몰: 관리자에서 삭제된 주문 찾기)
      if (source.verifyOpen) {
        const seen = new Set(orders.map(o => o.channel_order_id));
        const rows = db.prepare(
          `SELECT * FROM orders WHERE channel = ? AND (channel_status IS NULL OR channel_status NOT IN (${ENDED_SQL}))`
        ).all(source.channel).filter(r => !seen.has(r.channel_order_id));
        if (rows.length) {
          const checked = await source.verifyOpen(rows);
          orders = orders.concat(checked.map(o => ({ ...o, refreshOnly: true })));
        }
      }
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

// 여러 채널(스마트스토어 + 쿠팡 …)을 한 번에: '지금 수집' 과 자동 수집이 모두 돌게 한다.
// 한 채널이 실패해도 다른 채널은 그대로 수집한다
function createMultiCollector(collectors) {
  if (collectors.length === 1) return collectors[0];
  return {
    source: {
      label: collectors.map(c => c.source.label).join(' + '),
      isMock: collectors.some(c => c.source.isMock),
    },
    collectors,
    async run() {
      const results = [];
      for (const c of collectors) results.push(await c.run());
      const ok = results.filter(r => r.ok);
      const failed = results.map((r, i) => (r.ok ? null : `${collectors[i].source.label}: ${r.error}`)).filter(Boolean);
      const sum = key => ok.reduce((n, r) => n + (r[key] || 0), 0);
      return {
        ok: failed.length === 0,
        error: failed.join(' / ') || undefined,
        created: sum('created'),
        createdOrders: sum('createdOrders'),
        updated: sum('updated'),
        archived: sum('archived'),
        createdIds: ok.flatMap(r => r.createdIds || []),
        claims: ok.flatMap(r => r.claims || []),
      };
    },
  };
}

module.exports = { createCollector, createMultiCollector, applyOrders, getSetting, setSetting, lastStageId, isClaimRequest, ALREADY_DONE, CANCELED, ENDED, ENDED_SQL };
