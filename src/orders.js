// 주문 현황판: 주문 카드 조회, 직접 등록(전화·매장), 단계 이동, 담당자·납기 지정, 완료 처리
// 바뀐 내용은 order_events 에 "누가 언제 무엇을" 으로 남긴다.
const crypto = require('crypto');
const { transaction } = require('./db');

class UserError extends Error {}

// 접수 경로. smartstore 는 자동 수집, 나머지는 직원이 직접 등록
const CHANNEL_LABELS = {
  smartstore: '스토어',
  phone: '전화',
  walkin: '매장',
  kakao: '카톡',
  etc: '기타',
};
const MANUAL_CHANNELS = ['phone', 'walkin', 'kakao', 'etc'];
const isManual = order => MANUAL_CHANNELS.includes(order.channel);

// 채널에서 취소·반품된 주문 (카드에 표시해서 작업하지 않게)
const CANCELED = new Set(['CANCELED', 'RETURNED', 'CANCELED_BY_NOPAYMENT']);

// 한국 날짜 (YYYY-MM-DD). 납기는 날짜만 저장하므로 한국 기준 오늘과 비교한다
function kstDate(date, addDays = 0) {
  return new Date(date.getTime() + 9 * 3600 * 1000 + addDays * 86400 * 1000).toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(value, max, label, { required = false } = {}) {
  const v = String(value || '').trim();
  if (required && !v) throw new UserError(`${label}을(를) 입력하세요.`);
  if (v.length > max) throw new UserError(`${label}은(는) ${max}자 이하로 입력하세요.`);
  return v || null;
}

function createOrderService({ db, now = () => new Date() }) {
  const stages = () => db.prepare('SELECT id, name, sort_order FROM work_stages WHERE active = 1 ORDER BY sort_order, id').all();
  const setting = key => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? Number(row.value) || null : null;
  };
  const assignees = () => db.prepare(`
    SELECT u.id, u.name, j.name AS job_name FROM users u LEFT JOIN jobs j ON j.id = u.job_id
    WHERE u.status = 'active' ORDER BY j.sort_order IS NULL, j.sort_order, u.name`).all();
  const userName = id => {
    if (!id) return '없음';
    const row = db.prepare('SELECT name FROM users WHERE id = ?').get(id);
    return row ? row.name : '없음';
  };
  const stageName = id => {
    const row = id && db.prepare('SELECT name FROM work_stages WHERE id = ?').get(id);
    return row ? row.name : '없음';
  };
  // 이름 붙인 값(:today 등)을 쓰는 쿼리. 쓰지 않는 값이 넘어와도 오류 내지 않게
  const named = sql => {
    const stmt = db.prepare(sql);
    stmt.setAllowUnknownNamedParameters(true);
    return stmt;
  };
  const log = (orderId, user, message) =>
    db.prepare('INSERT INTO order_events (order_id, user_id, message) VALUES (?, ?, ?)').run(orderId, user ? user.id : null, message);

  const SELECT = `
    SELECT o.*, u.name AS assignee_name, s.name AS stage_name, s.active AS stage_active
    FROM orders o LEFT JOIN users u ON u.id = o.assignee_id LEFT JOIN work_stages s ON s.id = o.stage_id`;
  // 급한 건 → 납기 빠른 순 → 납기 없는 건 → 먼저 들어온 순
  const ORDER_BY = 'ORDER BY o.urgent DESC, o.due_date IS NULL, o.due_date, o.id';

  // 카드 색 표시용: late 납기 지남, soon 오늘·내일
  function decorate(order, today = kstDate(now()), tomorrow = kstDate(now(), 1)) {
    if (!order) return order;
    let due = '';
    if (order.due_date && !order.done_at) {
      if (order.due_date < today) due = 'late';
      else if (order.due_date <= tomorrow) due = 'soon';
    }
    const dueLabel = !order.due_date ? null
      : order.due_date === today ? '오늘'
      : order.due_date === tomorrow ? '내일'
      : order.due_date.slice(5).replace('-', '/');
    return {
      ...order,
      due,
      dueLabel,
      channelLabel: CHANNEL_LABELS[order.channel] || order.channel,
      manual: isManual(order),
      canceled: CANCELED.has(order.channel_status),
      customer: order.buyer_name || order.receiver_name || '-',
    };
  }

  // 요약 칸에서 고르는 필터
  const FILTERS = {
    today: { label: '오늘 발송', where: 'o.due_date = :today' },
    tomorrow: { label: '내일 발송', where: 'o.due_date = :tomorrow' },
    late: { label: '납기 지남', where: 'o.due_date < :today' },
    unassigned: { label: '미배정', where: 'o.assignee_id IS NULL' },
  };

  // 현황판: 진행 중(완료 전) 주문을 단계별 칸으로 나눈다
  function board({ userId = null, filter = null } = {}) {
    const today = kstDate(now());
    const tomorrow = kstDate(now(), 1);
    const params = { today, tomorrow };
    const base = ['o.done_at IS NULL'];
    if (userId) {
      base.push('o.assignee_id = :me');
      params.me = userId;
    }
    const count = where => named(`SELECT COUNT(*) AS n FROM orders o WHERE ${[...base, where].join(' AND ')}`)
      .get(params).n;
    const summary = Object.entries(FILTERS).map(([key, f]) => ({ key, label: f.label, count: count(f.where) }));

    const where = [...base];
    if (FILTERS[filter]) where.push(FILTERS[filter].where);
    const orders = named(`${SELECT} WHERE ${where.join(' AND ')} ${ORDER_BY}`).all(params)
      .map(o => decorate(o, today, tomorrow));

    const columns = stages().map(s => ({ ...s, orders: orders.filter(o => o.stage_id === s.id) }));
    // 숨긴 단계에 있거나 단계가 없는 카드는 맨 앞 '단계 없음' 칸에
    const stray = orders.filter(o => !o.stage_active);
    if (stray.length) columns.unshift({ id: null, name: '단계 없음', orders: stray });
    return { columns, summary, total: orders.length };
  }

  // 내 작업 건수 (탭에 표시)
  const myCount = userId => db.prepare('SELECT COUNT(*) AS n FROM orders WHERE done_at IS NULL AND assignee_id = ?').get(userId).n;

  // 완료한 주문 (최근 것부터)
  function done(limit = 100) {
    return db.prepare(`${SELECT} WHERE o.done_at IS NOT NULL ORDER BY o.done_at DESC LIMIT ?`).all(limit).map(o => decorate(o));
  }

  // 검색: 완료한 주문까지 찾는다 ("작년에 했던 그 현수막")
  function search(q, limit = 100) {
    const words = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
    if (!words.length) return [];
    const where = [];
    const params = [];
    for (const w of words) {
      const like = `%${w.replace(/[\\%_]/g, c => '\\' + c)}%`;
      const digits = w.replace(/[^0-9]/g, '');
      const fields = ['o.product_name', 'o.option_text', 'o.buyer_name', 'o.receiver_name', 'o.memo', 'o.channel_order_id', 'o.receiver_address']
        .map(f => `${f} LIKE ? ESCAPE '\\'`);
      params.push(...Array(fields.length).fill(like));
      // 전화번호는 하이픈 없이도 찾게
      if (digits.length >= 3) {
        fields.push("REPLACE(REPLACE(o.receiver_phone, '-', ''), ' ', '') LIKE ?");
        params.push(`%${digits}%`);
      }
      where.push(`(${fields.join(' OR ')})`);
    }
    return db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY o.done_at IS NOT NULL, o.id DESC LIMIT ?`)
      .all(...params, limit).map(o => decorate(o));
  }

  const get = id => decorate(db.prepare(`${SELECT} WHERE o.id = ?`).get(Number(id)) || null);
  const events = orderId => db.prepare(`
    SELECT e.*, u.name AS user_name FROM order_events e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.order_id = ? ORDER BY e.id DESC LIMIT 100`).all(orderId);

  // 직원이 고른 담당자·납기·급·메모를 확인한다
  function workFields(fields) {
    const due = String(fields.due_date || '').trim();
    if (due && (!DATE_RE.test(due) || Number.isNaN(Date.parse(due)))) throw new UserError('납기 날짜가 올바르지 않습니다.');
    let assigneeId = Number(fields.assignee_id) || null;
    if (assigneeId && !db.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").get(assigneeId)) {
      throw new UserError('담당자를 다시 골라 주세요.');
    }
    return {
      assignee_id: assigneeId,
      due_date: due || null,
      urgent: fields.urgent === '1' ? 1 : 0,
      memo: text(fields.memo, 2000, '작업 메모'),
    };
  }

  // 직접 등록한 주문만 고칠 수 있는 칸 (스마트스토어 주문은 수집할 때 덮어써지므로 고치지 않는다)
  function customerFields(fields) {
    const qty = fields.quantity === undefined || fields.quantity === '' ? 1 : Number(fields.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99999) throw new UserError('수량은 1 이상 숫자로 입력하세요.');
    return {
      product_name: text(fields.product_name, 200, '상품', { required: true }),
      option_text: text(fields.option_text, 300, '규격·옵션'),
      quantity: qty,
      buyer_name: text(fields.buyer_name, 100, '고객명', { required: true }),
      receiver_phone: text(fields.receiver_phone, 30, '전화번호'),
      receiver_address: text(fields.receiver_address, 300, '주소'),
    };
  }

  // 전화·매장·카톡 주문 직접 등록
  function create({ user, fields }) {
    const channel = MANUAL_CHANNELS.includes(fields.channel) ? fields.channel : null;
    if (!channel) throw new UserError('접수 경로를 고르세요.');
    const c = customerFields(fields);
    const w = workFields(fields);
    const code = 'M-' + crypto.randomBytes(5).toString('hex');
    return transaction(db, () => {
      const info = db.prepare(`
        INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, option_text, quantity,
          buyer_name, receiver_name, receiver_phone, receiver_address, paid_at,
          stage_id, assignee_id, due_date, urgent, memo, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`).run(
        channel, code, code, c.product_name, c.option_text, c.quantity,
        c.buyer_name, c.buyer_name, c.receiver_phone, c.receiver_address,
        setting('stage_new') || (stages()[0] || {}).id || null, w.assignee_id, w.due_date, w.urgent, w.memo, user.id
      );
      const id = Number(info.lastInsertRowid);
      log(id, user, `주문 등록 (${CHANNEL_LABELS[channel]})`);
      if (w.assignee_id) log(id, user, `담당자: ${userName(w.assignee_id)}`);
      return id;
    });
  }

  // 상세 화면에서 저장: 바뀐 칸만 기록에 남긴다
  function update({ user, order, fields }) {
    const w = workFields(fields);
    const c = order.manual ? customerFields(fields) : {};
    const changes = [];
    if (w.assignee_id !== order.assignee_id) changes.push(`담당자: ${userName(order.assignee_id)} → ${userName(w.assignee_id)}`);
    if (w.due_date !== order.due_date) changes.push(`납기: ${order.due_date || '없음'} → ${w.due_date || '없음'}`);
    if (w.urgent !== order.urgent) changes.push(w.urgent ? '급 표시' : '급 해제');
    if (w.memo !== order.memo) changes.push('작업 메모 수정');
    const changedCustomer = Object.keys(c).some(k => c[k] !== order[k]);
    if (changedCustomer) changes.push('주문 내용 수정');
    if (!changes.length) return 0;

    const all = { ...w, ...c, ...(order.manual ? { receiver_name: c.buyer_name } : {}) };
    const keys = Object.keys(all);
    transaction(db, () => {
      db.prepare(`UPDATE orders SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...keys.map(k => all[k]), order.id);
      changes.forEach(m => log(order.id, user, m));
    });
    return changes.length;
  }

  // 단계 옮기기. 이동할 단계를 번호로 받으므로 두 번 눌러도 결과가 같다
  function moveStage({ user, order, stageId }) {
    const stage = db.prepare('SELECT id, name FROM work_stages WHERE id = ? AND active = 1').get(Number(stageId));
    if (!stage) throw new UserError('단계를 다시 골라 주세요.');
    if (order.done_at) throw new UserError('완료한 주문입니다. 다시 열기를 먼저 누르세요.');
    if (stage.id === order.stage_id) return false;
    transaction(db, () => {
      db.prepare("UPDATE orders SET stage_id = ?, updated_at = datetime('now') WHERE id = ?").run(stage.id, order.id);
      log(order.id, user, `단계: ${stageName(order.stage_id)} → ${stage.name}`);
    });
    return true;
  }

  function complete({ user, order }) {
    const info = db.prepare("UPDATE orders SET done_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND done_at IS NULL").run(order.id);
    if (info.changes) log(order.id, user, '완료 처리');
    return info.changes > 0;
  }

  function reopen({ user, order }) {
    const info = db.prepare("UPDATE orders SET done_at = NULL, updated_at = datetime('now') WHERE id = ? AND done_at IS NOT NULL").run(order.id);
    if (info.changes) log(order.id, user, '다시 열기');
    return info.changes > 0;
  }

  return { stages, assignees, board, myCount, done, search, get, events, create, update, moveStage, complete, reopen, FILTERS };
}

module.exports = { createOrderService, UserError, CHANNEL_LABELS, MANUAL_CHANNELS, kstDate };
