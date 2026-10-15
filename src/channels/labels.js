// 채널 이름·표시와 주문 상태 코드를 한글로 보여주기 위한 표

// mark: 카드 앞에 붙는 한 글자 표시, cls: 색깔 (style.css 의 .ch-*)
const CHANNELS = {
  smartstore: { name: '스마트스토어', mark: 'N', cls: 'naver' },
  godo: { name: '자사몰', mark: 'B', cls: 'own' },
  coupang: { name: '쿠팡', mark: 'C', cls: 'coupang' },
  esm: { name: 'G마켓·옥션', mark: 'G', cls: 'esm' },
};

function channelInfo(key) {
  return CHANNELS[key] || { name: key || '기타', mark: '?', cls: 'etc' };
}

const SMARTSTORE_STATUS = {
  PAYMENT_WAITING: '결제대기',
  PAYED: '결제완료',
  DELIVERING: '배송중',
  DELIVERED: '배송완료',
  PURCHASE_DECIDED: '구매확정',
  EXCHANGED: '교환',
  CANCELED: '취소',
  RETURNED: '반품',
  CANCELED_BY_NOPAYMENT: '미결제취소',
};

function channelStatusLabel(code) {
  return SMARTSTORE_STATUS[code] || code || '-';
}

// 고객의 취소·반품·교환 진행 상태 (네이버 claimStatus)
const CLAIM_STATUS = {
  CANCEL_REQUEST: '취소 요청',
  CANCELING: '취소 처리중',
  CANCEL_DONE: '취소 완료',
  CANCEL_REJECT: '취소 거부됨',
  ADMIN_CANCELING: '직권취소 처리중',
  ADMIN_CANCEL_DONE: '직권취소 완료',
  ADMIN_CANCEL_REJECT: '직권취소 거부됨',
  RETURN_REQUEST: '반품 요청',
  EXCHANGE_REQUEST: '교환 요청',
  COLLECTING: '수거중',
  COLLECT_DONE: '수거 완료',
  EXCHANGE_REDELIVERING: '교환 재배송중',
  RETURN_DONE: '반품 완료',
  EXCHANGE_DONE: '교환 완료',
  RETURN_REJECT: '반품 거부됨',
  EXCHANGE_REJECT: '교환 거부됨',
  PURCHASE_DECISION_HOLDBACK: '구매확정 보류',
  PURCHASE_DECISION_HOLDBACK_REDELIVERING: '구매확정 보류(재배송중)',
  PURCHASE_DECISION_REQUEST: '구매확정 요청',
  PURCHASE_DECISION_HOLDBACK_RELEASE: '구매확정 보류 해제',
};

function claimLabel(code) {
  return CLAIM_STATUS[code] || code || '';
}

// 카드에 빨간 표시를 할 상태인지: 아직 진행 중인 취소·반품·교환
// (거부됨·보류 해제·구매확정 요청은 정상 진행으로 보고, 완료는 회색으로 표시)
function claimLevel(code) {
  if (!code || /_REJECT$/.test(code) || code === 'PURCHASE_DECISION_HOLDBACK_RELEASE' || code === 'PURCHASE_DECISION_REQUEST') return null;
  if (/_DONE$/.test(code)) return 'done';
  return 'open';
}

module.exports = { CHANNELS, channelInfo, channelStatusLabel, claimLabel, claimLevel };
