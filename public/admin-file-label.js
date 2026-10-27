// 관리자 › 작업 파일 이름 모양: 이름표 버튼 → 커서 자리에 넣기, 적는 대로 미리 보기 (서버가 실제 주문으로 만들어 줌)
(() => {
  const form = document.querySelector('[data-file-label]');
  if (!form) return;
  const input = form.querySelector('input[name="pattern"]');
  const preview = form.querySelector('[data-file-preview]');
  const note = form.querySelector('[data-file-preview-note]');
  let timer = null;

  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const res = await fetch(`/admin/file-label/preview?pattern=${encodeURIComponent(input.value)}`, { credentials: 'same-origin' });
        const data = await res.json();
        preview.textContent = data.error ? '' : data.text;
        note.textContent = data.error ? data.error : '(가장 최근 주문으로)';
        note.classList.toggle('error-text', Boolean(data.error));
      } catch {
        // 다음 입력 때 다시
      }
    }, 250);
  }

  form.querySelectorAll('[data-token]').forEach(button => {
    button.addEventListener('click', () => {
      const token = button.dataset.token;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + token + input.value.slice(end);
      input.focus();
      input.setSelectionRange(start + token.length, start + token.length);
      refresh();
    });
  });
  input.addEventListener('input', refresh);
})();
