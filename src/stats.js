// 통계 (관리자만): 매출·주문 수·채널별·일별·잘 팔리는 상품·요일×시간대·취소·반품
//
// 금액: 채널 주문은 상품주문마다 받은 결제 금액(pay_amount, 할인 뒤·배송비 제외)을 더한다.
//       수기 주문은 주문 전체 금액(amount)을 한 번만 센다.
// 시각: 결제 시각(없으면 등록 시각)을 한국 시간으로. 채널마다 모양이 달라서 SQLite datetime() 으로 맞춘다
const { utcSql } = require('./retention');

// 매출에서 빼는 상태: 취소·반품·입금 전
const DEAD = "('CANCELED', 'CANCELED_BY_NOPAYMENT', 'PAYMENT_WAITING', 'RETURNED')";
const T = 'datetime(COALESCE(o.paid_at, o.created_at))';

// 주문 묶음(주문번호) 단위 표
const GROUPS = `
  WITH g AS (
    SELECT o.channel AS ch, o.channel_order_id AS oid, MIN(${T}) AS t,
      CASE WHEN o.channel = 'manual' THEN MAX(o.amount)
           ELSE SUM(CASE WHEN o.channel_status NOT IN ${DEAD} THEN o.pay_amount END) END AS amt,
      MIN(o.channel_status IN ${DEAD}) AS dead,
      MAX(o.channel_status = 'PAYMENT_WAITING') AS waiting,
      MAX(o.channel_status IN ('CANCELED', 'CANCELED_BY_NOPAYMENT')) AS canceled,
      MAX(o.channel_status = 'RETURNED') AS returned
    FROM orders o
    GROUP BY o.channel, o.channel_order_id
  )`;

function totals(db, start, end) {
  const r = db.prepare(`${GROUPS}
    SELECT
      COALESCE(SUM(CASE WHEN NOT dead THEN amt END), 0) AS sales,
      COALESCE(SUM(NOT dead), 0) AS orders,
      COALESCE(SUM(NOT dead AND amt IS NULL), 0) AS missing,
      COALESCE(SUM(dead AND canceled AND NOT waiting), 0) AS canceled,
      COALESCE(SUM(returned), 0) AS returned,
      COALESCE(SUM(NOT waiting), 0) AS placed
    FROM g WHERE t >= ? AND t < ?
  `).get(start, end);
  const priced = r.orders - r.missing;
  return {
    ...r,
    aov: priced > 0 ? Math.round(r.sales / priced) : 0,
    cancelRate: r.placed ? (r.canceled + r.returned) / r.placed : 0,
  };
}

function byChannel(db, start, end) {
  return db.prepare(`${GROUPS}
    SELECT ch, COALESCE(SUM(amt), 0) AS sales, COUNT(*) AS orders FROM g
    WHERE t >= ? AND t < ? AND NOT dead GROUP BY ch ORDER BY sales DESC, orders DESC
  `).all(start, end);
}

// 일별 (기간이 길면 월별). 빈 날도 0 으로 채운다
function series(db, start, end, fromDay, toDay) {
  const days = Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000) + 1;
  const monthly = days > 62;
  const fmt = monthly ? '%Y-%m' : '%Y-%m-%d';
  const rows = db.prepare(`${GROUPS}
    SELECT strftime('${fmt}', t, '+9 hours') AS k, COALESCE(SUM(amt), 0) AS sales, COUNT(*) AS orders FROM g
    WHERE t >= ? AND t < ? AND NOT dead GROUP BY k
  `).all(start, end);
  const map = new Map(rows.map(r => [r.k, r]));
  const out = [];
  const d = new Date(`${fromDay}T00:00:00Z`);
  const last = new Date(`${toDay}T00:00:00Z`);
  while (d <= last) {
    const k = monthly ? d.toISOString().slice(0, 7) : d.toISOString().slice(0, 10);
    if (!out.length || out[out.length - 1].k !== k) out.push({ k, sales: 0, orders: 0, ...(map.get(k) || {}) });
    if (monthly) d.setUTCMonth(d.getUTCMonth() + 1, 1); else d.setUTCDate(d.getUTCDate() + 1);
  }
  return { monthly, points: out };
}

// 잘 팔리는 상품 (본상품만, 취소·반품 빼고). 수기 주문 금액은 그 주문의 상품 수로 나눠 넣는다
function topProducts(db, start, end, limit = 10) {
  return db.prepare(`
    WITH i AS (
      SELECT o.product_name AS name, o.quantity AS qty,
        CASE WHEN o.channel = 'manual' THEN o.amount * 1.0 / COUNT(*) OVER (PARTITION BY o.channel, o.channel_order_id)
             ELSE o.pay_amount END AS amt
      FROM orders o
      WHERE ${T} >= ? AND ${T} < ? AND o.item_type != 'addon' AND o.channel_status NOT IN ${DEAD}
    )
    SELECT name, SUM(qty) AS qty, ROUND(COALESCE(SUM(amt), 0)) AS sales, COUNT(*) AS lines FROM i
    GROUP BY name ORDER BY sales DESC, qty DESC LIMIT ?
  `).all(start, end, limit);
}

// 요일(0=일)×시간대 주문 수
function heatmap(db, start, end) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of db.prepare(`${GROUPS}
    SELECT CAST(strftime('%w', t, '+9 hours') AS INTEGER) AS wd, CAST(strftime('%H', t, '+9 hours') AS INTEGER) AS h, COUNT(*) AS n
    FROM g WHERE t >= ? AND t < ? AND NOT dead GROUP BY wd, h
  `).all(start, end)) grid[r.wd][r.h] = r.n;
  return grid;
}

// 같은 길이의 바로 앞 기간 (비교용)
function previousRange(fromDay, toDay) {
  const day = 86400000;
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  const len = b - a + day;
  const pFrom = new Date(a - len).toISOString().slice(0, 10);
  const pTo = new Date(a - day).toISOString().slice(0, 10);
  return { fromDay: pFrom, toDay: pTo };
}

// 'YYYY-MM-DD'(한국) 시작·종료 → UTC [start, end)
function utcRange(fromDay, toDay) {
  const kst = 9 * 3600000;
  return [utcSql(new Date(Date.parse(`${fromDay}T00:00:00Z`) - kst)), utcSql(new Date(Date.parse(`${toDay}T00:00:00Z`) + 86400000 - kst))];
}

function salesReport(db, fromDay, toDay) {
  const [start, end] = utcRange(fromDay, toDay);
  const prev = previousRange(fromDay, toDay);
  const [pStart, pEnd] = utcRange(prev.fromDay, prev.toDay);
  return {
    fromDay, toDay, prev,
    totals: totals(db, start, end),
    prevTotals: totals(db, pStart, pEnd),
    channels: byChannel(db, start, end),
    series: series(db, start, end, fromDay, toDay),
    products: topProducts(db, start, end),
    heatmap: heatmap(db, start, end),
  };
}

module.exports = { salesReport, utcRange, previousRange, DEAD };
