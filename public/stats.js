// 통계 그래프: 막대·칸에 마우스를 올리면 값이 뜬다 (휴대폰은 눌렀을 때)
(() => {
  const tip = document.getElementById('tip');
  if (!tip) return;
  const show = (el, x, y) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
    tip.style.top = `${y - tip.offsetHeight - 12}px`;
  };
  document.addEventListener('pointermove', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    show(el, e.clientX, e.clientY);
  });
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest('[data-tip]');
    if (el && e.pointerType !== 'mouse') show(el, e.clientX, e.clientY);
  });
  document.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
})();
