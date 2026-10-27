// 주문 상세의 '작업 파일 이름' 한 줄: 관리자가 정한 모양(예: {채널}_{날짜}_{구매자}({받는분}))에 주문 값을 넣어 만든다
//   값이 비면 빈 괄호 '()' 와 겹친 구분자 '__' 는 지운다 → 받는 분이 구매자와 같으면 괄호가 사라진다
//   파일 이름에 못 쓰는 글자(\ / : * ? " < > |)는 뺀다
const DEFAULT_PATTERN = '{채널}_{날짜}_{구매자}({받는분})';
const MAX_PATTERN = 100;

// [이름표, 설명(관리자 화면)]
const TOKENS = [
  ['채널', '스마트스토어 · 쿠팡 · 자사몰 (수기 주문은 출처 이름)'],
  ['날짜', '결제일 20261027'],
  ['날짜6', '결제일 261027'],
  ['날짜4', '결제일 1027'],
  ['구매자', '주문자 이름'],
  ['받는분', '받는 분 이름 (구매자와 같으면 비어요)'],
  ['담당자', '담당 디자이너 (없으면 비어요)'],
  ['주문번호', '채널 주문번호'],
  ['상품명', '첫 상품 이름 (앞 20자)'],
  ['수량', '상품 수량 합계'],
  ['전화뒷4', '받는 분 연락처 끝 4자리'],
];
const TOKEN_NAMES = new Set(TOKENS.map(([name]) => name));

const BAD = /[\\/:*?"<>|\r\n\t]+/g;
// 값 안의 '_' 도 빈칸으로 (구분자와 헷갈리지 않게)
const clean = v => String(v || '').replace(BAD, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

// 저장 전 검사: 틀리면 오류 문구, 맞으면 null
function checkPattern(pattern) {
  const p = String(pattern || '').trim();
  if (!p) return '파일 이름 모양을 적어 주세요.';
  if (p.length > MAX_PATTERN) return `파일 이름 모양은 ${MAX_PATTERN}자까지 적을 수 있어요.`;
  const used = [...p.matchAll(/\{([^{}]*)\}/g)].map(m => m[1]);
  if (!used.length) return '{채널}, {날짜} 같은 이름표를 하나 이상 넣어 주세요.';
  const unknown = used.filter(name => !TOKEN_NAMES.has(name));
  if (unknown.length) return `모르는 이름표가 있어요: ${unknown.map(n => `{${n}}`).join(', ')}`;
  return null;
}

// order: 주문(첫 상품 줄, assignee_name 포함), items: 같은 주문의 상품들, channelName: 화면에 쓰는 채널 이름, kst: 한국 시간 글자로
function fileLabel(pattern, { order, items = [order], channelName, sourceName = null, kst }) {
  const ymd = (kst(order.paid_at) || '').slice(0, 10).replace(/-/g, '');
  const buyer = clean(order.buyer_name || order.receiver_name) || '이름없음';
  const receiver = clean(order.receiver_name);
  const values = {
    채널: clean(order.channel === 'manual' && sourceName ? sourceName : channelName),
    날짜: ymd,
    날짜6: ymd.slice(2),
    날짜4: ymd.slice(4),
    구매자: buyer,
    받는분: receiver && receiver !== buyer ? receiver : '',
    담당자: clean(order.assignee_name),
    주문번호: clean(order.channel_order_id),
    상품명: clean(items[0] && items[0].product_name).slice(0, 20).trim(),
    수량: String(items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0) || ''),
    전화뒷4: String(order.receiver_phone || '').replace(/\D/g, '').slice(-4),
  };
  const pattern2 = checkPattern(pattern) ? DEFAULT_PATTERN : String(pattern).trim();
  return pattern2
    .replace(/\{([^{}]*)\}/g, (all, name) => (TOKEN_NAMES.has(name) ? values[name] : ''))
    .replace(BAD, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, '')          // 빈 괄호
    .replace(/([_\-.\s])[_\-.\s]*\1/g, '$1')  // 겹친 구분자 '__', '--', '  '
    .replace(/[_\-.\s]+([)\]])/g, '$1')       // 괄호 앞 구분자
    .replace(/^[_\-.\s]+|[_\-.\s]+$/g, '')    // 앞뒤 구분자
    .slice(0, 150);
}

module.exports = { fileLabel, checkPattern, DEFAULT_PATTERN, TOKENS, MAX_PATTERN };
