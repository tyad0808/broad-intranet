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

// ── 고객이 주문할 때 고른 배송 방법 (목록·상세에 보여 주는 표시) ──
// 채널 값 그대로 저장하고, 보여 줄 때만 글자·색으로 바꾼다
//   택배 = 노랑 · 퀵 = 파랑 · 방문수령·직접전달 = 파란 테두리
const SHIP_WAYS = {
  DELIVERY: { text: '택배', cls: 'sw-parcel' },
  GDFW_ISSUE_SVC: { text: '택배', cls: 'sw-parcel' }, // 굿스플로 송장 출력으로 보내는 택배 (스마트스토어)
  QUICK_SVC: { text: '퀵', cls: 'sw-quick' },
  VISIT_RECEIPT: { text: '방문수령', cls: 'sw-visit' },
  DIRECT_DELIVERY: { text: '직접전달', cls: 'sw-visit' },
  NOTHING: { text: '배송 없음', cls: 'sw-none' },
};

function shipWay(code) {
  return SHIP_WAYS[code] || null;
}

// 채널마다 다른 값(코드 또는 한글 이름)을 위 코드 하나로 맞춘다. 모르는 값이면 null
function shipWayCode(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (SHIP_WAYS[v.toUpperCase()]) return v.toUpperCase();
  if (/퀵/.test(v)) return 'QUICK_SVC';
  if (/방문/.test(v)) return 'VISIT_RECEIPT';
  if (/직접/.test(v)) return 'DIRECT_DELIVERY';
  if (/택배|등기|소포|배송/.test(v)) return 'DELIVERY';
  return null;
}

// 고객이 고른 방법에 맞춰 발송처리 칸에서 처음 골라 둘 값 (방문수령은 '직접전달' 로 처리)
function dispatchMethodFor(code) {
  if (code === 'QUICK_SVC') return 'QUICK_SVC';
  if (code === 'VISIT_RECEIPT' || code === 'DIRECT_DELIVERY') return 'DIRECT_DELIVERY';
  return DEFAULT_METHOD;
}

// 끝난(취소·반품) 상품은 금액에서 뺀다
const DEAD_STATUSES = new Set(['CANCELED', 'CANCELED_BY_NOPAYMENT', 'RETURNED']);

// 주문 한 건(상품 여러 개)의 금액
//   goods: 상품 결제 금액 합계 (할인 뒤, 배송비 빼고)
//   fee:   배송비 — 같은 묶음배송(ship_pkg)의 상품마다 같은 값이 반복해서 오므로 묶음마다 한 번만 더한다
//   total: 고객이 낸 총액 = goods + fee
// 수기 주문은 등록할 때 적은 금액(amount)을 그대로 쓴다. 모르면 null
function orderMoney(items) {
  const list = items || [];
  if (!list.length) return { total: null, goods: null, fee: null };
  if (list[0].channel === 'manual') {
    const amount = list[0].amount == null ? null : Number(list[0].amount);
    return { total: amount, goods: amount, fee: null };
  }
  const live = list.filter(i => !DEAD_STATUSES.has(i.channel_status));
  const use = live.length ? live : list; // 모두 취소된 주문은 원래 금액을 보여 준다
  const priced = use.filter(i => i.pay_amount != null);
  const goods = priced.length ? priced.reduce((t, i) => t + Number(i.pay_amount), 0) : null;
  const fees = new Map();
  for (const i of use) {
    if (i.ship_fee == null) continue;
    const pkg = i.ship_pkg || i.channel_order_id;
    fees.set(pkg, Math.max(fees.get(pkg) || 0, Number(i.ship_fee)));
  }
  const fee = fees.size ? [...fees.values()].reduce((t, v) => t + v, 0) : null;
  return { total: goods === null ? null : goods + (fee || 0), goods, fee };
}

// 주문 한 건의 배송 방법 코드 (본상품 먼저, 끝난 상품은 뒤로)
function orderShipWay(items) {
  const list = [...(items || [])].sort((a, b) => Number(DEAD_STATUSES.has(a.channel_status)) - Number(DEAD_STATUSES.has(b.channel_status))
    || Number(a.item_type === 'addon') - Number(b.item_type === 'addon'));
  const hit = list.find(i => i.delivery_method);
  return hit ? hit.delivery_method : null;
}

const won = n => `${Number(n).toLocaleString('ko-KR')}원`;

module.exports = {
  SHIP_METHODS, COURIERS, DEFAULT_METHOD, DEFAULT_COURIER, shipMethodLabel, courierLabel,
  SHIP_WAYS, shipWay, shipWayCode, dispatchMethodFor, orderMoney, orderShipWay, won,
};
