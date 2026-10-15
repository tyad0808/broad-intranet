// .env 의 ORDER_SOURCE 에 따라 주문 출처를 고른다
//   mock  → 가짜 주문 (개발용, 기본값)
//   naver → 실제 스마트스토어 (등록된 서버 IP 에서만 동작)
//   off   → 수집하지 않음 (운영 서버에 네이버 키를 넣기 전)
const { createMockSource } = require('./mock');
const { createSmartstoreSource } = require('./smartstore');

function createOrderSource(kind = process.env.ORDER_SOURCE || 'mock', { production = process.env.NODE_ENV === 'production' } = {}) {
  if (kind === 'off') return null;
  if (kind === 'naver') return createSmartstoreSource();
  if (kind !== 'mock') {
    throw new Error(`ORDER_SOURCE 값이 올바르지 않습니다: '${kind}' (mock, naver, off 중 하나)`);
  }
  // 운영 DB 에 가짜 주문이 섞이면 실제 주문과 구분하기 어렵다
  if (production) {
    throw new Error('운영 서버(NODE_ENV=production)에서는 가짜 주문(ORDER_SOURCE=mock)을 쓸 수 없습니다. off 또는 naver 로 바꾸세요.');
  }
  return createMockSource();
}

module.exports = { createOrderSource };
