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

module.exports = { CHANNELS, channelInfo, channelStatusLabel };
