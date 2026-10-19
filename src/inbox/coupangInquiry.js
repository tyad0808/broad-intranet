// 4-3 문의함: 쿠팡 문의 받기와 답변
//   상품별 고객문의 (onlineInquiries)      — 상품 페이지 Q&A
//   쿠팡 고객센터 문의 (callCenterInquiries) — 고객센터를 거쳐 판매자에게 넘어온 문의
//
// 받기: 쿠팡은 한 번에 7일까지만 조회돼서 기간을 7일씩 나눠 읽는다. 처음엔 최근 30일, 그 뒤로는 지난번 하루 전부터.
//       WING 에서 이미 답변한 문의는 '답변완료' 로 맞춘다.
// 답변: .env 의 COUPANG_ANSWER=on 일 때만 실제로 등록 (그 밖에는 연습 모드). 누가 답했는지로 WING 아이디(COUPANG_WING_ID)가 필요하다.
//
// ※ 응답 모양 공개 자료가 적어서 여러 이름을 함께 본다 (npm run coupang-inquiry-check 로 실제 모양 확인)
const { createCoupangClient } = require('../channels/coupangClient');

const SOURCE = 'coupang_qna';
const LABEL = '쿠팡';
const FIRST_DAYS = 30;
const WINDOW_DAYS = 7;
const MAX_PAGES = 20;
const KINDS = {
  p: { name: '상품문의', path: 'onlineInquiries', pageSize: 50, query: { answeredType: 'ALL' } },
  c: { name: '고객센터', path: 'callCenterInquiries', pageSize: 30, query: { partnerCounselingStatus: 'NONE' } },
};

const pick = (obj, ...keys) => {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return null;
};
const kstDate = d => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function listFrom(body) {
  const d = body && body.data !== undefined ? body.data : body;
  if (Array.isArray(d)) return d;
  for (const k of ['content', 'contents', 'items', 'list', 'data']) if (d && Array.isArray(d[k])) return d[k];
  return null;
}

