// 오래된 자료: ① 끝난 주문·문의는 N일(기본 14일)이 지나면 목록에서 숨긴다 (월별 보기·검색으로는 보임)
//              ② 보관 기간(기본 1년)이 지난 끝난 주문·문의는 관리자 화면에서 정리(삭제)한다
// 날짜는 채널마다 모양이 달라서('…+09:00', '…Z', 'YYYY-MM-DD HH:MM:SS') SQLite datetime() 으로 UTC 로 맞춰 비교한다
const { transaction } = require('./db');
const { getSetting, setSetting, ENDED_SQL } = require('./collector');

const DEFAULT_HIDE_DAYS = 14;
const DEFAULT_KEEP_MONTHS = 12;
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

// 'YYYY-MM' (한국 시간의 달) → [시작, 끝) UTC
function monthRange(month) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ''));
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) - 9 * 3600 * 1000;
  const end = Date.UTC(Number(m[1]), Number(m[2]), 1) - 9 * 3600 * 1000;
  return [utcSql(new Date(start)), utcSql(new Date(end))];
}

// 월 선택 목록: 자료가 있는 달 (최근 것부터, 최대 36개)
function monthsOf(db, table, timeExpr, where = '1') {
  const alias = table === 'orders' ? 'o' : 'q';
  return db.prepare(`
    SELECT DISTINCT strftime('%Y-%m', ${timeExpr}, '+9 hours') AS m FROM ${table} ${alias}
    WHERE ${where} AND ${timeExpr} IS NOT NULL ORDER BY m DESC LIMIT 36
  `).all().map(r => r.m).filter(Boolean);
}

// ───────── 정리 (삭제) ─────────
const keepMonths = (db, kind) => Number(getSetting(db, `keep_${kind}_months`)) || DEFAULT_KEEP_MONTHS;
const keepCutoff = (months, now = new Date()) => {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return utcSql(d);
};

// 지울 주문 묶음: 모든 상품이 끝났고(채널에서 끝남 또는 마지막 단계), 진행 중인 취소·반품·교환 요청이 없고, 마지막 결제일이 보관 기간 전
function oldOrderGroups(db, cutoff) {
  const last = db.prepare('SELECT id FROM work_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1').get();
  const lastId = last ? Number(last.id) : -1;
  return db.prepare(`
    SELECT o.channel, o.channel_order_id FROM orders o
    GROUP BY o.channel, o.channel_order_id
    HAVING MIN(o.channel_status IN (${ENDED_SQL}) OR COALESCE(o.stage_id = ${lastId}, 0)) = 1
      AND MAX(o.claim_status IS NOT NULL AND o.claim_status NOT LIKE '%_REJECT' AND o.claim_status NOT LIKE '%_DONE'
        AND o.claim_status NOT IN ('PURCHASE_DECISION_HOLDBACK_RELEASE', 'PURCHASE_DECISION_REQUEST')) = 0
      AND MAX(${ORDER_TIME}) < ?
  `).all(cutoff);
}

// 지울 문의: 답변완료·처리 완료이고 받은 날이 보관 기간 전 (미답변은 남긴다)
const OLD_INQUIRY_SQL = "q.status IN ('answered', 'closed') AND q.deleted_at IS NULL AND datetime(q.received_at) < ?";

function previewCleanup(db, { orderMonths = keepMonths(db, 'orders'), inquiryMonths = keepMonths(db, 'inquiries'), now = new Date() } = {}) {
  const orders = oldOrderGroups(db, keepCutoff(orderMonths, now)).length;
  const inquiries = db.prepare(`SELECT COUNT(*) AS n FROM inquiries q WHERE ${OLD_INQUIRY_SQL}`).get(keepCutoff(inquiryMonths, now)).n;
  return { orderMonths, inquiryMonths, orders, inquiries };
}

// 실제로 지운다. 메일은 '지웠음' 표시만 남긴다 (예전 메일 가져오기로 다시 들어오지 않게), 나머지는 통째로
function runCleanup(db, { orderMonths = keepMonths(db, 'orders'), inquiryMonths = keepMonths(db, 'inquiries'), userId = null, userName = '', now = new Date() } = {}) {
  const groups = oldOrderGroups(db, keepCutoff(orderMonths, now));
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
    const log = cleanupLog(db);
    log.unshift({ at: now.toISOString(), user: userName, orderMonths, inquiryMonths, orders: groups.length, inquiries: inquiryIds.length });
    setSetting(db, 'cleanup_log', JSON.stringify(log.slice(0, MAX_LOG)));
  });
  return { orders: groups.length, inquiries: inquiryIds.length };
}

function cleanupLog(db) {
  try { return JSON.parse(getSetting(db, 'cleanup_log') || '[]'); } catch { return []; }
}

module.exports = {
  DEFAULT_HIDE_DAYS, DEFAULT_KEEP_MONTHS, KEEP_CHOICES, HIDE_CHOICES, ORDER_TIME, INQUIRY_TIME,
  utcSql, hideDays, hideCutoff, monthRange, monthsOf, keepMonths, previewCleanup, runCleanup, cleanupLog,
};
