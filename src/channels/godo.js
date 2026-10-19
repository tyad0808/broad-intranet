// 자사몰(broadstore.co.kr) 주문 가져오기 + 발주확인·송장 등록
// ※ 자사몰은 고도몰 구조를 바탕으로 직접 만든 쇼핑몰이다 (고도몰 서비스가 아님). 처리 기준은 '자사몰 관리자'.
//
// 자사몰 API(broad-quote 프로젝트의 mall-api)는 인트라넷과 같은 서버에서 돈다.
// 그래서 기본 주소는 서버 안쪽 http://127.0.0.1:3100/mall-api/v1 (바깥 인터넷을 거치지 않음)
// 인증: Authorization: Bearer <키> — 키는 .env 에만 둔다
//   조회: GODO_API_KEY (orders 권한), 처리: GODO_WRITE_KEY (orders:write 권한, 따로 발급한 키)
//   4-4 문의: 조회는 GODO_API_KEY 에 inquiries 권한, 답변은 GODO_WRITE_KEY 에 inquiries:write 권한을 더한다
// 처리(발주확인·송장 등록)는 자사몰 관리자와 같은 처리 코드로 실행된다 → 고객에게 알림톡·SMS 가 실제로 나간다.
//
// 수집: '상태가 바뀐 날짜(dateType=modified)' 기준으로 최근 주문을 읽는다 (날짜 단위라 매번 오늘 것을 다시 읽음 →
//       상태가 그대로인 주문은 '바뀐 주문' 으로 세지 않는다)
const { courierLabel } = require('./shipping');

const CHANNEL = 'godo';
const DEFAULT_URL = 'http://127.0.0.1:3100/mall-api/v1';
const PAGE_SIZE = 100;

// 허용 주소: 주문 조회 2개 + 처리 2개(write) + 택배사 목록 + 문의 조회·답변 (상품·가격 API 는 부르지 않는다)
// write: true 는 allowWrite 를 켠 클라이언트만 (flag 에 적힌 .env 스위치가 on 일 때만, 기본은 연습 모드)
const ALLOWED = [
  { method: 'GET', pattern: /^\/orders$/ },
  { method: 'GET', pattern: /^\/orders\/[0-9A-Za-z_-]+$/ },
  { method: 'GET', pattern: /^\/couriers$/, writeKey: true },
  { method: 'POST', pattern: /^\/orders\/\d+\/confirm$/, write: true, writeKey: true },
  { method: 'POST', pattern: /^\/orders\/\d+\/invoice$/, write: true, writeKey: true },
  { method: 'GET', pattern: /^\/inquiries$/ },
  { method: 'POST', pattern: /^\/inquiries\/(inquiry|goodsqa|qa)\/\d+\/answer$/, write: true, writeKey: true, flag: 'GODO_ANSWER' },
];
const findAllowed = (method, path) => ALLOWED.find(a => a.method === method && a.pattern.test(path));
const isAllowed = (method, path) => Boolean(findAllowed(method, path));

class GodoApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GodoApiError';
    this.status = status;
    this.body = body;
  }
}

// 긴 번호(주문번호 등)가 숫자로 오면 끝자리가 틀어질 수 있어 글자로 읽는다
function parseJson(text) {
  return JSON.parse(text.replace(/"(orderNo|itemNo|goodsNo|parentGoodsNo|inquiryNo)"\s*:\s*(\d+)/g, '"$1":"$2"'));
}

