// 주문 목록과 주문 카드 (로그인 + 승인된 직원 모두 사용)
//
// DB 에는 상품주문(상품 하나) 단위로 저장하지만, 화면에서는 같은 주문번호의 상품을 카드 하나로 묶는다.
// 본상품에 딸린 추가상품(무료 양면테이프, 누끼 작업 등)이 따로 흩어지지 않게 하기 위해서다.
// 담당자·작업 단계·납기·메모는 주문 단위로 함께 바뀐다.
const express = require('express');
const { CHANNELS } = require('../channels/labels');
const { ENDED_SQL } = require('../collector');
const { canConfirm, canDispatch, checkDispatchInput, describeShipping, hasOpenClaim } = require('../actions');
const { SHIP_METHODS, COURIERS, DEFAULT_METHOD, DEFAULT_COURIER } = require('../channels/shipping');

const BULK_MAX = 50; // 한 번에 일괄 처리할 수 있는 주문 수

const RESULT_WORD = { ok: '완료', partial: '일부 완료', fail: '실패', unknown: '확인 필요', practice: '연습', skip: '건너뜀' };

const VIEWS = {
  active: '진행 중',
  mine: '내 담당',
  unassigned: '미지정',
  all: '전체',
};

// 주문 묶음을 구분하는 열쇠 (채널 + 주문번호)
const GROUP_KEY = "o.channel || ':' || o.channel_order_id";
// 묶음의 모든 상품이 채널에서 끝났으면(배송중·배송완료·취소·반품 등) 1, 아니면 0
const GROUP_ENDED = `MIN(CASE WHEN o.channel_status IN (${ENDED_SQL}) THEN 1 ELSE 0 END)`;
// 판매자센터 '판매 관리' 처럼 보는 채널 상태 (주문 묶음 하나는 가장 앞 단계 하나로 센다)
// 수기 주문은 발송 기록 = 끝(배송완료로 저장)이라 배송완료 칸에는 넣지 않는다 (계속 쌓이기만 하므로)
const SHIP_STATES = { new: '신규주문', ready: '배송준비', shipping: '배송중', delivered: '배송완료' };
const GROUP_SHIP_STATE = `CASE
  WHEN MAX(o.channel_status = 'PAYED' AND o.channel_confirmed = 0) THEN 'new'
  WHEN MAX(o.channel_status = 'PAYED' AND o.channel_confirmed = 1) THEN 'ready'
  WHEN MAX(o.channel_status = 'DELIVERING') THEN 'shipping'
  WHEN MAX(o.channel_status = 'DELIVERED' AND o.channel != 'manual') THEN 'delivered'
  ELSE '' END`;
// 묶음 안에서 본상품을 먼저, 추가상품을 뒤에
const ITEM_ORDER = "CASE WHEN o.item_type = 'addon' THEN 1 ELSE 0 END, o.id";