function toIso(value) {
  if (!value) return null;
  if (Array.isArray(value)) { // [2026,10,19,10,0,0] 모양
    const [y, mo, da, h = 0, mi = 0, se = 0] = value;
    return new Date(Date.UTC(y, mo - 1, da, h - 9, mi, se)).toISOString();
  }
  const text = String(value).trim().replace(' ', 'T');
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}+09:00`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// 답변 목록 (이름이 여러 가지)
const repliesOf = q => pick(q, 'commentDtoList', 'replies', 'answers', 'comments', 'replyList') || [];

// 쿠팡 문의 1건 → 문의함 한 줄. kind: 'p'(상품문의) / 'c'(고객센터)
function normalizeInquiry(q, kind) {
  const id = pick(q, 'inquiryId', 'id');
  if (id === null) return null;
  const replies = Array.isArray(repliesOf(q)) ? repliesOf(q) : [];
  const product = pick(q, 'sellerProductName', 'productName', 'vendorItemName', 'itemName');
  const question = String(pick(q, 'content', 'inquiryContent', 'question', 'title') || '').trim();
  const status = String(pick(q, 'partnerCounselingStatus', 'csPartnerCounselingStatus', 'answeredType', 'status') || '').toUpperCase();
  const answered = kind === 'p'
    ? replies.length > 0 || Boolean(pick(q, 'answered', 'isAnswered'))
    : status === 'ANSWER' || status === 'ANSWERED' || Boolean(pick(q, 'answered'));
  const orderIds = pick(q, 'orderIds', 'orderIdList');
  const orderNo = pick(q, 'orderId') || (Array.isArray(orderIds) && orderIds.length ? orderIds[0] : null);
  const replyText = replies.map(r => pick(r, 'content', 'answerContent', 'comment')).filter(Boolean).join('\n');
  // 고객센터 문의 답변에는 앞선 상담 답변 번호(parentAnswerId)가 필요할 수 있어 기억해 둔다
  const lastReply = replies.length ? replies[replies.length - 1] : null;
  return {
    source: SOURCE,
    external_id: `${kind}:${id}`,
    from_name: pick(q, 'buyerName', 'customerName', 'maskedBuyerId', 'buyerEmail'),
    from_addr: null,
    reply_to: null,
    subject: `[쿠팡 ${KINDS[kind].name}] ${product || (orderNo ? `주문 ${orderNo}` : '문의')}`,
    body: [question || '(내용 없음)', replyText ? `\n── 등록된 답변 ──\n${replyText}` : ''].join('').slice(0, 20_000),
    attachments: '[]',
    message_id: null,
    references_hdr: null,
    received_at: toIso(pick(q, 'inquiryAt', 'receiptAt', 'createdAt', 'createAt', 'inquiryDate')) || new Date().toISOString(),
    order_no: orderNo !== null ? String(orderNo) : null,
    meta: JSON.stringify({ kind, inquiryId: String(id), parentAnswerId: lastReply ? pick(lastReply, 'answerId', 'inquiryCommentId', 'id') : null }),
    answered,
  };
}

function createCoupangInquirySource({ client = createCoupangClient(), now = () => new Date(), firstDays = FIRST_DAYS } = {}) {
  const base = () => `/v2/providers/openapi/apis/api/v4/vendors/${client.vendorId}`;
  return {
    source: SOURCE,
    label: LABEL,
    async fetch({ state = {}, openIds = [] } = {}) {
      const end = now();
      const last = state.lastRun ? Date.parse(state.lastRun) : NaN;
      const start = Number.isFinite(last)
        ? new Date(Math.max(last - 24 * 3600 * 1000, end.getTime() - firstDays * 24 * 3600 * 1000))
        : new Date(end.getTime() - firstDays * 24 * 3600 * 1000);
      const items = [];
      // 7일씩 끊어서 (쿠팡 조회 기간 한도)
      for (let from = start; from < end; from = new Date(from.getTime() + WINDOW_DAYS * 24 * 3600 * 1000)) {
        const to = new Date(Math.min(end.getTime(), from.getTime() + (WINDOW_DAYS - 1) * 24 * 3600 * 1000));
        for (const [kind, k] of Object.entries(KINDS)) {
          for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            const body = await client.request('GET', `${base()}/${k.path}`, {
              query: { vendorId: client.vendorId, inquiryStartAt: kstDate(from), inquiryEndAt: kstDate(to), pageNum, pageSize: k.pageSize, ...k.query },
            });
            const list = listFrom(body);
            if (!list) throw new Error(`쿠팡 ${k.name} 응답 모양을 알 수 없습니다 (항목: ${Object.keys((body && body.data) || body || {}).join(', ') || '없음'})`);
            items.push(...list.map(q => normalizeInquiry(q, kind)).filter(Boolean));
            if (list.length < k.pageSize) break;
          }
        }
      }
      // 같은 문의가 기간 경계에서 두 번 나올 수 있어 하나로
      const unique = [...new Map(items.map(i => [i.external_id, i])).values()];
      const open = new Set(openIds);
      return {
        items: unique,
        answeredIds: unique.filter(i => i.answered && open.has(i.external_id)).map(i => i.external_id),
        state: { lastRun: end.toISOString() },
      };
    },
  };
}

function createCoupangInquirySender({ client = createCoupangClient({ allowWrite: true }), wingId = process.env.COUPANG_WING_ID } = {}) {
  return {
    async reply(inquiry, body, files = []) {
      if (files.length) return { result: 'fail', message: '쿠팡 문의 답변에는 파일을 붙일 수 없습니다.' };
      if (!wingId) return { result: 'fail', message: '.env 에 COUPANG_WING_ID(쿠팡 WING 로그인 아이디)가 없어 답변할 수 없습니다.' };
      let meta = {};
      try { meta = JSON.parse(inquiry.meta || '{}'); } catch { meta = {}; }
      const [kind, id] = String(inquiry.external_id).split(':');
      const vendorId = client.vendorId;
      const path = kind === 'c'
        ? `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/callCenterInquiries/${id}/replies`
        : `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/onlineInquiries/${id}/replies`;
      const json = kind === 'c'
        ? { vendorId, inquiryId: id, content: body, replyBy: wingId, ...(meta.parentAnswerId ? { parentAnswerId: String(meta.parentAnswerId) } : {}) }
        : { vendorId, content: body, replyBy: wingId };
      try {
        await client.request('POST', path, { json });
        return { result: 'ok', message: '쿠팡에 답변을 등록했습니다.' };
      } catch (e) {
        if (e.notSent || (e.status && e.status < 500)) return { result: 'fail', message: `등록하지 못했습니다 — ${e.message}` };
        return { result: 'unknown', message: `쿠팡 응답을 받지 못했습니다. WING 에서 답변이 등록됐는지 확인하세요. (${e.message})` };
      }
    },
  };
}

module.exports = { SOURCE, LABEL, KINDS, createCoupangInquirySource, createCoupangInquirySender, normalizeInquiry, listFrom };
