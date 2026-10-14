// 네이버 커머스 API 연결 (조회 전용)
//
// 안전장치: 아래 ALLOWED 목록에 있는 주소만 호출할 수 있다.
// 1차는 주문을 "조회만" 하기로 했으므로 발주확인·발송처리 같은 상태 변경 API 는 목록에 없고,
// 코드 어디에서 실수로 부르더라도 요청을 보내기 전에 오류로 막힌다.
const bcrypt = require('bcryptjs');

const BASE_URL = 'https://api.commerce.naver.com/external';
const TOKEN_PATH = '/v1/oauth2/token';

const ALLOWED = [
  // 변경 상품 주문 내역 조회 (어떤 주문이 바뀌었는지 목록만)
  { method: 'GET', path: '/v1/pay-order/seller/product-orders/last-changed-statuses' },
  // 상품 주문 상세 내역 조회 (방식은 POST 지만 조회만 한다)
  { method: 'POST', path: '/v1/pay-order/seller/product-orders/query' },
];

function isAllowed(method, path) {
  return ALLOWED.some(a => a.method === method && a.path === path);
}

class NaverApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'NaverApiError';
    this.status = status;
    this.body = body;
  }
}

// 커머스 API 전자서명: bcrypt(clientId_timestamp, clientSecret) 결과를 base64 로 인코딩
function buildSignature(clientId, clientSecret, timestamp) {
  const hashed = bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret);
  return Buffer.from(hashed, 'utf-8').toString('base64');
}

// fetchFn 을 바꿔 끼울 수 있게 해서, 테스트에서는 실제 네이버에 요청하지 않는다
function createNaverClient({
  clientId = process.env.NAVER_CLIENT_ID,
  clientSecret = process.env.NAVER_CLIENT_SECRET,
  fetchFn = fetch,
} = {}) {
  let token = null;
  let tokenExpiresAt = 0;

  async function getAccessToken() {
    if (token && Date.now() < tokenExpiresAt) return token;
    if (!clientId || !clientSecret) {
      throw new Error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 .env 에 없습니다.');
    }
    const timestamp = Date.now();
    const res = await fetchFn(BASE_URL + TOKEN_PATH, {
      method: 'POST',
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
    if (!isAllowed(method, path)) {
      throw new Error(`허용되지 않은 네이버 API 호출입니다: ${method} ${path} (1차는 조회 전용)`);
    }
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const res = await fetchFn(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${await getAccessToken()}`,
        ...(json ? { 'content-type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401) token = null; // 토큰이 만료됐으면 다음 요청 때 새로 받는다
      const detail = body && (body.message || body.code) ? `: ${body.message || body.code}` : '';
      throw new NaverApiError(`네이버 API 오류 (HTTP ${res.status})${detail}`, res.status, body);
    }
    return body;
  }

  return { request };
}

module.exports = { createNaverClient, isAllowed, ALLOWED, NaverApiError, buildSignature };
