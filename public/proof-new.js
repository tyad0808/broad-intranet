// 새 시안: 주문을 고르면 비어 있는 고객 이름·전화번호·시안 이름을 주문 정보로 채운다
(function () {
  var select = document.getElementById('order-select');
  if (!select) return;
  var fill = function (id, value) {
    var input = document.getElementById(id);
    if (input && !input.value && value) input.value = value;
  };
  var apply = function () {
    var opt = select.options[select.selectedIndex];
    if (!opt || !opt.value) return;
    fill('customer-name', opt.getAttribute('data-name'));
    fill('customer-phone', opt.getAttribute('data-phone'));
    fill('title', opt.getAttribute('data-title'));
  };
  select.addEventListener('change', apply);
  apply();
})();
