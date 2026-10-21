// 문의 답장: 첨부파일을 끌어다 놓기 / 골라서 넣기, 고른 파일 목록(빼기 가능), 합계 한도 확인 (서버에서도 다시 검사함)
(() => {
  const zone = document.querySelector('[data-drop-zone]');
  // 파일을 화면 다른 곳에 잘못 놓아도 브라우저가 그 파일을 열어 버리지 않게
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });
  if (!zone) return;

  const input = zone.querySelector('input[type="file"]');
  const list = zone.querySelector('[data-drop-list]');
  const form = zone.closest('form');
  const max = Number(input.dataset.maxTotal);
  let files = [];

  const size = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

  // 고른 파일들을 실제 폼 칸(input)에 넣고 목록을 다시 그린다
  function sync() {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;
    list.innerHTML = '';
    files.forEach((f, i) => {
      const li = document.createElement('li');
      li.textContent = `${f.name} (${size(f.size)}) `;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'drop-remove';
      remove.setAttribute('aria-label', `${f.name} 빼기`);
      remove.textContent = '×';
      remove.addEventListener('click', () => { files.splice(i, 1); sync(); });
      li.appendChild(remove);
      list.appendChild(li);
    });
    zone.classList.toggle('has-files', files.length > 0);
  }

  function add(newFiles) {
    const next = [...files];
    for (const f of newFiles) {
      if (!next.some(x => x.name === f.name && x.size === f.size)) next.push(f); // 같은 파일 두 번 넣기 방지
    }
    const total = next.reduce((sum, f) => sum + f.size, 0);
    if (total > max) {
      alert(`첨부파일 합계가 ${size(total)} 입니다. ${Math.round(max / 1024 / 1024)}MB 까지 보낼 수 있어요.\n큰 파일은 웹하드에 올리고 링크를 답장에 적어 주세요.`);
    } else {
      files = next;
    }
    sync();
  }

  input.addEventListener('change', () => add([...input.files]));

  // 답변 칸을 포함한 답장 상자 전체에 놓을 수 있다
  let depth = 0;
  form.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; zone.classList.add('dragging'); } });
  form.addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; zone.classList.remove('dragging'); } });
  form.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove('dragging');
    add([...e.dataTransfer.files]);
  });
})();

// 채팅: 처음 열면 가장 최근 말이 보이게 맨 아래로
document.querySelectorAll('.chat-thread').forEach(el => { el.scrollTop = el.scrollHeight; });

// 자주 쓰는 답장 문구: 고르면 답장 칸의 커서 자리에 넣는다 (이미 쓴 글이 있으면 그 뒤에)
document.querySelectorAll('select[data-template]').forEach(select => {
  select.addEventListener('change', () => {
    const option = select.selectedOptions[0];
    const textarea = select.closest('form').querySelector('textarea[name="body"]');
    if (!option || !option.value || !textarea) return;
    const text = option.dataset.body || '';
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const glue = before && !before.endsWith('\n') ? '\n' : '';
    textarea.value = before + glue + text + textarea.value.slice(end);
    textarea.focus();
    const pos = (before + glue + text).length;
    textarea.setSelectionRange(pos, pos);
    // 많이 쓰는 문구가 위로 오게 기록 (실패해도 괜찮음)
    fetch(`/templates/${option.value}/used`, { method: 'POST', headers: { 'x-csrf-token': select.dataset.csrf }, credentials: 'same-origin' }).catch(() => {});
    select.value = '';
  });
});
