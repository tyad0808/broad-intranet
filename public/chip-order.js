// 채널 버튼(쿠팡·스마트스토어 …) 순서를 끌어다 놓아 바꾼다. 바꾼 순서는 내 계정에 저장된다
(() => {
  const nav = document.querySelector('.channel-chips[data-csrf]');
  if (!nav) return;
  let dragging = null;
  let moved = false;

  nav.addEventListener('dragstart', event => {
    dragging = event.target.closest('[data-channel]');
    if (!dragging) return;
    moved = false;
    dragging.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragging.dataset.channel);
  });

  nav.addEventListener('dragover', event => {
    if (!dragging) return;
    event.preventDefault();
    const over = event.target.closest('[data-channel]');
    if (!over || over === dragging) return;
    // 마우스가 버튼의 왼쪽 절반이면 앞에, 오른쪽 절반이면 뒤에 끼운다
    const box = over.getBoundingClientRect();
    const before = event.clientX < box.left + box.width / 2;
    nav.insertBefore(dragging, before ? over : over.nextSibling);
    moved = true;
  });

  nav.addEventListener('drop', event => event.preventDefault());

  nav.addEventListener('dragend', async () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    if (!moved) return;
    const order = [...nav.querySelectorAll('[data-channel]')].map(el => el.dataset.channel);
    try {
      await fetch('/me/channel-order', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': nav.dataset.csrf },
        body: new URLSearchParams({ order: order.join(',') }).toString(),
      });
    } catch {
      // 저장이 안 돼도 화면 순서는 이번에만 바뀐 채로 둔다
    }
  });
})();