function orderRoutes(db, notifier, actions, collector = null) {
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
    // st(채널 상태 칸: 신규주문·배송준비·배송중·배송완료)을 누르면 탭과 상관없이 그 상태의 주문을 모두 보여준다
    const st = SHIP_STATES[req.query.st] ? req.query.st : '';
    const view = st ? 'all' : VIEWS[req.query.view] ? req.query.view : 'active';
    const stageFilter = Number(req.query.stage) || null;
    const channel = CHANNELS[req.query.ch] ? req.query.ch : '';
    const sort = req.query.sort === 'due' ? 'due' : 'recent';
    const q = String(req.query.q || '').trim().slice(0, 50);
    const last = lastStageId();

    // 상품 단위 조건 (단계 필터는 단계별 건수를 셀 때 빼야 해서 따로 둔다)
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
    if (q) {
      where.push('(o.product_name LIKE ? OR o.option_text LIKE ? OR o.buyer_name LIKE ? OR o.receiver_name LIKE ? OR o.channel_order_id LIKE ? OR o.channel_item_id LIKE ? OR o.memo LIKE ?)');
      params.push(...Array(7).fill(`%${q}%`));
    }
    const sqlWhere = list => (list.length ? 'WHERE ' + list.join(' AND ') : '');
    const whereSql = sqlWhere(stageFilter ? [...where, 'o.stage_id = ?'] : where);
    const listParams = stageFilter ? [...params, stageFilter] : params;
    // 묶음 단위 조건: 진행 중 탭들은 채널에서 끝난 주문을 빼고, 상태 칸을 눌렀으면 그 상태만
    const having = [];
    if (view !== 'all') having.push(`${GROUP_ENDED} = 0`);
    if (st) having.push(`${GROUP_SHIP_STATE} = '${st}'`);
    const havingSql = having.length ? 'HAVING ' + having.join(' AND ') : '';

    const groupOrder = sort === 'due'
      ? 'g_due IS NULL, g_due ASC, g_paid DESC, oid DESC'
      : 'g_paid DESC, oid DESC';

    // ① 조건에 맞는 주문 묶음을 고르고(최대 300개) ② 그 묶음에 든 상품을 모두 가져온다
    const rows = db.prepare(`
      WITH g AS (
        SELECT o.channel AS ch, o.channel_order_id AS oid, MAX(o.paid_at) AS g_paid, MIN(o.due_date) AS g_due
        FROM orders o ${whereSql}
        GROUP BY o.channel, o.channel_order_id
        ${havingSql}
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
    `).all(...listParams);

    const groups = [];
    for (const row of rows) {
      const current = groups[groups.length - 1];
      if (current && current.rnk === row.rnk) current.items.push(row);
      else groups.push({ rnk: row.rnk, main: row, items: [row] });
    }
    // 카드에 보여줄 처리 가능 여부와 클레임 표시
    for (const g of groups) {
      g.canConfirm = g.items.some(canConfirm);
      g.canDispatch = g.items.some(canDispatch);
      g.claim = g.items.find(hasOpenClaim) || g.items.find(i => i.claim_status) || null;
      g.shipped = g.items.find(i => i.shipped_at) || null;
    }

    // 단계 버튼에 보여줄 건수: 지금 탭·검색 조건 그대로, 단계만 빼고 센다
    const stageCounts = {};
    let stageTotal = 0;
    for (const r of db.prepare(`
      SELECT stage_id, COUNT(*) AS n FROM (
        SELECT MIN(o.stage_id) AS stage_id FROM orders o ${sqlWhere(where)}
        GROUP BY o.channel, o.channel_order_id ${havingSql}
      ) GROUP BY stage_id
    `).all(...params)) {
      stageCounts[r.stage_id] = r.n;
      stageTotal += r.n;
    }

    // 탭 건수와 채널 상태 칸 건수 (주문 묶음 단위, 채널을 골랐으면 그 채널만)
    const countWhere = channel ? 'WHERE o.channel = ?' : '';
    const counts = db.prepare(`
      WITH grp AS (
        SELECT
          MAX(CASE WHEN o.stage_id IS NULL OR o.stage_id != ? THEN 1 ELSE 0 END) AND ${GROUP_ENDED} = 0 AS open,
          MAX(CASE WHEN o.assignee_id = ? THEN 1 ELSE 0 END) AS mine,
          MIN(CASE WHEN o.assignee_id IS NULL THEN 1 ELSE 0 END) AS unassigned,
          ${GROUP_SHIP_STATE} AS ship_state,
          o.channel AS ch
        FROM orders o ${countWhere}
        GROUP BY o.channel, o.channel_order_id
      )
      SELECT
        COALESCE(SUM(open), 0) AS active,
        COALESCE(SUM(open AND mine), 0) AS mine,
        COALESCE(SUM(open AND unassigned), 0) AS unassigned,
        COUNT(*) AS "all",
        COALESCE(SUM(ship_state = 'new' AND (? OR ch != 'manual')), 0) AS st_new,
        COALESCE(SUM(ship_state = 'ready' AND (? OR ch != 'manual')), 0) AS st_ready,
        COALESCE(SUM(ship_state = 'shipping'), 0) AS st_shipping,
        COALESCE(SUM(ship_state = 'delivered'), 0) AS st_delivered
      FROM grp
    `).get(last, req.user.id, ...(channel ? [channel] : []), channel ? 1 : 0, channel ? 1 : 0);

    // 상태 칸의 큰 숫자는 판매자센터와 같은 '상품주문' 단위 (추가상품·옵션별 상품도 하나씩 센다)
    // 전체 채널일 때는 판매자센터 숫자와 비교하기 쉽게 수기 주문을 뺀다
    const itemCounts = db.prepare(`
      SELECT
        COALESCE(SUM(o.channel_status = 'PAYED' AND o.channel_confirmed = 0), 0) AS new,
        COALESCE(SUM(o.channel_status = 'PAYED' AND o.channel_confirmed = 1), 0) AS ready,
        COALESCE(SUM(o.channel_status = 'DELIVERING'), 0) AS shipping,
        COALESCE(SUM(o.channel_status = 'DELIVERED' AND o.channel != 'manual'), 0) AS delivered
      FROM orders o ${channel ? countWhere : "WHERE o.channel != 'manual'"}
    `).get(...(channel ? [channel] : []));

    const lastRun = db.prepare('SELECT started_at, ok FROM collect_runs ORDER BY id DESC LIMIT 1').get() || null;

    res.render('orders/list', {
      title: '주문',
      groups,
      counts,
      VIEWS,
      view,
      st,
      SHIP_STATES,
      itemCounts,
      stageCounts,
      stageTotal,
      stageFilter,
      channel,
      channels: channelsInUse(),
      sort,
      q,
      stages: stages(),
      designers: designers(),
      today: kstToday(),
      currentUrl: req.originalUrl,
      canCollect: Boolean(collector),
      lastRun,
    });
  });

  // 주문 목록에서 바로 '지금 수집' (조회만 하므로 승인된 직원 누구나)
  router.post('/orders/collect', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      if (!collector) return flashBack(req, res, back, { type: 'error', message: '주문 수집이 꺼져 있습니다 (ORDER_SOURCE=off).' });
      const result = await collector.run();
      req.session.flash = result.ok
        ? { type: 'ok', message: `수집 완료: 새 주문 ${result.createdOrders}건, 바뀐 상품주문 ${result.updated}건` }
        : { type: 'error', message: `수집 실패: ${result.error}` };
      res.redirect(back);
    } catch (e) {
      next(e);
    }
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

  // ───────── 2차: 스마트스토어 발주확인·발송처리 ─────────
  // ※ '/orders/bulk/...' 를 '/orders/:id' 보다 먼저 등록해야 bulk 가 주문 번호로 읽히지 않는다

  // 여러 주문 일괄 발주확인
  router.post('/orders/bulk/confirm', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      const ids = pickIds(req.body.ids);
      if (ids.error) return flashBack(req, res, back, { type: 'error', message: ids.error });
      const results = [];
      for (const id of ids) results.push(await actions.confirm(id, req.user.id));
      afterActions(results, req.user.id);
      req.session.flash = summarize('발주확인', results);
      res.redirect(back);
    } catch (e) {
      next(e);
    }
  });

  // 여러 주문 일괄 발송처리 ① 송장 입력 화면 (아직 아무것도 보내지 않음)
  router.post('/orders/bulk/dispatch-form', (req, res) => {
    const back = safeBack(req.body.back);
    const ids = pickIds(req.body.ids);
    if (ids.error) return flashBack(req, res, back, { type: 'error', message: ids.error });
    const rows = [];
    const skipped = [];
    for (const id of ids) {
      const order = findOrder(id);
      if (!order) continue;
      const items = groupItems(order);
      if (items.some(canDispatch)) rows.push({ main: items[0], items: items.filter(canDispatch) });
      else skipped.push(items[0].product_name);
    }
    if (rows.length === 0) {
      return flashBack(req, res, back, {
        type: 'error',
        message: '고른 주문 중 발송처리할 수 있는 주문이 없습니다 (발주확인 전이거나 이미 발송된 주문).',
      });
    }
    res.render('orders/bulk-dispatch', {
      title: '일괄 발송처리', rows, skipped, back, SHIP_METHODS, COURIERS, DEFAULT_METHOD, DEFAULT_COURIER,
    });
  });

  // 여러 주문 일괄 발송처리 ② 보내기
  router.post('/orders/bulk/dispatch', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      const ids = pickIds(req.body.ids);
      if (ids.error) return flashBack(req, res, back, { type: 'error', message: ids.error });
      // 먼저 모든 줄을 검사하고, 하나라도 틀리면 아무것도 보내지 않는다
      const inputs = [];
      for (const id of ids) {
        const input = checkDispatchInput({
          method: req.body[`method_${id}`],
          company: req.body[`company_${id}`],
          tracking: req.body[`tracking_${id}`],
        });
        if (input.error) {
          const order = findOrder(id);
          const name = order ? groupItems(order)[0].product_name : `주문 ${id}`;
          return flashBack(req, res, back, { type: 'error', message: `'${name}': ${input.error} 아무것도 보내지 않았습니다.` });
        }
        inputs.push([id, input]);
      }
      const results = [];
      for (const [id, input] of inputs) results.push(await actions.dispatch(id, req.user.id, input));
      afterActions(results, req.user.id);
      req.session.flash = summarize('발송처리', results);
      res.redirect(back);
    } catch (e) {
      next(e);
    }
  });

  // 주문 하나 발주확인
  router.post('/orders/:id/confirm', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      const result = await actions.confirm(req.params.id, req.user.id);
      afterActions([result], req.user.id);
      req.session.flash = single('발주확인', result);
      res.redirect(selfUrl(req.params.id, back));
    } catch (e) {
      next(e);
    }
  });

  // 주문 하나 발송처리
  router.post('/orders/:id/dispatch', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      const input = checkDispatchInput({ method: req.body.method, company: req.body.company, tracking: req.body.tracking });
      if (input.error) {
        return flashBack(req, res, selfUrl(req.params.id, back), { type: 'error', message: input.error });
      }
      const result = await actions.dispatch(req.params.id, req.user.id, input);
      if (result.result === 'ok' || result.result === 'partial') result.message += ` (${describeShipping(input)})`;
      afterActions([result], req.user.id);
      req.session.flash = single('발송처리', result);
      res.redirect(selfUrl(req.params.id, back));
    } catch (e) {
      next(e);
    }
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
      canConfirm: items.some(canConfirm),
      canDispatch: items.some(canDispatch),
      claimItems: items.filter(i => i.claim_status),
      shipped: items.find(i => i.shipped_at) || null,
      history: history(order),
      SHIP_METHODS,
      COURIERS,
      DEFAULT_METHOD,
      DEFAULT_COURIER,
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

  // 이 주문 묶음의 처리 기록 (최근 20개)
  function history(order) {
    return db.prepare(`
      SELECT a.*, u.name AS user_name FROM order_actions a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.channel = ? AND a.channel_order_id = ? ORDER BY a.id DESC LIMIT 20
    `).all(order.channel, order.channel_order_id);
  }

  // 처리가 끝나면 다른 직원 화면도 새로 고친다
  function afterActions(results, userId) {
    const ids = results.flatMap(r => r.itemIds || []);
    if (ids.length) notifier.ordersChanged(ids, userId);
  }

  return router;
}

