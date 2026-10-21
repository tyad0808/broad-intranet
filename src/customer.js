// 고객 이력: 한 고객의 다른 주문·문의·메일을 모은다
//
// 같은 고객 찾기
//   확실: 전화번호가 같은 주문 (숫자만 비교). 050으로 시작하는 안심번호는 주문마다 바뀌므로 쓰지 않는다
//         그 주문들의 주문번호로 들어온 쇼핑몰 문의
//   참고: 이름만 같은 주문·문의·메일 (동명이인일 수 있어 따로 보여준다)
const { ENDED_SQL } = require('./collector');

const MAX = 10;
const digits = v => String(v || '').replace(/\D/g, '');
// 비교에 쓸 수 있는 전화번호 (휴대폰·일반 전화, 9자리 이상, 안심번호 제외)
const phoneKey = v => {
  const d = digits(v);
  return d.length >= 9 && !d.startsWith('050') ? d : null;
};
// '홍길동 (hong12)' → '홍길동', 가려진 이름(abc***)은 비교하지 않는다
const nameKey = v => {
  const n = String(v || '').replace(/\s*\(.*\)\s*$/, '').trim();
  return n && !n.includes('*') ? n : null;
};
const PHONE_SQL = col => `replace(replace(replace(COALESCE(${col}, ''), '-', ''), ' ', ''), '.', '')`;

// 주문 묶음 요약 (주문번호 단위): 대표 상품, 상품 수, 결제일, 끝났는지
function groupSummaries(db, where, params) {
  return db.prepare(`
    SELECT MIN(o.id) AS id, o.channel, o.channel_order_id, MAX(o.paid_at) AS paid_at, COUNT(*) AS items,
      (SELECT x.product_name FROM orders x WHERE x.channel = o.channel AND x.channel_order_id = o.channel_order_id
        ORDER BY x.item_type = 'addon', x.id LIMIT 1) AS product_name,
      MIN(o.channel_status IN (${ENDED_SQL})) AS ended, MAX(o.channel_status = 'CANCELED') AS canceled
    FROM orders o WHERE ${where}
    GROUP BY o.channel, o.channel_order_id
    ORDER BY paid_at DESC
  `).all(...params);
}

// 주문 하나 기준: 같은 고객의 다른 주문과 문의
function historyForOrder(db, order) {
  const phones = [...new Set([phoneKey(order.receiver_phone), phoneKey(order.buyer_phone)].filter(Boolean))];
  const name = nameKey(order.buyer_name);
  const notThis = 'NOT (o.channel = ? AND o.channel_order_id = ?)';
  const self = [order.channel, order.channel_order_id];

  const sure = phones.length
    ? groupSummaries(db, `(${PHONE_SQL('o.receiver_phone')} IN (${phones.map(() => '?').join(',')}) OR ${PHONE_SQL('o.buyer_phone')} IN (${phones.map(() => '?').join(',')})) AND ${notThis}`,
      [...phones, ...phones, ...self])
    : [];
  const sureKeys = new Set(sure.map(g => `${g.channel}:${g.channel_order_id}`));
  const nameOnly = name
    ? groupSummaries(db, `o.buyer_name = ? AND ${notThis}`, [name, ...self]).filter(g => !sureKeys.has(`${g.channel}:${g.channel_order_id}`))
    : [];

  // 문의: 이 고객 주문번호로 온 것(확실) + 이름이 같은 것(참고)
  const orderNos = [order.channel_order_id, ...sure.map(g => g.channel_order_id)];
  const inquiries = db.prepare(`
    SELECT id, source, subject, received_at, status FROM inquiries
    WHERE deleted_at IS NULL AND order_no IN (${orderNos.map(() => '?').join(',')})
    ORDER BY received_at DESC LIMIT ${MAX}
  `).all(...orderNos);
  const seen = new Set(inquiries.map(i => i.id));
  const nameInquiries = name
    ? db.prepare(`
        SELECT id, source, subject, received_at, status FROM inquiries
        WHERE deleted_at IS NULL AND (from_name = ? OR from_name LIKE ?)
        ORDER BY received_at DESC LIMIT ${MAX * 2}
      `).all(name, `${name} (%`).filter(i => !seen.has(i.id)).slice(0, MAX)
    : [];

  // 이번이 몇 번째 주문인지 (전화번호로 찾은 주문 중 이번 주문보다 먼저인 것 + 1)
  const earlier = sure.filter(g => g.paid_at && order.paid_at && g.paid_at < order.paid_at).length;
  return {
    orders: sure.slice(0, MAX), moreOrders: Math.max(0, sure.length - MAX),
    nameOrders: nameOnly.slice(0, MAX),
    inquiries, nameInquiries,
    nth: sure.length ? earlier + 1 : 1,
    total: sure.length + 1,
  };
}

// 문의 하나 기준: 이 고객의 주문 (주문번호 → 그 주문의 전화번호로 다른 주문까지 / 없으면 이름이 같은 주문)
function ordersForInquiry(db, inquiry) {
  const linked = inquiry.order_no
    ? db.prepare('SELECT * FROM orders WHERE channel_order_id = ? ORDER BY id LIMIT 1').get(String(inquiry.order_no))
    : null;
  if (linked) {
    const h = historyForOrder(db, linked);
    const own = groupSummaries(db, 'o.channel = ? AND o.channel_order_id = ?', [linked.channel, linked.channel_order_id]);
    return { orders: [...own, ...h.orders].slice(0, MAX), nameOrders: [], sure: true };
  }
  const name = nameKey(inquiry.from_name);
  return { orders: [], nameOrders: name ? groupSummaries(db, 'o.buyer_name = ?', [name]).slice(0, MAX) : [], sure: false };
}

module.exports = { historyForOrder, ordersForInquiry, phoneKey, nameKey };
