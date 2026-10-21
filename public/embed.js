// 주문 목록 위 팝업(iframe) 안에서 열린 화면: '닫기' 를 누르면 바깥 목록에 팝업을 닫으라고 알린다
document.addEventListener('click', event => {
  if (event.target.closest('[data-close-modal]')) {
    window.parent.postMessage({ type: 'close-order' }, location.origin);
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.parent.postMessage({ type: 'close-order' }, location.origin);
});
// 문의함 오른쪽 칸 안에서 열린 화면: 위쪽 여백을 줄이고 한 줄로 쌓는다
if (window.name === 'inbox-pane') document.body.classList.add('in-pane');
