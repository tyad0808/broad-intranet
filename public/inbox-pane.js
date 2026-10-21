// 문의함 넓은 화면: 목록에서 문의를 누르면 오른쪽 칸에 바로 연다 (페이지를 옮기지 않음)
// 좁은 화면(오른쪽 칸이 안 보일 때)은 원래대로 내용 화면으로 간다
(() => {
  const split = document.querySelector('[data-inbox-split]');
  if (!split) return;
  const pane = split.querySelector('.inbox-pane');
  const frame = pane.querySelector('iframe');
  const empty = pane.querySelector('[data-pane-empty]');
  let selected = null;

  const paneShown = () => getComputedStyle(pane).display !== 'none';
  // 고른 줄 표시 (목록이 실시간으로 새로 그려져도 다시 표시)
  function mark() {
    split.querySelectorAll('.inbox-item.on').forEach(li => li.classList.remove('on'));
    if (!selected) return;
    const link = split.querySelector(`a.oi-main[data-id="${selected}"]`);
    if (link) link.closest('.inbox-item').classList.add('on');
  }

  document.addEventListener('click', event => {
    const link = event.target.closest('.inbox-split a.oi-main');
    if (!link || !paneShown() || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const url = new URL(link.getAttribute('href'), location.href);
    url.searchParams.set('embed', '1');
    frame.src = url.pathname + url.search;
    frame.hidden = false;
    empty.hidden = true;
    selected = link.dataset.id;
    mark();
  });

  const list = document.getElementById('live-list');
  if (list) new MutationObserver(mark).observe(list.parentNode, { childList: true, subtree: true });
})();