function createGodoClient({
  baseUrl = process.env.GODO_API_URL || DEFAULT_URL,
  apiKey = process.env.GODO_API_KEY,
  writeKey = process.env.GODO_WRITE_KEY,
  fetchFn = fetch,
  allowWrite = false,
} = {}) {
  const notSent = message => Object.assign(new Error(message), { notSent: true });

  async function request(method, path, { query = {}, json } = {}) {
    const rule = findAllowed(method, path);
    if (!rule) throw notSent(`허용되지 않은 자사몰 API 호출입니다: ${method} ${path}`);
    if (rule.write && !allowWrite) {
      throw notSent(rule.flag
        ? `자사몰 문의 답변이 꺼져 있습니다 (${rule.flag}=on 이 아님): ${method} ${path}`
        : `자사몰 주문 처리가 꺼져 있습니다 (GODO_WRITE=on 이 아님): ${method} ${path}`);
    }
    const key = rule.writeKey ? writeKey : apiKey;
    if (!key) throw notSent(`${rule.writeKey ? 'GODO_WRITE_KEY' : 'GODO_API_KEY'} 가 .env 에 없습니다.`);
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}${path}${qs ? `?${qs}` : ''}`, {
      method,
      // 처리는 자사몰 서버까지 다녀오므로 넉넉히 (자사몰 API 쪽 대기 60초보다 길게)
      signal: AbortSignal.timeout(rule.write ? 90_000 : 30_000),
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        ...(json ? { 'content-type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? parseJson(text) : null; } catch { body = null; }
    if (!res.ok) {
      const detail = body && (body.message || body.code) ? `: ${body.message || body.code}` : '';
      const err = new GodoApiError(`자사몰 API 오류 (HTTP ${res.status})${detail}`, res.status, body);
      // 처리 설정이 없어 자사몰로 넘어가지도 않은 경우 → 확실히 아무것도 바뀌지 않음
      if (body && body.code === 'NOT_CONFIGURED') err.notSent = true;
      throw err;
    }
    return body;
  }
  return { request };
}

// 자사몰 주문상태 코드 → 인트라넷 공통 상태
//   p1 결제완료 → 신규주문, g1~g3 상품준비중·구매발주·상품입고 → 배송준비(발주확인), g4 상품출고·d1 배송중 → 배송중 …
// 취소·반품·교환·환불 '요청/진행' 은 빨간 표시(claim)로, '완료' 는 끝난 주문으로
// stale: 상태가 마지막으로 바뀐 지 오래됐는지 (고객취소요청이 처리 안 된 채 남아 있는 경우)
function mapStatus(code, shipped, { stale = false } = {}) {
  const base = shipped ? 'DELIVERED' : 'PAYED';
  const c = String(code || '').toLowerCase();
  const plain = (status, confirmed) => ({ status, confirmed, claimType: null, claimStatus: null });
  const claim = (claimType, claimStatus, status = base) => ({ status, confirmed: 1, claimType, claimStatus });
  if (c === 'o1' || /^f[1-4]$/.test(c)) return plain('PAYMENT_WAITING', 0); // 입금대기·결제 미완료 → 카드로 만들지 않음
  if (c === 'p1') return plain('PAYED', 0);
  if (/^g[1-3]$/.test(c)) return plain('PAYED', 1);
  if (c === 'g4' || c === 'd1') return plain('DELIVERING', 1);
  if (c === 'd2') return plain('DELIVERED', 1);
  if (c === 's1') return plain('PURCHASE_DECIDED', 1);
  // 환불접수·환불보류는 취소를 받아준 뒤 환불만 남은 상태 → 끝난 주문(취소)으로 본다
  if (/^c[1-3]$/.test(c) || /^r[1-3]$/.test(c)) return plain('CANCELED', 1);
  // 고객취소요청: 최근 요청만 '취소 요청' 으로 알리고, 오래 묵은 것은 이미 처리된 것으로 보고 취소로
  if (c === 'c4') return stale ? plain('CANCELED', 1) : claim('CANCEL', 'CANCEL_REQUEST');
  if (c === 'b1' || c === 'b3') return claim('RETURN', 'RETURN_REQUEST');
  if (c === 'b2') return claim('RETURN', 'COLLECTING');
  if (c === 'b4') return claim('RETURN', 'RETURN_DONE', 'RETURNED');
  if (c === 'e1' || c === 'e4') return claim('EXCHANGE', 'EXCHANGE_REQUEST');
  if (c === 'e2') return claim('EXCHANGE', 'COLLECTING');
  if (c === 'e3') return claim('EXCHANGE', 'EXCHANGE_REDELIVERING');
  if (c === 'e5') return claim('EXCHANGE', 'EXCHANGE_DONE', 'EXCHANGED');
  return plain(code || null, 0);
}

// 고도몰은 옵션을 [["옵션명","선택값","코드","",옵션가,null], …] 같은 내부 형식으로 준다
// → "옵션명: 선택값 / …" 로 풀어서 보여준다. 모양이 다르면 따옴표·괄호만 걷어낸다
function formatOption(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (!raw.startsWith('[')) return raw;
  try {
    const parsed = JSON.parse(raw.replace(/\\"/g, '"'));
    const rows = Array.isArray(parsed[0]) ? parsed : [parsed];
    const parts = rows.map(r => {
      const name = String(r[0] ?? '').trim();
      const value = String(r[1] ?? '').trim();
      if (name && value) return `${name}: ${value}`;
      return name || value;
    }).filter(Boolean);
    return parts.join(' / ') || null;
  } catch {
    return raw.replace(/\\?"/g, '').replace(/[[\]]/g, '').replace(/,(null|\d+)/g, '').replace(/,+/g, ', ').trim() || null;
  }
}

// 'YYYY-MM-DD HH:mm:ss'(한국 시간) → 2026-10-17T10:00:00+09:00
function kstIso(value) {
  if (!value) return null;
  const text = String(value).trim().replace(' ', 'T');
  return /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}+09:00`;
}

