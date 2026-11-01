// 답장 칸 위 [＋ 매크로 넣기]: 누르면 찾기 칸 + 카테고리별 목록이 뜬다. 제목·내용으로 찾고, 누르면(또는 ↑↓ Enter) 답장 칸 커서 자리에 넣는다.
// 넣은 뒤에는 직원이 마음대로 고쳐서 보낸다. 넣을 때마다 사용 횟수를 1 올린다 (관리자 점검용)
(function () {
  document.querySelectorAll('[data-macro-picker]').forEach(picker => {
    const openBtn = picker.querySelector('[data-macro-open]');
    const panel = picker.querySelector('[data-macro-panel]');
    if (!openBtn || !panel) return;
    const search = panel.querySelector('[data-macro-search]');
    const items = [...panel.querySelectorAll('[data-macro-item]')];
    const groups = [...panel.querySelectorAll('[data-macro-group]')];
    const none = panel.querySelector('[data-macro-none]');
    const form = picker.closest('form');
    const textarea = form && form.querySelector('textarea[name="body"]');
    const squash = s => String(s || '').toLowerCase().replace(/\s+/g, '');
    let active = -1;

    const visible = () => [...panel.querySelectorAll('[data-macro-item]:not([hidden])')];
    // i 가 null 이면 고른 것 없음. 위·아래 화살표는 끝에서 처음으로 돈다
    function setActive(i) {
      const list = visible();
      items.forEach(x => x.classList.remove('active'));
      active = i === null || !list.length ? -1 : (i + list.length) % list.length;
      if (active >= 0) {
        list[active].classList.add('active');
        list[active].scrollIntoView({ block: 'nearest' });
      }
    }
    // 찾기: 모든 낱말이 들어 있는 것만. 찾는 중에는 카테고리 묶음 대신 한 줄로,
    //       제목에 들어 있는 것 → 언제 쓰나에 들어 있는 것 → 내용에만 있는 것 순서
    const results = document.createElement('div');
    results.className = 'macro-results';
    results.hidden = true;
    panel.querySelector('[data-macro-list]').prepend(results);
    const home = items.map(i => i.parentElement);
    function filter() {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean).map(squash);
      if (!words.length) {
        items.forEach((i, n) => { i.hidden = false; home[n].appendChild(i); });
        groups.forEach(g => { g.hidden = false; });
        results.hidden = true;
        if (none) none.hidden = true;
        setActive(null);
        panel.querySelector('[data-macro-list]').scrollTop = 0;
        return;
      }
      const score = i => {
        const title = squash(i.querySelector('strong').textContent);
        const hint = squash((i.querySelector('.macro-hint') || {}).textContent);
        if (!words.every(w => squash(i.dataset.search).includes(w))) return -1;
        return words.every(w => title.includes(w)) ? 2 : words.every(w => (title + hint).includes(w)) ? 1 : 0;
      };
      const ranked = items.map((i, n) => ({ i, n, s: score(i) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s || a.n - b.n);
      items.forEach(i => { i.hidden = true; });
      groups.forEach(g => { g.hidden = true; });
      ranked.forEach(x => { x.i.hidden = false; results.appendChild(x.i); });
      results.hidden = !ranked.length;
      if (none) none.hidden = ranked.length > 0;
      setActive(0);
    }
    function open() {
      panel.hidden = false;
      openBtn.setAttribute('aria-expanded', 'true');
      search.value = '';
      filter();
      search.focus();
    }
    function close() {
      panel.hidden = true;
      openBtn.setAttribute('aria-expanded', 'false');
    }
    function insert(item) {
      if (!textarea) return;
      const text = item.dataset.body || '';
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      const before = textarea.value.slice(0, start);
      const glue = before && !before.endsWith('\n') ? '\n' : '';
      textarea.value = before + glue + text + textarea.value.slice(end);
      close();
      textarea.focus();
      const pos = (before + glue + text).length;
      textarea.setSelectionRange(pos, pos);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      // 사용 횟수 기록 (실패해도 괜찮음)
      fetch(`/templates/${item.dataset.id}/used`, { method: 'POST', headers: { 'x-csrf-token': picker.dataset.csrf }, credentials: 'same-origin' }).catch(() => {});
    }

    openBtn.addEventListener('click', () => (panel.hidden ? open() : close()));
    search.addEventListener('input', filter);
    search.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active < 0 ? -1 : active - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault(); // 답장 폼이 제출되지 않게
        const list = visible();
        if (list[active]) insert(list[active]);
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); openBtn.focus(); }
    });
    items.forEach(item => {
      item.addEventListener('click', () => insert(item));
      item.addEventListener('mousemove', () => { const i = visible().indexOf(item); if (i !== active) setActive(i); });
    });
    document.addEventListener('click', e => { if (!panel.hidden && !picker.contains(e.target)) close(); });
  });
})();
