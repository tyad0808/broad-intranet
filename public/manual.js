// 수기 주문 화면: '상품 추가' 를 누르면 상품 입력 줄을 하나 더 만든다
(() => {
  const rows = document.getElementById('item-rows');
  const template = document.getElementById('item-row-template');
  const button = document.getElementById('add-item');
  if (!rows || !template || !button) return;
  button.addEventListener('click', () => {
    if (rows.children.length >= 20) return;
    rows.appendChild(template.content.cloneNode(true));
    rows.lastElementChild.querySelector('input[name="item_name"]').focus();
  });
})();

// 배송지 주소 검색 (카카오 우편번호 서비스, 무료·키 없음). 화면 안에 검색 창을 펼친다
(() => {
  const button = document.querySelector('[data-addr-search]');
  const layer = document.querySelector('[data-addr-layer]');
  const box = document.querySelector('[data-addr-box]');
  const input = document.getElementById('receiver_address');
  const detail = document.getElementById('receiver_address_detail');
  if (!button || !layer || !box || !input) return;
  // 기본주소는 있는데 상세주소가 비어 있으면 저장 전에 한 번 물어본다 (단독주택처럼 없을 수도 있어서 막지는 않는다)
  const form = input.form;
  if (form && detail) {
    form.addEventListener('submit', event => {
      if (input.value.trim() && !detail.value.trim() && !form.dataset.noDetailOk) {
        if (!window.confirm('상세주소(동·호수)를 안 적었어요. 이대로 저장할까요?')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          detail.focus();
          return;
        }
        form.dataset.noDetailOk = '1';
      }
    }, true);
  }
  const close = () => { layer.hidden = true; box.innerHTML = ''; };
  document.querySelector('[data-addr-close]').addEventListener('click', close);
  button.addEventListener('click', () => {
    if (!window.daum || !window.daum.Postcode) {
      alert('주소 검색을 불러오지 못했어요. 주소를 직접 적어 주세요.');
      return;
    }
    layer.hidden = false;
    box.innerHTML = '';
    new window.daum.Postcode({
      width: '100%',
      height: '100%',
      oncomplete(data) {
        // 도로명 주소 우선, 아파트·건물 이름이 있으면 괄호로
        const addr = data.roadAddress || data.jibunAddress || data.address;
        const building = data.buildingName && data.apartment === 'Y' ? ` (${data.buildingName})` : '';
        input.value = `(${data.zonecode}) ${addr}${building}`;
        close();
        if (detail) detail.focus();
      },
    }).embed(box);
  });
})();
