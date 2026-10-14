// 주문 목록: 단계·정렬을 고르면 바로 검색 (버튼을 안 눌러도 됨)
document.querySelectorAll('form[data-autosubmit] select').forEach(select => {
  select.addEventListener('change', () => select.form.submit());
});