// 고객취소요청을 '처리 안 된 요청' 으로 볼 기간
const CANCEL_REQUEST_FRESH_DAYS = 14;

const kstDate = date => new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 자사몰 주문 1건 → 인트라넷 주문(상품) 여러 건
function normalize(order, now = new Date()) {
  const changed = Date.parse(kstIso(order.modifiedAt || order.paidAt || order.orderedAt) || '');
  const stale = Number.isFinite(changed) && now.getTime() - changed > CANCEL_REQUEST_FRESH_DAYS * 24 * 3600 * 1000;
  const orderer = order.orderer || {};
  const receiver = order.receiver || {};
  const address = [receiver.zipcode ? `(${receiver.zipcode})` : null, receiver.address, receiver.addressDetail]
    .filter(Boolean).join(' ') || null;
  return (order.items || []).map(item => {
    const map = mapStatus(item.status || order.status, Boolean(item.shippedAt), { stale });
    const size = item.sizeW && item.sizeH ? `${item.sizeW}x${item.sizeH}mm` : null;
    const option = [formatOption(item.option), formatOption(item.textOption), size].filter(Boolean).join(' / ') || null;
    return {
      channel: CHANNEL,
      channel_order_id: String(order.orderNo || ''),
      channel_item_id: `${order.orderNo}-${item.itemNo}`,
      product_name: item.name || '(상품명 없음)',
      item_type: item.type === 'addGoods' ? 'addon' : 'main',
      option_text: option,
      quantity: Number(item.quantity) || 1,
      buyer_name: orderer.name || null,
      receiver_name: receiver.name || null,
      receiver_phone: receiver.cellPhone || receiver.phone || null,
      receiver_address: address,
      paid_at: kstIso(item.paidAt || order.paidAt || order.orderedAt),
      channel_status: map.status,
      channel_confirmed: map.confirmed,
      claim_type: map.claimType,
      claim_status: map.claimStatus,
      // 자사몰이 쓰는 상태 이름 그대로 (예: '고객취소요청', '상품준비중')
      channel_status_label: item.statusName || order.statusName || null,
    };
  });
}

function createGodoSource(options = {}) {
  const client = options.client || createGodoClient(options);
  const now = options.now || (() => new Date());

  return {
    channel: CHANNEL,
    label: '자사몰',
    async fetchChanges({ from, to }) {
      const end = to || now();
      // 날짜 단위 API 라 하루 여유를 두고, 최대 92일까지만
      const start = new Date(Math.max((from || end).getTime() - 24 * 3600 * 1000, end.getTime() - 91 * 24 * 3600 * 1000));
      const orders = [];
      for (let page = 1; page <= 200; page++) {
        const body = await client.request('GET', '/orders', {
          query: { from: kstDate(start), to: kstDate(end), dateType: 'modified', page, size: PAGE_SIZE },
        });
        const items = (body && body.items) || [];
        orders.push(...items);
        if (items.length < PAGE_SIZE || page * PAGE_SIZE >= Number(body.total || 0)) break;
      }
      return orders.flatMap(o => normalize(o, end))
        .filter(o => o.channel_order_id && o.channel_item_id)
        .map(o => ({ ...o, refreshOnly: true }));
    },
    // 인트라넷에선 아직 진행 중인데 이번 목록에 안 나온 주문을 한 건씩 확인한다.
    // 자사몰 관리자에서 삭제된 주문은 '없는 주문(404)' 이 되므로 → '자사몰에서 삭제됨' 으로 끝난 주문 처리
    async verifyOpen(rows) {
      const byOrder = new Map();
      for (const r of rows) {
        if (!byOrder.has(r.channel_order_id)) byOrder.set(r.channel_order_id, []);
        byOrder.get(r.channel_order_id).push(r);
      }
      const out = [];
      for (const [orderNo, items] of byOrder) {
        try {
          const body = await client.request('GET', `/orders/${encodeURIComponent(orderNo)}`);
          const order = body && (body.item || body.order || body);
          if (order && order.items) out.push(...normalize(order, now()));
        } catch (e) {
          if (e.status !== 404) continue; // 잠깐 연결이 안 되는 등: 다음 수집 때 다시 확인
          out.push(...items.map(r => ({
            channel: CHANNEL, channel_order_id: r.channel_order_id, channel_item_id: r.channel_item_id,
            product_name: r.product_name, item_type: r.item_type, option_text: r.option_text, quantity: r.quantity,
            buyer_name: r.buyer_name, receiver_name: r.receiver_name, receiver_phone: r.receiver_phone,
            receiver_address: r.receiver_address, paid_at: r.paid_at,
            channel_status: 'CANCELED', channel_confirmed: r.channel_confirmed,
            claim_type: null, claim_status: null, channel_status_label: '자사몰에서 삭제됨',
          })));
        }
      }
      return out;
    },
  };
}

