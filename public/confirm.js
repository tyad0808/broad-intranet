// data-confirm 이 붙은 폼(또는 누른 버튼)은 제출 전에 확인창을 띄운다
// (정지·거절, 발주확인·발송처리처럼 되돌리기 번거로운 버튼)
(() => {
  // 발송처리 확인창에 들어갈 배송 정보 요약: "로젠택배 123456789" / "퀵서비스"
  function shipSummary(form) {
    const method = form.querySelector('[data-ship-method]');
    if (!method) return '';
    if (method.value !== 'DELIVERY') return method.selectedOptions[0].text;
    const company = form.querySelector('select[name="company"]');
    const tracking = form.querySelector('input[name="tracking"]');
    return `${company ? company.selectedOptions[0].text : ''} ${tracking ? tracking.value.trim() : ''}`.trim();
  }

  // 두 번 눌러 같은 요청이 두 번 가지 않도록, 확인 후에는 버튼을 잠근다
  const sent = new WeakSet();

  // data-once: 한 번 제출하면 버튼을 잠근다 (form.elements 에는 form="..." 로 연결된 바깥 버튼도 들어 있다)
  function lock(form) {
    sent.add(form);
    setTimeout(() => [...form.elements].forEach(el => { if (el.tagName === 'BUTTON') el.disabled = true; }), 0);
  }

  document.addEventListener('submit', event => {
    const form = event.target;
    const button = event.submitter;
    if (sent.has(form)) {
      event.preventDefault();
      return;
    }
    const raw = (button && button.getAttribute('data-confirm')) || form.getAttribute('data-confirm');
    if (raw && !window.confirm(raw.replace('{ship}', shipSummary(form)))) {
      event.preventDefault();
      return;
    }
    if (form.hasAttribute('data-once')) lock(form);
  });

  // '뒤로 가기'로 돌아왔을 때 잠긴 버튼이 그대로 남지 않게 새로 불러온다
  window.addEventListener('pageshow', event => {
    if (event.persisted && document.querySelector('form[data-once]')) location.reload();
  });
})();
