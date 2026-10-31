// 오래된 자료: ① 끝난 주문·문의는 N일(기본 14일)이 지나면 목록에서 숨긴다 (월별 보기·검색으로는 보임)
//              ② 개인정보: 끝난 지 3개월 지난 주문은 이름·연락처·주소를 지우고(금액·상품은 통계용으로 남김),
//                 답변한 문의는 3개월 뒤 지운다 — 매일 자동 (개인정보보호법: 목적이 끝나면 바로 파기)
//              ③ 보관 기간(기본 1년)이 지난 끝난 주문은 관리자 화면에서 통째로 정리(삭제)한다
// 날짜는 채널마다 모양이 달라서('…+09:00', '…Z', 'YYYY-MM-DD HH:MM:SS') SQLite datetime() 으로 UTC 로 맞춰 비교한다
const { transaction } = require('./db');
const { getSetting, setSetting, ENDED_SQL } = require('./collector');

const DEFAULT_HIDE_DAYS = 14;
const DEFAULT_KEEP_MONTHS = 12;
const PERSONAL_MONTHS = 3; // 개인정보 보관 기간 (사장님 결정 2026-10)
const KEEP_CHOICES = [6, 12, 24];
const HIDE_CHOICES = [7, 14, 30, 60];
const MAX_LOG = 20;

// 주문은 결제일(없으면 등록일), 문의는 받은 날
const ORDER_TIME = 'datetime(COALESCE(o.paid_at, o.created_at))';
const INQUIRY_TIME = 'datetime(q.received_at)';

// Date → SQLite datetime() 과 같은 모양 (UTC 'YYYY-MM-DD HH:MM:SS')
const utcSql = d => d.toISOString().replace('T', ' ').slice(0, 19);

const hideDays = db => Number(getSetting(db, 'hide_done_days')) || DEFAULT_HIDE_DAYS;
const hideCutoff = (db, now = new Date()) => utcSql(new Date(now.getTime() - hideDays(db) * 24 * 3600 * 1000));

// 기간 보기: 'YYYY-MM-DD'(한국 날짜) 시작일·종료일 → { from, to, start, end } (start·end 는 UTC, 종료일은 그날 끝까지)
//   한쪽만 있어도 된다 (시작일만: 그날부터 지금까지 / 종료일만: 처음부터 그날까지). 둘 다 없거나 틀리면 null
const DAY = 24 * 3600 * 1000;
const KST = 9 * 3600 * 1000;
function kstDayStart(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 2026-02-31 처럼 없는 날짜는 받지 않는다
  return new Date(t).toISOString().slice(0, 10) === m[0] ? t - KST : null;
}
function periodRange(fromText, toText) {
  let from = kstDayStart(fromText) === null ? '' : String(fromText);
  let to = kstDayStart(toText) === null ? '' : String(toText);
  if (!from && !to) return null;
  if (from && to && from > to) [from, to] = [to, from];
  return {
    from, to,
    start: from ? utcSql(new Date(kstDayStart(from))) : '0000-01-01 00:00:00',
    end: to ? utcSql(new Date(kstDayStart(to) + DAY)) : '9999-12-31 00:00:00',
  };
}
// 기간 이름 (안내 문구): '2026-10-01 ~ 2026-10-21', '2026-10-21 하루', '2026-10-01부터', '2026-10-21까지'
function periodLabel(p) {
  if (!p) return '';
  if (p.from && p.to) return p.from === p.to ? `${p.from} 하루` : `${p.from} ~ ${p.to}`;
  return p.from ? `${p.from}부터` : `${p.to}까지`;
}
// 빠른 선택 버튼: 오늘 · 어제 · 최근 7일 · 이번 달 · 지난달 (한국 날짜)
function quickPeriods(now = new Date()) {
  const day = offset => new Date(now.getTime() + KST + offset * DAY).toISOString().slice(0, 10);
  const today = day(0);
  const [y, m] = today.split('-').map(Number);
  const first = (yy, mm) => new Date(Date.UTC(yy, mm - 1, 1)).toISOString().slice(0, 10);
  const lastMonthEnd = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  return [
    { label: '오늘', from: today, to: today },
    { label: '어제', from: day(-1), to: day(-1) },
    { label: '최근 7일', from: day(-6), to: today },
    { label: '이번 달', from: first(y, m), to: today },
    { label: '지난달', from: first(y, m - 1), to: lastMonthEnd },
  ];
}

