// .env 의 ORDER_SOURCE 에 따라 주문 출처를 고른다
//   mock  → 가짜 주문 (개발용, 기본값)
//   naver → 실제 스마트스토어 (등록된 서버 IP 에서만 동작)
const { createMockSource } = require('./mock');
const { createSmartstoreSource } = require('./smartstore');

function createOrderSource(kind = process.env.ORDER_SOURCE || 'mock') {
  if (kind === 'naver') return createSmartstoreSource();
  if (kind !== 'mock') {
    throw new Error(`ORDER_SOURCE 값이 올바르지 않습니다: '${kind}' (mock 또는 naver)`);
  }
  return createMockSource();
}

module.exports = { createOrderSource };
