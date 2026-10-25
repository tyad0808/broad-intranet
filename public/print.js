// 발주서: 열리면 바로 인쇄 창 (미리보기만 볼 때는 ?preview=1)
document.querySelector('[data-print]').addEventListener('click', () => window.print());
document.querySelector('[data-close]').addEventListener('click', () => window.close());
if (!new URLSearchParams(location.search).has('preview')) {
  window.addEventListener('load', () => setTimeout(() => window.print(), 300));
}
