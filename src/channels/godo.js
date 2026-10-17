// 자사몰(broadstore.co.kr, 고도몰 기반) 주문 가져오기 — 조회 전용
//
// 자사몰 API(broad-quote 프로젝트의 mall-api)는 인트라넷과 같은 서버에서 돈다.
// 그래서 기본 주소는 서버 안쪽 http://127.0.0.1:3100/mall-api/v1 (바깥 인터넷을 거치지 않음)
// 인증: Authorization: Bearer <GODO_API_KEY> — 키는 .env 에만 둔다
//
// 수집: '상태가 바뀐 날짜(dateType=modified)' 기준으로 최근 주문을 읽는다 (날짜 단위라 매번 오늘 것을 다시 읽음 →
//       상태가 그대로인 주문은 '바뀐 주문' 으로 세지 않는다)
const CHANNEL = 'godo';
const DEFAULT_URL = 'http://127.0.0.1:3100/mall-api/v1';
const PAGE_SIZE = 100;

// 허용 주소: 주문 목록 조회 하나뿐 (상품·가격 API 와 상태 변경은 부르지 않는다)
const ALLOWED = [{ method: 'GET', pattern: /^\/orders$/ }];
const isAllowed = (method, path) => ALLOWED.some(a => a.method === method && a.pattern.test(path));

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
  return JSON.parse(text.replace(/"(orderNo|itemNo|goodsNo|parentGoodsNo)"\s*:\s*(\d+)/g, '"$1":"$2"'));
}

function createGodoClient({
  baseUrl = process.env.GODO_API_URL || DEFAULT_URL,
  apiKey = process.env.GODO_API_KEY,
  fetchFn = fetch,
} = {}) {
  async function request(method, path, { query = {} } = {}) {
    if (!isAllowed(method, path)) {
      const err = new Error(`허용되지 않은 자사몰 API 호출입니다: ${method} ${path}`);
      err.notSent = true;
      throw err;
    }
    if (!apiKey) {
      const err = new Error('GODO_API_KEY 가 .env 에 없습니다.');
      err.notSent = true;
      throw err;
    }
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}${path}${qs ? `?${qs}` : ''}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? parseJson(text) : null; } catch { body = null; }
    if (!res.ok) {
      const detail = body && (body.message || body.code) ? `: ${body.message || body.code}` : '';
      throw new GodoApiError(`자사몰 API 오류 (HTTP ${res.status})${detail}`, res.status, body);
    }
    return body;
  }
  return { request };
}

// 자사몰 주문상태 코드 → 인트라넷 공통 상태
//   p1 결제완료 → 신규주문, g1~g3 상품준비중·구매발주·상품입고 → 배송준비(발주확인), g4 상품출고·d1 배송중 → 배송중 …
// 취소·반품·교환·환불 '요청/진행' 은 빨간 표시(claim)로, '완료' 는 끝난 주문으로
function mapStatus(code, shipped) {
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
  if (/^c[1-3]$/.test(c) || c === 'r3') return plain('CANCELED', 1);
  if (c === 'c4' || c === 'r1' || c === 'r2') return claim('CANCEL', 'CANCEL_REQUEST');
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

const kstDate = date => new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 자사몰 주문 1건 → 인트라넷 주문(상품) 여러 건
function normalize(order) {
  const orderer = order.orderer || {};
  const receiver = order.receiver || {};
  const address = [receiver.zipcode ? `(${receiver.zipcode})` : null, receiver.address, receiver.addressDetail]
    .filter(Boolean).join(' ') || null;
  return (order.items || []).map(item => {
    const map = mapStatus(item.status || order.status, Boolean(item.shippedAt));
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
      return orders.flatMap(normalize)
        .filter(o => o.channel_order_id && o.channel_item_id)
        .map(o => ({ ...o, refreshOnly: true }));
    },
  };
}

module.exports = { formatOption, createGodoSource, createGodoClient, normalize, mapStatus, isAllowed, parseJson, GodoApiError };
