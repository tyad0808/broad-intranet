// 주문 목록과 주문 카드 (로그인 + 승인된 직원 모두 사용)
const express = require('express');

const VIEWS = {
  active: '진행 중',
  mine: '내 담당',
  unassigned: '미지정',
  all: '전체',
};

function orderRoutes(db) {
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

  router.get('/', (req, res) => {
    const view = VIEWS[req.query.view] ? req.query.view : 'active';
    const stageFilter = Number(req.query.stage) || null;
    const sort = req.query.sort === 'due' ? 'due' : 'recent';
    const q = String(req.query.q || '').trim().slice(0, 50);
    const last = lastStageId();

    const where = [];
    const params = [];
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

    const orderBy = sort === 'due'
      ? 'o.due_date IS NULL, o.due_date ASC, o.paid_at DESC'
      : 'o.paid_at DESC, o.id DESC';

    const orders = db.prepare(`
      SELECT o.*, s.name AS stage_name, u.name AS assignee_name
      FROM orders o
      LEFT JOIN work_stages s ON s.id = o.stage_id
      LEFT JOIN users u ON u.id = o.assignee_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${orderBy}
      LIMIT 300
    `).all(...params);

    // 탭에 보여줄 건수
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN stage_id IS NULL OR stage_id != ? THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN (stage_id IS NULL OR stage_id != ?) AND assignee_id = ? THEN 1 ELSE 0 END) AS mine,
        SUM(CASE WHEN (stage_id IS NULL OR stage_id != ?) AND assignee_id IS NULL THEN 1 ELSE 0 END) AS unassigned,
        COUNT(*) AS "all"
      FROM orders
    `).get(last, last, req.user.id, last);

    res.render('orders/list', {
      title: '주문',
      orders,
      counts,
      VIEWS,
      view,
      stageFilter,
      sort,
      q,
      stages: stages(),
      today: kstToday(),
      currentUrl: req.originalUrl,
    });
  });

  router.get('/orders/:id', (req, res) => {
    const order = findOrder(req.params.id);
    if (!order) {
      return res.status(404).render('error', { title: '없는 주문', message: '주문을 찾을 수 없습니다.' });
    }
    res.render('orders/detail', {
      title: order.product_name,
      order,
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

    db.prepare(`
      UPDATE orders SET assignee_id = ?, stage_id = ?, due_date = ?, memo = ?, nas_path = ?,
        version = version + 1, updated_at = datetime('now')
      WHERE id = ? AND version = ?
    `).run(changes.assignee_id, changes.stage_id, changes.due_date, changes.memo, changes.nas_path, order.id, order.version);

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
