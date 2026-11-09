// 홈 (오늘 할 일): 로그인하면 처음 보는 화면
//   지금 처리할 주문 · 내 담당(주문·메일·문의·톡톡) · 오늘·내일 일정 · 방금 들어온 주문
//   관리자·부관리자에게만: 이번 달 매출 한 줄 · 판매처·메일 받기 상태
// 숫자는 모두 이미 있는 목록과 같은 조건으로 센다 → 칸을 누르면 그 목록에 같은 건수가 보인다
const express = require('express');
const { isManager } = require('../auth');
const { orderSummary, kstDay } = require('./orders');
const { ORDER_TIME } = require('../retention');
const { totals, utcRange } = require('../stats');
const { dueCountsBetween } = require('./calendar');

const MAIL_SQL = "(q.source GLOB 'naver_mail*' OR q.source GLOB 'gmail*')";
const BOX_WHERE = {
  mail: `(${MAIL_SQL} AND q.deleted_at IS NULL)`,
  shop: `(NOT ${MAIL_SQL} AND q.source != 'talktalk')`,
  chat: "(q.source = 'talktalk')",
};
const MAIL_KIND = source => (/^naver_mail/.test(source) ? '네이버메일' : /^gmail/.test(source) ? '지메일' : null);
// 판매처 받기 상태: 이 시간 안에 받은 기록이 있는 판매처만 보여 준다 (예전에 쓰다 뺀 판매처는 안 보이게)
const RECENT_RUN_DAYS = 3;
const CHANNEL_NAMES = { smartstore: '스마트스토어', coupang: '쿠팡', godo: '자사몰', esm: 'G마켓·옥션' };
const WEEKDAYS = '일월화수목금토';

// ISO 시각 → 한국 시각 'HH:MM' (오늘이 아니면 'M/D HH:MM')
function kstClock(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const k = new Date(t + 9 * 3600 * 1000).toISOString();
  const day = k.slice(0, 10);
  const hm = k.slice(11, 16);
  return day === kstDay(0) ? hm : `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} ${hm}`;
}

// 이번 달 1일 ~ 오늘 매출과, 지난달 같은 기간(1일 ~ 같은 날, 지난달이 짧으면 말일까지)
function monthSales(db) {
  const today = kstDay(0);
  const [y, m, d] = today.split('-').map(Number);
  const first = `${today.slice(0, 7)}-01`;
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevLast = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const pad = n => String(n).padStart(2, '0');
  const prevFrom = `${prevY}-${pad(prevM)}-01`;
  const prevTo = `${prevY}-${pad(prevM)}-${pad(Math.min(d, prevLast))}`;
  const now = totals(db, ...utcRange(first, today));
  const prev = totals(db, ...utcRange(prevFrom, prevTo));
  const change = prev.sales > 0 ? Math.round(((now.sales - prev.sales) / prev.sales) * 100) : null;
  return { from: first, to: today, month: m, day: d, sales: now.sales, orders: now.orders, prevSales: prev.sales, change };
}

