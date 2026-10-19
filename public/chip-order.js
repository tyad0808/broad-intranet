// 버튼 순서를 끌어다 놓아 바꾼다 (주문 목록의 채널 버튼, 문의함의 쇼핑몰 문의/메일 탭). 바꾼 순서는 내 계정에 저장된다
//   묶음: data-sortable data-url="저장 주소" data-csrf="…", 버튼: draggable="true" data-key="이름"
(() => {
  for (const nav of document.querySelectorAll('[data-sortable][data-url][data-csrf]')) {
    let dragging = null;
    let moved = false;

    nav.addEventListener('dragstart', event => {
      dragging = event.target.closest('[data-key]');
      if (!dragging) return;
      moved = false;
      dragging.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragging.dataset.key);
    });

    nav.addEventListener('dragover', event => {
      if (!dragging) return;
      event.preventDefault();
      const over = event.target.closest('[data-key]');
      if (!over || over === dragging || over.parentNode !== nav) return;
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
      const order = [...nav.querySelectorAll('[data-key]')].map(el => el.dataset.key);
      try {
        await fetch(nav.dataset.url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': nav.dataset.csrf },
          body: new URLSearchParams({ order: order.join(',') }).toString(),
        });
      } catch {
        // 저장이 안 돼도 화면 순서는 이번에만 바뀐 채로 둔다
      }
    });
  }
})();
