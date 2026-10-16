// 주문 처리: 발주확인, 발송처리 (2차 스마트스토어, 3차 쿠팡)
//
// 흐름: ① 주문 묶음(본상품 + 추가상품)에서 처리할 수 있는 상품만 고른다
//       ② 네이버로 보낸다 (연습 모드면 보내지 않는다)
//       ③ 네이버가 "성공" 이라고 답한 상품만 인트라넷에도 반영한다
//       ④ 누가·언제·무엇을 했는지 order_actions 표에 남긴다
//
// 연습 모드: 채널마다 따로. .env 의 NAVER_WRITE=on / COUPANG_WRITE=on 이 아니면 그 채널의 writer 가 없고,
//           바깥으로 아무것도 보내지 않는다.
const { transaction } = require('./db');
const { getSetting, lastStageId } = require('./collector');
const { claimLevel } = require('./channels/labels');
const { SHIP_METHODS, COURIERS, shipMethodLabel, courierLabel } = require('./channels/shipping');
const { toKstIso } = require('./channels/smartstore');

const ITEM_ORDER = "CASE WHEN item_type = 'addon' THEN 1 ELSE 0 END, id";

// 처리 버튼이 있는 채널
const WRITE_CHANNELS = ['smartstore', 'coupang'];
// 안내 문구용 (받침에 따라 '로/으로', '가/이')
const CHANNEL_NAMES = {
  smartstore: { name: '네이버', ro: '네이버로', ga: '네이버가' },
  coupang: { name: '쿠팡', ro: '쿠팡으로', ga: '쿠팡이' },
};

// 진행 중인 취소·반품·교환이 있으면 처리하지 않는다 (먼저 판매자센터에서 클레임을 처리해야 함)
const hasOpenClaim = item => claimLevel(item.claim_status) === 'open';

// 발주확인할 수 있는 상품: 결제완료 + 아직 발주확인 전
function canConfirm(item) {
  return WRITE_CHANNELS.includes(item.channel) && item.channel_status === 'PAYED' && !item.channel_confirmed && !hasOpenClaim(item);
}

// 발송처리할 수 있는 상품: 결제완료 + 발주확인 됨 (발주확인 전에는 발송처리 버튼을 막는다)
function canDispatch(item) {
  return WRITE_CHANNELS.includes(item.channel) && item.channel_status === 'PAYED' && Boolean(item.channel_confirmed) && !hasOpenClaim(item);
}

// 화면에서 받은 배송 정보 검사
function checkDispatchInput({ method, company, tracking } = {}) {
  method = String(method || '');
  if (!SHIP_METHODS[method]) return { error: '배송 방법을 골라 주세요.' };
  if (method !== 'DELIVERY') return { method, company: null, tracking: null };
  company = String(company || '');
  if (!COURIERS[company]) return { error: '택배사를 골라 주세요.' };
  tracking = String(tracking || '').replace(/[\s-]/g, '');
  if (!/^[0-9A-Za-z]{6,30}$/.test(tracking)) return { error: '송장번호를 확인해 주세요 (숫자 6자리 이상).' };
  return { method, company, tracking };
}

function describeShipping({ method, company, tracking }) {
  return method === 'DELIVERY' ? `${courierLabel(company)} ${tracking}` : shipMethodLabel(method);
}

// 네이버 응답에서 성공·실패 상품주문번호를 꺼낸다. 모양이 예상과 다르면 null (= 결과를 알 수 없음)
// 성공 목록은 API 에 따라 이름이 다르다:
//   발주확인 → successProductOrderInfos: [{ productOrderId, isReceiverAddressChanged }]
//   발송처리 → successProductOrderIds: ['...']
function parseResult(body, ids) {
  const data = body && body.data;
  if (!data) return null;
  const okIds = Array.isArray(data.successProductOrderIds) ? data.successProductOrderIds : null;
  const okInfos = Array.isArray(data.successProductOrderInfos) ? data.successProductOrderInfos : null;
  const fails = Array.isArray(data.failProductOrderInfos) ? data.failProductOrderInfos : null;
  if (!okIds && !okInfos && !fails) return null;
  const success = [
    ...(okIds || []).map(String),
    ...(okInfos || []).map(i => String((i && i.productOrderId) || '')),
  ].filter(id => ids.includes(id));
  const fail = (fails || []).map(f => ({
    id: String(f.productOrderId || ''),
    message: f.message || f.code || '실패',
  }));
  // 성공도 실패도 없다고 답하면 무슨 일이 있었는지 알 수 없다
  if (success.length === 0 && fail.length === 0) return null;
  return { success, fail };
}

