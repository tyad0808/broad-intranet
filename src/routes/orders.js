// 주문 목록과 주문 카드 (로그인 + 승인된 직원 모두 사용)
//
// DB 에는 상품주문(상품 하나) 단위로 저장하지만, 화면에서는 같은 주문번호의 상품을 카드 하나로 묶는다.
// 본상품에 딸린 추가상품(무료 양면테이프, 누끼 작업 등)이 따로 흩어지지 않게 하기 위해서다.
// 담당자·작업 단계·납기·메모는 주문 단위로 함께 바뀐다.
const express = require('express');
const { CHANNELS } = require('../channels/labels');
const { ENDED_SQL } = require('../collector');
const { buildWeek } = require('./calendar');
const { historyForOrder } = require('../customer');
const { fileLabel } = require('../fileLabel');
const { canConfirm, canDispatch, canDelay, checkDispatchInput, checkDelayInput, describeShipping, hasOpenClaim, DELAY_REASONS, DELAY_DEFAULT_TEXT } = require('../actions');
const { SHIP_METHODS, COURIERS, DEFAULT_METHOD, DEFAULT_COURIER } = require('../channels/shipping');
const { ORDER_TIME, hideCutoff, hideDays, periodRange, periodLabel, quickPeriods } = require('../retention');

const BULK_MAX = 50; // 한 번에 일괄 처리할 수 있는 주문 수

// 발주서 맨 아래 작업 확인 칸 (필요 없는 칸은 여기서 빼면 된다)
const PRINT_STEPS = ['디자인', '시안 확인', '출력', '가공·재단', '검수', '포장'];

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
// '확인 필요' 모아보기
//   claim: 고객이 취소·반품·교환을 요청해 진행 중 (거부됨·완료 등은 제외)
//   late : 납기가 지났는데 아직 안 나간 주문
//   today: 스마트스토어 오늘출발 상품이 들어 있는데 아직 발송 전인 주문 (발송기한 이른 순)
//   shiplate: 채널의 발송기한이 지났는데 아직 발송 전인 주문
const ALERTS = { today: '오늘출발', claim: '취소·반품·교환 요청', late: '납기 지남', shiplate: '발송기한 지남' };
const TODAY_TYPES = "('TODAY', 'OPTION_TODAY')";
const TODAY_HAVING = `MAX(o.channel_status = 'PAYED' AND o.delivery_type IN ${TODAY_TYPES}) = 1`;
// 발송지연 처리하면 네이버가 발송기한을 새 날짜로 바꿔 준다 → 새 기한까지 지나야 '발송기한 지남'
const shipLateHaving = () => `MIN(CASE WHEN o.channel_status = 'PAYED' THEN o.ship_due END) < '${new Date().toISOString()}'`;
// 검색: 상품·고객·주문번호·메모 + 수기 주문의 판매처 주문번호와 출처 이름
const SEARCH_SQL = `(o.product_name LIKE ? OR o.option_text LIKE ? OR o.buyer_name LIKE ? OR o.receiver_name LIKE ?
  OR o.channel_order_id LIKE ? OR o.channel_item_id LIKE ? OR o.memo LIKE ? OR o.source_order_no LIKE ?
  OR o.source_id IN (SELECT id FROM order_sources WHERE name LIKE ?))`;
const SEARCH_PARAMS = 9;

const OPEN_CLAIM_SQL = `(o.claim_status IS NOT NULL AND o.claim_status NOT LIKE '%_REJECT' AND o.claim_status NOT LIKE '%_DONE'
  AND o.claim_status NOT IN ('PURCHASE_DECISION_HOLDBACK_RELEASE', 'PURCHASE_DECISION_REQUEST'))`;
// 묶음 안에서 본상품을 먼저, 추가상품을 뒤에
const ITEM_ORDER = "CASE WHEN o.item_type = 'addon' THEN 1 ELSE 0 END, o.id";

