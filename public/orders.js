// 주문 목록: 단계·정렬·담당자를 고르면 바로 저장/검색 (버튼을 안 눌러도 됨)
// 목록이 실시간으로 새로 그려져도 동작하도록 문서 전체에서 한 번만 감지한다
document.addEventListener('change', event => {
  const select = event.target;
  if (select.matches('form[data-autosubmit] select')) select.form.submit();
  // 기간: 시작일·종료일이 둘 다 제대로 들어가면 바로 조회 (연도를 치는 중에는 기다린다)
  if (select.matches('input[data-period]')) {
    const dates = [...select.form.querySelectorAll('input[data-period]')].map(i => i.value);
    if (dates.every(v => /^(19|20)\d\d-\d\d-\d\d$/.test(v))) select.form.submit();
  }
});

// 발송처리: 배송 한 칸(로젠·경동·퀵·직접전달)에서 고른 값을 숨은 method·company 칸에 나눠 넣고, 택배일 때만 송장번호 칸을 보여준다
function syncShipPick(select) {
  const box = select.closest('.ship-row, form');
  if (!box) return;
  const [method, company] = select.value.split(':');
  const m = box.querySelector('[data-ship-m]');
  const c = box.querySelector('[data-ship-c]');
  if (m) m.value = method;
  if (c) c.value = company || '';
  const fields = box.querySelector('[data-ship-fields]');
  if (!fields) return;
  const show = method === 'DELIVERY';
  fields.hidden = !show;
  fields.querySelectorAll('input, select').forEach(el => { el.disabled = !show; });
}
document.querySelectorAll('[data-ship-pick]').forEach(syncShipPick);
document.addEventListener('change', event => {
  if (event.target.matches('[data-ship-pick]')) syncShipPick(event.target);
});

// 주문 목록 일괄 처리: 체크한 주문 수를 아래 막대에 보여주고, 전체 선택
function syncBulkBar() {
  const bar = document.getElementById('bulk-bar');
  if (!bar) return;
  const checked = [...document.querySelectorAll('input[name="ids"][form="bulk-form"]:checked')];
  bar.hidden = checked.length === 0;
  bar.querySelector('[data-bulk-count]').textContent = checked.length;
  // 버튼마다 실제로 처리할 수 있는 주문 수 (발주확인 전 / 발송 가능)
  for (const button of bar.querySelectorAll('[data-bulk-kind]')) {
    const kind = button.dataset.bulkKind;
    const n = kind === 'any' ? checked.length : checked.filter(box => (box.dataset.can || '').split(' ').includes(kind)).length;
    button.querySelector('[data-n]').textContent = n;
    button.disabled = n === 0;
  }
}
document.addEventListener('change', event => {
  if (event.target.matches('[data-check-all]')) {
    document.querySelectorAll('input[name="ids"][form="bulk-form"]').forEach(box => { box.checked = event.target.checked; });
  }
  if (event.target.matches('input[name="ids"], [data-check-all]')) syncBulkBar();
});
document.addEventListener('click', event => {
  // 체크한 주문의 발주서를 새 창에서 (한 장에 주문 하나)
  const print = event.target.closest('[data-print-selected]');
  if (print) {
    const ids = [...document.querySelectorAll('input[name="ids"][form="bulk-form"]:checked')].map(box => box.value);
    if (ids.length) window.open(`/orders/print?ids=${ids.join(',')}`, '_blank', 'noopener');
    return;
  }
  if (event.target.matches('[data-bulk-clear]')) {
    document.querySelectorAll('input[name="ids"][form="bulk-form"], [data-check-all]').forEach(box => { box.checked = false; });
    syncBulkBar();
  }
});
syncBulkBar();

// [📋 복사]: data-copy 의 글자를 클립보드로 (작업 파일 이름 등). 잠깐 '복사됨 ✓' 으로 바뀐다
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const text = button.dataset.copy;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // 클립보드를 못 쓰는 환경: 잠깐 글상자를 만들어 복사
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    box.remove();
  }
  const before = button.dataset.label || button.textContent;
  button.dataset.label = before;
  button.textContent = ok ? '복사됨 ✓' : '복사 실패';
  button.classList.toggle('copied', ok);
  setTimeout(() => { button.textContent = before; button.classList.remove('copied'); }, 1500);
});
