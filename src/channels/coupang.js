// 쿠팡 주문 가져오기 (1단계: 조회 전용)
//
// 쿠팡은 '바뀐 주문' 목록이 없어서, 수집할 때마다 상태별로 최근 주문을 다시 읽는다.
//   - 아직 안 나간 주문(결제완료·상품준비중·배송지시): 최근 30일
//   - 나간 주문(배송중·배송완료 등): 최근 7일 (상태가 바뀌었는지 맞추기 위해)
// 한 주문(orderId)의 여러 상품은 스마트스토어처럼 한 카드로 묶인다.
const { createCoupangClient } = require('./coupangClient');

const CHANNEL = 'coupang';
const OPEN_STATUSES = ['ACCEPT', 'INSTRUCT', 'DEPARTURE'];
const DONE_STATUSES = ['DELIVERING', 'FINAL_DELIVERY', 'NONE_TRACKING'];
const OPEN_DAYS = 30;
const DONE_DAYS = 7;

// 쿠팡 상태 → 인트라넷 공통 상태 (상태 칸·탭이 스마트스토어와 똑같이 동작하도록)
//   결제완료 → 신규주문, 상품준비중(발주확인) → 배송준비, 배송지시·배송중 → 배송중, 배송완료 → 배송완료
const STATUS_MAP = {
  ACCEPT: { status: 'PAYED', confirmed: 0 },
  INSTRUCT: { status: 'PAYED', confirmed: 1 },
  DEPARTURE: { status: 'DELIVERING', confirmed: 1 },
  DELIVERING: { status: 'DELIVERING', confirmed: 1 },
  FINAL_DELIVERY: { status: 'DELIVERED', confirmed: 1 },
  NONE_TRACKING: { status: 'DELIVERING', confirmed: 1 },
};

// 쿠팡 시각(한국 시간, 시간대 표시 없음) → 2026-10-16T10:00:00+09:00
function kstIso(value) {
  if (!value) return null;
  const text = String(value).replace(' ', 'T');
  return /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}+09:00`;
}

// 한국 날짜 YYYY-MM-DD
function kstDate(date) {
  return new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 쿠팡 발주서 1건(배송 묶음) → 인트라넷 주문(상품) 여러 건
function normalize(sheet) {
  const map = STATUS_MAP[sheet.status] || { status: sheet.status || null, confirmed: 0 };
  const orderer = sheet.orderer || {};
  const receiver = sheet.receiver || {};
  const address = [receiver.postCode ? `(${receiver.postCode})` : null, receiver.addr1, receiver.addr2].filter(Boolean).join(' ') || null;
  return (sheet.orderItems || []).map(item => {
    const quantity = Number(item.shippingCount) || 1;
    // 고객이 취소를 요청해 출고를 멈춘 수량이 있으면 취소 요청으로 표시
    const holdCancel = Number(item.holdCountForCancel) > 0;
    const allCanceled = Number(item.cancelCount) >= quantity && Number(item.cancelCount) > 0;
    return {
      channel: CHANNEL,
      channel_order_id: String(sheet.orderId || ''),
      channel_item_id: `${sheet.shipmentBoxId}-${item.vendorItemId}`,
      product_name: item.sellerProductName || item.vendorItemName || '(상품명 없음)',
      item_type: 'main',
      option_text: item.sellerProductItemName || null,
      quantity,
      buyer_name: orderer.name || null,
      receiver_name: receiver.name || null,
      receiver_phone: receiver.safeNumber || receiver.receiverNumber || null,
      receiver_address: address,
      paid_at: kstIso(sheet.paidAt || sheet.orderedAt),
      channel_status: allCanceled ? 'CANCELED' : map.status,
      channel_confirmed: map.confirmed,
      claim_type: holdCancel ? 'CANCEL' : null,
      claim_status: holdCancel && !allCanceled ? 'CANCEL_REQUEST' : null,
    };
  });
}

function createCoupangSource(options = {}) {
  const client = options.client || createCoupangClient(options);
  const now = options.now || (() => new Date());
  const path = () => `/v2/providers/openapi/apis/api/v4/vendors/${client.vendorId}/ordersheets`;

  // 한 상태의 발주서를 기간 안에서 모두 (다음 페이지가 있으면 이어서)
  async function sheets(status, days) {
    const to = now();
    const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
    const out = [];
    let nextToken = '';
    for (let page = 0; page < 200; page++) {
      const body = await client.request('GET', path(), {
        query: { createdAtFrom: kstDate(from), createdAtTo: kstDate(to), status, maxPerPage: 50, nextToken },
      });
      out.push(...((body && body.data) || []));
      nextToken = body && body.nextToken;
      if (!nextToken) break;
    }
    return out;
  }

  return {
    channel: CHANNEL,
    label: '쿠팡',
    async fetchChanges() {
      const all = [];
      for (const status of OPEN_STATUSES) all.push(...await sheets(status, OPEN_DAYS));
      for (const status of DONE_STATUSES) all.push(...await sheets(status, DONE_DAYS));
      // 매번 최근 주문 전체를 다시 읽으므로, 상태가 그대로인 주문은 '바뀐 주문' 으로 세지 않는다 (refreshOnly)
      return all.flatMap(normalize).filter(o => o.channel_order_id && o.channel_item_id).map(o => ({ ...o, refreshOnly: true }));
    },
  };
}

module.exports = { createCoupangSource, normalize, STATUS_MAP, kstIso };
