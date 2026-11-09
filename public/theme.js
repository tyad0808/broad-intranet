// 화면 밝기 버튼: 누를 때마다 자동 → 밝게 → 어둡게. 화면은 바로 바꾸고, 계정에 저장한다 (다른 PC·휴대폰에서도 같게)
//   자동: 컴퓨터·휴대폰이 다크모드일 때만 어둡게 (dark.css 의 media 로)
(() => {
  const LABEL = { auto: '자동', light: '밝게', dark: '어둡게' };
  const NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
  const MEDIA = { auto: '(prefers-color-scheme: dark)', light: 'not all', dark: 'all' };

  function apply(theme) {
    const root = document.documentElement;
    root.dataset.theme = theme;
    const css = document.getElementById('dark-css');
    if (css) css.media = MEDIA[theme];
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = theme === 'auto' ? 'light dark' : theme;
    for (const form of document.querySelectorAll('[data-theme-form]')) {
      form.elements.theme.value = NEXT[theme];
      const btn = form.querySelector('button');
      const text = `화면 밝기: ${LABEL[theme]}. 누르면 ${LABEL[NEXT[theme]]}`;
      btn.title = `화면 밝기: ${LABEL[theme]} (누르면 ${LABEL[NEXT[theme]]})`;
      btn.setAttribute('aria-label', text);
      const label = form.querySelector('[data-theme-label]');
      if (label) label.textContent = LABEL[theme];
    }
    // 팝업(주문 화면 iframe)도 같이
    for (const frame of document.querySelectorAll('iframe')) {
      try { if (frame.contentDocument && frame.contentWindow.applyTheme) frame.contentWindow.applyTheme(theme); } catch { /* 다른 사이트 */ }
    }
  }
  window.applyTheme = apply;

  document.addEventListener('submit', async event => {
    const form = event.target.closest('[data-theme-form]');
    if (!form) return;
    event.preventDefault();
    const theme = form.elements.theme.value;
    const body = new URLSearchParams(new FormData(form)); // 바꾸기 전에 보낼 값을 먼저 담는다 (apply 가 다음 값으로 바꿔 놓으므로)
    apply(theme);
    try {
      await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        credentials: 'same-origin',
      });
    } catch {
      // 저장이 안 돼도 이 화면은 바뀐 채로 둔다 (다음에 다시 누르면 저장)
    }
  });
})();
