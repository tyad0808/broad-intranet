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
