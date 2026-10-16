// 쿠팡 OPEN API 연결 (1단계: 조회 전용)
//
// 안전장치: 아래 ALLOWED 에 맞는 주소만 호출할 수 있다. 지금은 '발주서 목록 조회' 하나뿐이고,
// 주문 상태를 바꾸는 주소(상품준비중 처리·송장 업로드)는 목록에 없어서 보내기 전에 막힌다.
//
// 인증(HMAC): 서명할 글 = 서명시각(yyMMddTHHmmssZ, UTC) + 메서드 + 경로 + 쿼리(? 없이)
//            Authorization: CEA algorithm=HmacSHA256, access-key=…, signed-date=…, signature=…
const crypto = require('crypto');

const BASE_URL = 'https://api-gateway.coupang.com';

const ALLOWED = [
  // 발주서 목록 조회 (일 단위 페이징)
  { method: 'GET', pattern: /^\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/[A-Za-z0-9]+\/ordersheets$/ },
];

function isAllowed(method, path) {
  return ALLOWED.some(a => a.method === method && a.pattern.test(path));
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
    /"(shipmentBoxId|orderId|vendorItemId|vendorItemPackageId|productId|sellerProductId|sellerProductItemId)"\s*:\s*(\d+)/g,
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
} = {}) {
  let nextSlot = 0;

  async function request(method, path, { query = {} } = {}) {
    if (!isAllowed(method, path)) {
      const err = new Error(`허용되지 않은 쿠팡 API 호출입니다: ${method} ${path}`);
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
      });
      const text = await res.text();
      let body = null;
      try { body = text ? parseJson(text) : null; } catch { body = null; }
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

module.exports = { createCoupangClient, isAllowed, ALLOWED, buildAuthorization, signedDate, parseJson, CoupangApiError };
