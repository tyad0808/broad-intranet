// G마켓·옥션(ESM) 주문 가져오기 (1단계: 조회) + 주문확인·발송처리 (2단계: ESM_WRITE=on 일 때만, 맨 아래 createEsmWriter)
//
// ESM 주문번호(OrderNo) 하나 = 상품 하나. 인트라넷에서는 주문번호 하나를 주문 카드 하나로 본다.
//   번호 앞에 사이트를 붙인다: G-2946269058 (G마켓) · A-1234567890 (옥션)
//   같은 장바구니(PayNo)로 산 주문들은 배송 묶음(ship_pkg)이 같아서 배송비는 한 번만 센다.
// ESM 주문조회에는 취소·반품·교환 주문이 나오지 않는다 → 클레임 조회(fetchClaims)로 따로 읽어 덮어 쓴다.
// 기간 조회는 5초에 1번이라 한 번 수집에 사이트마다 4번만 묻는다:
//   아직 안 나간 주문(신규·발송대기): 최근 28일 · 나간 주문(배송중·배송완료): 최근 7일
//   7일보다 오래된 '배송중' 주문은 collector 가 주문번호로 몇 건씩 다시 묻는다 (refreshOrders, 제한 없음)
// 켠 날부터 가져오기: startDate(YYYY-MM-DD, 한국 날짜) 전에 결제한 주문은 가져오지 않는다
//   (그 전 G마켓·옥션 주문은 수기 주문으로 넣어 왔으므로 겹치지 않게)
const { createEsmClient, SITES } = require('./esmClient');

const CHANNEL = 'esm';
const OPEN_DAYS = 28;
const DONE_DAYS = 7;
const WINDOW_DAYS = 30; // G마켓은 한 번에 31일까지만 → 긴 기간은 30일씩 나눠 묻는다 (평소 최근 28일~내일은 한 번에)
const MAX_BACK_DAYS = 90; // 처음 한 번 시작일부터 읽을 때도 최대 90일 전까지
const CLAIM_DAYS = 7; // 클레임 조회는 7일 단위
const CLAIM_EVERY_MS = 15 * 60 * 1000;
const PAGE_SIZE = 100; // 연결 확인(esm-check)에서 성공한 값 — 페이지를 넘겨 가며 끝까지 읽는다 // 클레임은 15분에 한 번만 (사이트마다 12번씩 묻는다)

// ESM 주문상태 → 인트라넷 공통 상태
//   1 신규주문 → 신규주문(발주확인 전) · 2 발송대기중(주문확인 완료) → 배송준비 · 3 배송중 · 4 배송완료 · 5 구매결정완료
const STATUS_MAP = {
  1: { status: 'PAYED', confirmed: 0, label: '신규주문' },
  2: { status: 'PAYED', confirmed: 1, label: '발송대기중' },
  3: { status: 'DELIVERING', confirmed: 1, label: '배송중' },
  4: { status: 'DELIVERED', confirmed: 1, label: '배송완료' },
  5: { status: 'PURCHASE_DECIDED', confirmed: 1, label: '구매결정완료' },
};

