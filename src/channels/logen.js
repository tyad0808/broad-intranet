// 로젠택배 Open API (송장 발행)
//
// 주소: 개발계(테스트) https://topenapi.ilogen.com · 운영계(실제) https://openapi.ilogen.com — .env 의 LOGEN_ENV=prod 일 때만 운영계
// 인증: 로젠에 등록한 서버 IP + 요청 헤더 secretKey (로젠 개발자 사이트 '이용안내 > 인증키발급' 에서 발급, 유효기간 최대 2년)
//       키는 .env 의 LOGEN_SECRET_KEY 에만 둔다
// 코드: userId = 연동업체코드 (없으면 거래처코드), custCd = 거래처코드
// 요청 모양: POST { userId, data: [ {...}, ... ] } → 응답 { data: [ {..., resultCd, resultMsg} ], sttsCd, sttsMsg }
//
// 허용 주소: 로젠이 메일로 허락한 5개만 — 계약·운임 조회 2개 + 주문 등록 1개(write) + 송장번호 조회 1개 + 화물추적 1개
//   (로젠 안내: 안내 메일에 없는 API 는 절대 호출하지 말 것. 한 번에 10건 안팎, 차례대로, 사이에 몇 초씩 쉬기 → src/logen.js)
// write: true 는 allowWrite 를 켠 연결만 (운영계는 .env 의 LOGEN_WRITE=on 일 때만, 기본은 연습 모드)
const BASE = { dev: 'https://topenapi.ilogen.com', prod: 'https://openapi.ilogen.com' };
const PREFIX = '/lrm02b-edi/edi/';
// 개발계 테스트 코드 (로젠 문서에 공개된 값)
const TEST_CODES = { userId: '10358007', custCd: '20179999' };

const ALLOWED = [
  { name: 'contractTotalInfo' }, // 거래처 계약정보 (영업소·운임구분·사용여부)
  { name: 'contPickFares' }, // 운임구분별 계약 운임 (박스 종류별)
  { name: 'registerOrderData', write: true }, // 주문 정보 일괄 등록 → 로젠 '주문등록출력(복수건)' 화면
  { name: 'inquirySlipNoMulti' }, // 출력한 송장번호 조회 (주문번호로)
  { name: 'inquiryCargoTrackingMulti' }, // 화물추적 전체
];
const isAllowed = name => ALLOWED.some(a => a.name === name);

class LogenApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'LogenApiError';
    this.status = status;
    this.body = body;
  }
}

function createLogenClient({
  env = process.env.LOGEN_ENV === 'prod' ? 'prod' : 'dev',
  secretKey = process.env.LOGEN_SECRET_KEY,
  custCd = process.env.LOGEN_CUST_CD,
  userId = process.env.LOGEN_USER_ID || custCd,
  fetchFn = fetch,
  allowWrite = false,
} = {}) {
  const notSent = message => Object.assign(new Error(message), { notSent: true });

  // name: 위 허용 목록의 이름, rows: data 목록 (거래처코드는 자동으로 넣는다)
  async function request(name, rows = [{}]) {
    const rule = ALLOWED.find(a => a.name === name);
    if (!rule) throw notSent(`허용되지 않은 로젠 API 호출입니다: ${name}`);
    // 개발계(테스트)는 가짜 주문이라 언제든 되고, 운영계 등록은 LOGEN_WRITE=on 일 때만
    if (rule.write && env === 'prod' && !allowWrite) throw notSent(`로젠 송장 발행이 꺼져 있습니다 (LOGEN_WRITE=on 이 아님): ${name}`);
    if (!secretKey) throw notSent('LOGEN_SECRET_KEY 가 .env 에 없습니다.');
    if (!userId || !custCd) throw notSent('LOGEN_CUST_CD(거래처코드)가 .env 에 없습니다.');
    const res = await fetchFn(`${BASE[env]}${PREFIX}${name}`, {
      method: 'POST',
      signal: AbortSignal.timeout(rule.write ? 60_000 : 20_000),
      headers: { secretKey, 'content-type': 'application/json', accept: 'application/json' },
      // 화물추적은 송장번호만, 나머지는 거래처코드를 함께
      body: JSON.stringify({ userId, data: name.startsWith('inquiryCargo') ? rows : rows.map(r => ({ custCd, ...r })) }),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) {
      const hint = res.status === 401 ? ' — 인증키가 틀렸거나 서버 IP 가 로젠에 등록되지 않았습니다' : '';
      const detail = body && (body.sttsMsg || body.message) ? `: ${body.sttsMsg || body.message}` : '';
      throw new LogenApiError(`로젠 API 오류 (HTTP ${res.status})${detail}${hint}`, res.status, body);
    }
    if (!body) throw new LogenApiError('로젠 응답을 읽지 못했습니다', res.status, text.slice(0, 200));
    return body;
  }
  return { request, env, custCd, userId, hasKey: Boolean(secretKey), allowWrite };
}

module.exports = { BASE, TEST_CODES, ALLOWED, isAllowed, createLogenClient, LogenApiError };