// 체크한 주문 번호들 (숫자만, 중복 제거, 최대 BULK_MAX 개)
function pickIds(raw) {
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  const ids = [...new Set(list)];
  if (ids.length === 0) return { error: '처리할 주문을 먼저 체크하세요.' };
  if (ids.length > BULK_MAX) return { error: `한 번에 ${BULK_MAX}건까지만 처리할 수 있습니다.` };
  return ids;
}

function flashBack(req, res, url, flash) {
  req.session.flash = flash;
  res.redirect(url);
}

function selfUrl(id, back) {
  return `/orders/${Number(id)}${back !== '/' ? `?back=${encodeURIComponent(back)}` : ''}`;
}

// 주문 하나 처리 결과 → 화면 안내 문구
function single(label, r) {
  const type = r.result === 'ok' ? 'ok' : r.result === 'practice' ? 'ok' : r.result === 'fail' || r.result === 'skip' ? 'error' : 'warn';
  return { type, message: `${label} ${RESULT_WORD[r.result] || ''}: ${r.message}` };
}

// 여러 주문 처리 결과 → "완료 3건, 실패 1건" + 주문별 사유
function summarize(label, results) {
  const count = {};
  for (const r of results) count[r.result] = (count[r.result] || 0) + 1;
  const parts = Object.keys(RESULT_WORD).filter(k => count[k]).map(k => `${RESULT_WORD[k]} ${count[k]}건`);
  const problems = results.filter(r => r.result !== 'ok');
  const type = problems.some(r => r.result === 'unknown' || r.result === 'partial' || r.result === 'fail')
    ? 'warn'
    : results.every(r => r.result === 'skip') ? 'error' : 'ok';
  return {
    type,
    message: `${label} ${results.length}건: ${parts.join(', ')}`,
    details: problems.slice(0, 20).map(r => r.message),
  };
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
