// 채널 이름·표시와 주문 상태 코드를 한글로 보여주기 위한 표

// mark: 카드 앞에 붙는 한 글자 표시, cls: 색깔 (style.css 의 .ch-*)
const CHANNELS = {
  smartstore: { name: '스마트스토어', mark: 'N', cls: 'naver' },
  godo: { name: '자사몰', mark: 'B', cls: 'own' },
  coupang: { name: '쿠팡', mark: 'C', cls: 'coupang' },
  esm: { name: 'G마켓·옥션', mark: 'G', cls: 'esm' },
  manual: { name: '수기 주문', mark: '수', cls: 'manual' },
};

function channelInfo(key) {
  return CHANNELS[key] || { name: key || '기타', mark: '?', cls: 'etc' };
}

// 수기 주문 채널의 이름·한 글자 표시는 관리자가 바꿀 수 있다 (settings 의 manual_channel_name / manual_channel_mark)
// → 화면마다 이 함수를 써서 바뀐 이름으로 보여준다
function channelInfoWith(db) {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  return () => {
    const name = (get.get('manual_channel_name') || {}).value;
    const mark = (get.get('manual_channel_mark') || {}).value;
    if (!name && !mark) return channelInfo;
    const manual = { ...CHANNELS.manual, ...(name ? { name } : {}), ...(mark ? { mark } : {}) };
    return key => (key === 'manual' ? manual : channelInfo(key));
  };
}

const SMARTSTORE_STATUS = {
  PAYMENT_WAITING: '결제대기',
  PAYED: '결제완료',
  DELIVERING: '배송중',
  DELIVERED: '배송완료',
  PURCHASE_DECIDED: '구매확정',
  EXCHANGED: '교환',
  CANCELED: '취소',
  RETURNED: '반품',
  CANCELED_BY_NOPAYMENT: '미결제취소',
};

// 수기 주문(계좌이체 등)은 같은 상태 코드를 쓰되 이름만 다르게 보여준다
const MANUAL_STATUS = {
  PAYMENT_WAITING: '입금대기',
  PAYED: '입금완료',
  DELIVERED: '발송완료',
  CANCELED: '취소',
};

function channelStatusLabel(code, channel) {
  if (channel === 'manual' && MANUAL_STATUS[code]) return MANUAL_STATUS[code];
  return SMARTSTORE_STATUS[code] || code || '-';
}

// 고객의 취소·반품·교환 진행 상태 (네이버 claimStatus)
const CLAIM_STATUS = {
  CANCEL_REQUEST: '취소 요청',
  CANCELING: '취소 처리중',
  CANCEL_DONE: '취소 완료',
  CANCEL_REJECT: '취소 거부됨',
  ADMIN_CANCELING: '직권취소 처리중',
  ADMIN_CANCEL_DONE: '직권취소 완료',
  ADMIN_CANCEL_REJECT: '직권취소 거부됨',
  RETURN_REQUEST: '반품 요청',
  EXCHANGE_REQUEST: '교환 요청',
  COLLECTING: '수거중',
  COLLECT_DONE: '수거 완료',
  EXCHANGE_REDELIVERING: '교환 재배송중',
  RETURN_DONE: '반품 완료',
  EXCHANGE_DONE: '교환 완료',
  RETURN_REJECT: '반품 거부됨',
  EXCHANGE_REJECT: '교환 거부됨',
  PURCHASE_DECISION_HOLDBACK: '구매확정 보류',
  PURCHASE_DECISION_HOLDBACK_REDELIVERING: '구매확정 보류(재배송중)',
  PURCHASE_DECISION_REQUEST: '구매확정 요청',
  PURCHASE_DECISION_HOLDBACK_RELEASE: '구매확정 보류 해제',
};

function claimLabel(code) {
  return CLAIM_STATUS[code] || code || '';
}

// 카드에 빨간 표시를 할 상태인지: 아직 진행 중인 취소·반품·교환
// (거부됨·보류 해제·구매확정 요청은 정상 진행으로 보고, 완료는 회색으로 표시)
function claimLevel(code) {
  if (!code || /_REJECT$/.test(code) || code === 'PURCHASE_DECISION_HOLDBACK_RELEASE' || code === 'PURCHASE_DECISION_REQUEST') return null;
  if (/_DONE$/.test(code)) return 'done';
  return 'open';
}

// 손님이 보는 상품 페이지 주소 (주문의 product_no 로). 모르면 null
//   스마트스토어는 가게 주소가 필요하다 (관리자 › 주문 수집 에서 저장). 없으면 /main/ 으로 (네이버가 해당 가게로 넘겨 줌)
const GODO_SHOP_URL = 'https://broadstore.co.kr';
const SMARTSTORE_DEFAULT = 'https://smartstore.naver.com/main';
function productUrl(order, { smartstoreUrl } = {}) {
  const no = order && order.product_no ? encodeURIComponent(String(order.product_no)) : null;
  if (!no) return null;
  if (order.channel === 'smartstore') return `${(smartstoreUrl || SMARTSTORE_DEFAULT).replace(/\/$/, '')}/products/${no}`;
  if (order.channel === 'coupang') return `https://www.coupang.com/vp/products/${no}`;
  if (order.channel === 'godo') return `${GODO_SHOP_URL}/goods/goods_view.php?goodsNo=${no}`;
  return null;
}

// 관리자가 적은 스마트스토어 주소 → 'https://smartstore.naver.com/가게주소' (틀리면 null)
function normalizeSmartstoreUrl(text) {
  const m = String(text || '').trim().match(/^(?:https?:\/\/)?(?:m\.)?smartstore\.naver\.com\/([A-Za-z0-9_-]{2,50})\/?$/);
  return m ? `https://smartstore.naver.com/${m[1]}` : null;
}

module.exports = { CHANNELS, channelInfo, channelInfoWith, channelStatusLabel, claimLabel, claimLevel, productUrl, normalizeSmartstoreUrl };
