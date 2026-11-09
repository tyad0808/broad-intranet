// G마켓·옥션 (ESM Trading API) 연결
//
// 안전장치 1: 아래 ALLOWED 에 맞는 주소만 호출할 수 있다 (지금은 조회만: 주문·취소·반품·교환).
// 안전장치 2: 상태를 바꾸는 주소(주문확인·발송처리 등)는 아직 목록에 없다 — 다음 단계에서 ESM_WRITE=on 일 때만 더한다.
//
// 인증(JWT, HS256): 매 요청마다 시크릿키로 서명한 토큰을 Authorization: Bearer 로 보낸다 (etapi.gmarket.com 'API 가이드')
//   header  { alg: HS256, typ: JWT, kid: ESM+ 마스터 ID }
//   payload { iss, sub: 'sell', aud: 'sa.esmplus.com', iat, ssi: 'G:G마켓ID' 또는 'A:옥션ID' }
//   ※ 안내 예시는 'A:…,G:…' 둘 다였지만, 실제 주문조회는 "한 사이트 판매자 ID 만" 받는다 (HTTP 400)
//     → 요청마다 그 요청의 사이트(siteType) ID 하나만 넣는다
// ESM 은 미리 등록한 서버(인트라넷 서버 IP)에서 온 요청만 받는다.
// 키·아이디는 서버 .env 에만: ESM_MASTER_ID, ESM_SECRET_KEY, ESM_GMARKET_ID, ESM_AUCTION_ID
const crypto = require('crypto');

const BASE_URL = 'https://sa2.esmplus.com';
// 사이트 구분: 요청은 1 옥션 · 2 G마켓 (응답의 SiteType 은 G마켓이 3 으로 올 때도 있다)
const SITES = {
  G: { code: 2, name: 'G마켓', env: 'ESM_GMARKET_ID' },
  A: { code: 1, name: '옥션', env: 'ESM_AUCTION_ID' },
};

const ALLOWED = [
  // 주문조회 (상태별·기간별, 또는 주문번호로) — 기간 조회는 5초에 1번까지
  { method: 'POST', pattern: /^\/shipping\/v1\/Order\/RequestOrders$/ },
  // 취소·반품·교환 조회
  { method: 'POST', pattern: /^\/claim\/v1\/sa\/Cancels$/ },
  { method: 'POST', pattern: /^\/claim\/v1\/sa\/Returns$/ },
  { method: 'POST', pattern: /^\/claim\/v1\/sa\/Exchanges$/ },
];

function findAllowed(method, path) {
  return ALLOWED.find(a => a.method === method && a.pattern.test(path));
}
const isAllowed = (method, path) => Boolean(findAllowed(method, path));

class EsmApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'EsmApiError';
    this.status = status;
    this.body = body;
  }
}

const b64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

// 인증 토큰 (Authorization: Bearer 토큰). site: 'G' / 'A' 면 그 사이트 ID 만
function buildToken({ masterId, secretKey, gmarketId, auctionId, site = null, issuer = 'www.esmplus.com', now = new Date() }) {
  const ssi = [site !== 'G' && auctionId ? `A:${auctionId}` : null, site !== 'A' && gmarketId ? `G:${gmarketId}` : null].filter(Boolean).join(',');
  const head = b64url({ alg: 'HS256', typ: 'JWT', kid: masterId });
  const body = b64url({ iss: issuer, sub: 'sell', aud: 'sa.esmplus.com', iat: Math.floor(now.getTime() / 1000), ssi });
  const sig = crypto.createHmac('sha256', secretKey).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// 주문 기간 조회는 5초에 1번 (ESM 규칙) → 넉넉히 5.2초 간격. 주문번호 조회·클레임 조회는 짧게
const RANGE_GAP_MS = 5200;
const MIN_GAP_MS = 400;
const RETRY_WAITS_MS = [2000, 5000];
const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createEsmClient({
  masterId = process.env.ESM_MASTER_ID,
  secretKey = process.env.ESM_SECRET_KEY,
  gmarketId = process.env.ESM_GMARKET_ID,
  auctionId = process.env.ESM_AUCTION_ID,
  issuer = process.env.ESM_TOKEN_ISSUER || 'www.esmplus.com',
  fetchFn = fetch,
  sleep = realSleep,
  now = () => new Date(),
} = {}) {
  let nextAny = 0;
  let nextRange = 0;
  // 아이디가 있는 사이트만 (G마켓만 / 옥션만 / 둘 다)
  const sites = Object.entries(SITES).filter(([key]) => (key === 'G' ? gmarketId : auctionId)).map(([key, s]) => ({ key, ...s }));

  async function wait(isRange) {
    const t = Date.now();
    const at = Math.max(t, nextAny, isRange ? nextRange : 0);
    nextAny = at + MIN_GAP_MS;
    if (isRange) nextRange = at + RANGE_GAP_MS;
    if (at > t) await sleep(at - t);
  }

  async function request(method, path, json = {}) {
    if (!findAllowed(method, path)) {
      throw Object.assign(new Error(`허용되지 않은 G마켓·옥션 API 호출입니다: ${method} ${path}`), { notSent: true });
    }
    if (!masterId || !secretKey || !sites.length) {
      throw Object.assign(new Error('ESM_MASTER_ID / ESM_SECRET_KEY / ESM_GMARKET_ID(또는 ESM_AUCTION_ID) 가 .env 에 없습니다.'), { notSent: true });
    }
    // 주문 '기간' 조회만 5초 규칙 (주문번호로 조회하면 제한 없음)
    const isRange = /RequestOrders$/.test(path) && Number(json.orderStatus) !== 0;
    // 이 요청의 사이트 (1 옥션 · 2 G마켓) → 토큰에 그 사이트 판매자 ID 하나만
    const siteCode = Number(json.siteType ?? json.SiteType);
    const site = siteCode === 1 ? 'A' : siteCode === 2 ? 'G' : null;
    for (let attempt = 0; ; attempt++) {
      await wait(isRange);
      const res = await fetchFn(BASE_URL + path, {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${buildToken({ masterId, secretKey, gmarketId, auctionId, site, issuer, now: now() })}`,
          'content-type': 'application/json',
          accept: 'application/json',
          // 언어를 꼭 적는다: Node 기본값 '*' 를 ESM 서버가 언어 이름으로 못 읽어 코드 3000 ('* 은 잘못된 문화권 식별자')
          'accept-language': 'ko-KR',
        },
        body: JSON.stringify(json),
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      // 429(요청이 많음)는 처리하지 않고 거절한 것이라 다시 보내도 안전하다 (조회만 하므로)
      if (res.status === 429 && attempt < RETRY_WAITS_MS.length) {
        await sleep(RETRY_WAITS_MS[attempt]);
        continue;
      }
      const code = body && (body.ResultCode ?? body.resultCode);
      if (!res.ok || (code !== undefined && code !== null && Number(code) !== 0)) {
        const msg = (body && (body.Message || body.message || (body.status && body.status.message))) || (text ? text.slice(0, 200) : '');
        throw new EsmApiError(`G마켓·옥션 API 오류 (HTTP ${res.status}${code ? `, 코드 ${code}` : ''})${msg ? `: ${msg}` : ''}`, res.status, body);
      }
      return body;
    }
  }

  return { request, sites };
}

module.exports = { createEsmClient, buildToken, isAllowed, ALLOWED, SITES, EsmApiError };