// ───────── 정리 (삭제) ─────────
// 문의는 내용 자체가 개인정보라서 3개월로 고정
const keepMonths = (db, kind) => (kind === 'inquiries' ? PERSONAL_MONTHS : Number(getSetting(db, `keep_${kind}_months`)) || DEFAULT_KEEP_MONTHS);
const keepCutoff = (months, now = new Date()) => {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return utcSql(d);
};

// 지울 주문 묶음: 모든 상품이 끝났고(채널에서 끝남 또는 마지막 단계), 진행 중인 취소·반품·교환 요청이 없고, 마지막 결제일이 보관 기간 전
function oldOrderGroups(db, cutoff, { personalLeft = false } = {}) {
  const last = db.prepare('SELECT id FROM work_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1').get();
  const lastId = last ? Number(last.id) : -1;
  return db.prepare(`
    SELECT o.channel, o.channel_order_id FROM orders o
    GROUP BY o.channel, o.channel_order_id
    HAVING MIN(o.channel_status IN (${ENDED_SQL}) OR COALESCE(o.stage_id = ${lastId}, 0)) = 1
      AND MAX(o.claim_status IS NOT NULL AND o.claim_status NOT LIKE '%_REJECT' AND o.claim_status NOT LIKE '%_DONE'
        AND o.claim_status NOT IN ('PURCHASE_DECISION_HOLDBACK_RELEASE', 'PURCHASE_DECISION_REQUEST')) = 0
      AND MAX(${ORDER_TIME}) < ?
      ${personalLeft ? 'AND MAX(o.pii_cleared_at IS NULL) = 1' : ''}
  `).all(cutoff);
}

// 개인정보만 지우기: 끝난 지 3개월 지난 주문 묶음의 이름·연락처·주소·배송 메시지·입금자명, 로젠 배송 조회 기록
//   주문 번호·상품·금액·날짜는 남긴다 (매출 통계·처리 기록용)
const PERSONAL_COLUMNS = ['buyer_name', 'buyer_phone', 'receiver_name', 'receiver_phone', 'receiver_address', 'receiver_address_detail', 'ship_memo', 'depositor'];
function clearPersonal(db, { months = PERSONAL_MONTHS, now = new Date() } = {}) {
  const groups = oldOrderGroups(db, keepCutoff(months, now), { personalLeft: true });
  if (!groups.length) return 0;
  transaction(db, () => {
    const clear = db.prepare(`UPDATE orders SET ${PERSONAL_COLUMNS.map(c => `${c} = NULL`).join(', ')}, pii_cleared_at = ? WHERE channel = ? AND channel_order_id = ?`);
    const track = db.prepare('UPDATE logen_shipments SET track_json = NULL WHERE channel = ? AND channel_order_id = ?');
    for (const g of groups) {
      clear.run(utcSql(now), g.channel, g.channel_order_id);
      track.run(g.channel, g.channel_order_id);
    }
  });
  return groups.length;
}

// 지울 문의: 답변완료·처리 완료이고 받은 날이 보관 기간 전 (미답변은 남긴다)
const OLD_INQUIRY_SQL = "q.status IN ('answered', 'closed') AND q.deleted_at IS NULL AND datetime(q.received_at) < ?";

function previewCleanup(db, { orderMonths = keepMonths(db, 'orders'), inquiryMonths = keepMonths(db, 'inquiries'), now = new Date() } = {}) {
  const orders = oldOrderGroups(db, keepCutoff(orderMonths, now)).length;
  const inquiries = db.prepare(`SELECT COUNT(*) AS n FROM inquiries q WHERE ${OLD_INQUIRY_SQL}`).get(keepCutoff(inquiryMonths, now)).n;
  return { orderMonths, inquiryMonths, orders, inquiries };
}

