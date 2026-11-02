// 톡톡 대화방: [주문·고객] 버튼으로 오른쪽 서랍 열고 닫기 (좁은 화면). 열어 둔 상태는 이 브라우저에 기억
(function () {
  const room = document.querySelector('[data-talk-room]');
  if (!room) return;
  const toggle = room.querySelector('[data-talk-side-toggle]');
  const KEY = 'talk-side-open';
  const set = open => {
    room.classList.toggle('side-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem(KEY, open ? '1' : ''); } catch { /* 저장 못 해도 괜찮음 */ }
  };
  try { if (localStorage.getItem(KEY) === '1') set(true); } catch { /* 처음엔 닫힘 */ }
  room.addEventListener('click', e => {
    if (e.target.closest('[data-talk-side-toggle]')) set(!room.classList.contains('side-open'));
    else if (e.target.closest('[data-talk-side-open]')) set(true);
    else if (e.target.closest('[data-talk-side-close]')) set(false);
  });
  // 쓰던 답장 칸에 바로 쓸 수 있게
  const box = room.querySelector('.talk-composer textarea');
  if (box && !matchMedia('(max-width: 760px)').matches) box.focus({ preventScroll: true });
})();
