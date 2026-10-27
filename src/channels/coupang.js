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
const money = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

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
  // 고객이 남긴 배송 메시지 (쿠팡 이름: parcelPrintMessage)
  const shipMemo = String(sheet.parcelPrintMessage || '').trim().slice(0, 500) || null;
  const address = [receiver.postCode ? `(${receiver.postCode})` : null, receiver.addr1, receiver.addr2].filter(Boolean).join(' ') || null;
  return (sheet.orderItems || []).map(item => {
    // 취소가 끝나면 쿠팡이 출고 수량(shippingCount)을 0 으로 준다 (WING 주문상세의 '수량 0') → 취소된 상품
    const shipping = Number(item.shippingCount);
    const zeroLeft = item.shippingCount !== undefined && item.shippingCount !== null && shipping === 0;
    const quantity = shipping || Number(item.cancelCount) || 1;
    // 고객이 취소를 요청해 출고를 멈춘 수량이 있으면 취소 요청으로 표시
    const holdCancel = Number(item.holdCountForCancel) > 0;
    const allCanceled = zeroLeft || (Number(item.cancelCount) >= quantity && Number(item.cancelCount) > 0);
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
      // 결제 금액 (orderPrice = 판매가 × 수량, 쿠팡이 준 값). 없으면 판매가 × 수량
      pay_amount: money(item.orderPrice) ?? (money(item.salesPrice) !== null ? money(item.salesPrice) * quantity : null),
      ship_memo: shipMemo,
      // 쿠팡 상품 번호 (상품 페이지 링크: coupang.com/vp/products/번호)
      product_no: item.productId ? String(item.productId) : null,
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
    // 인트라넷에선 진행 중인데 이번 목록 어디에도 없는 주문 (collector 가 부른다)
    //   쿠팡 발주서 목록에는 '취소' 상태가 없어서, 취소된 주문은 목록에서 그냥 사라진다.
    //   단, 7일보다 오래된 주문은 배송중·배송완료로 넘어갔을 수도 있어 그 상태들을 30일치로 한 번 더 본다.
    //   그래도 없으면 취소된 것으로 본다. 30일보다 오래된 주문은 알 수 없어 그대로 둔다.
    async verifyOpen(rows) {
      const since = now().getTime() - (OPEN_DAYS - 1) * 24 * 3600 * 1000;
      const recent = rows.filter(r => r.paid_at && Date.parse(r.paid_at) >= since);
      if (!recent.length) return [];
      const found = new Map();
      try {
        for (const status of DONE_STATUSES) {
          for (const o of (await sheets(status, OPEN_DAYS)).flatMap(normalize)) found.set(o.channel_item_id, o);
        }
      } catch {
        return []; // 잠깐 연결이 안 되는 등: 다음 수집 때 다시 확인 (모르는데 취소로 바꾸지 않는다)
      }
      return recent.map(r => found.get(r.channel_item_id) || {
        channel: CHANNEL, channel_order_id: r.channel_order_id, channel_item_id: r.channel_item_id,
        product_name: r.product_name, item_type: r.item_type, option_text: r.option_text, quantity: r.quantity,
        buyer_name: r.buyer_name, receiver_name: r.receiver_name, receiver_phone: r.receiver_phone,
        receiver_address: r.receiver_address, paid_at: r.paid_at,
        channel_status: 'CANCELED', channel_confirmed: r.channel_confirmed,
        claim_type: null, claim_status: null, channel_status_label: '쿠팡에서 취소됨',
      });
    },
  };
}

// ───────── 주문 상태 바꾸기 (3차 2단계) ─────────
// 인트라넷의 상품 번호(channel_item_id) = '배송번호-옵션번호' (shipmentBoxId-vendorItemId)
const splitItemId = id => {
  const [shipmentBoxId, vendorItemId] = String(id).split('-');
  return { shipmentBoxId, vendorItemId };
};

// 쿠팡 응답(data.responseList: 배송번호별 성공 여부)을 네이버와 같은 모양으로 바꾼다
//   → actions.js 가 채널 상관없이 '성공한 상품만 반영' 할 수 있게.  모양이 다르면 그대로 돌려줘서 '확인 필요' 가 된다
function toCommonResult(body, itemIds) {
  const list = body && body.data && Array.isArray(body.data.responseList) ? body.data.responseList : null;
  if (!list) return body;
  const okBoxes = new Set(list.filter(r => r.succeed === true).map(r => String(r.shipmentBoxId)));
  const failed = list.filter(r => r.succeed !== true);
  return {
    data: {
      successProductOrderIds: itemIds.filter(id => okBoxes.has(splitItemId(id).shipmentBoxId)),
      failProductOrderInfos: failed.map(r => ({
        productOrderId: String(r.shipmentBoxId),
        message: r.resultMessage || r.resultCode || '실패',
      })),
    },
  };
}

// 서버에서는 .env 의 COUPANG_WRITE=on 일 때만 만든다 (src/server.js)
function createCoupangWriter(options = {}) {
  const client = options.client || createCoupangClient({ ...options, allowWrite: true });
  const base = () => `/v2/providers/openapi/apis/api/v4/vendors/${client.vendorId}`;
  return {
    // 상품준비중 처리: 배송번호 목록
    async confirm(itemIds) {
      const shipmentBoxIds = [...new Set(itemIds.map(id => splitItemId(id).shipmentBoxId))];
      const body = await client.request('PUT', `${base()}/ordersheets/acknowledgement`, {
        json: { vendorId: client.vendorId, shipmentBoxIds },
      });
      return toCommonResult(body, itemIds);
    },
    // 송장 업로드: 상품(옵션)마다 배송번호·주문번호·택배사·송장번호
    async dispatch(list, targets) {
      const orderIdOf = new Map(targets.map(t => [t.channel_item_id, t.channel_order_id]));
      const dtos = list.map(l => {
        const { shipmentBoxId, vendorItemId } = splitItemId(l.productOrderId);
        return {
          shipmentBoxId,
          orderId: orderIdOf.get(l.productOrderId),
          vendorItemId,
          deliveryCompanyCode: l.deliveryCompanyCode,
          invoiceNumber: l.trackingNumber,
          splitShipping: false,
          preSplitShipped: false,
          estimatedShippingDate: '',
        };
      });
      const body = await client.request('POST', `${base()}/orders/invoices`, {
        json: { vendorId: client.vendorId, orderSheetInvoiceApplyDtos: dtos },
      });
      return toCommonResult(body, list.map(l => l.productOrderId));
    },
  };
}

module.exports = { createCoupangWriter, toCommonResult, splitItemId, createCoupangSource, normalize, STATUS_MAP, kstIso };