function orderRoutes(db, notifier, actions, collector = null, logen = null) {
  const router = express.Router();

  // 마지막 단계(보통 '발송')에 있는 주문은 끝난 것으로 보고 '진행 중' 목록에서 뺀다
  const lastStageId = () => {
    const row = db.prepare('SELECT id FROM work_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1').get();
    return row ? row.id : -1;
  };
  const stages = () => db.prepare('SELECT id, name, active FROM work_stages ORDER BY sort_order').all();
  // 디자인 단계 (주문 단계와 따로). 비어 있는 주문은 첫 번째 디자인 단계로 본다
  const designStages = () => db.prepare('SELECT id, name, active FROM design_stages ORDER BY sort_order').all();
  const firstDesignId = () => {
    const row = db.prepare('SELECT id FROM design_stages WHERE active = 1 ORDER BY sort_order LIMIT 1').get();
    return row ? row.id : null;
  };
  // 담당 디자이너로 고를 수 있는 사람: 승인된 계정 + '디자이너 목록'이 켜진 직무
  const designers = () => db.prepare(`
    SELECT u.id, u.name FROM users u JOIN jobs j ON j.id = u.job_id
    WHERE u.status = 'active' AND j.is_designer = 1 ORDER BY u.name
  `).all();
  // 실제 주문이 있는 채널만 골라 보기 목록에 보여준다
  // 디자인 단계를 고를 수 있는 사람: 디자이너 + 관리자
  const canPickStage = user => user.role === 'admin' || designers().some(d => d.id === user.id);
  // 실제 주문이 있는 채널만, 직원이 끌어다 놓은 순서대로 (저장 안 했으면 기본 순서)
  const channelsInUse = user => {
    const inUse = db.prepare('SELECT DISTINCT channel FROM orders ORDER BY channel').all().map(r => r.channel);
    let saved = [];
    try { saved = JSON.parse(user.channel_order || '[]'); } catch { saved = []; }
    const rank = ch => (saved.includes(ch) ? saved.indexOf(ch) : saved.length + inUse.indexOf(ch));
    return inUse.sort((a, b) => rank(a) - rank(b));
  };

  router.get('/', (req, res) => {
    // st(채널 상태 칸: 신규주문·배송준비·배송중·배송완료)을 누르면 탭과 상관없이 그 상태의 주문을 모두 보여준다
    const st = SHIP_STATES[req.query.st] ? req.query.st : '';
    // 확인 필요(alert)를 누르면 탭과 상관없이 해당 주문을 모두 보여준다
    const alert = ALERTS[req.query.alert] ? req.query.alert : '';
    // 기간 보기 (from·to=YYYY-MM-DD, 결제일 기준): 그 기간 주문을 끝난 것까지 모두
    const period = periodRange(req.query.from, req.query.to);
    const stageFilter = Number(req.query.stage) || null;
    const last = lastStageId();
    // 마지막 단계(발송)를 고르면 끝난 주문이라 '전체' 탭에서 보여준다
    const view = st || alert || period || (stageFilter && stageFilter === last) ? 'all' : VIEWS[req.query.view] ? req.query.view : 'active';
    // 디자인 단계 거르기 (ds). 비어 있는 주문은 첫 번째 디자인 단계로 본다
    const designFilter = Number(req.query.ds) || null;
    const firstDesign = firstDesignId() || -1;
    const DESIGN_OF = `COALESCE(o.design_stage_id, ${Number(firstDesign)})`;
    const channel = CHANNELS[req.query.ch] ? req.query.ch : '';
    const sort = req.query.sort === 'due' ? 'due' : 'recent';
    const q = String(req.query.q || '').trim().slice(0, 50);
    // 달력의 '출고 N건' 을 누르면 그날 납기인 주문만
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.due || '')) ? req.query.due : '';
    // 수기 주문 출처 거르기 (src: 출처 번호, 'none' 은 출처 미지정). 수기 주문 채널을 볼 때만
    const src = channel === 'manual' && (req.query.src === 'none' || Number(req.query.src) > 0) ? String(req.query.src) : '';

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
    if (due) {
      where.push('o.due_date = ?');
      params.push(due);
    }
    if (q) {
      where.push(SEARCH_SQL);
      params.push(...Array(SEARCH_PARAMS).fill(`%${q}%`));
    }
    if (period) {
      where.push(`${ORDER_TIME} >= ? AND ${ORDER_TIME} < ?`);
      params.push(period.start, period.end);
    }
    // 출처 칩 건수는 출처 필터만 빼고 센다
    const whereNoSrc = [...where];
    const paramsNoSrc = [...params];
    if (src === 'none') where.push('o.source_id IS NULL');
    else if (src) {
      where.push('o.source_id = ?');
      params.push(Number(src));
    }
    const sqlWhere = list => (list.length ? 'WHERE ' + list.join(' AND ') : '');
    // 단계 건수를 셀 때는 그 단계 필터만 빼고 센다
    const withStage = (list, p) => (stageFilter ? [[...list, 'o.stage_id = ?'], [...p, stageFilter]] : [list, p]);
    const withDesign = (list, p) => (designFilter ? [[...list, `${DESIGN_OF} = ?`], [...p, designFilter]] : [list, p]);
    const [listWhere, listParams] = withDesign(...withStage(where, params));
    const whereSql = sqlWhere(listWhere);
    // 묶음 단위 조건: 진행 중 탭들은 채널에서 끝난 주문을 빼고, 상태 칸을 눌렀으면 그 상태만
    const having = [];
    if (view !== 'all') having.push(`${GROUP_ENDED} = 0`);
    if (st) having.push(`${GROUP_SHIP_STATE} = '${st}'`);
    const lateHaving = `MIN(o.due_date) < '${kstToday()}' AND ${GROUP_ENDED} = 0 AND MAX(o.stage_id IS NULL OR o.stage_id != ${Number(last)}) = 1`;
    if (alert === 'claim') having.push(`MAX(${OPEN_CLAIM_SQL}) = 1`);
    if (alert === 'late') having.push(lateHaving);
    if (alert === 'today') having.push(TODAY_HAVING);
    if (alert === 'shiplate') having.push(shipLateHaving());
    // 끝난 주문은 N일(기본 14일)이 지나면 '전체'·'배송완료' 에서 숨긴다 (검색·월별 보기·확인 필요·달력 날짜로는 보임)
    const cutoff = hideCutoff(db);
    const doneGroup = `(${GROUP_ENDED} = 1 OR MIN(COALESCE(o.stage_id = ${Number(last)}, 0)) = 1)`;
    const oldDone = `(${doneGroup} AND MAX(${ORDER_TIME}) < '${cutoff}')`;
    const hidingOld = view === 'all' && !alert && !q && !due && !period;
    if (hidingOld) having.push(`NOT ${oldDone}`);
    const havingSql = having.length ? 'HAVING ' + having.join(' AND ') : '';

    // 오늘출발·발송기한 모아보기는 발송기한이 이른 것부터
    const groupOrder = alert === 'today' || alert === 'shiplate'
      ? 'g_ship IS NULL, g_ship ASC, g_paid DESC, oid DESC'
      : sort === 'due'
        ? 'g_due IS NULL, g_due ASC, g_paid DESC, oid DESC'
        : 'g_paid DESC, oid DESC';

    // ① 조건에 맞는 주문 묶음을 고르고(최대 300개) ② 그 묶음에 든 상품을 모두 가져온다
    const rows = db.prepare(`
      WITH g AS (
        SELECT o.channel AS ch, o.channel_order_id AS oid, MAX(${ORDER_TIME}) AS g_paid, MIN(o.due_date) AS g_due,
          MIN(CASE WHEN o.channel_status = 'PAYED' THEN o.ship_due END) AS g_ship
        FROM orders o ${whereSql}
        GROUP BY o.channel, o.channel_order_id
        ${havingSql}
        ORDER BY ${groupOrder}
        LIMIT 300
      ), r AS (
        SELECT g.*, ROW_NUMBER() OVER (ORDER BY ${groupOrder}) AS rnk FROM g
      )
      SELECT o.*, s.name AS stage_name, u.name AS assignee_name, src.name AS source_name, r.rnk
      FROM r
      JOIN orders o ON o.channel = r.ch AND o.channel_order_id = r.oid
      LEFT JOIN work_stages s ON s.id = o.stage_id
      LEFT JOIN order_sources src ON src.id = o.source_id
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
      // 오늘출발 여부와 발송 전 상품 중 가장 이른 발송기한
      g.today = g.items.some(i => i.channel_status === 'PAYED' && (i.delivery_type === 'TODAY' || i.delivery_type === 'OPTION_TODAY'));
      g.shipDue = g.items.filter(i => i.channel_status === 'PAYED' && i.ship_due && !i.ship_delayed).map(i => i.ship_due).sort()[0] || null;
      // 발송지연 처리한 상품 (판매자센터에서 새 발송 예정일을 알림)
      g.delayed = g.items.find(i => i.channel_status === 'PAYED' && i.ship_delayed) || null;
      // 로젠: 등록 상태(송장번호)와 지금 등록할 수 있는지
      g.logen = logen ? logen.shipmentOf(g.main.channel, g.main.channel_order_id) : null;
      g.canLogen = Boolean(logen && logen.hasKey && logen.canRegister(g.items));
    }

    // 단계 버튼에 보여줄 건수: 지금 탭·검색 조건 그대로, 그 단계 필터만 빼고 센다
    const countBy = (expr, [list, p]) => {
      const out = {};
      let total = 0;
      for (const r of db.prepare(`
        SELECT k, COUNT(*) AS n FROM (
          SELECT MIN(${expr}) AS k FROM orders o ${sqlWhere(list)}
          GROUP BY o.channel, o.channel_order_id ${havingSql}
        ) GROUP BY k
      `).all(...p)) {
        out[r.k] = r.n;
        total += r.n;
      }
      return { counts: out, total };
    };
    const stageCount = countBy('o.stage_id', withDesign(where, params));
    const designCount = countBy(DESIGN_OF, withStage(where, params));
    // 수기 주문 출처 칩 (0 = 출처 미지정)
    const sourceCount = channel === 'manual'
      ? countBy('COALESCE(o.source_id, 0)', withDesign(...withStage(whereNoSrc, paramsNoSrc)))
      : { counts: {}, total: 0 };
    // '진행 중'·'내 담당'·'미지정' 탭은 끝난 주문(발송)을 빼고 보여주므로, 발송 버튼에는 탭과 상관없이
    // 발송 단계에 있는 주문 수를 보여주고 누르면 '전체' 탭에서 본다
    let shippedCount = null;
    if (view !== 'all') {
      const base = [];
      const baseParams = [];
      if (channel) { base.push('o.channel = ?'); baseParams.push(channel); }
      if (due) { base.push('o.due_date = ?'); baseParams.push(due); }
      if (src === 'none') base.push('o.source_id IS NULL');
      else if (src) { base.push('o.source_id = ?'); baseParams.push(Number(src)); }
      if (q) {
        base.push(SEARCH_SQL);
        baseParams.push(...Array(SEARCH_PARAMS).fill(`%${q}%`));
      }
      const [list, p] = withDesign([...base, 'o.stage_id = ?'], [...baseParams, last]);
      shippedCount = db.prepare(`
        SELECT COUNT(*) AS n FROM (SELECT 1 FROM orders o ${sqlWhere(list)} GROUP BY o.channel, o.channel_order_id)
      `).get(...p).n;
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
          ${oldDone} AS old,
          o.channel AS ch
        FROM orders o ${countWhere}
        GROUP BY o.channel, o.channel_order_id
      )
      SELECT
        COALESCE(SUM(open), 0) AS active,
        COALESCE(SUM(open AND mine), 0) AS mine,
        COALESCE(SUM(open AND unassigned), 0) AS unassigned,
        COALESCE(SUM(NOT old), 0) AS "all",
        COALESCE(SUM(ship_state = 'new' AND (? OR ch != 'manual')), 0) AS st_new,
        COALESCE(SUM(ship_state = 'ready' AND (? OR ch != 'manual')), 0) AS st_ready,
        COALESCE(SUM(ship_state = 'shipping'), 0) AS st_shipping,
        COALESCE(SUM(ship_state = 'delivered' AND NOT old), 0) AS st_delivered
      FROM grp
    `).get(last, req.user.id, ...(channel ? [channel] : []), channel ? 1 : 0, channel ? 1 : 0);

    // 상태 칸의 큰 숫자는 판매자센터와 같은 '상품주문' 단위 (추가상품·옵션별 상품도 하나씩 센다)
    // 전체 채널일 때는 판매자센터 숫자와 비교하기 쉽게 수기 주문을 뺀다
    const itemCounts = db.prepare(`
      SELECT
        COALESCE(SUM(o.channel_status = 'PAYED' AND o.channel_confirmed = 0), 0) AS new,
        COALESCE(SUM(o.channel_status = 'PAYED' AND o.channel_confirmed = 1), 0) AS ready,
        COALESCE(SUM(o.channel_status = 'DELIVERING'), 0) AS shipping,
        COALESCE(SUM(o.channel_status = 'DELIVERED' AND o.channel != 'manual' AND ${ORDER_TIME} >= '${cutoff}'), 0) AS delivered
      FROM orders o ${channel ? countWhere : "WHERE o.channel != 'manual'"}
    `).get(...(channel ? [channel] : []));

    // 확인 필요 건수 (채널을 골랐으면 그 채널만)
    const alertCounts = db.prepare(`
      SELECT
        COALESCE(SUM(claim), 0) AS claim,
        COALESCE(SUM(late), 0) AS late,
        COALESCE(SUM(today), 0) AS today,
        COALESCE(SUM(shiplate), 0) AS shiplate
      FROM (
        SELECT MAX(${OPEN_CLAIM_SQL}) AS claim, (${lateHaving}) AS late, (${TODAY_HAVING}) AS today, COALESCE(${shipLateHaving()}, 0) AS shiplate
        FROM orders o ${countWhere}
        GROUP BY o.channel, o.channel_order_id
      )
    `).get(...(channel ? [channel] : []));

    const lastRun = db.prepare('SELECT started_at, ok FROM collect_runs ORDER BY id DESC LIMIT 1').get() || null;

    res.render('orders/list', {
      ds: true, // 새 디자인 규칙(.ds-v2) — 지금은 이 화면에만
      title: '주문',
      logenOn: Boolean(logen && logen.hasKey),
      logenEnv: logen ? logen.env : null,
      logenWaiting: logen && logen.hasKey ? logen.waiting().length : 0,
      groups,
      counts,
      VIEWS,
      view,
      st,
      alert,
      ALERTS,
      alertCounts,
      SHIP_STATES,
      itemCounts,
      stageCounts: stageCount.counts,
      stageTotal: stageCount.total,
      lastStage: last,
      shippedCount,
      designCounts: designCount.counts,
      designTotal: designCount.total,
      designFilter,
      firstDesign,
      src,
      sources: channel === 'manual' ? db.prepare('SELECT id, name, active FROM order_sources ORDER BY sort_order').all() : [],
      sourceCounts: sourceCount.counts,
      sourceTotal: sourceCount.total,
      stageFilter,
      due,
      channel,
      channels: channelsInUse(req.user),
      sort,
      q,
      from: period ? period.from : '',
      to: period ? period.to : '',
      periodText: periodLabel(period),
      quick: quickPeriods(),
      hidingOld,
      hideDays: hideDays(db),
      stages: stages(),
      designStages: designStages(),
      canPickStage: canPickStage(req.user),
      designers: designers(),
      today: kstToday(),
      currentUrl: req.originalUrl,
      canCollect: Boolean(collector),
      // 넓은 PC 화면에서만 오른쪽에 보이는 회사 일정 달력
      week: buildWeek(db),
      lastRun,
    });
  });

  // 채널 버튼 순서 저장 (끌어다 놓기). 내 계정에만 적용된다
  router.post('/me/channel-order', (req, res) => {
    const order = String(req.body.order || '').split(',').map(x => x.trim()).filter(ch => CHANNELS[ch]);
    const unique = [...new Set(order)].slice(0, 20);
    db.prepare('UPDATE users SET channel_order = ? WHERE id = ?').run(JSON.stringify(unique), req.user.id);
    res.json({ ok: true, order: unique });
  });

  // 주문 목록에서 바로 '지금 수집' (조회만 하므로 승인된 직원 누구나)
  router.post('/orders/collect', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      if (!collector) return flashBack(req, res, back, { type: 'error', message: '주문 수집이 꺼져 있습니다 (ORDER_SOURCE=off).' });
      const result = await collector.run();
      req.session.flash = collectFlash(result);
      res.redirect(back);
    } catch (e) {
      next(e);
    }
  });

  // 담당자·디자인 단계 바뀐 기록 (직원별 처리 현황에서 씀). 값이 그대로면 남기지 않는다
  const logEvent = (order, userId, kind, from, to) => {
    if ((from || null) === (to || null)) return;
    db.prepare('INSERT INTO order_events (channel, channel_order_id, user_id, kind, from_value, to_value) VALUES (?, ?, ?, ?, ?, ?)')
      .run(order.channel, order.channel_order_id, userId, kind, from || null, to || null);
  };

  // 목록에서 바로 디자인 단계 바꾸기 (주문 묶음 전체, 디자이너·관리자만)
  router.post('/orders/:id/design', (req, res) => {
    const back = safeBack(req.body.back);
    const order = findOrder(req.params.id);
    if (!order) return flashBack(req, res, back, { type: 'error', message: '주문을 찾을 수 없습니다.' });
    if (!canPickStage(req.user)) {
      return flashBack(req, res, back, { type: 'error', message: '디자인 단계는 디자이너만 바꿀 수 있습니다.' });
    }
    const stage = designStages().find(s => s.id === Number(req.body.design_stage_id) && s.active);
    if (!stage) return flashBack(req, res, back, { type: 'error', message: '고를 수 없는 디자인 단계입니다.' });
    const items = groupItems(order);
    db.prepare(
      "UPDATE orders SET design_stage_id = ?, version = version + 1, updated_at = datetime('now') WHERE channel = ? AND channel_order_id = ?"
    ).run(stage.id, order.channel, order.channel_order_id);
    logEvent(order, req.user.id, 'design', order.design_stage_id || firstDesignId(), stage.id);
    notifier.ordersChanged(items.map(i => i.id), req.user.id);
    req.session.flash = { type: 'ok', message: `'${items[0].product_name}' → ${stage.name}` };
    res.redirect(`${back}#o${items[0].id}`);
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
    logEvent(order, req.user.id, 'assign', order.assignee_id, assignee);
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

  // ───────── 발주서 출력 (A4 한 장에 주문 하나) ─────────
  // /orders/print?ids=3,7,9 (목록에서 체크한 주문) · /orders/12/print (주문 하나)
  router.get('/orders/print', (req, res) => {
    const ids = pickIds(String(req.query.ids || '').split(','));
    if (ids.error) return res.status(400).render('error', { title: '발주서', message: ids.error });
    renderPrint(res, ids);
  });
  router.get('/orders/:id/print', (req, res) => renderPrint(res, [Number(req.params.id)]));

  function renderPrint(res, ids) {
    const seen = new Set();
    const sheets = [];
    for (const id of ids) {
      const order = findOrder(id);
      if (!order) continue;
      const key = `${order.channel}:${order.channel_order_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const items = groupItems(order);
      const main = items[0];
      const design = db.prepare('SELECT name FROM design_stages WHERE id = ?').get(main.design_stage_id || firstDesignId() || -1);
      sheets.push({
        order: main, items,
        stageName: order.stage_name,
        assigneeName: order.assignee_name,
        designName: design ? design.name : null,
        sourceName: main.source_id ? (db.prepare('SELECT name FROM order_sources WHERE id = ?').get(main.source_id) || {}).name : null,
        today: items.some(i => i.channel_status === 'PAYED' && (i.delivery_type === 'TODAY' || i.delivery_type === 'OPTION_TODAY')),
        shipDue: items.filter(i => i.channel_status === 'PAYED' && i.ship_due).map(i => i.ship_due).sort()[0] || null,
        totalQty: items.reduce((n, i) => n + (Number(i.quantity) || 0), 0),
      });
    }
    if (!sheets.length) return res.status(404).render('error', { title: '발주서', message: '주문을 찾을 수 없습니다.' });
    res.render('orders/print', { title: `발주서 ${sheets.length}건`, sheets, printedAt: new Date().toISOString(), STEPS: PRINT_STEPS });
  }

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
  //   [송장번호 가져오기](refresh_slips=1): iLOGEN 에서 출력한 뒤 이 주문들의 송장번호를 로젠에서 가져와 다시 그린다
  router.post('/orders/bulk/dispatch-form', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      const ids = pickIds(req.body.ids);
      if (ids.error) return finish(req, res, back, { type: 'error', message: ids.error });
      let notice = null;
      if (req.body.refresh_slips === '1' && logen && logen.hasKey) {
        const pairs = ids.map(id => findOrder(id)).filter(Boolean).map(o => [o.channel, o.channel_order_id]);
        notice = slipFlash(await slipsOrError(pairs));
      }
      const { rows, skipped } = dispatchRows(ids);
      if (rows.length === 0) {
        return finish(req, res, back, {
          type: 'error',
          message: '고른 주문 중 발송처리할 수 있는 주문이 없습니다 (발주확인 전이거나 이미 발송된 주문).',
        });
      }
      renderBulkDispatch(res, { rows, skipped, back, notice });
    } catch (e) {
      next(e);
    }
  });

  // 여러 주문 일괄 발송처리 ② 보내기
  router.post('/orders/bulk/dispatch', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      const ids = pickIds(req.body.ids);
      if (ids.error) return finish(req, res, back, { type: 'error', message: ids.error });
      // 먼저 모든 줄을 검사하고, 하나라도 틀리면 아무것도 보내지 않는다 (입력한 값은 그대로 다시 보여준다)
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
          const { rows, skipped } = dispatchRows(ids);
          return renderBulkDispatch(res, {
            status: 400, rows, skipped, back, values: req.body,
            error: `'${name}': ${input.error} 아무것도 보내지 않았습니다.`,
          });
        }
        inputs.push([id, input]);
      }
      const results = [];
      for (const [id, input] of inputs) results.push(await actions.dispatch(id, req.user.id, input));
      afterActions(results, req.user.id);
      finish(req, res, back, summarize('발송처리', results));
    } catch (e) {
      next(e);
    }
  });

  // ───────── 로젠 송장 (src/logen.js) ─────────
  // 고른 주문을 로젠에 등록 → 직원이 iLOGEN 에서 출력 → [송장번호 가져오기]
  router.post('/orders/bulk/logen', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      if (!logen || !logen.hasKey) return flashBack(req, res, back, { type: 'error', message: '로젠 인증키(LOGEN_SECRET_KEY)가 .env 에 없습니다.' });
      const ids = pickIds(req.body.ids);
      if (ids.error) return flashBack(req, res, back, { type: 'error', message: ids.error });
      flashBack(req, res, back, logenFlash(await logen.register(groupsOf(ids), req.user.id)));
    } catch (e) {
      next(e);
    }
  });

  router.post('/orders/logen/slips', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      if (!logen || !logen.hasKey) return flashBack(req, res, back, { type: 'error', message: '로젠 인증키(LOGEN_SECRET_KEY)가 .env 에 없습니다.' });
      flashBack(req, res, back, slipFlash(await slipsOrError(null)));
    } catch (e) {
      next(e);
    }
  });

  router.post('/orders/:id/logen', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      const order = findOrder(req.params.id);
      if (!order || !logen || !logen.hasKey) return flashBack(req, res, selfUrl(req.params.id, back), { type: 'error', message: '로젠에 등록할 수 없습니다.' });
      flashBack(req, res, selfUrl(order.id, back), logenFlash(await logen.register([groupItems(order)], req.user.id)));
    } catch (e) {
      next(e);
    }
  });

  router.post('/orders/:id/logen/slip', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      const order = findOrder(req.params.id);
      if (!order || !logen || !logen.hasKey) return flashBack(req, res, selfUrl(req.params.id, back), { type: 'error', message: '로젠 연결이 없습니다.' });
      flashBack(req, res, selfUrl(order.id, back), slipFlash(await slipsOrError([[order.channel, order.channel_order_id]])));
    } catch (e) {
      next(e);
    }
  });

  router.post('/orders/:id/logen/track', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      const order = findOrder(req.params.id);
      const url = selfUrl(req.params.id, back);
      const slip = order && logenSlipOf(order);
      if (!slip || !logen || !logen.hasKey) return flashBack(req, res, url, { type: 'error', message: '조회할 로젠 송장번호가 없습니다.' });
      try {
        const r = await logen.track(slip, { channel: order.channel, orderId: order.channel_order_id });
        const last = r.events[r.events.length - 1];
        flashBack(req, res, url, { type: 'ok', message: last ? `배송 조회: ${last.stat}${r.cached ? ' (5분 안에 조회한 결과)' : ''}` : '아직 로젠에 배송 기록이 없어요 (집하 전).' });
      } catch (e) {
        flashBack(req, res, url, { type: 'error', message: `배송 조회 실패: ${e.message}` });
      }
    } catch (e) {
      next(e);
    }
  });

  // 주문 번호 목록 → 주문 묶음(같은 주문번호 상품) 목록, 같은 묶음은 한 번만
  function groupsOf(ids) {
    const seen = new Set();
    const out = [];
    for (const id of ids) {
      const order = findOrder(id);
      if (!order) continue;
      const key = `${order.channel}:${order.channel_order_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(groupItems(order));
    }
    return out;
  }

  async function slipsOrError(only) {
    try {
      return await logen.fetchSlips(only);
    } catch (e) {
      return { error: e.message };
    }
  }

  // 이 주문의 로젠 송장번호: 로젠에서 가져온 번호, 없으면 발송처리 때 넣은 로젠택배 송장번호
  function logenSlipOf(order) {
    const s = logen && logen.shipmentOf(order.channel, order.channel_order_id);
    if (s && s.slip_no) return s.slip_no;
    const shipped = groupItems(order).find(i => i.shipped_at && i.ship_company === 'KGB' && i.tracking_no);
    return shipped ? shipped.tracking_no : null;
  }

  // 일괄 발송처리 입력 줄: 발송처리할 수 있는 주문만, 나머지는 '뺀 주문'
  function dispatchRows(ids) {
    const rows = [];
    const skipped = [];
    for (const id of ids) {
      const order = findOrder(id);
      if (!order) continue;
      const items = groupItems(order);
      const lg = logen && logen.shipmentOf(order.channel, order.channel_order_id);
      // waiting: 로젠에 등록했지만 아직 iLOGEN 에서 출력하지 않아 송장번호가 없는 주문
      if (items.some(canDispatch)) rows.push({ main: items[0], items: items.filter(canDispatch), slip: (lg && lg.slip_no) || '', waiting: Boolean(lg && lg.status === 'registered' && !lg.slip_no) });
      else skipped.push(items[0].product_name);
    }
    return { rows, skipped };
  }

  function renderBulkDispatch(res, { status = 200, rows, skipped, back, values = {}, error = null, notice = null }) {
    res.status(status).render('orders/bulk-dispatch', {
      title: '일괄 발송처리', rows, skipped, back, values, error, notice, SHIP_METHODS, COURIERS, DEFAULT_METHOD, DEFAULT_COURIER,
    });
  }

  // 일괄 처리가 끝난 뒤: 팝업 안이면 결과를 팝업에 보여주고, 아니면 목록으로 돌아가 안내한다
  function finish(req, res, back, flash) {
    if (res.locals.embed) return res.render('orders/bulk-done', { title: '처리 결과', result: flash });
    req.session.flash = flash;
    res.redirect(back);
  }

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

  // 주문 하나 발송지연 처리 (스마트스토어만, 주문마다 한 번)
  router.post('/orders/:id/delay', async (req, res, next) => {
    try {
      const back = safeBack(req.body.back);
      const input = checkDelayInput({ date: req.body.date, reason: req.body.reason, detail: req.body.detail });
      if (input.error) {
        return flashBack(req, res, selfUrl(req.params.id, back), { type: 'error', message: input.error });
      }
      const result = await actions.delay(req.params.id, req.user.id, input);
      if (result.result === 'ok' || result.result === 'partial') result.message += ` (새 발송기한 ${input.date})`;
      afterActions([result], req.user.id);
      req.session.flash = single('발송지연', result);
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
    const sourceName = order.source_id ? (db.prepare('SELECT name FROM order_sources WHERE id = ?').get(order.source_id) || {}).name : null;
    // 작업 파일 이름 한 줄: 관리자 › 주문 수집 에서 정한 모양으로
    const pattern = (db.prepare("SELECT value FROM settings WHERE key = 'file_label_pattern'").get() || {}).value;
    res.render('orders/detail', {
      title: items[0].product_name,
      order,
      sourceName,
      fileLabel: fileLabel(pattern, { order, items, sourceName, channelName: res.locals.channelInfo(order.channel).name, kst: res.app.locals.kst }),
      items,
      canConfirm: items.some(canConfirm),
      canDispatch: items.some(canDispatch),
      canDelay: items.some(canDelay),
      delayed: items.find(i => i.channel_status === 'PAYED' && i.ship_delayed) || null,
      DELAY_REASONS,
      DELAY_DEFAULT_TEXT,
      delayMin: kstDay(1),
      delayDefault: kstDay(3),
      claimItems: items.filter(i => i.claim_status),
      shipped: items.find(i => i.shipped_at) || null,
      history: history(order),
      customer: historyForOrder(db, order),
      logen: logenView(order, items),
      SHIP_METHODS,
      COURIERS,
      DEFAULT_METHOD,
      DEFAULT_COURIER,
      stages: stages(),
      designers: designers(),
      isDesigner: designers().some(d => d.id === req.user.id),
      designStages: designStages(),
      currentDesignId: items[0].design_stage_id || firstDesignId(),
      canPickStage: canPickStage(req.user),
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
      UPDATE orders SET assignee_id = ?, stage_id = ?, design_stage_id = ?, due_date = ?, memo = ?, nas_path = ?,
        version = version + 1, updated_at = datetime('now')
      WHERE channel = ? AND channel_order_id = ?
    `).run(changes.assignee_id, changes.stage_id, changes.design_stage_id, changes.due_date, changes.memo, changes.nas_path,
      order.channel, order.channel_order_id);
    logEvent(order, req.user.id, 'assign', order.assignee_id, changes.assignee_id);
    logEvent(order, req.user.id, 'design', order.design_stage_id || firstDesignId(), changes.design_stage_id || firstDesignId());

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

    // 주문 단계(발주·발주확인·발송)는 보통 자동. 손으로 고치는 건 관리자만 (판매자센터에서 직접 처리한 주문 맞추기)
    const stage = body.stage_id ? Number(body.stage_id) : order.stage_id;
    if (stage !== order.stage_id) {
      if (user.role !== 'admin') return { error: '주문 단계는 관리자만 바꿀 수 있습니다.' };
      if (!stages().some(s => s.active && s.id === stage)) return { error: '고를 수 없는 주문 단계입니다.' };
    }
    // 디자인 단계: 디자이너·관리자만
    const currentDesign = order.design_stage_id || firstDesignId();
    const design = body.design_stage_id ? Number(body.design_stage_id) : currentDesign;
    if (design !== currentDesign) {
      if (!canPickStage(user)) return { error: '디자인 단계는 디자이너만 바꿀 수 있습니다.' };
      if (!designStages().some(s => s.active && s.id === design)) return { error: '고를 수 없는 디자인 단계입니다.' };
    }

    const due = String(body.due_date || '').trim();
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { error: '납기 날짜 형식이 올바르지 않습니다.' };

    return {
      assignee_id: assignee,
      stage_id: stage,
      design_stage_id: design,
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

  // 주문 카드의 로젠 칸: 등록 상태·송장번호·마지막 배송 조회
  function logenView(order, items) {
    if (!logen || !logen.hasKey) return null;
    const ship = logen.shipmentOf(order.channel, order.channel_order_id);
    const slip = logenSlipOf(order);
    return { env: logen.env, ship, slip, canRegister: logen.canRegister(items), track: slip ? logen.lastTrack(slip) : null };
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

// 로젠 등록 결과 → 안내 문구
function logenFlash(r) {
  if (r.error) return { type: 'error', message: r.error };
  const details = [
    ...r.failed.map(f => `실패 · ${f.name}: ${f.message}`),
    ...r.skipped.map(f => `뺀 주문 · ${f.name}: ${f.reason}`),
  ].slice(0, 20);
  const head = r.done
    ? `로젠에 ${r.done}건 등록했습니다. iLOGEN '주문등록출력(복수건)'에서 출력한 뒤 [송장번호 가져오기]를 누르세요.`
    : '로젠에 등록한 주문이 없습니다.';
  return { type: r.failed.length ? 'warn' : r.done ? 'ok' : 'error', message: head, details };
}

function slipFlash(r) {
  if (r.error) return { type: 'error', message: `송장번호를 가져오지 못했습니다: ${r.error}` };
  if (!r.checked) return { type: 'ok', message: '송장번호를 기다리는 로젠 등록 주문이 없습니다.' };
  const parts = [`송장번호 ${r.found}건 받음`];
  if (r.waiting) parts.push(`아직 출력 전 ${r.waiting}건`);
  if (r.deleted) parts.push(`iLOGEN 에서 지워진 주문 ${r.deleted}건 (다시 등록할 수 있음)`);
  return { type: r.found ? 'ok' : 'warn', message: `${parts.join(' · ')}${r.found ? ' — 발송처리 칸에 송장번호를 채워 두었어요.' : ''}` };
}

// 수집 결과 안내 (여러 채널 중 일부만 실패하면 들어온 건수와 실패 이유를 함께)
function collectFlash(result) {
  const counts = `새 주문 ${result.createdOrders || 0}건, 바뀐 상품주문 ${result.updated || 0}건`;
  if (result.ok) return { type: 'ok', message: `수집 완료: ${counts}` };
  if (result.createdOrders !== undefined) return { type: 'warn', message: `일부 채널 수집 실패 (${result.error}) · ${counts}` };
  return { type: 'error', message: `수집 실패: ${result.error}` };
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
  return kstDay(0);
}

// 오늘부터 offset 일 뒤의 한국 날짜 'YYYY-MM-DD'
function kstDay(offset) {
  return new Date(Date.now() + 9 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);
}

module.exports = { orderRoutes, safeBack, collectFlash };
