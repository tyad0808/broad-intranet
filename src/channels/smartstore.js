// 스마트스토어 주문 가져오기(조회)와 발주확인·발송처리(createSmartstoreWriter)
//
// 흐름: ① "이 시간 동안 바뀐 주문" 목록을 받고 → ② 그 주문들의 상세 정보를 받아
//       → ③ 인트라넷 DB 에 넣기 좋은 모양(normalize)으로 바꿔 돌려준다.
const { createNaverClient } = require('./naverClient');

const CHANNEL = 'smartstore';
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // 네이버는 한 번에 최대 24시간 범위만 조회할 수 있다
const QUERY_BATCH = 300;                   // 상세 조회는 한 번에 최대 300건

// 네이버가 요구하는 시각 형식: 2026-10-14T10:00:00.000+09:00 (한국 시간)
function toKstIso(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace('Z', '+09:00');
}

function joinAddress(addr) {
  if (!addr) return null;
  const parts = [addr.zipCode ? `(${addr.zipCode})` : null, addr.baseAddress, addr.detailedAddress];
  return parts.filter(Boolean).join(' ') || null;
}

// 네이버 응답 1건 → 인트라넷 주문 1건
// 날짜 글자 → UTC ISO (DB 에서 글자끼리 비교할 수 있게 한 모양으로)
function utcIso(value) {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function normalize(item) {
  const order = item.order || {};
  const po = item.productOrder || {};
  const addr = po.shippingAddress || {};
  return {
    channel: CHANNEL,
    channel_order_id: String(order.orderId || po.orderId || ''),
    channel_item_id: String(po.productOrderId || ''),
    product_name: po.productName || '(상품명 없음)',
    // 스마트스토어는 추가상품을 별도 상품주문으로 보낸다 (productClass: '추가구성상품')
    item_type: String(po.productClass || '').includes('추가') ? 'addon' : 'main',
    option_text: po.productOption || null,
    quantity: Number(po.quantity) || 1,
    buyer_name: order.ordererName || null,
    receiver_name: addr.name || null,
    receiver_phone: addr.tel1 || addr.tel2 || null,
    receiver_address: joinAddress(addr),
    paid_at: order.paymentDate || null,
    channel_status: po.productOrderStatus || null,
    // 고객의 취소·반품·교환 요청 (예: claimType CANCEL, claimStatus CANCEL_REQUEST)
    claim_type: po.claimType || null,
    claim_status: po.claimStatus || null,
    // 판매자센터에서 발주확인을 하면 placeOrderStatus 가 'OK' 가 된다 (조회로 알아내기만 함)
    channel_confirmed: po.placeOrderStatus === 'OK' ? 1 : 0,
    // 오늘출발 상품이면 TODAY (옵션별 오늘출발은 OPTION_TODAY). 발송기한은 네이버가 상품별 마감 시간으로 계산해 준 값
    delivery_type: po.deliveryAttributeType || 'NORMAL',
    ship_due: utcIso(po.shippingDueDate),
  };
}

function createSmartstoreSource(options = {}) {
  const client = options.client || createNaverClient(options);

  // ① from~to 사이에 바뀐 상품주문번호 목록 (24시간씩 끊어서, 페이지가 넘어가면 이어서)
  async function changedIds(from, to) {
    const ids = new Set();
    for (let start = from.getTime(); start < to.getTime(); start += MAX_WINDOW_MS) {
      const end = new Date(Math.min(start + MAX_WINDOW_MS, to.getTime()));
      let query = { lastChangedFrom: toKstIso(new Date(start)), lastChangedTo: toKstIso(end) };
      // 결과가 많으면 네이버가 more 정보를 주고, 그걸로 다음 페이지를 요청한다
      for (let page = 0; page < 100; page++) {
        const body = await client.request('GET', '/v1/pay-order/seller/product-orders/last-changed-statuses', { query });
        const data = (body && body.data) || {};
        for (const s of data.lastChangeStatuses || []) {
          if (s.productOrderId) ids.add(String(s.productOrderId));
        }
        const more = data.more;
        if (!more || !more.moreFrom) break;
        query = { ...query, lastChangedFrom: more.moreFrom, moreSequence: more.moreSequence };
      }
    }
    return [...ids];
  }

  // ② 상세 정보 (300건씩)
  async function details(ids) {
    const items = [];
    for (let i = 0; i < ids.length; i += QUERY_BATCH) {
      const body = await client.request('POST', '/v1/pay-order/seller/product-orders/query', {
        json: { productOrderIds: ids.slice(i, i + QUERY_BATCH) },
      });
      items.push(...((body && body.data) || []));
    }
    return items;
  }

  return {
    channel: CHANNEL,
    label: '스마트스토어',
    fillsDeliveryType: true, // 주문에 오늘출발·발송기한이 들어 있다 (모르는 주문은 다시 읽어 채운다)
    async fetchChanges({ from, to }) {
      const ids = await changedIds(from, to);
      if (ids.length === 0) return [];
      const items = await details(ids);
      return items.map(normalize).filter(o => o.channel_item_id);
    },
    // 상품주문번호로 지금 상태를 다시 읽는다.
    // 판매자센터에서 누른 '발주확인' 은 바뀐 주문 목록(①)에 나오지 않아서, 발주확인 전 주문은 이걸로 따로 확인한다
    async fetchByIds(ids) {
      if (ids.length === 0) return [];
      const items = await details(ids);
      return items.map(normalize).filter(o => o.channel_item_id);
    },
  };
}

// 주문 상태를 바꾸는 쪽 (2차). allowWrite 를 켠 클라이언트로만 만든다.
// 서버에서는 .env 의 NAVER_WRITE=on 일 때만 이 함수를 부른다 (src/server.js).
function createSmartstoreWriter(options = {}) {
  const client = options.client || createNaverClient({ ...options, allowWrite: true });
  return {
    // 발주확인: { productOrderIds: [...] }
    confirm(productOrderIds) {
      return client.request('POST', '/v1/pay-order/seller/product-orders/confirm', { json: { productOrderIds } });
    },
    // 발송처리: [{ productOrderId, deliveryMethod, deliveryCompanyCode, trackingNumber, dispatchDate }]
    dispatch(dispatchProductOrders) {
      return client.request('POST', '/v1/pay-order/seller/product-orders/dispatch', { json: { dispatchProductOrders } });
    },
  };
}

module.exports = { createSmartstoreWriter, createSmartstoreSource, normalize, toKstIso };
