// 채널의 주문 상태 코드를 한글로 보여주기 위한 표
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

module.exports = { channelStatusLabel };