// 실제로 지운다. 메일은 '지웠음' 표시만 남긴다 (예전 메일 가져오기로 다시 들어오지 않게), 나머지는 통째로
function runCleanup(db, { orderMonths = keepMonths(db, 'orders'), inquiryMonths = keepMonths(db, 'inquiries'), userId = null, userName = '', now = new Date(), skipOrders = false } = {}) {
  const groups = skipOrders ? [] : oldOrderGroups(db, keepCutoff(orderMonths, now));
  const inquiryIds = db.prepare(`SELECT q.id, q.source FROM inquiries q WHERE ${OLD_INQUIRY_SQL}`).all(keepCutoff(inquiryMonths, now));
  const isMail = s => /^(naver_mail|gmail)\d*$/.test(s);
  transaction(db, () => {
    const ids = db.prepare('SELECT id FROM orders WHERE channel = ? AND channel_order_id = ?');
    const delNotes = db.prepare('DELETE FROM notifications WHERE order_id = ?');
    const delActions = db.prepare('DELETE FROM order_actions WHERE channel = ? AND channel_order_id = ?');
    const delOrders = db.prepare('DELETE FROM orders WHERE channel = ? AND channel_order_id = ?');
    for (const g of groups) {
      for (const r of ids.all(g.channel, g.channel_order_id)) delNotes.run(r.id);
      delActions.run(g.channel, g.channel_order_id);
      delOrders.run(g.channel, g.channel_order_id);
    }
    const delReplies = db.prepare('DELETE FROM inquiry_replies WHERE inquiry_id = ?');
    const delChat = db.prepare('DELETE FROM chat_messages WHERE inquiry_id = ?');
    const delInquiry = db.prepare('DELETE FROM inquiries WHERE id = ?');
    const tombstone = db.prepare(`
      UPDATE inquiries SET deleted_at = datetime('now'), deleted_by = ?, subject = NULL, body = NULL, from_name = NULL, from_addr = NULL,
        reply_to = NULL, attachments = '[]', message_id = NULL, references_hdr = NULL, order_no = NULL, meta = NULL, assignee_id = NULL
      WHERE id = ?
    `);
    for (const q of inquiryIds) {
      delReplies.run(q.id);
      delChat.run(q.id);
      if (isMail(q.source)) tombstone.run(userId, q.id);
      else delInquiry.run(q.id);
    }
    if (groups.length || inquiryIds.length) {
      const log = cleanupLog(db);
      log.unshift({ at: now.toISOString(), user: userName, orderMonths, inquiryMonths, orders: groups.length, inquiries: inquiryIds.length });
      setSetting(db, 'cleanup_log', JSON.stringify(log.slice(0, MAX_LOG)));
    }
  });
  return { orders: groups.length, inquiries: inquiryIds.length };
}

// 매일 자동 (server.js): 3개월 지난 개인정보 지우기 + 답변한 문의 지우기. 하루 한 번만 (한국 날짜 기준)
function autoPersonalCleanup(db, { now = new Date() } = {}) {
  const day = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  if (getSetting(db, 'personal_cleanup_day') === day) return null;
  const orders = clearPersonal(db, { now });
  const { inquiries } = runCleanup(db, { skipOrders: true, userName: '자동 (개인정보 3개월)', now });
  setSetting(db, 'personal_cleanup_day', day);
  setSetting(db, 'personal_cleanup_last', JSON.stringify({ at: now.toISOString(), orders, inquiries }));
  return { orders, inquiries };
}
function lastPersonalCleanup(db) {
  try { return JSON.parse(getSetting(db, 'personal_cleanup_last') || 'null'); } catch { return null; }
}

function cleanupLog(db) {
  try { return JSON.parse(getSetting(db, 'cleanup_log') || '[]'); } catch { return []; }
}

module.exports = {
  DEFAULT_HIDE_DAYS, DEFAULT_KEEP_MONTHS, KEEP_CHOICES, HIDE_CHOICES, ORDER_TIME, INQUIRY_TIME,
  utcSql, hideDays, hideCutoff, periodRange, periodLabel, quickPeriods, keepMonths, previewCleanup, runCleanup, cleanupLog,
  PERSONAL_MONTHS, clearPersonal, autoPersonalCleanup, lastPersonalCleanup,
};
