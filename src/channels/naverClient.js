// 네이버 커머스 API 연결
//
// 안전장치 1: 아래 ALLOWED 목록에 있는 주소만 호출할 수 있다. 목록 밖 주소는 요청을 보내기 전에 오류로 막힌다.
// 안전장치 2: 주문 상태를 바꾸는 주소(write: true)는 allowWrite 를 켠 클라이언트에서만 부를 수 있다.
//            (.env 의 NAVER_WRITE=on 일 때만 켜진다. 기본은 꺼짐 = 연습 모드)
const bcrypt = require('bcryptjs');

const BASE_URL = 'https://api.commerce.naver.com/external';
const TOKEN_PATH = '/v1/oauth2/token';

const ALLOWED = [
  // 변경 상품 주문 내역 조회 (어떤 주문이 바뀌었는지 목록만)
  { method: 'GET', path: '/v1/pay-order/seller/product-orders/last-changed-statuses' },
  // 상품 주문 상세 내역 조회 (방식은 POST 지만 조회만 한다)
  { method: 'POST', path: '/v1/pay-order/seller/product-orders/query' },
  // ── 2차: 상태를 바꾸는 주소는 이 2개뿐 ──
  // 발주확인
  { method: 'POST', path: '/v1/pay-order/seller/product-orders/confirm', write: true },
  // 발송처리 (송장 입력)
  { method: 'POST', path: '/v1/pay-order/seller/product-orders/dispatch', write: true },
  // ── 4차: 상품문의(Q&A) ── 조회 2개 + 답변 등록 1개 (답변은 .env 의 NAVER_ANSWER=on 일 때만)
  { method: 'GET', path: '/v1/contents/qnas' },
  { method: 'GET', path: '/v1/contents/qnas/templates' },
  { method: 'PUT', pattern: /^\/v1\/contents\/qnas\/\d+$/, write: true, flag: 'NAVER_ANSWER' },
];

function findAllowed(method, path) {
  return ALLOWED.find(a => a.method === method && (a.path === path || (a.pattern && a.pattern.test(path))));
}

function isAllowed(method, path) {
  return Boolean(findAllowed(method, path));
}

class NaverApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'NaverApiError';
    this.status = status;
    this.body = body;
  }
}

// 네이버로 요청을 보내기 전에 막힌 오류 (확실히 아무것도 보내지 않았음)
function notSent(message) {
  const err = new Error(message);
  err.notSent = true;
  return err;
}

// 커머스 API 전자서명: bcrypt(clientId_timestamp, clientSecret) 결과를 base64 로 인코딩
function buildSignature(clientId, clientSecret, timestamp) {
  const hashed = bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret);
  return Buffer.from(hashed, 'utf-8').toString('base64');
}

// ── 요청 속도 조절 ──
// 네이버는 짧은 시간에 요청이 몰리면 429(요청이 많음)로 거절한다. 견적 계산기와 같은 API 키를 쓰므로 여유 있게:
//  - 요청 사이에 최소 MIN_GAP_MS 간격 (이 서버의 모든 네이버 요청이 같은 줄에 선다)
//  - 429 를 받으면 1초, 2초, 4초, 8초 기다렸다가 다시 시도 (429 는 처리하지 않고 거절한 것이라 다시 보내도 안전)
const MIN_GAP_MS = 400;
const RETRY_WAITS_MS = [1000, 2000, 4000, 8000];
const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let nextSlot = 0;
async function waitTurn(gapMs, sleep) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gapMs;
  if (at > now) await sleep(at - now);
}

// fetchFn 을 바꿔 끼울 수 있게 해서, 테스트에서는 실제 네이버에 요청하지 않는다
function createNaverClient({
  clientId = process.env.NAVER_CLIENT_ID,
  clientSecret = process.env.NAVER_CLIENT_SECRET,
  fetchFn = fetch,
  allowWrite = false,
  minGapMs = MIN_GAP_MS,
  retryWaitsMs = RETRY_WAITS_MS,
  sleep = realSleep,
} = {}) {
  let token = null;
  let tokenExpiresAt = 0;

  async function getAccessToken() {
    if (token && Date.now() < tokenExpiresAt) return token;
    if (!clientId || !clientSecret) {
      throw notSent('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 .env 에 없습니다.');
    }
    const timestamp = Date.now();
    const res = await fetchFn(BASE_URL + TOKEN_PATH, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        timestamp: String(timestamp),
        client_secret_sign: buildSignature(clientId, clientSecret, timestamp),
        grant_type: 'client_credentials',
        type: 'SELF',
      }).toString(),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.access_token) {
      throw new NaverApiError(`네이버 인증 실패 (HTTP ${res.status})`, res.status, body);
    }
    token = body.access_token;
    // 만료 1분 전에 미리 새로 받는다
    tokenExpiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000 - 60_000;
    return token;
  }

  async function request(method, path, { query, json } = {}) {
    const rule = findAllowed(method, path);
    if (!rule) {
      throw notSent(`허용되지 않은 네이버 API 호출입니다: ${method} ${path}`);
    }
    if (rule.write && !allowWrite) {
      throw notSent(`네이버로 보내기가 꺼져 있습니다 (${rule.flag || 'NAVER_WRITE'}=on 이 아님): ${method} ${path}`);
    }
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    // 토큰은 먼저 받아 둔다 (토큰 받기 실패 = 주문 요청은 보내지 않은 것)
    const accessToken = await getAccessToken().catch(e => {
      e.notSent = true;
      throw e;
    });
    let res;
    for (let attempt = 0; ; attempt++) {
      await waitTurn(minGapMs, sleep);
      res = await fetchFn(url.toString(), {
        method,
        // 응답이 30초 넘게 없으면 끊는다 (이때 상태 변경 요청은 결과를 알 수 없음으로 처리)
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(json ? { 'content-type': 'application/json' } : {}),
        },
        body: json ? JSON.stringify(json) : undefined,
      });
      if (res.status !== 429 || attempt >= retryWaitsMs.length) break;
      await sleep(retryWaitsMs[attempt]);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401) token = null; // 토큰이 만료됐으면 다음 요청 때 새로 받는다
      // 입력값 오류(400)는 어떤 항목이 틀렸는지(invalidInputs)까지 보여준다
      const invalid = body && Array.isArray(body.invalidInputs) && body.invalidInputs.length
        ? ` [${body.invalidInputs.map(i => `${i.name}: ${i.message || i.type}`).join(', ')}]` : '';
      const detail = (body && (body.message || body.code) ? `: ${body.message || body.code}` : '') + invalid;
      throw new NaverApiError(`네이버 API 오류 (HTTP ${res.status})${detail}`, res.status, body);
    }
    return body;
  }

  return { request };
}

module.exports = { createNaverClient, isAllowed, ALLOWED, NaverApiError, buildSignature };