// DB 시각('2026-11-04 01:00:00' 처럼 끝에 Z 없는 UTC 포함) → ISO
const isoOf = v => { const t = String(v || ''); return /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`; };
// 쇼핑몰 문의 출처 → 판매처 (한 글자 표시용)
const SHOP_CHANNEL = { smartstore_qna: 'smartstore', naver_qna: 'smartstore', godo_qna: 'godo', coupang_qna: 'coupang' };

function homeRoutes(db, { sourceLabels = {}, chatOn = false } = {}) {
  const router = express.Router();

  const countOpen = (box, userId) => db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(q.assignee_id = ?), 0) AS mine
    FROM inquiries q WHERE q.status = 'open' AND ${BOX_WHERE[box]}
  `).get(userId);

  router.get('/home', (req, res) => {
    // 오늘 홈을 봤다는 표시: 오늘은 주소 '/' 로 들어와도 주문 목록이 바로 열린다 (app.js 참고)
    req.session.homeDay = kstDay(0);
    const user = req.user;
    const today = kstDay(0);
    const tomorrow = kstDay(1);

    const orders = orderSummary(db, user.id);
    const inbox = { mail: countOpen('mail', user.id), shop: countOpen('shop', user.id), chat: countOpen('chat', user.id) };

    // 오늘·내일 일정 (여러 날 일정은 걸친 날마다 한 줄씩, 최대 6줄)
    const events = db.prepare(`
      SELECT e.id, e.title, e.start_date, e.end_date, e.time, e.color, u.name AS who
      FROM events e LEFT JOIN users u ON u.id = e.created_by
      WHERE e.start_date <= ? AND COALESCE(e.end_date, e.start_date) >= ?
      ORDER BY e.time IS NOT NULL, e.time, e.id
    `).all(tomorrow, today);
    const eventRows = [];
    for (const [date, label] of [[today, '오늘'], [tomorrow, '내일']]) {
      for (const e of events) {
        if (e.start_date <= date && (e.end_date || e.start_date) >= date) eventRows.push({ ...e, date, dayLabel: label });
      }
    }

    // 오늘·내일 출고(납기) 건수: 주문 목록 위 출고 달력과 같은 셈 → 누르면 그날 납기 주문 목록
    const dueCounts = dueCountsBetween(db, today, tomorrow);
    const dues = [[today, '오늘'], [tomorrow, '내일']].map(([date, label]) => ({ date, label, n: dueCounts[date] || 0 })).filter(d => d.n);

    // 방금 들어온 주문 4건 (주문번호 묶음 단위, 결제 시각 최근 순)
    const recent = db.prepare(`
      WITH g AS (
        SELECT o.channel AS ch, o.channel_order_id AS oid, MAX(${ORDER_TIME}) AS t, COUNT(*) AS n
        FROM orders o GROUP BY o.channel, o.channel_order_id ORDER BY t DESC LIMIT 4
      )
      SELECT g.n, g.t, o.id, o.channel, o.product_name, COALESCE(NULLIF(o.buyer_name, ''), o.receiver_name) AS buyer,
        COALESCE(o.paid_at, o.created_at) AS at
      FROM g JOIN orders o ON o.id = (
        SELECT id FROM orders x WHERE x.channel = g.ch AND x.channel_order_id = g.oid
        ORDER BY CASE WHEN x.item_type = 'addon' THEN 1 ELSE 0 END, x.id LIMIT 1)
      ORDER BY g.t DESC
    `).all().map(r => ({ ...r, clock: kstClock(isoOf(r.at)) }));

    // 미답변 메일 · 문의(쇼핑몰 문의 + 톡톡) 최근 5건씩: 누가 보냈는지·무슨 내용인지·담당
    const openRows = (where, limit = 5) => db.prepare(`
      SELECT q.id, q.source, q.from_name, q.from_addr, q.received_at, q.assignee_id, u.name AS assignee_name,
        substr(COALESCE(NULLIF(q.subject, ''), q.body, ''), 1, 120) AS title
      FROM inquiries q LEFT JOIN users u ON u.id = q.assignee_id
      WHERE q.status = 'open' AND ${where}
      ORDER BY q.received_at DESC, q.id DESC LIMIT ${Number(limit)}
    `).all().map(r => ({ ...r, clock: kstClock(isoOf(r.received_at)) }));
    const mailRows = openRows(BOX_WHERE.mail);
    const askRows = openRows(chatOn ? `(${BOX_WHERE.shop} OR ${BOX_WHERE.chat})` : BOX_WHERE.shop);

    // 관리자·부관리자만: 이번 달 매출 · 판매처·메일 받기 상태
    let manager = null;
    if (isManager(user)) {
      const since = new Date(Date.now() - RECENT_RUN_DAYS * 86400000).toISOString();
      const runs = db.prepare(`
        SELECT r.channel, r.started_at, r.ok, r.error FROM collect_runs r
        WHERE r.id IN (SELECT MAX(id) FROM collect_runs WHERE started_at >= ? AND finished_at IS NOT NULL GROUP BY channel)
        ORDER BY r.channel
      `).all(since);
      const rank = ch => { const i = Object.keys(CHANNEL_NAMES).indexOf(ch); return i < 0 ? 99 : i; };
      const conns = runs
        .sort((a, b) => rank(a.channel) - rank(b.channel))
        .map(r => ({ name: CHANNEL_NAMES[r.channel] || r.channel, ok: r.ok === 1, at: kstClock(r.started_at), error: r.error || '', fix: '/admin/channels' }));
      for (const source of Object.keys(sourceLabels).filter(MAIL_KIND)) {
        let st = null;
        try { st = JSON.parse((db.prepare('SELECT value FROM settings WHERE key = ?').get(`inbox_status_${source}`) || {}).value || 'null'); } catch { st = null; }
        if (!st) continue;
        const label = String(sourceLabels[source] || '');
        conns.push({
          name: label.includes('@') ? `${MAIL_KIND(source)} · ${label.split('@')[0]}` : MAIL_KIND(source),
          ok: Boolean(st.ok), at: kstClock(st.at), error: st.error || '', fix: '/admin/mail', mail: true,
        });
      }
      manager = { sales: monthSales(db), conns, admin: user.role === 'admin' };
    }

    const [, mm, dd] = today.split('-').map(Number);
    const weekday = WEEKDAYS[new Date(`${today}T00:00:00Z`).getUTCDay()];
    res.render('home', {
      title: '홈',
      navSection: 'home',
      ds: true,
      bodyClass: 'orders-wide', // 주문 화면과 같은 너비
      todayText: `${mm}월 ${dd}일 (${weekday})`,
      orders,
      inbox,
      events: eventRows.slice(0, 6),
      dues,
      moreEvents: Math.max(0, eventRows.length - 6),
      recent,
      mailRows,
      askRows,
      mailLabel: source => MAIL_KIND(source) || source,
      askChannel: source => SHOP_CHANNEL[source] || null,
      manager,
    });
  });

  return router;
}

module.exports = { homeRoutes, kstClock, monthSales };
