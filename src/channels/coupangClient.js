// 쿠팡 OPEN API 연결
//
// 안전장치 1: 아래 ALLOWED 에 맞는 주소만 호출할 수 있다 (조회 1개 + 상태 변경 2개).
// 안전장치 2: 상태 변경(상품준비중 처리·송장 업로드, write: true)은 allowWrite 를 켠 클라이언트만.
//            .env 의 COUPANG_WRITE=on 일 때만 켜진다 (기본은 연습 모드).
//
// 인증(HMAC): 서명할 글 = 서명시각(yyMMddTHHmmssZ, UTC) + 메서드 + 경로 + 쿼리(? 없이)
//            Authorization: CEA algorithm=HmacSHA256, access-key=…, signed-date=…, signature=…
const crypto = require('crypto');

const BASE_URL = 'https://api-gateway.coupang.com';

const ALLOWED = [
  // 발주서 목록 조회 (일 단위 페이징)
  { method: 'GET', pattern: /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/[A-Za-z0-9]+\/ordersheets$/ },
  // 상품준비중 처리 (= 발주확인)
  { method: 'PUT', pattern: /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/[A-Za-z0-9]+\/ordersheets\/acknowledgement$/, write: true },
  // 송장 업로드 (= 발송처리)
  { method: 'POST', pattern: /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/[A-Za-z0-9]+\/orders\/invoices$/, write: true },
  // ── 4-3 문의 ── 조회 2개 + 답변 2개 (답변은 .env 의 COUPANG_ANSWER=on 일 때만)
  // 상품별 고객문의 조회 (문서에 v4·v5 둘 다 나와서 둘 다 허용)
  { method: 'GET', pattern: /^\/v2\/providers\/openapi\/apis\/api\/v[45]\/vendors\/[A-Za-z0-9]+\/onlineInquiries$/ },
  // 쿠팡 고객센터 문의 조회
  { method: 'GET', pattern: /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/[A-Za-z0-9]+\/callCenterInquiries$/ },
  { method: 'POST', pattern: /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/[A-Za-z0-9]+\/onlineInquiries\/\d+\/replies$/, write: true, flag: 'COUPANG_ANSWER' },
  { method: 'POST', pattern: /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/[A-Za-z0-9]+\/callCenterInquiries\/\d+\/replies$/, write: true, flag: 'COUPANG_ANSWER' },
];

function findAllowed(method, path) {
  return ALLOWED.find(a => a.method === method && a.pattern.test(path));
}

function isAllowed(method, path) {
  return Boolean(findAllowed(method, path));
}

// 보낼 JSON: 긴 번호(배송번호 등)는 글자로 갖고 있다가 숫자 모양 그대로 보낸다
function stringifyBody(body) {
  return JSON.stringify(body).replace(/"(shipmentBoxId|orderId|vendorItemId|inquiryId|parentAnswerId)":"(\d+)"/g, '"$1":$2')
    .replace(/"shipmentBoxIds":\[([^\]]*)\]/g, (m, inner) => `"shipmentBoxIds":[${inner.replace(/"(\d+)"/g, '$1')}]`);
}

class CoupangApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'CoupangApiError';
    this.status = status;
    this.body = body;
  }
}

// 서명 시각: 260116T013000Z 처럼 (UTC)
function signedDate(now = new Date()) {
  return now.toISOString().slice(2, 19).replace(/[-:]/g, '') + 'Z';
}

function buildAuthorization({ accessKey, secretKey, method, path, query, now }) {
  const datetime = signedDate(now);
  const signature = crypto.createHmac('sha256', secretKey).update(datetime + method + path + query).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

// 쿠팡 번호(shipmentBoxId 등)는 자바스크립트 숫자로 읽으면 끝자리가 틀어질 만큼 길다 → 글자로 바꿔 읽는다
function parseJson(text) {
  return JSON.parse(text.replace(
    /"(shipmentBoxId|orderId|vendorItemId|vendorItemPackageId|productId|sellerProductId|sellerProductItemId|inquiryId|answerId|parentAnswerId)"\s*:\s*(\d+)/g,
    '"$1":"$2"'
  ));
}

const MIN_GAP_MS = 300;
const RETRY_WAITS_MS = [1000, 2000, 4000];
const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createCoupangClient({
  vendorId = process.env.COUPANG_VENDOR_ID,
  accessKey = process.env.COUPANG_ACCESS_KEY,
  secretKey = process.env.COUPANG_SECRET_KEY,
  fetchFn = fetch,
  minGapMs = MIN_GAP_MS,
  sleep = realSleep,
  now = () => new Date(),
  allowWrite = false,
} = {}) {
  let nextSlot = 0;

  async function request(method, path, { query = {}, json } = {}) {
    const rule = findAllowed(method, path);
    if (!rule) {
      const err = new Error(`허용되지 않은 쿠팡 API 호출입니다: ${method} ${path}`);
      err.notSent = true;
      throw err;
    }
    if (rule.write && !allowWrite) {
      const err = new Error(`쿠팡으로 보내기가 꺼져 있습니다 (${rule.flag || 'COUPANG_WRITE'}=on 이 아님): ${method} ${path}`);
      err.notSent = true;
      throw err;
    }
    if (!vendorId || !accessKey || !secretKey) {
      const err = new Error('COUPANG_VENDOR_ID / COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 가 .env 에 없습니다.');
      err.notSent = true;
      throw err;
    }
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
    for (let attempt = 0; ; attempt++) {
      // 요청 사이 간격 (쿠팡도 짧은 시간에 몰리면 거절한다)
      const t = Date.now();
      const at = Math.max(t, nextSlot);
      nextSlot = at + minGapMs;
      if (at > t) await sleep(at - t);

      const res = await fetchFn(BASE_URL + path + (qs ? `?${qs}` : ''), {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: buildAuthorization({ accessKey, secretKey, method, path, query: qs, now: now() }),
          'content-type': 'application/json;charset=UTF-8',
          'x-requested-by': vendorId,
        },
        body: json ? stringifyBody(json) : undefined,
      });
      const text = await res.text();
      let body = null;
      try { body = text ? parseJson(text) : null; } catch { body = null; }
      // 429(요청이 많음)는 처리하지 않고 거절한 것이라 다시 보내도 안전하다
      if (res.status === 429 && attempt < RETRY_WAITS_MS.length) {
        await sleep(RETRY_WAITS_MS[attempt]);
        continue;
      }
      if (!res.ok || (body && body.code !== undefined && String(body.code) !== '200' && body.code !== 'SUCCESS')) {
        const detail = body && body.message ? `: ${body.message}` : text ? `: ${text.slice(0, 200)}` : '';
        throw new CoupangApiError(`쿠팡 API 오류 (HTTP ${res.status})${detail}`, res.status, body);
      }
      return body;
    }
  }

  return { request, vendorId };
}

module.exports = { createCoupangClient, isAllowed, ALLOWED, stringifyBody, buildAuthorization, signedDate, parseJson, CoupangApiError };
