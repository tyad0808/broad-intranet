// 답장 문구 관리: 제목·내용으로 찾기 (글자를 칠 때마다 목록을 거른다)
(function () {
  const input = document.querySelector('[data-template-search]');
  if (!input) return;
  const squash = s => String(s || '').toLowerCase().replace(/\s+/g, '');
  const none = document.querySelector('[data-template-none]');
  input.addEventListener('input', () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean).map(squash);
    let shown = 0;
    document.querySelectorAll('[data-template-group]').forEach(group => {
      let n = 0;
      group.querySelectorAll('[data-template-row]').forEach(row => {
        const hay = squash(row.dataset.search);
        const ok = words.every(w => hay.includes(w));
        row.hidden = !ok;
        if (ok) n++;
      });
      group.hidden = n === 0;
      shown += n;
    });
    if (none) none.hidden = shown > 0;
  });
})();

// [엑셀 올리기]: 파일을 고르면 바로 올린다 (미리보기 화면으로 감, 아직 반영 안 됨)
document.querySelectorAll('input[data-auto-submit]').forEach(input => {
  input.addEventListener('change', () => { if (input.files.length) input.form.requestSubmit ? input.form.requestSubmit() : input.form.submit(); });
});
