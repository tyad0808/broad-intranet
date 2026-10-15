// 주문 목록: 주문을 누르면 목록 위에 팝업으로 연다 (바깥을 누르거나 ✕·Esc 로 닫기)
// 팝업 안은 주문 카드 화면 그대로(iframe)라서 저장·발주확인·발송처리 모두 그 안에서 된다.
(() => {
  let overlay = null;

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.body.classList.remove('modal-open');
    // 팝업에서 바꾼 내용이 목록에 바로 보이도록 새로 그린다
    if (typeof window.refreshOrderList === 'function') window.refreshOrderList();
  }

  // url 이 없으면 빈 팝업만 연다 (폼이 formtarget="order-modal-frame" 으로 이 안에 결과를 띄운다)
  function open(url) {
    close();
    overlay = document.createElement('div');
    overlay.className = 'order-modal';
    overlay.innerHTML = '<div class="order-modal-box" role="dialog" aria-modal="true">'
      + '<button type="button" class="order-modal-close" aria-label="닫기">✕</button>'
      + '<iframe title="주문 카드" name="order-modal-frame"></iframe></div>';
    const frame = overlay.querySelector('iframe');
    if (url) {
      const target = new URL(url, location.href);
      target.searchParams.set('embed', '1');
      frame.src = target.pathname + target.search;
    }
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('.order-modal-close')) close();
    });
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');
  }

  document.addEventListener('click', event => {
    const link = event.target.closest('a.oi-main');
    // Ctrl·Shift·가운데 버튼 클릭은 원래대로 (새 탭 등)
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(link.getAttribute('href'));
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && overlay) close();
  });

  // data-modal 버튼으로 보내는 폼(일괄 송장 입력 등)은 팝업 안에 연다
  document.addEventListener('submit', event => {
    const button = event.submitter;
    if (event.defaultPrevented || !button || !button.hasAttribute('data-modal')) return;
    open(null);
  });

  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.data && event.data.type === 'close-order') close();
  });
})();