const money = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
// ESM 시각(한국 시간, 시간대 표시 없음: 2019-04-10T17:45:50.507) → 2019-04-10T17:45:50.507+09:00
function kstIso(value) {
  if (!value) return null;
  const text = String(value).trim().replace(' ', 'T');
  return /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}+09:00`;
}
const kstDate = date => new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const DAY = 24 * 3600 * 1000;

// 배송비 방식 → 인트라넷 배송 방법 (W 방문수령 · Q 퀵서비스 · 나머지는 택배)
const shipWayOf = cond => (cond === 'W' ? 'VISIT_RECEIPT' : cond === 'Q' ? 'QUICK_SVC' : 'DELIVERY');

// 인트라넷 번호 'G-2946269058' → { site: 'G', orderNo: '2946269058' }
function splitId(id) {
  const m = /^([GA])-(\d+)$/.exec(String(id || ''));
  return m ? { site: m[1], orderNo: m[2] } : null;
}

// ESM 주문 한 건 → 인트라넷 주문 한 줄
function normalize(o, site) {
  const map = STATUS_MAP[Number(o.OrderStatus)] || { status: null, confirmed: 0, label: null };
  const id = `${site}-${o.OrderNo}`;
  const options = (o.ItemOptionSelectList || []).map(x => `${x.ItemOptionValue}${Number(x.ItemOptionOrderCnt) > 1 ? ` ×${x.ItemOptionOrderCnt}` : ''}`);
  const extras = (o.ItemOptionAdditionList || []).map(x => `추가: ${x.ItemOptionValue}${Number(x.ItemOptionOrderCnt) > 1 ? ` ×${x.ItemOptionOrderCnt}` : ''}`);
  const address = o.DelFullAddress || [o.DelFrontAddress, o.DelBackAddress].filter(Boolean).join(' ');
  const fee = [o.ShippingFee, o.BackwoodsAddDeliveryFee, o.JejuAddDeliveryFee].map(money);
  // 상품 판매 금액(배송비 빼고): 판매금액 + 옵션·추가구성 금액 − 판매자 할인
  const goods = money(o.OrderAmount);
  return {
    channel: CHANNEL,
    channel_order_id: id,
    channel_item_id: id,
    product_name: o.GoodsName || '(상품명 없음)',
    item_type: 'main',
    option_text: [...options, ...extras].join(' / ') || null,
    quantity: Number(o.ContrAmount) || 1,
    buyer_name: o.BuyerName || null,
    buyer_phone: o.BuyerMobileTel || o.BuyerTel || null,
    receiver_name: o.ReceiverName || null,
    receiver_phone: o.HpNo || o.TelNo || null,
    receiver_address: address ? `${o.ZipCode ? `(${o.ZipCode}) ` : ''}${address}` : null,
    paid_at: kstIso(o.PayDate || o.OrderDate),
    channel_status: map.status,
    channel_confirmed: map.confirmed,
    channel_status_label: map.label ? `${SITES[site].name} ${map.label}` : null,
    claim_type: null,
    claim_status: null,
    pay_amount: goods === null ? null : goods + (money(o.OptSelPrice) || 0) + (money(o.OptAddPrice) || 0) - (money(o.SellerDiscountPrice) || 0),
    ship_memo: String(o.DelMemo || '').trim().slice(0, 500) || null,
    ship_due: kstIso(o.TransDueDate),
    delivery_method: shipWayOf(o.DeliveryFeeCondition),
    ship_fee: fee.every(f => f === null) ? null : fee.reduce((t, f) => t + (f || 0), 0),
    ship_pkg: o.PayNo ? `${site}-${o.PayNo}` : id,
    // 상품 페이지 링크용 (G마켓·옥션 상품번호)
    product_no: o.SiteGoodsNo ? String(o.SiteGoodsNo) : null,
  };
}

// 같은 장바구니의 배송비: G마켓은 장바구니 안 한 주문에만 배송비가 오고, 옥션은 모든 주문에 같은 값이 온다
//   → 묶음마다 가장 큰 값으로 맞춘다 (인트라넷은 묶음마다 한 번만 더한다)
function evenShipFee(rows) {
  const max = new Map();
  for (const r of rows) if (r.ship_fee != null) max.set(r.ship_pkg, Math.max(max.get(r.ship_pkg) || 0, r.ship_fee));
  return rows.map(r => (max.has(r.ship_pkg) ? { ...r, ship_fee: max.get(r.ship_pkg) } : r));
}

// ── 취소·반품·교환 ── 상태 → 인트라넷 요청 상태 (스마트스토어와 같은 이름: 화면·알림이 그대로 동작)
//   철회(고객이 취소)는 요청 표시를 지운다
const CLAIMS = {
  cancel: {
    path: '/claim/v1/sa/Cancels', statusKey: 'CancelStatus', type: 'CANCEL',
    // 0 전체를 신청일·완료일 기준으로 한 번씩
    queries: [{ CancelStatus: 0, Type: 2 }, { CancelStatus: 0, Type: 3 }],
    map: { 1: 'CANCEL_REQUEST', 2: 'CANCELING', 3: 'DONE', 4: 'WITHDRAW', 5: 'DONE', 6: 'DONE' },
  },
  return: {
    path: '/claim/v1/sa/Returns', statusKey: 'ReturnStatus', type: 'RETURN',
    queries: [1, 2, 3].map(s => ({ ReturnStatus: s, Type: 2 })).concat([4, 5, 6].map(s => ({ ReturnStatus: s, Type: 3 }))),
    map: { 1: 'RETURN_REQUEST', 2: 'COLLECT_DONE', 3: 'COLLECT_DONE', 4: 'DONE', 5: 'WITHDRAW', 6: 'DONE' },
  },
  exchange: {
    path: '/claim/v1/sa/Exchanges', statusKey: 'ExchangeStatus', type: 'EXCHANGE',
    queries: [1, 2, 3].map(s => ({ ExchangeStatus: s, Type: 2 })).concat([4, 5].map(s => ({ ExchangeStatus: s, Type: 3 }))),
    map: { 1: 'EXCHANGE_REQUEST', 2: 'COLLECT_DONE', 3: 'EXCHANGE_REQUEST', 4: 'EXCHANGE_DONE', 5: 'WITHDRAW' },
  },
};

// 클레임 한 건 → 주문에 덮어 쓸 값 { channel_order_id, vendorItemId, claim_type, claim_status, channel_status? }
function claimPatch(kind, row, site) {
  const c = CLAIMS[kind];
  const state = c.map[Number(row[c.statusKey])];
  if (!state || !row.OrderNo) return null;
  const id = `${site}-${row.OrderNo}`;
  const base = { channel_order_id: id, vendorItemId: String(row.OrderNo), shipmentBoxId: site };
  if (state === 'WITHDRAW') return { ...base, claim_type: null, claim_status: null };
  if (state === 'DONE') {
    const canceled = kind === 'cancel';
    return { ...base, claim_type: c.type, claim_status: `${c.type}_DONE`, channel_status: canceled ? 'CANCELED' : 'RETURNED',
      channel_status_label: `${SITES[site].name}에서 ${canceled ? '취소됨' : '반품됨'}` };
  }
  return { ...base, claim_type: c.type, claim_status: state };
}

function createEsmSource(options = {}) {
  const client = options.client || createEsmClient(options);
  const now = options.now || (() => new Date());
  const startDate = options.startDate || null; // 이 날(포함)부터 결제한 주문만
  let lastClaimsAt = 0;
  // 서버가 켜진 뒤 첫 수집은 시작일부터 오늘까지 모든 상태를 읽는다 (시작일을 앞당겼을 때 그 사이 주문도 들어오게)
  let backfilled = false;

  const list = body => {
    const data = body && (body.Data || body.data);
    if (Array.isArray(data)) return data;
    return (data && (data.RequestOrders || data.requestOrders)) || [];
  };

  // 읽을 기간의 시작 날짜: 최근 days 일, 단 시작일보다 앞으로는 가지 않는다
  const fromDate = days => {
    const recent = kstDate(new Date(now().getTime() - days * DAY));
    return startDate && startDate > recent ? startDate : recent;
  };
  // 첫 수집: 시작일부터 (최대 90일 전까지)
  const backfillFrom = () => {
    const limit = kstDate(new Date(now().getTime() - MAX_BACK_DAYS * DAY));
    const from = startDate || kstDate(new Date(now().getTime() - OPEN_DAYS * DAY));
    return from < limit ? limit : from;
  };

  // 한 사이트·한 상태의 주문을 결제일 기준으로 from(포함)~오늘 (30일씩 나눠서, 페이지 끝까지)
  async function orders(site, orderStatus, from) {
    // 오늘까지 보려면 끝 날짜를 내일로 (ESM 안내)
    const end = kstDate(new Date(now().getTime() + DAY));
    const out = [];
    for (let a = from; a < end;) {
      const b = kstDate(new Date(Math.min(Date.parse(`${a}T00:00:00Z`) + WINDOW_DAYS * DAY, Date.parse(`${end}T00:00:00Z`))));
      for (let page = 1; page <= 20; page++) {
        const body = await client.request('POST', '/shipping/v1/Order/RequestOrders', {
          siteType: SITES[site].code, orderStatus, requestDateType: 2,
          requestDateFrom: a, requestDateTo: b,
          pageIndex: page, pageSize: PAGE_SIZE,
        });
        const rows = list(body);
        out.push(...rows);
        const total = Number(((body && (body.Data || body.data)) || {}).TotalCount) || 0;
        if (!rows.length || rows.length < PAGE_SIZE || out.length >= total) break;
      }
      a = b;
    }
    // 나눈 기간의 경계 날짜에 걸친 주문이 두 번 나올 수 있다 → 주문번호로 하나만
    const seen = new Set();
    return out.filter(o => !seen.has(String(o.OrderNo)) && seen.add(String(o.OrderNo))).map(o => normalize(o, site));
  }

  const afterStart = o => !startDate || !o.paid_at || kstDate(new Date(Date.parse(o.paid_at))) >= startDate;

  return {
    channel: CHANNEL,
    label: 'G마켓·옥션',
    async fetchChanges() {
      const all = [];
      for (const { key, name } of client.sites) {
        // 어느 사이트·상태에서 실패했는지 알 수 있게 (관리자 › 판매처 연결 · 대시보드에 그대로 보인다)
        // 구매결정완료(5)는 서버를 켠 뒤 첫 수집에서만 (지난 주문은 대부분 이미 구매결정이라 이걸 안 읽으면 지난달 매출이 빠진다)
        //   평소에는 결제완료~배송완료(1~4)만 5분마다 — 그 사이에 이미 다 한 번씩 보므로
        const statuses = [[1, OPEN_DAYS], [2, OPEN_DAYS], [3, DONE_DAYS], [4, DONE_DAYS], ...(backfilled ? [] : [[5, DONE_DAYS]])];
        for (const [status, days] of statuses) {
          try {
            all.push(...await orders(key, status, backfilled ? fromDate(days) : backfillFrom()));
          } catch (e) {
            throw Object.assign(new Error(`${name} ${STATUS_MAP[status].label} 주문조회: ${e.message}`), { status: e.status });
          }
        }
      }
      backfilled = true; // 다음부터는 최근 기간만
      // 매번 최근 주문 전체를 다시 읽으므로, 상태가 그대로인 주문은 '바뀐 주문' 으로 세지 않는다 (refreshOnly)
      return evenShipFee(all.filter(afterStart)).map(o => ({ ...o, refreshOnly: true }));
    },
    // 7일이 지나 목록으로 다시 읽지 않는 '배송중' 주문: 주문번호로 하나씩 지금 상태를 물어본다
    //   클레임 주문은 주문조회에 안 나온다 → 건너뜀 (클레임 조회가 맡는다)
    async refreshOrders(orderIds) {
      const out = [];
      for (const id of orderIds) {
        const p = splitId(id);
        if (!p) continue;
        try {
          const body = await client.request('POST', '/shipping/v1/Order/RequestOrders', { siteType: SITES[p.site].code, orderStatus: 0, orderNo: Number(p.orderNo) });
          out.push(...list(body).map(o => normalize(o, p.site)));
        } catch {
          // 다음 차례에 다시
        }
      }
      return out;
    },
    // 최근 7일의 취소·반품·교환 (15분에 한 번) → 주문별 요청 상태
    async fetchClaims() {
      const t = now();
      if (t.getTime() - lastClaimsAt < CLAIM_EVERY_MS) return [];
      const range = { StartDate: kstDate(new Date(t.getTime() - (CLAIM_DAYS - 1) * DAY)), EndDate: kstDate(t) };
      const out = [];
      for (const { key } of client.sites) {
        for (const [kind, c] of Object.entries(CLAIMS)) {
          for (const q of c.queries) {
            const body = await client.request('POST', c.path, { SiteType: SITES[key].code, ...q, ...range });
            out.push(...list(body).map(r => claimPatch(kind, r, key)).filter(Boolean));
          }
        }
      }
      lastClaimsAt = t.getTime();
      // 같은 주문이 여러 번 나오면 뒤(완료·철회 조회)가 이긴다
      return out;
    },
  };
}

// 고객이 보는 상품 페이지 주소 (labels.js productUrl 에서 쓴다)
function esmProductUrl(itemId, productNo) {
  const p = splitId(itemId);
  if (!p || !/^[A-Za-z0-9]+$/.test(String(productNo || ''))) return null;
  return p.site === 'G'
    ? `https://item.gmarket.co.kr/Item?goodscode=${productNo}`
    : `https://itempage3.auction.co.kr/DetailView.aspx?itemno=${productNo}`;
}

