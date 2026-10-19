// 4-4 문의함: 자사몰 고객 문의 받기와 답변
//   1:1 문의(inquiry) · 상품 문의(goodsqa) · 견적 문의(qa) 게시판
// ※ 자사몰은 고도몰 구조를 바탕으로 직접 만든 쇼핑몰이다 (고도몰 서비스가 아님). 기준은 '자사몰 관리자'.
//
// 받기: 자사몰 API GET /inquiries — '바뀐 시각(dateType=modified)' 기준이라 새 문의와 자사몰 관리자에서 단 답변이 함께 온다.
//       처음엔 최근 30일, 그 뒤로는 지난번 받은 날 하루 전부터. 자사몰 관리자에서 이미 답변한 문의는 '답변완료' 로 맞춘다.
// 답변: POST /inquiries/{board}/{inquiryNo}/answer — 자사몰 관리자 게시판에서 답변한 것과 같은 처리 (답변 알림 메일·SMS 포함)
//       .env 의 GODO_ANSWER=on 일 때만 실제로 등록 (그 밖에는 연습 모드)
const { createGodoClient } = require('../channels/godo');

const SOURCE = 'godo_qna';
const LABEL = '자사몰';
const FIRST_DAYS = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const BOARDS = { inquiry: '1:1문의', goodsqa: '상품문의', qa: '견적문의' };

const kstDate = d => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 'YYYY-MM-DD HH:mm:ss'(한국 시간) → ISO
function toIso(value) {
  if (!value) return null;
  const text = String(value).trim().replace(' ', 'T');
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}+09:00`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// 자사몰 문의 1건 → 문의함 한 줄
function normalizeInquiry(q) {
  if (!q || !q.inquiryNo || !BOARDS[q.board]) return null;
  const subject = String(q.subject || '').trim();
  const goods = q.board === 'goodsqa' && q.goodsName ? String(q.goodsName).trim() : '';
  const files = Array.isArray(q.files) ? q.files.filter(Boolean) : [];
  const answerText = q.answer && q.answer.contents ? String(q.answer.contents).trim() : '';
  const body = [
    goods && subject ? `제목: ${subject}\n\n` : '',
    String(q.contents || '').trim() || '(내용 없음)',
    files.length ? `\n\n첨부파일: ${files.join(', ')} (자사몰 관리자에서 확인)` : '',
    answerText ? `\n── 등록된 답변 ──\n${answerText}` : '',
  ].join('');
  return {
    source: SOURCE,
    external_id: `${q.board}:${q.inquiryNo}`,
    from_name: [q.writerName, q.writerId ? `(${q.writerId})` : ''].filter(Boolean).join(' ') || null,
    from_addr: null,
    reply_to: null,
    subject: `[자사몰 ${BOARDS[q.board]}] ${goods || subject || '문의'}${q.secret ? ' 🔒' : ''}`,
    body: body.slice(0, 20_000),
    attachments: '[]',
    message_id: null,
    references_hdr: null,
    received_at: toIso(q.createdAt) || new Date().toISOString(),
    order_no: q.orderNo ? String(q.orderNo) : null,
    meta: JSON.stringify({ board: q.board, inquiryNo: String(q.inquiryNo), goodsNo: q.goodsNo || null }),
    answered: Boolean(q.answered),
  };
}

function createGodoInquirySource({ client = createGodoClient(), now = () => new Date(), firstDays = FIRST_DAYS } = {}) {
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
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await client.request('GET', '/inquiries', {
          query: { from: kstDate(start), to: kstDate(end), dateType: 'modified', page, size: PAGE_SIZE },
        });
        if (!body || !Array.isArray(body.items)) throw new Error('자사몰 문의 응답 모양을 알 수 없습니다 (items 없음)');
        items.push(...body.items.map(normalizeInquiry).filter(Boolean));
        if (body.items.length < PAGE_SIZE || page * PAGE_SIZE >= Number(body.total || 0)) break;
      }
      const open = new Set(openIds);
      return {
        items,
        answeredIds: items.filter(i => i.answered && open.has(i.external_id)).map(i => i.external_id),
        state: { lastRun: end.toISOString() },
      };
    },
  };
}

// 답변 등록: 실패를 '보내기 전에 막힘·거절(실패)' 과 '결과를 알 수 없음(확인 필요)' 으로 나눈다
function createGodoInquirySender({ client = createGodoClient({ allowWrite: true }) } = {}) {
  return {
    async reply(inquiry, body, files = []) {
      if (files.length) return { result: 'fail', message: '자사몰 문의 답변에는 파일을 붙일 수 없습니다.' };
      const [board, no] = String(inquiry.external_id).split(':');
      try {
        const out = await client.request('POST', `/inquiries/${board}/${no}/answer`, { json: { contents: body } });
        if (!out || out.ok !== true) return { result: 'fail', message: `등록하지 못했습니다 — ${(out && out.message) || '자사몰이 거절했습니다'}` };
        const notices = Array.isArray(out.notices) && out.notices.length ? ` (${out.notices.join(' ')})` : '';
        return { result: 'ok', message: `자사몰에 답변을 등록했습니다.${notices}` };
      } catch (e) {
        if (e.notSent || (e.status && e.status < 500)) return { result: 'fail', message: `등록하지 못했습니다 — ${e.message}` };
        return { result: 'unknown', message: `자사몰 응답을 받지 못했습니다. 자사몰 관리자에서 답변이 등록됐는지 확인하세요. (${e.message})` };
      }
    },
  };
}

module.exports = { SOURCE, LABEL, BOARDS, createGodoInquirySource, createGodoInquirySender, normalizeInquiry };