// ───────── 발주확인·송장 등록 ─────────
// 인트라넷의 상품 번호(channel_item_id) = '주문번호-주문상품번호' (orderNo-itemNo)
const splitItemId = id => {
  const [orderNo, itemNo] = String(id).split('-');
  return { orderNo, itemNo };
};

// 자사몰 응답 { results: [{ itemNo, ok, message }] } 을 네이버와 같은 모양으로 바꾼다
//   → actions.js 가 채널 상관없이 '성공한 상품만 반영' 할 수 있게. 모양이 다르면 null (= '확인 필요')
function toCommonResult(responses) {
  const success = [];
  const fail = [];
  for (const { itemIds, body } of responses) {
    if (!body || !Array.isArray(body.results)) return null;
    const byItem = new Map(body.results.map(r => [String(r.itemNo), r]));
    for (const id of itemIds) {
      const r = byItem.get(splitItemId(id).itemNo);
      if (r && r.ok === true) success.push(id);
      else if (r) fail.push({ productOrderId: id, message: r.message || '실패' });
    }
  }
  return { data: { successProductOrderIds: success, failProductOrderInfos: fail } };
}

// 서버에서는 .env 의 GODO_WRITE=on 이고 GODO_WRITE_KEY 가 있을 때만 만든다 (src/server.js)
function createGodoWriter(options = {}) {
  const client = options.client || createGodoClient({ ...options, allowWrite: true });
  // 주문번호별로 나눠 보낸다 (보통 한 번에 한 주문)
  async function perOrder(itemIds, makeBody, action) {
    const groups = new Map();
    for (const id of itemIds) {
      const { orderNo } = splitItemId(id);
      if (!groups.has(orderNo)) groups.set(orderNo, []);
      groups.get(orderNo).push(id);
    }
    const responses = [];
    for (const [orderNo, ids] of groups) {
      const body = await client.request('POST', `/orders/${orderNo}/${action}`, {
        json: { itemNos: ids.map(id => splitItemId(id).itemNo), ...makeBody(ids) },
      });
      responses.push({ orderNo, itemIds: ids, body });
    }
    return toCommonResult(responses) || responses.map(r => r.body);
  }
  return {
    // 발주확인: 결제완료 → 상품준비중
    confirm(itemIds) {
      return perOrder(itemIds, () => ({}), 'confirm');
    },
    // 송장 등록: 택배면 택배사 이름·송장번호, 퀵·직접전달이면 method 만
    dispatch(list) {
      const first = list[0] || {};
      const shipping = first.deliveryMethod === 'DELIVERY'
        ? { courier: courierLabel(first.deliveryCompanyCode), invoiceNo: first.trackingNumber }
        : { method: first.deliveryMethod === 'QUICK_SVC' ? 'quick' : 'direct' };
      return perOrder(list.map(l => l.productOrderId), () => shipping, 'invoice');
    },
  };
}

module.exports = {
  formatOption, createGodoSource, createGodoClient, createGodoWriter, toCommonResult, splitItemId,
  normalize, mapStatus, isAllowed, parseJson, GodoApiError,
};
