// data-confirm 이 붙은 폼은 제출 전에 확인창을 띄운다 (정지·거절처럼 되돌리기 번거로운 버튼)
document.addEventListener('submit', event => {
  const form = event.target;
  const message = form.getAttribute('data-confirm');
  if (message && !window.confirm(message)) {
    event.preventDefault();
  }
});
