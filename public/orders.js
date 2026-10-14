// 주문 목록: 단계·정렬·담당자를 고르면 바로 저장/검색 (버튼을 안 눌러도 됨)
// 목록이 실시간으로 새로 그려져도 동작하도록 문서 전체에서 한 번만 감지한다
document.addEventListener('change', event => {
  const select = event.target;
  if (select.matches('form[data-autosubmit] select')) select.form.submit();
});
