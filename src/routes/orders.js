// 주문 목록과 주문 카드 (로그인 + 승인된 직원 모두 사용)
//
// DB 에는 상품주문(상품 하나) 단위로 저장하지만, 화면에서는 같은 주문번호의 상품을 카드 하나로 묶는다.
// 본상품에 딸린 추가상품(무료 양면테이프, 누끼 작업 등)이 따로 흩어지지 않게 하기 위해서다.
// 담당자·작업 단계·납기·메모는 주문 단위로 함께 바뀐다.
const express = require('express');
const { CHANNELS } = require('../channels/labels');

const VIEWS = {
  active: '진행 중',
  mine: '내 담당',
  unassigned: '미지정',
  all: '전체',
};

// 주문 묶음을 구분하는 열쇠 (채널 + 주문번호)
const GROUP_KEY = "o.channel || ':' || o.channel_order_id";
// 묶음 안에서 본상품을 먼저, 추가상품을 뒤에
const ITEM_ORDER = "CASE WHEN o.item_type = 'addon' THEN 1 ELSE 0 END, o.id";

function orderRoutes(db, notifier) {
  const router = express.Router();

  // 마지막 단계(보통 '발송')에 있는 주문은 끝난 것으로 보고 '진행 중' 목록에서 뺀다
  const lastStageId = () => {
    const row = db.prepare('SELECT id FROM work_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1').get();
    return row ? row.id : -1;
  };
  const stages = () => db.prepare('SELECT id, name, active FROM work_stages ORDER BY sort_order').all();
  // 담당 디자이너로 고를 수 있는 사람: 승인된 계정 + '디자이너 목록'이 켜진 직무
  const designers = () => db.prepare(`
    SELECT u.id, u.name FROM users u JOIN jobs j ON j.id = u.job_id
    WHERE u.status = 'active' AND j.is_designer = 1 ORDER BY u.name
  `).all();
  // 실제 주문이 있는 채널만 골라 보기 목록에 보여준다
  const channelsInUse = () => db.prepare('SELECT DISTINCT channel FROM orders ORDER BY channel').all().map(r => r.channel);

  router.get('/', (req, res) => {
    const view = VIEWS[req.query.view] ? req.query.view : 'active';
    const stageFilter = Number(req.query.stage) || null;
    const channel = CHANNELS[req.query.ch] ? req.query.ch : '';
    const sort = req.query.sort === 'due' ? 'due' : 'recent';
    const q = String(req.query.q || '').trim().slice(0, 50);
    const last = lastStageId();

    const where = [];
    const params = [];
    if (channel) {
      where.push('o.channel = ?');
      params.push(channel);
    }
    if (view !== 'all') {
      where.push('(o.stage_id IS NULL OR o.stage_id != ?)');
      params.push(last);
    }
    if (view === 'mine') {
      where.push('o.assignee_id = ?');
      params.push(req.user.id);
    }
    if (view === 'unassigned') where.push('o.assignee_id IS NULL');
    if (stageFilter) {
      where.push('o.stage_id = ?');
      params.push(stageFilter);
    }
    if (q) {
      where.push('(o.product_name LIKE ? OR o.option_text LIKE ? OR o.buyer_name LIKE ? OR o.receiver_name LIKE ? OR o.channel_order_id LIKE ? OR o.channel_item_id LIKE ? OR o.memo LIKE ?)');
      params.push(...Array(7).fill(`%${q}%`));
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const groupOrder = sort === 'due'
      ? 'g_due IS NULL, g_due ASC, g_paid DESC, oid DESC'
      : 'g_paid DESC, oid DESC';

    // ① 조건에 맞는 주문 묶음을 고르고(최대 300개) ② 그 묶음에 든 상품을 모두 가져온다
    const rows = db.prepare(`
      WITH g AS (
        SELECT o.channel AS ch, o.channel_order_id AS oid, MAX(o.paid_at) AS g_paid, MIN(o.due_date) AS g_due
        FROM orders o ${whereSql}
        GROUP BY o.channel, o.channel_order_id
        ORDER BY ${groupOrder}
        LIMIT 300
      ), r AS (
        SELECT g.*, ROW_NUMBER() OVER (ORDER BY ${groupOrder}) AS rnk FROM g
      )
      SELECT o.*, s.name AS stage_name, u.name AS assignee_name, r.rnk
      FROM r
      JOIN orders o ON o.channel = r.ch AND o.channel_order_id = r.oid
      LEFT JOIN work_stages s ON s.id = o.stage_id
      LEFT JOIN users u ON u.id = o.assignee_id
      ORDER BY r.rnk, ${ITEM_ORDER}
    `).all(...params);

    const groups = [];
    for (const row of rows) {
      const current = groups[groups.length - 1];
      if (current && current.rnk === row.rnk) current.items.push(row);
      else groups.push({ rnk: row.rnk, main: row, items: [row] });
    }

    // 탭에 보여줄 건수 (주문 묶음 단위, 채널을 골랐으면 그 채널만)
    const countWhere = channel ? 'WHERE o.channel = ?' : '';
    const counts = db.prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN o.stage_id IS NULL OR o.stage_id != ? THEN ${GROUP_KEY} END) AS active,
        COUNT(DISTINCT CASE WHEN (o.stage_id IS NULL OR o.stage_id != ?) AND o.assignee_id = ? THEN ${GROUP_KEY} END) AS mine,
        COUNT(DISTINCT CASE WHEN (o.stage_id IS NULL OR o.stage_id != ?) AND o.assignee_id IS NULL THEN ${GROUP_KEY} END) AS unassigned,
        COUNT(DISTINCT ${GROUP_KEY}) AS "all"
      FROM orders o ${countWhere}
    `).get(last, last, req.user.id, last, ...(channel ? [channel] : []));

    res.render('orders/list', {
      title: '주문',
      groups,
      counts,
      VIEWS,
      view,
      stageFilter,
      channel,
      channels: channelsInUse(),
      sort,
      q,
      stages: stages(),
      designers: designers(),
      today: kstToday(),
      currentUrl: req.originalUrl,
    });
  });

  // 목록에서 바로 담당 디자이너 지정 (주문 묶음 전체의 담당자 칸만 바꾼다)
  router.post('/orders/:id/assign', (req, res) => {
    const back = safeBack(req.body.back);
    const order = findOrder(req.params.id);
    if (!order) {
      req.session.flash = { type: 'error', message: '주문을 찾을 수 없습니다.' };
      return res.redirect(back);
    }
    const items = groupItems(order);
    const assignee = req.body.assignee_id ? Number(req.body.assignee_id) : null;
    const designer = designers().find(d => d.id === assignee);
    if (assignee && !designer && assignee !== order.assignee_id) {
      req.session.flash = { type: 'error', message: '담당 디자이너로 지정할 수 없는 직원입니다.' };
      return res.redirect(back);
    }
    // version 을 올려서, 이 주문 카드를 열어 둔 다른 직원이 옛 담당자로 덮어쓰지 못하게 한다
    db.prepare(
      "UPDATE orders SET assignee_id = ?, version = version + 1, updated_at = datetime('now') WHERE channel = ? AND channel_order_id = ?"
    ).run(assignee, order.channel, order.channel_order_id);
    notifier.ordersChanged(items.map(i => i.id), req.user.id);
    notifier.checkUnassigned();
    const name = items[0].product_name;
    req.session.flash = {
      type: 'ok',
      message: designer ? `'${name}' 담당자를 ${designer.name} 님으로 지정했습니다.` : `'${name}' 담당자를 비웠습니다.`,
    };
    // 목록의 같은 위치로 돌아간다 (#o12 처럼 주문 위치로 스크롤)
    res.redirect(`${back}#o${items[0].id}`);
  });

  router.get('/orders/:id', (req, res) => {
    const order = findOrder(req.params.id);
    if (!order) {
      return res.status(404).render('error', { title: '없는 주문', message: '주문을 찾을 수 없습니다.' });
    }
    const items = groupItems(order);
    res.render('orders/detail', {
      title: items[0].product_name,
      order,
      items,
      stages: stages(),
      designers: designers(),
      isDesigner: designers().some(d => d.id === req.user.id),
      back: safeBack(req.query.back),
      today: kstToday(),
    });
  });

  router.post('/orders/:id', (req, res) => {
    const order = findOrder(req.params.id);
    if (!order) {
      return res.status(404).render('error', { title: '없는 주문', message: '주문을 찾을 수 없습니다.' });
    }
    const back = safeBack(req.body.back);
    const self = `/orders/${order.id}${back !== '/' ? `?back=${encodeURIComponent(back)}` : ''}`;
    const fail = message => {
      req.session.flash = { type: 'error', message };
      res.redirect(self);
    };

    // 다른 직원이 그 사이에 먼저 저장했다면 덮어쓰지 않는다
    if (Number(req.body.version) !== order.version) {
      return fail('다른 직원이 이 주문을 먼저 수정했습니다. 바뀐 내용을 확인하고 다시 저장하세요.');
    }

    const changes = parseChanges(req.body, order, req.user);
    if (changes.error) return fail(changes.error);

    // 같은 주문번호의 상품(본상품 + 추가상품)에 모두 같은 값을 넣는다
    db.prepare(`
      UPDATE orders SET assignee_id = ?, stage_id = ?, due_date = ?, memo = ?, nas_path = ?,
        version = version + 1, updated_at = datetime('now')
      WHERE channel = ? AND channel_order_id = ?
    `).run(changes.assignee_id, changes.stage_id, changes.due_date, changes.memo, changes.nas_path,
      order.channel, order.channel_order_id);

    notifier.ordersChanged(groupItems(order).map(i => i.id), req.user.id);
    if (changes.assignee_id !== order.assignee_id || changes.stage_id !== order.stage_id) notifier.checkUnassigned();
    req.session.flash = { type: 'ok', message: '저장했습니다.' };
    res.redirect(self);
  });

  // 주문 카드에서 바꿀 수 있는 사내 칸만 꺼내고 검사한다
  function parseChanges(body, order, user) {
    const designerIds = new Set(designers().map(d => d.id));
    // '내가 맡기' 버튼을 누르면 선택 상자 값과 버튼 값이 함께 오므로 마지막(버튼) 값을 쓴다
    const rawAssignee = Array.isArray(body.assignee_id) ? body.assignee_id[body.assignee_id.length - 1] : body.assignee_id;
    const assignee = rawAssignee === 'me' ? user.id : rawAssignee ? Number(rawAssignee) : null;
    // 원래 담당자는 직무가 바뀌었어도 그대로 둘 수 있다
    if (assignee && assignee !== order.assignee_id && !designerIds.has(assignee)) {
      return { error: '담당 디자이너로 지정할 수 없는 직원입니다.' };
    }

    const activeStageIds = new Set(stages().filter(s => s.active).map(s => s.id));
    const stage = body.stage_id ? Number(body.stage_id) : order.stage_id;
    if (stage !== order.stage_id && !activeStageIds.has(stage)) {
      return { error: '고를 수 없는 작업 단계입니다.' };
    }

    const due = String(body.due_date || '').trim();
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { error: '납기 날짜 형식이 올바르지 않습니다.' };

    return {
      assignee_id: assignee,
      stage_id: stage,
      due_date: due || null,
      memo: String(body.memo || '').slice(0, 2000) || null,
      nas_path: String(body.nas_path || '').trim().slice(0, 300) || null,
    };
  }

  function findOrder(id) {
    return db.prepare(`
      SELECT o.*, s.name AS stage_name, u.name AS assignee_name
      FROM orders o
      LEFT JOIN work_stages s ON s.id = o.stage_id
      LEFT JOIN users u ON u.id = o.assignee_id
      WHERE o.id = ?
    `).get(Number(id));
  }

  // 같은 주문번호의 상품들 (본상품 먼저)
  function groupItems(order) {
    return db.prepare(`
      SELECT o.* FROM orders o WHERE o.channel = ? AND o.channel_order_id = ? ORDER BY ${ITEM_ORDER}
    `).all(order.channel, order.channel_order_id);
  }

  return router;
}

// 목록으로 돌아갈 주소: 우리 사이트의 목록 주소만 허용 (다른 사이트로 튕기는 것 방지)
function safeBack(value) {
  const v = String(value || '');
  return /^\/(\?[^\s]*)?$/.test(v) ? v : '/';
}

// 오늘 날짜 (한국 시간) YYYY-MM-DD
function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

module.exports = { orderRoutes, safeBack };
