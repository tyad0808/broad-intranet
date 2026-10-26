// 수기 주문: 계좌이체·전화 주문처럼 쇼핑몰을 거치지 않은 주문을 직원이 직접 등록한다.
//
// 스마트스토어 주문과 같은 orders 표에 channel = 'manual' 로 넣는다. 그래서 목록·담당자·작업 단계·알림이 똑같이 동작한다.
// 채널 상태는 같은 코드를 쓴다: 입금대기(PAYMENT_WAITING) → 입금완료(PAYED) → 발송완료(DELIVERED), 취소(CANCELED)
// 네이버 등 바깥으로는 아무것도 보내지 않는다. 처리 기록은 order_actions 에 mode = 'local' 로 남긴다.
const express = require('express');
const { transaction } = require('../db');
const { getSetting, lastStageId } = require('../collector');
const { checkDispatchInput, describeShipping } = require('../actions');
const { SHIP_METHODS, COURIERS, DEFAULT_METHOD, DEFAULT_COURIER } = require('../channels/shipping');

const CHANNEL = 'manual';
const PAY_METHODS = { BANK: '계좌이체', CARD: '카드', CASH: '현금', ETC: '기타' };
const MAX_ITEMS = 20;

function manualRoutes(db, notifier) {
  const router = express.Router();

  const designers = () => db.prepare(`
    SELECT u.id, u.name FROM users u JOIN jobs j ON j.id = u.job_id
    WHERE u.status = 'active' AND j.is_designer = 1 ORDER BY u.name
  `).all();
  // 수기 주문 출처: 새로 고를 수 있는 것은 숨기지 않은 출처만 (수정할 때는 원래 출처도 그대로 둘 수 있다)
  const sources = keepId => db.prepare(
    'SELECT id, name, active FROM order_sources WHERE active = 1 OR id = ? ORDER BY sort_order'
  ).all(Number(keepId) || 0);
  const findOrder = id => db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
  const groupItems = order => db.prepare(
    "SELECT * FROM orders WHERE channel = ? AND channel_order_id = ? ORDER BY CASE WHEN item_type = 'addon' THEN 1 ELSE 0 END, id"
  ).all(order.channel, order.channel_order_id);
  const log = db.prepare(`
    INSERT INTO order_actions (user_id, action, channel, channel_order_id, item_ids, detail, mode, result, message)
    VALUES (?, ?, 'manual', ?, ?, ?, 'local', 'ok', ?)
  `);
  const record = (userId, action, order, items, message, detail = null) =>
    log.run(userId, action, order.channel_order_id, JSON.stringify(items.map(i => i.channel_item_id)),
      detail ? JSON.stringify(detail) : null, message);

  function renderForm(res, { status = 200, mode, order = null, values, items, error = null, back = '/' }) {
    res.status(status).render('orders/manual-form', {
      title: mode === 'new' ? '수기 주문 등록' : '수기 주문 수정',
      mode, order, values, items, error, back,
      designers: designers(), PAY_METHODS,
      sources: sources(order && order.source_id),
    });
  }

  // ───────── 등록 ─────────
  router.get('/orders/new', (req, res) => {
    renderForm(res, {
      mode: 'new',
      values: { pay_method: 'BANK', pay_status: 'waiting', source_id: (sources()[0] || {}).id },
      items: [{}, {}, {}],
      back: safeBack(req.query.back),
    });
  });

  router.post('/orders/new', (req, res) => {
    const back = safeBack(req.body.back);
    const input = parseInput(req.body, {
      designerIds: new Set(designers().map(d => d.id)), sourceIds: new Set(sources().map(s => s.id)), isNew: true,
    });
    if (input.error) {
      return renderForm(res, { status: 400, mode: 'new', values: req.body, items: input.rawItems, error: input.error, back });
    }
    const orderId = nextOrderId();
    const stageNew = Number(getSetting(db, 'stage_new')) || null;
    const nowIso = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO orders (channel, channel_order_id, channel_item_id, item_type, product_name, option_text, quantity,
        buyer_name, buyer_phone, receiver_name, receiver_phone, receiver_address, paid_at, channel_status, channel_confirmed,
        stage_id, assignee_id, due_date, memo, pay_method, amount, depositor, source_id, source_order_no, receiver_address_detail)
      VALUES (?, ?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ids = transaction(db, () => {
      const created = input.items.map((it, n) => Number(insert.run(
        CHANNEL, orderId, `${orderId}-${n + 1}`, it.name, it.option, it.qty,
        input.buyer_name, input.buyer_phone, input.receiver_name, input.receiver_phone, input.receiver_address,
        nowIso, input.pay_status === 'paid' ? 'PAYED' : 'PAYMENT_WAITING',
        stageNew, input.assignee_id, input.due_date, input.memo, input.pay_method, input.amount, input.depositor,
        input.source_id, input.source_order_no, input.receiver_address_detail
      ).lastInsertRowid));
      const order = { channel_order_id: orderId };
      const items = created.map(id => findOrder(id));
      record(req.user.id, 'create', order, items, `등록 (${PAY_METHODS[input.pay_method]}, ${input.pay_status === 'paid' ? '입금완료' : '입금대기'})`);
      db.prepare("INSERT INTO notifications (type, message, order_id) VALUES ('new_order', ?, ?)")
        .run(`수기 주문: ${input.items[0].name}`, created[0]);
      return created;
    });

    notifier.notify('new_order', {
      title: '수기 주문 등록',
      body: `${input.items[0].name}${input.items.length > 1 ? ` 외 ${input.items.length - 1}개` : ''} (${req.user.name})`,
      url: `/orders/${ids[0]}`,
    }, userId => userId !== req.user.id);
    notifier.ordersChanged(ids, req.user.id);
    notifier.checkUnassigned();
    req.session.flash = { type: 'ok', message: `수기 주문을 등록했습니다 (주문번호 ${orderId}).` };
    res.redirect(`/orders/${ids[0]}${back !== '/' ? `?back=${encodeURIComponent(back)}` : ''}`);
  });

  // ───────── 수정 ─────────
  router.get('/orders/:id/manual-edit', (req, res) => {
    const order = findOrder(req.params.id);
    if (!order || order.channel !== CHANNEL) return notFound(res);
    const items = groupItems(order);
    renderForm(res, {
      mode: 'edit',
      order,
      values: { ...order, ...splitAddress(order) },
      items: items.map(i => ({ id: i.id, name: i.product_name, option: i.option_text, qty: i.quantity })),
      back: safeBack(req.query.back),
    });
  });

  router.post('/orders/:id/manual-edit', (req, res) => {
    const order = findOrder(req.params.id);
    if (!order || order.channel !== CHANNEL) return notFound(res);
    const back = safeBack(req.body.back);
    const items = groupItems(order);
    if (Number(req.body.version) !== order.version) {
      req.session.flash = { type: 'error', message: '다른 직원이 이 주문을 먼저 수정했습니다. 바뀐 내용을 확인하고 다시 고쳐 주세요.' };
      return res.redirect(selfUrl(order.id, back));
    }
    const designerIds = new Set(designers().map(d => d.id));
    if (order.assignee_id) designerIds.add(order.assignee_id); // 원래 담당자는 그대로 둘 수 있다
    const sourceIds = new Set(sources(order.source_id).map(s => s.id));
    const input = parseInput(req.body, { designerIds, sourceIds, isNew: false, itemIds: new Set(items.map(i => i.id)) });
    if (input.error) {
      return renderForm(res, { status: 400, mode: 'edit', order, values: { ...order, ...req.body }, items: input.rawItems, error: input.error, back });
    }
    transaction(db, () => {
      db.prepare(`
        UPDATE orders SET buyer_name = ?, buyer_phone = ?, receiver_name = ?, receiver_phone = ?, receiver_address = ?, receiver_address_detail = ?,
          pay_method = ?, amount = ?, depositor = ?, assignee_id = ?, due_date = ?, memo = ?,
          source_id = ?, source_order_no = ?,
          version = version + 1, updated_at = datetime('now')
        WHERE channel = ? AND channel_order_id = ?
      `).run(input.buyer_name, input.buyer_phone, input.receiver_name, input.receiver_phone, input.receiver_address, input.receiver_address_detail,
        input.pay_method, input.amount, input.depositor, input.assignee_id, input.due_date, input.memo,
        input.source_id, input.source_order_no,
        CHANNEL, order.channel_order_id);
      const updateItem = db.prepare(
        'UPDATE orders SET product_name = ?, option_text = ?, quantity = ? WHERE id = ? AND channel = ? AND channel_order_id = ?'
      );
      const insertItem = db.prepare(`
        INSERT INTO orders (channel, channel_order_id, channel_item_id, item_type, product_name, option_text, quantity,
          buyer_name, buyer_phone, receiver_name, receiver_phone, receiver_address, paid_at, channel_status, channel_confirmed,
          stage_id, assignee_id, due_date, memo, nas_path, pay_method, amount, depositor, version, design_stage_id,
          source_id, source_order_no, receiver_address_detail)
        SELECT channel, channel_order_id, ?, 'main', ?, ?, ?, buyer_name, buyer_phone, receiver_name, receiver_phone, receiver_address,
          paid_at, channel_status, 1, stage_id, assignee_id, due_date, memo, nas_path, pay_method, amount, depositor, version, design_stage_id,
          source_id, source_order_no, receiver_address_detail
        FROM orders WHERE id = ?
      `);
      let seq = Math.max(0, ...items.map(i => Number(String(i.channel_item_id).split('-').pop()) || 0));
      for (const it of input.items) {
        if (it.id) updateItem.run(it.name, it.option, it.qty, it.id, CHANNEL, order.channel_order_id);
        else insertItem.run(`${order.channel_order_id}-${++seq}`, it.name, it.option, it.qty, items[0].id);
      }
      record(req.user.id, 'edit', order, items, '주문 정보 수정');
    });
    notifier.ordersChanged(groupItems(order).map(i => i.id), req.user.id);
    notifier.checkUnassigned();
    req.session.flash = { type: 'ok', message: '수기 주문을 수정했습니다.' };
    res.redirect(selfUrl(order.id, back));
  });

  // ───────── 입금 확인 · 발송 기록 · 취소 ─────────
  // 상태를 바꾸는 공통 순서: 주문 확인 → 지금 상태에서 할 수 있는지 → 바꾸고 기록
  function change(req, res, { allowed, apply, action, message }) {
    const order = findOrder(req.params.id);
    if (!order || order.channel !== CHANNEL) return notFound(res);
    const back = safeBack(req.body.back);
    const items = groupItems(order);
    const reason = allowed(order);
    if (reason !== true) {
      req.session.flash = { type: 'error', message: reason };
      return res.redirect(selfUrl(order.id, back));
    }
    const result = transaction(db, () => {
      const r = apply(order);
      if (r && r.error) return r;
      db.prepare("UPDATE orders SET version = version + 1, updated_at = datetime('now') WHERE channel = ? AND channel_order_id = ?")
        .run(CHANNEL, order.channel_order_id);
      record(req.user.id, action, order, items, typeof message === 'function' ? message(r) : message, r && r.detail);
      return r;
    });
    if (result && result.error) {
      req.session.flash = { type: 'error', message: result.error };
      return res.redirect(selfUrl(order.id, back));
    }
    notifier.ordersChanged(items.map(i => i.id), req.user.id);
    notifier.checkUnassigned();
    req.session.flash = { type: 'ok', message: typeof message === 'function' ? message(result) : message };
    res.redirect(selfUrl(order.id, back));
  }

  router.post('/orders/:id/manual/paid', (req, res) => change(req, res, {
    action: 'paid',
    message: '입금 확인했습니다.',
    allowed: o => o.channel_status === 'PAYMENT_WAITING' || '입금대기 상태인 주문만 입금 확인할 수 있습니다.',
    apply: o => {
      db.prepare("UPDATE orders SET channel_status = 'PAYED' WHERE channel = ? AND channel_order_id = ? AND channel_status = 'PAYMENT_WAITING'")
        .run(CHANNEL, o.channel_order_id);
    },
  }));

  router.post('/orders/:id/manual/dispatch', (req, res) => change(req, res, {
    action: 'dispatch',
    message: r => `발송 완료로 기록했습니다 (${describeShipping(r.detail)}).`,
    allowed: o => ['PAYED', 'PAYMENT_WAITING'].includes(o.channel_status) || '이미 발송했거나 취소된 주문입니다.',
    apply: o => {
      const input = checkDispatchInput({ method: req.body.method, company: req.body.company, tracking: req.body.tracking });
      if (input.error) return { error: input.error };
      db.prepare(`
        UPDATE orders SET ship_method = ?, ship_company = ?, tracking_no = ?, shipped_at = datetime('now'), channel_status = 'DELIVERED'
        WHERE channel = ? AND channel_order_id = ? AND channel_status IN ('PAYED', 'PAYMENT_WAITING')
      `).run(input.method, input.company, input.tracking, CHANNEL, o.channel_order_id);
      const last = lastStageId(db);
      if (last) db.prepare('UPDATE orders SET stage_id = ? WHERE channel = ? AND channel_order_id = ?').run(last, CHANNEL, o.channel_order_id);
      return { detail: input };
    },
  }));

  router.post('/orders/:id/manual/cancel', (req, res) => change(req, res, {
    action: 'cancel',
    message: '주문을 취소했습니다.',
    allowed: o => o.channel_status !== 'CANCELED' || '이미 취소된 주문입니다.',
    apply: o => {
      db.prepare("UPDATE orders SET channel_status = 'CANCELED' WHERE channel = ? AND channel_order_id = ?")
        .run(CHANNEL, o.channel_order_id);
    },
  }));

  // 수기 주문 삭제: 잘못 넣었거나 필요 없는 주문을 통째로 (상품·알림·처리 기록·로젠 기록까지). 되돌릴 수 없다
  //   채널(스마트스토어 등)에서 들어온 주문은 지울 수 없다 — 다음 수집 때 다시 들어오기 때문
  router.post('/orders/:id/manual/delete', (req, res) => {
    const order = findOrder(req.params.id);
    if (!order || order.channel !== CHANNEL) return notFound(res);
    const back = safeBack(req.body.back);
    const ids = deleteOrders([order], req.user.id);
    notifier.ordersChanged(ids, req.user.id);
    notifier.checkUnassigned();
    const result = { type: 'ok', message: `수기 주문 ${order.channel_order_id} 을(를) 지웠습니다.` };
    // 주문 목록 위 팝업에서 지웠으면 팝업 안에 결과만 (닫으면 목록이 새로 그려진다)
    if (res.locals.embed) return res.render('orders/bulk-done', { title: '삭제', result });
    req.session.flash = result;
    res.redirect(back);
  });

  // 주문 목록에서 체크한 주문 중 수기 주문만 한꺼번에 지운다 (다른 채널 주문은 건너뛴다)
  router.post('/orders/bulk/manual-delete', (req, res) => {
    const back = safeBack(req.body.back);
    const raw = Array.isArray(req.body.ids) ? req.body.ids : req.body.ids ? [req.body.ids] : [];
    const picked = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 300).map(findOrder).filter(Boolean);
    const orders = picked.filter(o => o.channel === CHANNEL);
    const skipped = picked.length - orders.length;
    if (!orders.length) {
      req.session.flash = { type: 'error', message: '지울 수 있는 주문이 없습니다. 직접 등록한 주문만 지울 수 있어요.' };
      return res.redirect(back);
    }
    const ids = deleteOrders(orders, req.user.id);
    notifier.ordersChanged(ids, req.user.id);
    notifier.checkUnassigned();
    const groups = new Set(orders.map(o => o.channel_order_id)).size;
    req.session.flash = {
      type: 'ok',
      message: `수기 주문 ${groups}건을 지웠습니다.${skipped ? ` (쇼핑몰 주문 ${skipped}건은 지울 수 없어 건너뛰었어요)` : ''}`,
    };
    res.redirect(back);
  });

  // 주문 묶음(주문번호)째로 상품·알림·처리 기록·로젠 기록까지 지운다. 지운 주문 줄 id 를 돌려준다
  function deleteOrders(orders, userId) {
    const ids = [];
    transaction(db, () => {
      const delNotes = db.prepare('DELETE FROM notifications WHERE order_id = ?');
      const done = new Set();
      for (const order of orders) {
        if (done.has(order.channel_order_id)) continue;
        done.add(order.channel_order_id);
        const items = groupItems(order);
        for (const i of items) { delNotes.run(i.id); ids.push(i.id); }
        for (const table of ['order_actions', 'order_events', 'logen_shipments']) {
          db.prepare(`DELETE FROM ${table} WHERE channel = ? AND channel_order_id = ?`).run(CHANNEL, order.channel_order_id);
        }
        db.prepare('DELETE FROM orders WHERE channel = ? AND channel_order_id = ?').run(CHANNEL, order.channel_order_id);
        console.log(`[수기 주문 삭제] ${order.channel_order_id} '${items[0].product_name}' · 직원 ${userId}`);
      }
    });
    return ids;
  }

  // 수기 주문번호: M + 한국 날짜(YYMMDD) + 순번. 예) M261016-001
  function nextOrderId() {
    const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(2, 10).replace(/-/g, '');
    const prefix = `M${day}-`;
    const row = db.prepare(
      'SELECT MAX(CAST(substr(channel_order_id, ?) AS INTEGER)) AS n FROM orders WHERE channel = ? AND channel_order_id LIKE ?'
    ).get(prefix.length + 1, CHANNEL, `${prefix}%`);
    return `${prefix}${String((row.n || 0) + 1).padStart(3, '0')}`;
  }

  return router;
}

