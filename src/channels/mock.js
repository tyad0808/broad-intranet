// 가짜 주문 (개발용). .env 의 ORDER_SOURCE=mock 일 때 사용한다.
// 실제 네이버 API 는 등록된 서버 IP 에서만 응답하므로, 서버에 올리기 전까지는 이걸로 화면과 기능을 만든다.
// 진짜 스마트스토어처럼: 수집할 때마다 새 주문이 0~2건 들어오고, 일부는 판매자센터에서 발주확인되거나 가끔 취소 요청이 들어온다.

const PRODUCTS = [
  { name: '명함 (고급지 250g)', options: ['양면 / 200매', '단면 / 500매', '양면 / 1000매'] },
  { name: '현수막 주문제작', options: ['900x600 / 열재단', '3000x900 / 아일렛', '5000x900 / 각목'] },
  { name: 'X배너 거치대 세트', options: ['실내용', '실외용 (물통)'] },
  { name: '스티커 라벨 인쇄', options: ['원형 50mm / 1000매', '사각 90x50 / 500매'] },
  { name: '전단지 A4', options: ['아트지 150g / 2000매', '스노우지 120g / 4000매'] },
];
// 실제 스마트스토어처럼 본상품에 붙는 추가상품 (같은 주문번호, 별도 상품주문번호)
const ADDONS = [
  { name: '제공', option: '무료 양면테이프(미신청 시 미제공): 제공' },
  { name: '(무료)누끼+칼선작업', option: '디자인 작업 의뢰: (무료)누끼+칼선작업' },
  { name: '중급 디자인', option: '디자인 요청(출력파일이 없는 경우): 중급 디자인' },
];
const NAMES = ['김민준', '이서연', '박지호', '최수아', '정예준', '강하은', '조도윤', '윤지우'];
const ADDRESSES = [
  '(06236) 서울 강남구 테헤란로 123 4층',
  '(13529) 경기 성남시 분당구 판교역로 45 101호',
  '(48058) 부산 해운대구 센텀중앙로 78',
  '(35229) 대전 서구 둔산로 100 2층',
];

function createMockSource({ random = Math.random, now = () => new Date() } = {}) {
  const orders = []; // 이 가짜 "스마트스토어" 에 쌓인 주문
  let seq = 0;
  const pick = list => list[Math.floor(random() * list.length)];

  function newOrder() {
    seq += 1;
    const product = pick(PRODUCTS);
    const id = `${Date.now()}${String(seq).padStart(3, '0')}`;
    return {
      channel: 'smartstore',
      channel_order_id: `MOCK-O${id}`,
      channel_item_id: `MOCK-P${id}`,
      item_type: 'main',
      product_name: product.name,
      option_text: pick(product.options),
      quantity: 1 + Math.floor(random() * 3),
      buyer_name: pick(NAMES),
      receiver_name: pick(NAMES),
      receiver_phone: `010-${1000 + Math.floor(random() * 9000)}-${1000 + Math.floor(random() * 9000)}`,
      receiver_address: pick(ADDRESSES),
      paid_at: now().toISOString(),
      channel_status: 'PAYED',
      channel_confirmed: 0,
    };
  }

  return {
    channel: 'smartstore',
    label: '스마트스토어 (가짜 주문)',
    isMock: true,
    async fetchChanges() {
      const changed = [];
      // 처음 수집할 때는 3건으로 시작, 이후 0~2건씩 새 주문
      const count = orders.length === 0 ? 3 : Math.floor(random() * 3);
      for (let i = 0; i < count; i++) {
        const o = newOrder();
        orders.push(o);
        changed.push(o);
        // 절반쯤은 추가상품이 같이 들어온다
        if (random() < 0.5) {
          const addon = pick(ADDONS);
          const extra = {
            ...o,
            channel_item_id: `${o.channel_item_id}-A`,
            item_type: 'addon',
            product_name: addon.name,
            option_text: addon.option,
            quantity: 1,
          };
          orders.push(extra);
          changed.push(extra);
        }
      }
      // 아직 발주확인 안 된 기존 주문 중 일부를 "판매자센터에서 발주확인함" 으로 바꾼다
      // 가끔은 고객이 취소를 요청한 것처럼 바꾼다 (빨간 표시·알림 확인용)
      for (const o of orders) {
        if (changed.includes(o) || o.claim_status || o.item_type === 'addon') continue;
        const roll = random();
        if (!o.channel_confirmed && roll < 0.15) {
          o.channel_confirmed = 1;
          changed.push(o);
        } else if (roll > 0.97) {
          o.claim_type = 'CANCEL';
          o.claim_status = 'CANCEL_REQUEST';
          changed.push(o);
        }
      }
      return changed.map(o => ({ ...o }));
    },
  };
}

module.exports = { createMockSource };