// "확인 필요" 기록에 남길 네이버 응답 앞부분 (원인 확인용, 비밀값은 들어 있지 않음)
function snippet(body) {
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return String(body).slice(0, 300);
  }
}

// writer: 스마트스토어 (예전 호출 방식), writers: { coupang: … } 채널별
function createOrderActions({ db, writer = null, writers = {}, now = () => new Date() }) {
  const allWriters = { smartstore: writer, ...writers };
  const modeOf = channel => (allWriters[channel] ? 'live' : 'practice');
  const mode = modeOf('smartstore');
  const modes = Object.fromEntries(WRITE_CHANNELS.map(ch => [ch, modeOf(ch)]));
  const busy = new Set(); // 같은 주문을 두 번 연달아 누르는 것 방지

  const findOrder = id => db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
  const groupItems = order => db.prepare(
    `SELECT * FROM orders WHERE channel = ? AND channel_order_id = ? ORDER BY ${ITEM_ORDER}`
  ).all(order.channel, order.channel_order_id);
  const log = db.prepare(`
    INSERT INTO order_actions (user_id, action, channel, channel_order_id, item_ids, detail, mode, result, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bumpGroup = db.prepare(
    "UPDATE orders SET version = version + 1, updated_at = datetime('now') WHERE channel = ? AND channel_order_id = ?"
  );

  // 발주확인·발송처리 공통 순서
  async function run({ action, orderId, userId, eligible, send, apply, detail = null, emptyMessage }) {
    const order = findOrder(orderId);
    if (!order) return { result: 'skip', message: '주문을 찾을 수 없습니다.' };
    const items = groupItems(order);
    const name = items[0].product_name;
    const out = extra => ({ name, orderId: items[0].id, itemIds: items.map(i => i.id), ...extra });
    if (!WRITE_CHANNELS.includes(order.channel)) {
      return out({ result: 'skip', message: `'${name}': 이 채널은 아직 인트라넷에서 처리할 수 없습니다.` });
    }
    const w = allWriters[order.channel];
    const chMode = modeOf(order.channel);
    const ch = CHANNEL_NAMES[order.channel];
    const targets = items.filter(eligible);
    if (targets.length === 0) return out({ result: 'skip', message: `'${name}': ${emptyMessage}` });

    const key = `${order.channel}:${order.channel_order_id}`;
    if (busy.has(key)) return out({ result: 'skip', message: `'${name}': 이미 처리 중입니다. 잠시 후 새로고침해 보세요.` });
    busy.add(key);

    const ids = targets.map(i => i.channel_item_id);
    const record = (result, message) => {
      log.run(userId, action, order.channel, order.channel_order_id, JSON.stringify(ids),
        detail ? JSON.stringify(detail) : null, chMode, result, message);
      return out({ result, message: `'${name}': ${message}` });
    };

    try {
      if (!w) {
        return record('practice', `연습 모드라 ${ch.ro} 보내지 않았습니다 (대상 상품 ${ids.length}개).`);
      }

      let body;
      try {
        body = await send(targets, w);
      } catch (e) {
        // 네이버가 거절했거나(4xx) 보내기 전에 막힘 → 아무것도 바뀌지 않았다
        if (e.notSent || (e.status && e.status < 500)) return record('fail', `실패했습니다 — ${e.message}`);
        // 응답이 끊기거나 네이버 서버 오류 → 실제로 처리됐는지 알 수 없다
        return record('unknown', `${ch.name} 응답을 받지 못했습니다. 판매자센터에서 처리됐는지 꼭 확인하세요. (${e.message})`);
      }

      const parsed = parseResult(body, ids);
      if (!parsed) {
        return record('unknown', `${ch.name} 응답을 이해하지 못했습니다. 판매자센터에서 처리됐는지 꼭 확인하세요. 응답: ${snippet(body)}`);
      }
      if (parsed.success.length > 0) {
        transaction(db, () => {
          apply(parsed.success, order, items);
          bumpGroup.run(order.channel, order.channel_order_id);
        });
      }
      const failText = parsed.fail.map(f => f.message).filter(Boolean).slice(0, 2).join(' / ');
      if (parsed.success.length === ids.length) return record('ok', '완료했습니다.');
      if (parsed.success.length > 0) {
        return record('partial', `${ids.length}개 중 ${parsed.success.length}개만 완료했습니다. ${failText}`.trim());
      }
      return record('fail', `실패했습니다 — ${failText || `${ch.ga} 처리하지 않았습니다.`}`);
    } finally {
      busy.delete(key);
    }
  }

  // 발주확인
  function confirm(orderId, userId) {
    return run({
      action: 'confirm',
      orderId,
      userId,
      eligible: canConfirm,
      emptyMessage: '발주확인할 상품이 없습니다 (이미 발주확인됐거나, 결제완료가 아니거나, 취소·반품 요청 중).',
      send: (targets, w) => w.confirm(targets.map(t => t.channel_item_id), targets),
      apply(successIds, order) {
        const marks = successIds.map(() => '?').join(',');
        db.prepare(
          `UPDATE orders SET channel_confirmed = 1 WHERE channel = ? AND channel_item_id IN (${marks})`
        ).run(order.channel, ...successIds);
        // 카드가 아직 '발주' 단계면 '발주확인' 단계로 (직원이 이미 다음 단계로 옮겼으면 그대로)
        const stageNew = Number(getSetting(db, 'stage_new')) || null;
        const stageConfirmed = Number(getSetting(db, 'stage_confirmed')) || null;
        if (stageNew && stageConfirmed) {
          db.prepare(
            'UPDATE orders SET stage_id = ? WHERE channel = ? AND channel_order_id = ? AND stage_id = ?'
          ).run(stageConfirmed, order.channel, order.channel_order_id, stageNew);
        }
      },
    });
  }

  // 발송처리 (shipping: { method, company, tracking } — checkDispatchInput 을 통과한 값)
  function dispatch(orderId, userId, shipping) {
    const dispatchDate = toKstIso(now());
    // 쿠팡은 택배(송장번호)로만 발송처리할 수 있다
    const target = findOrder(orderId);
    if (target && target.channel === 'coupang' && shipping.method !== 'DELIVERY') {
      return Promise.resolve({
        result: 'skip', orderId: target.id, itemIds: [],
        message: `'${target.product_name}': 쿠팡 주문은 택배(택배사·송장번호)로만 발송처리할 수 있습니다.`,
      });
    }
    return run({
      action: 'dispatch',
      orderId,
      userId,
      detail: shipping,
      eligible: canDispatch,
      emptyMessage: '발송처리할 상품이 없습니다 (발주확인 전이거나, 이미 발송됐거나, 취소·반품 요청 중).',
      send: (targets, w) => w.dispatch(targets.map(t => ({
        productOrderId: t.channel_item_id,
        deliveryMethod: shipping.method,
        ...(shipping.method === 'DELIVERY'
          ? { deliveryCompanyCode: shipping.company, trackingNumber: shipping.tracking }
          : {}),
        dispatchDate,
      })), targets),
      apply(successIds, order) {
        const marks = successIds.map(() => '?').join(',');
        db.prepare(`
          UPDATE orders SET ship_method = ?, ship_company = ?, tracking_no = ?, shipped_at = datetime('now'),
            channel_status = 'DELIVERING'
          WHERE channel = ? AND channel_item_id IN (${marks})
        `).run(shipping.method, shipping.company, shipping.tracking, order.channel, ...successIds);
        // 묶음 안에 보낼 상품이 더 남지 않았으면 카드를 마지막 단계(발송)로
        const left = groupItems(order).filter(i => i.channel_status === 'PAYED' && !hasOpenClaim(i));
        const last = lastStageId(db);
        if (left.length === 0 && last) {
          db.prepare('UPDATE orders SET stage_id = ? WHERE channel = ? AND channel_order_id = ?')
            .run(last, order.channel, order.channel_order_id);
        }
      },
    });
  }

  return { mode, modes, modeOf, confirm, dispatch };
}

module.exports = {
  WRITE_CHANNELS,
  createOrderActions, canConfirm, canDispatch, checkDispatchInput, describeShipping, parseResult, hasOpenClaim,
};