// ── 주문확인·발송처리 (2단계, 서버 .env 의 ESM_WRITE=on 일 때만 만든다 — src/server.js) ──
// 인트라넷 택배사 → ESM 택배사 코드 (ESM '택배사 리스트 조회': 10003 로젠택배 · 10016 경동택배)
const ESM_COURIERS = { KGB: 10003, KDEXP: 10016 };
// 발송일시: 한국 시각 'YYYY-MM-DDThh:mm:ss' (ESM 은 호출 시점 2일 안의 시각만 받는다)
const kstStamp = date => new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19);

// 주문(=상품) 하나씩 보내고, 결과를 다른 채널과 같은 모양으로 모은다 (actions.js 의 parseResult)
//   ESM 이 거절(4xx·코드 3000 등)하면 그 주문만 실패, 응답이 끊기면(5xx·시간 초과) 결과를 알 수 없음 → 그대로 던진다
function createEsmWriter(options = {}) {
  const client = options.client || createEsmClient({ ...options, allowWrite: true });
  const now = options.now || (() => new Date());
  async function each(ids, call) {
    const success = [];
    const fail = [];
    for (const id of ids) {
      const p = splitId(id);
      if (!p) { fail.push({ productOrderId: id, message: '주문번호 모양이 다릅니다' }); continue; }
      try {
        await call(p, id);
        success.push(id);
      } catch (e) {
        if (e.notSent || (e.status && e.status < 500) || (e.body && e.body.ResultCode !== undefined)) {
          fail.push({ productOrderId: id, message: String(e.message || '실패').replace(/^G마켓·옥션 API 오류 \([^)]*\):\s*/, '') });
        } else {
          throw e;
        }
      }
    }
    return { data: { successProductOrderIds: success, failProductOrderInfos: fail } };
  }
  return {
    // 주문확인: 결제완료 → 배송준비중
    confirm(itemIds) {
      return each(itemIds, p => client.request('POST', `/shipping/v1/Order/OrderCheck/${p.orderNo}`, {}, { site: p.site }));
    },
    // 발송처리: 택배사 코드 + 송장번호 (ESM 은 택배로만)
    dispatch(list) {
      const byId = new Map(list.map(l => [l.productOrderId, l]));
      return each(list.map(l => l.productOrderId), (p, id) => {
        const l = byId.get(id);
        const code = ESM_COURIERS[l.deliveryCompanyCode];
        if (l.deliveryMethod !== 'DELIVERY' || !code || !l.trackingNumber) {
          throw Object.assign(new Error('G마켓·옥션은 택배(로젠·경동)와 송장번호로만 발송처리할 수 있어요.'), { notSent: true });
        }
        return client.request('POST', '/shipping/v1/Delivery/ShippingInfo', {
          OrderNo: Number(p.orderNo), ShippingDate: kstStamp(now()), DeliveryCompanyCode: code, InvoiceNo: String(l.trackingNumber),
        }, { site: p.site });
      });
    },
  };
}

module.exports = { createEsmSource, createEsmWriter, ESM_COURIERS, normalize, claimPatch, evenShipFee, splitId, esmProductUrl, STATUS_MAP, CLAIMS };
