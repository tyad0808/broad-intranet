// 4-2 문의함: 스마트스토어 상품문의(Q&A) 받기와 답변
//
// 받기: GET /v1/contents/qnas — 처음엔 최근 30일, 그 뒤로는 지난번 받은 시각 하루 전부터 (그사이 답변된 것도 다시 확인)
//       판매자센터에서 이미 답변한 문의는 '답변완료' 로 맞춘다.
// 답변: PUT /v1/contents/qnas/{questionId} { commentContent } — .env 의 NAVER_ANSWER=on 일 때만 실제로 등록 (그 밖에는 연습 모드)
//
// ※ 네이버 응답 모양은 공개 자료가 적어서 이름이 조금 달라도 받아들이도록 여러 이름을 함께 본다
//   (npm run naver-inquiry-check 로 실제 응답 모양을 확인할 수 있다)
const { createNaverClient } = require('../channels/naverClient');
const { toKstIso } = require('../channels/smartstore');

const SOURCE = 'smartstore_qna';
const LABEL = '스마트스토어';
const PATH = '/v1/contents/qnas';
const FIRST_DAYS = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const pick = (obj, ...keys) => {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return null;
};

// 응답에서 문의 목록 꺼내기 (contents / content / data …)
function listFrom(body) {
  const d = body && body.data !== undefined && !Array.isArray(body.data) ? body.data : body;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.data)) return d.data;
  for (const k of ['contents', 'content', 'qnas', 'items', 'list']) if (d && Array.isArray(d[k])) return d[k];
  return null;
}

// 날짜 글자 → ISO (시간대 없으면 한국 시간으로 본다)
function toIso(value) {
  if (!value) return null;
  const text = String(value).trim().replace(' ', 'T');
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}+09:00`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// 상품문의 1건 → 문의함 한 줄
function normalizeQna(q) {
  const id = pick(q, 'questionId', 'qnaId', 'id', 'inquiryNo');
  if (id === null) return null;
  const product = pick(q, 'productName', 'channelProductName', 'productTitle');
  const answerText = pick(q, 'answer', 'answerContent', 'commentContent');
  const answered = Boolean(pick(q, 'answered', 'isAnswered')) || Boolean(answerText);
  const question = String(pick(q, 'question', 'questionContent', 'content', 'title') || '').trim();
  return {
    source: SOURCE,
    external_id: String(id),
    from_name: pick(q, 'maskedWriterId', 'writerId', 'maskedNickname', 'nickname', 'writer'),
    from_addr: null,
    reply_to: null,
    subject: `[상품문의] ${product || '상품'}`,
    body: [question || '(내용 없음)', answerText ? `\n── 등록된 답변 ──\n${answerText}` : ''].join('').slice(0, 20_000),
    attachments: '[]',
    message_id: null,
    references_hdr: null,
    received_at: toIso(pick(q, 'createDate', 'createdDate', 'regDate', 'registeredDate', 'createdAt')) || new Date().toISOString(),
    answered,
  };
}

function createNaverQnaSource({ client = createNaverClient(), now = () => new Date(), firstDays = FIRST_DAYS } = {}) {
  return {
    source: SOURCE,
    label: LABEL,
    async fetch({ state = {}, openIds = [], openSince = null } = {}) {
      const end = now();
      const last = state.lastRun ? Date.parse(state.lastRun) : NaN;
      const oldest = end.getTime() - firstDays * 24 * 3600 * 1000;
      // 문의 목록은 '쓴 날짜'로만 걸러져서, 미답변 문의가 남아 있으면 가장 오래된 것(최대 30일 전)부터 다시 읽는다
      //   → 판매자센터에서 나중에 단 답변도 알아채 '답변완료' 로 맞춘다
      let from = Number.isFinite(last) ? last - 24 * 3600 * 1000 : oldest;
      if (openSince && Number.isFinite(openSince.getTime())) from = Math.min(from, openSince.getTime() - 3600 * 1000);
      const start = new Date(Math.max(from, oldest));
      const items = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = await client.request('GET', PATH, {
          query: { page, size: PAGE_SIZE, fromDate: toKstIso(start), toDate: toKstIso(end) },
        });
        const list = listFrom(body);
        if (!list) throw new Error(`스마트스토어 문의 응답 모양을 알 수 없습니다 (항목: ${Object.keys(body || {}).join(', ') || '없음'})`);
        items.push(...list.map(normalizeQna).filter(Boolean));
        if (list.length < PAGE_SIZE) break;
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

// 답변 등록: 실패를 '보내기 전에 막힘(실패)' 과 '결과를 알 수 없음(확인 필요)' 으로 나눈다
function createNaverQnaSender({ client = createNaverClient({ allowWrite: true }) } = {}) {
  return {
    async reply(inquiry, body, files = []) {
      if (files.length) return { result: 'fail', message: '스마트스토어 상품문의 답변에는 파일을 붙일 수 없습니다.' };
      try {
        await client.request('PUT', `${PATH}/${encodeURIComponent(inquiry.external_id)}`, { json: { commentContent: body } });
        return { result: 'ok', message: '스마트스토어에 답변을 등록했습니다.' };
      } catch (e) {
        if (e.notSent || (e.status && e.status < 500)) return { result: 'fail', message: `등록하지 못했습니다 — ${e.message}` };
        return { result: 'unknown', message: `네이버 응답을 받지 못했습니다. 판매자센터에서 답변이 등록됐는지 확인하세요. (${e.message})` };
      }
    },
  };
}

module.exports = { SOURCE, LABEL, createNaverQnaSource, createNaverQnaSender, normalizeQna, listFrom };
