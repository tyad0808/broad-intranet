// 스마트스토어 주문 가져오기 (조회 전용)
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
    // 판매자센터에서 발주확인을 하면 placeOrderStatus 가 'OK' 가 된다 (조회로 알아내기만 함)
    channel_confirmed: po.placeOrderStatus === 'OK' ? 1 : 0,
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
    async fetchChanges({ from, to }) {
      const ids = await changedIds(from, to);
      if (ids.length === 0) return [];
      const items = await details(ids);
      return items.map(normalize).filter(o => o.channel_item_id);
    },
  };
}

module.exports = { createSmartstoreSource, normalize, toKstIso };
