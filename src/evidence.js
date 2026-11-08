// 자사몰 주문의 증빙(세금계산서·현금영수증) 보여 주기
// 값은 수집할 때 자사몰 API(evidence)에서 읽어 order_evidence 표에 넣어 둔다 (collector.js applyOrders)
// 세금계산서는 견적 도구에서 발행한다 → tax_url 로 견적 도구를 연다. 현금영수증은 상태만 보여 준다

// 세금계산서 발행 대기: 손님이 신청했고 아직 발행 전 (상태가 비어 있어도 신청이면 대기로 본다)
const TAX_PENDING_SQL = "(e.type = 'tax_invoice' AND COALESCE(e.tax_status, 'requested') = 'requested')";
// 주문 묶음(o.channel, o.channel_order_id)에 발행 대기 계산서가 있는지 — 주문 목록 HAVING·홈 숫자에 쓴다
const GROUP_TAX_PENDING = `EXISTS (SELECT 1 FROM order_evidence e WHERE e.channel = o.channel AND e.channel_order_id = o.channel_order_id AND ${TAX_PENDING_SQL})`;

const CASH_USE = { income: '소득공제', expense: '지출증빙' };

// 저장된 값 → 화면용 { badges: [{ cls, text }], tax, cash }
//   cls: req(연한 빨강, 할 일) · done(초록) · cash(파랑) · off(회색)
function evidenceView(row) {
  if (!row) return null;
  const badges = [];
  let tax = null;
  if (row.type === 'tax_invoice' || row.tax_status) {
    const status = row.tax_status || 'requested';
    tax = {
      status,
      label: { requested: '발행 전', issued: '발행됨', canceled: '발행 취소' }[status],
      requestedAt: row.requested_at,
      issuedAt: row.tax_issued_at,
      url: row.tax_url,
      requested: row.type === 'tax_invoice',
    };
    badges.push(status === 'issued' ? { cls: 'done', text: '세금계산서 발행됨' }
      : status === 'canceled' ? { cls: 'off', text: '세금계산서 취소됨' }
        : { cls: 'req', text: '세금계산서 · 발행 전' });
  }
  let cash = null;
  if (row.type === 'cash_receipt' || row.cash_status) {
    const status = row.cash_status || 'requested';
    const use = CASH_USE[row.cash_use] || '';
    cash = {
      status, use,
      label: { requested: '신청', issued: '발급됨', canceled: '취소됨', failed: '발급 실패' }[status],
      requestedAt: row.requested_at,
      issuedAt: row.cash_issued_at,
    };
    badges.push({
      cls: status === 'failed' ? 'req' : status === 'canceled' ? 'off' : 'cash',
      text: `현금영수증${use ? ` · ${use}` : ''} ${cash.label}`,
    });
  }
  if (!badges.length) return null;
  // 할 일: 세금계산서 발행 전 · 현금영수증 발급 실패 → 목록 꼬리표와 상세 맨 위 큰 칸은 이것만
  const todo = Boolean((tax && tax.status === 'requested') || (cash && cash.status === 'failed'));
  return { badges, listBadges: badges.filter(b => b.cls === 'req'), tax, cash, todo };
}

// 주문 묶음 여러 개의 증빙을 한 번에: Map('channel:주문번호' → 화면용)
function evidenceFor(db, groups) {
  const keys = groups.filter(g => g.channel === 'godo').map(g => g.channel_order_id);
  const out = new Map();
  if (!keys.length) return out;
  const rows = db.prepare(`SELECT * FROM order_evidence WHERE channel = 'godo' AND channel_order_id IN (${keys.map(() => '?').join(', ')})`).all(...keys);
  for (const r of rows) {
    const view = evidenceView(r);
    if (view) out.set(`${r.channel}:${r.channel_order_id}`, view);
  }
  return out;
}

module.exports = { evidenceView, evidenceFor, TAX_PENDING_SQL, GROUP_TAX_PENDING };
