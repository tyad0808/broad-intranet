// 발송처리에 쓰는 배송 방법과 택배사 코드 (네이버 커머스 API 기준)
//
// 택배사를 더 쓰게 되면 COURIERS 에 한 줄 추가하면 된다.
// ※ 코드는 네이버 택배사 코드표 기준이다. 처음 실제로 발송처리할 때 판매자센터에서 송장이 맞게 들어갔는지 꼭 확인할 것.
const SHIP_METHODS = {
  DELIVERY: '택배',
  QUICK_SVC: '퀵서비스',
  DIRECT_DELIVERY: '직접전달',
};

const COURIERS = {
  KGB: '로젠택배',
  KDEXP: '경동택배',
};

// 화면에서 처음 골라져 있는 값
const DEFAULT_METHOD = 'DELIVERY';
const DEFAULT_COURIER = 'KGB';

function shipMethodLabel(code) {
  return SHIP_METHODS[code] || code || '';
}

function courierLabel(code) {
  return COURIERS[code] || code || '';
}

module.exports = { SHIP_METHODS, COURIERS, DEFAULT_METHOD, DEFAULT_COURIER, shipMethodLabel, courierLabel };
