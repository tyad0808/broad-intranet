// 알림 규칙: 누구에게, 언제, 무엇을 알릴지
//
//  신규 발주   새 주문이 수집될 때            → 전 직원
//  미지정 초과 담당자 없는 진행 중 주문이 기준 건수를 넘을 때
//              (넘는 순간 1회, 해소될 때까지 정해진 간격마다 다시) → 관리자 + 관리자가 지정한 직원
//  가입 신청   직원이 회원가입할 때           → 관리자
//  클레임      고객이 취소·반품·교환을 요청할 때 → 관리자 + 그 주문 담당자
const { EventHub } = require('./events');
const { claimLabel } = require('./channels/labels');
const { ENDED_SQL } = require('./collector');

function createNotifier({ db, hub = new EventHub(), now = () => Date.now() }) {
  const activeUserStmt = db.prepare("SELECT id, role FROM users WHERE id = ? AND status = 'active'");
  const setting = key => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  const record = db.prepare('INSERT INTO notifications (type, message, order_id) VALUES (?, ?, ?)');

  // 받을 사람 판단: 보내는 순간에도 계정이 '사용 중' 인지 다시 확인한다
  const receivers = rule => userId => {
    const user = activeUserStmt.get(userId);
    return Boolean(user) && rule(user);
  };
  const everyone = receivers(() => true);
  const admins = receivers(u => u.role === 'admin');
  const isUnassignedRecipient = u => {
    if (u.role === 'admin') return true;
    try {
      return JSON.parse(setting('unassigned_recipients') || '[]').includes(u.id);
    } catch {
      return false;
    }
  };
  const unassignedReceivers = receivers(isUnassignedRecipient);

  function notify(type, { title, body, url }, canReceive) {
    hub.send('notify', { type, title, body, url }, canReceive);
  }

  // 주문 목록·카드를 보고 있는 화면들에게 "다시 불러오라" 고 알린다
  function ordersChanged(ids = [], actorId = null) {
    hub.send('orders-changed', { ids, actorId }, everyone);
  }

  // ── 미지정 초과 ──
  let overSince = null;     // 기준을 넘은 상태가 시작된 시각
  let lastAlertAt = null;   // 마지막으로 알린 시각

  function unassignedCount() {
    const last = db.prepare('SELECT id FROM work_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1').get();
    // 주문 묶음(채널 + 주문번호) 단위로 센다: 본상품과 추가상품은 1건.
    // 채널에서 이미 끝난 주문(배송중·취소 등)은 빼고 센다
    return db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM orders
        WHERE assignee_id IS NULL AND (stage_id IS NULL OR stage_id != ?)
        GROUP BY channel, channel_order_id
        HAVING MIN(CASE WHEN channel_status IN (${ENDED_SQL}) THEN 1 ELSE 0 END) = 0
      )
    `).get(last ? last.id : -1).n;
  }

  // 화면 위쪽 배너용: 지금 기준을 넘었는지 (알림을 놓쳐도 배너는 계속 보이게)
  function unassignedBanner(user) {
    if (!user || user.status !== 'active' || !isUnassignedRecipient(user)) return null;
    const threshold = Number(setting('unassigned_threshold')) || 5;
    const count = unassignedCount();
    return count > threshold ? { count, threshold } : null;
  }

  function checkUnassigned() {
    const threshold = Number(setting('unassigned_threshold')) || 5;
    const repeatMs = (Number(setting('unassigned_repeat_minutes')) || 30) * 60 * 1000;
    const count = unassignedCount();

    if (count <= threshold) {
      overSince = null;
      lastAlertAt = null;
      return { count, alerted: false };
    }
    const t = now();
    if (overSince === null) overSince = t;
    if (lastAlertAt !== null && t - lastAlertAt < repeatMs) return { count, alerted: false };

    lastAlertAt = t;
    const message = `담당 디자이너가 없는 주문이 ${count}건입니다 (기준 ${threshold}건).`;
    record.run('unassigned_over', message, null);
    notify('unassigned_over', { title: '미지정 주문이 쌓였습니다', body: message, url: '/?view=unassigned' }, unassignedReceivers);
    return { count, alerted: true };
  }

  // 주문 수집이 끝날 때마다 호출된다
  function afterCollect(result) {
    if (!result || !result.ok) return;
    if (result.created > 0) {
      // 알림 기록(notifications)은 수집기가 주문마다 이미 남겼으므로 여기서는 화면에만 보낸다.
      // 본상품과 추가상품을 1건으로 세고, 이름은 본상품 이름으로 보여준다
      const marks = result.createdIds.map(() => '?').join(',');
      const orderCount = db.prepare(
        `SELECT COUNT(DISTINCT channel || ':' || channel_order_id) AS n FROM orders WHERE id IN (${marks})`
      ).get(...result.createdIds).n;
      const names = db.prepare(
        `SELECT product_name FROM orders WHERE id IN (${marks}) AND item_type != 'addon' ORDER BY id LIMIT 3`
      ).all(...result.createdIds).map(r => r.product_name);
      const more = orderCount > names.length ? ` 외 ${orderCount - names.length}건` : '';
      notify('new_order', {
        title: `신규 발주 ${orderCount}건`,
        body: names.join(', ') + more,
        url: '/?view=unassigned',
      }, everyone);
    }
    claims(result.claims || []);
    if (result.created > 0 || result.updated > 0) ordersChanged(result.createdIds || []);
    checkUnassigned();
  }

  // 취소·반품·교환 요청: 주문 묶음마다 1번, 관리자와 그 주문 담당자에게
  function claims(list) {
    const seen = new Set();
    for (const c of list) {
      const order = db.prepare('SELECT id, channel, channel_order_id, assignee_id FROM orders WHERE id = ?').get(c.id);
      if (!order) continue;
      const key = `${order.channel}:${order.channel_order_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const main = db.prepare(
        "SELECT id, product_name FROM orders WHERE channel = ? AND channel_order_id = ? ORDER BY CASE WHEN item_type = 'addon' THEN 1 ELSE 0 END, id LIMIT 1"
      ).get(order.channel, order.channel_order_id);
      const label = claimLabel(c.claim_status);
      notify('claim', {
        title: `${label}: 확인이 필요합니다`,
        body: `${main.product_name} (주문번호 ${order.channel_order_id})`,
        url: `/orders/${main.id}`,
      }, receivers(u => u.role === 'admin' || u.id === order.assignee_id));
    }
  }

  // 달력 일정이 바뀌면 다른 직원 화면의 달력도 새로 그린다
  // 문의함이 바뀌었을 때 (새 문의, 답변, 담당자 지정 등) 문의함 화면들에게 다시 불러오라고 알린다
  function inboxChanged(ids = [], actorId = null) {
    hub.send('inbox-changed', { ids, actorId }, everyone);
  }

  function calendarChanged(actorId = null) {
    hub.send('calendar-changed', { actorId }, everyone);
  }

  function signup(user) {
    const message = `${user.name}(${user.email}) 님이 가입을 신청했습니다.`;
    record.run('signup', message, null);
    notify('signup', { title: '가입 신청', body: message, url: '/admin/users' }, admins);
  }

  // 저장 공간: 디스크가 기준(80%)을 넘으면 관리자에게 하루 한 번 알린다
  function checkStorage(info, today) {
    if (!info.alert) return false;
    if (setting('storage_alert_day') === today) return false;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('storage_alert_day', today);
    notify('storage', {
      title: '서버 저장 공간 부족',
      body: `디스크를 ${info.disk.percent}% 쓰고 있습니다. 관리자 → 저장 공간에서 확인하세요.`,
      url: '/admin/storage',
    }, admins);
    return true;
  }

  return { hub, notify, ordersChanged, inboxChanged, calendarChanged, checkUnassigned, checkStorage, afterCollect, signup, unassignedCount, unassignedBanner };
}

module.exports = { createNotifier };