// 입력 검사. 오류가 있으면 { error, rawItems } (화면에 입력값을 그대로 다시 보여주기 위해)
function parseInput(body, { designerIds, sourceIds = new Set(), isNew, itemIds = new Set() }) {
  const list = v => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const text = (v, max) => String(v || '').trim().slice(0, max) || null;
  const names = list(body.item_name);
  const options = list(body.item_option);
  const qtys = list(body.item_qty);
  const ids = list(body.item_id);
  const rawItems = names.map((name, n) => ({ id: isNew ? null : Number(ids[n]) || null, name, option: options[n], qty: qtys[n] }));
  const fail = error => ({ error, rawItems: rawItems.length ? rawItems : [{}] });

  const items = [];
  for (const raw of rawItems) {
    const name = text(raw.name, 200);
    if (!name) {
      if (raw.id) return fail('상품명은 비울 수 없습니다. 상품을 빼려면 주문을 취소하고 새로 등록하세요.');
      continue; // 빈 줄은 건너뛴다
    }
    const qty = raw.qty === undefined || String(raw.qty).trim() === '' ? 1 : Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99999) return fail(`'${name}' 수량을 확인해 주세요.`);
    if (raw.id && !itemIds.has(raw.id)) return fail('이 주문의 상품이 아닙니다.');
    items.push({ id: raw.id, name, option: text(raw.option, 300), qty });
  }
  if (items.length === 0) return fail('상품을 하나 이상 적어 주세요.');
  if (items.length > MAX_ITEMS) return fail(`상품은 ${MAX_ITEMS}개까지 적을 수 있습니다.`);

  const buyerName = text(body.buyer_name, 50);
  if (!buyerName) return fail('주문자 이름을 적어 주세요.');

  const payMethod = PAY_METHODS[body.pay_method] ? body.pay_method : 'BANK';
  const amountText = String(body.amount || '').replace(/[,\s원]/g, '');
  if (amountText && !/^\d{1,10}$/.test(amountText)) return fail('금액은 숫자로 적어 주세요.');

  const due = String(body.due_date || '').trim();
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return fail('납기 날짜 형식이 올바르지 않습니다.');

  const assignee = body.assignee_id ? Number(body.assignee_id) : null;
  if (assignee && !designerIds.has(assignee)) return fail('담당 디자이너로 지정할 수 없는 직원입니다.');

  const source = body.source_id ? Number(body.source_id) : null;
  if (source && !sourceIds.has(source)) return fail('고를 수 없는 주문 출처입니다. 화면을 새로고침해 주세요.');

  return {
    items,
    source_id: source,
    source_order_no: text(body.source_order_no, 50),
    buyer_name: buyerName,
    buyer_phone: text(body.buyer_phone, 30),
    receiver_name: text(body.receiver_name, 50) || buyerName,
    receiver_phone: text(body.receiver_phone, 30) || text(body.buyer_phone, 30),
    // 주소 = 기본주소(검색) + 상세주소(동·호수), 한 줄로
    receiver_address: [text(body.receiver_address, 250), text(body.receiver_address_detail, 50)].filter(Boolean).join(' ').slice(0, 300) || null,
    receiver_address_detail: text(body.receiver_address_detail, 50) || null,
    pay_method: payMethod,
    pay_status: body.pay_status === 'paid' ? 'paid' : 'waiting',
    amount: amountText ? Number(amountText) : null,
    depositor: text(body.depositor, 50),
    assignee_id: assignee,
    due_date: due || null,
    memo: text(body.memo, 2000),
  };
}

// 저장된 한 줄 주소 → 기본주소 + 상세주소 (고치는 화면에서 두 칸으로 다시 보여주기)
function splitAddress(order) {
  const full = order.receiver_address || '';
  const detail = order.receiver_address_detail || '';
  if (detail && full.endsWith(` ${detail}`)) return { receiver_address: full.slice(0, -detail.length - 1), receiver_address_detail: detail };
  return { receiver_address: full, receiver_address_detail: '' };
}

function safeBack(value) {
  const v = String(value || '');
  return /^\/(\?[^\s]*)?$/.test(v) ? v : '/';
}

function selfUrl(id, back) {
  return `/orders/${Number(id)}${back !== '/' ? `?back=${encodeURIComponent(back)}` : ''}`;
}

function notFound(res) {
  return res.status(404).render('error', { title: '없는 주문', message: '수기 주문을 찾을 수 없습니다.' });
}

module.exports = { manualRoutes, PAY_METHODS };
