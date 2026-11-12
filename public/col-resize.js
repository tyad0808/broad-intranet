// 주문 목록 한 줄 보기: 표 머리 세로선을 잡고 끌어서 칸 너비 바꾸기 (사용자 요청 2026-11)
//   - 끈 칸은 px 로 고정, 상품명 칸은 남는 너비를 다 쓴다
//   - 세로선 왼쪽 칸 너비가 바뀐다. 왼쪽이 상품명 칸이면 오른쪽 칸이 바뀐다 (상품명은 남는 너비라서)
//   - 주문 칸 안의 '이름 | 상품명' 선은 이름 칸 너비 (buyer)
//   - 손을 떼면 내 계정에 저장 (/me/order-widths). 선을 두 번 누르면 그 칸만 처음 너비, '칸 너비 처음대로' 는 모두
(() => {
  const head = document.querySelector('.order-head[data-col-widths]');
  if (!head || !document.body.classList.contains('orders-line')) return;

  let widths = {};
  let defaults = {};
  try { widths = JSON.parse(head.dataset.colWidths || '{}'); } catch { widths = {}; }
  try { defaults = JSON.parse(head.dataset.colDefaults || '{}'); } catch { defaults = {}; }
  const LIMITS = { buyer: [70, 320], memo: [60, 420], status: [70, 320], ship: [70, 260], due: [60, 220], design: [90, 260], assign: [60, 200] };
  const BUYER = 132;
  const MIN_PRODUCT = 140;
  const resetBtn = document.querySelector('[data-col-reset]');
  const cols = () => [...head.querySelectorAll(':scope > [data-col]')];
  const shown = el => el.offsetParent !== null && getComputedStyle(el).display !== 'none';

  // 지금 너비로 표 모양(grid) 다시 만들기 — 머리와 주문 줄이 같은 변수를 쓴다
  function apply() {
    const keys = cols().map(el => el.dataset.col);
    const line = list => `24px ${list.map(k => (widths[k] ? `${widths[k]}px` : defaults[k] || 'auto')).join(' ')}`;
    const root = document.documentElement.style;
    root.setProperty('--oll-wide', line(keys));
    root.setProperty('--olln-wide', line(keys.filter(k => k !== 'memo')));
    root.setProperty('--oll-buyer', `${widths.buyer || BUYER}px`);
    if (resetBtn) resetBtn.hidden = !Object.keys(widths).length;
  }

  let saving = null;
  function save() {
    clearTimeout(saving);
    saving = setTimeout(() => {
      fetch('/me/order-widths', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': head.dataset.csrf },
        body: new URLSearchParams({ widths: JSON.stringify(widths) }),
        credentials: 'same-origin',
      }).catch(() => {});
    }, 200);
  }

  const clamp = (key, n) => Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], Math.round(n)));

  // 이 세로선이 바꾸는 칸: { key, el(너비를 잴 머리 칸), sign(오른쪽으로 끌면 +1 커짐, -1 작아짐) }
  function targetOf(grip) {
    const span = grip.parentElement;
    if (span.classList.contains('head-product')) return { key: 'buyer', el: span.previousElementSibling, sign: 1 };
    const list = cols().filter(shown);
    const i = list.indexOf(span);
    if (i <= 0) return null;
    const left = list[i - 1];
    if (left.dataset.col === 'main') return LIMITS[span.dataset.col] ? { key: span.dataset.col, el: span, sign: -1 } : null;
    return LIMITS[left.dataset.col] ? { key: left.dataset.col, el: left, sign: 1 } : null;
  }

  // 세로선마다 잡는 곳을 붙인다 (첫 칸 '주문' 왼쪽은 체크 칸이라 없음)
  for (const span of [...cols().slice(1), head.querySelector('.head-product')].filter(Boolean)) {
    const grip = document.createElement('span');
    grip.className = 'col-grip';
    grip.title = '끌어서 칸 너비 바꾸기 · 두 번 누르면 처음 너비';
    grip.setAttribute('aria-hidden', 'true');
    span.appendChild(grip);
  }

  let drag = null;
  head.addEventListener('pointerdown', event => {
    const grip = event.target.closest('.col-grip');
    if (!grip || event.button !== 0) return;
    const t = targetOf(grip);
    if (!t) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add('dragging');
    document.body.classList.add('col-resizing');
    drag = { ...t, grip, x: event.clientX, start: t.el.getBoundingClientRect().width, moved: false };
  });
  head.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) < 2 && !drag.moved) return;
    drag.moved = true;
    const prev = widths[drag.key];
    const product = head.querySelector('.head-product');
    const before = product ? product.getBoundingClientRect().width : 0;
    widths[drag.key] = clamp(drag.key, drag.start + drag.sign * dx);
    apply();
    // 상품명 칸은 적어도 MIN_PRODUCT 는 남긴다 (다른 칸을 너무 넓히면 그 이상은 안 커짐)
    const after = product ? product.getBoundingClientRect().width : 0;
    if (product && after < MIN_PRODUCT && after < before) {
      if (prev === undefined) delete widths[drag.key]; else widths[drag.key] = prev;
      apply();
    }
  });
  const end = () => {
    if (!drag) return;
    drag.grip.classList.remove('dragging');
    document.body.classList.remove('col-resizing');
    if (drag.moved) save();
    drag = null;
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);

  head.addEventListener('dblclick', event => {
    const grip = event.target.closest('.col-grip');
    const t = grip && targetOf(grip);
    if (!t) return;
    delete widths[t.key];
    apply();
    save();
  });

  if (resetBtn) resetBtn.addEventListener('click', () => { widths = {}; apply(); save(); });
})();
