// 주문 상세 › 시안 · 작업지시서: 캡처한 그림을 Ctrl+V 로 붙여 넣으면 '확정 시안 그림' 칸에 넣는다
// (올리기는 지금처럼 [시안 올리기]/[저장] 을 눌러야 된다)
(function () {
  const input = document.querySelector('[data-proof-file]');
  if (!input || typeof DataTransfer === 'undefined') return;
  const box = document.querySelector('[data-proof-pasted]');
  const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  document.addEventListener('paste', e => {
    const file = [...((e.clipboardData && e.clipboardData.files) || [])].find(f => TYPES.includes(f.type));
    if (!file) return; // 글자 붙여 넣기는 그대로
    e.preventDefault();
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type];
    const named = new File([file], file.name && file.name !== 'image.png' ? file.name : `붙여넣은시안_${Date.now()}.${ext}`, { type: file.type });
    const dt = new DataTransfer();
    dt.items.add(named);
    input.files = dt.files;
    if (box) {
      const img = box.querySelector('img');
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(named);
      box.hidden = false;
    }
    document.getElementById('proof').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  // 파일을 직접 다시 고르면 붙여 넣은 미리보기는 숨긴다
  input.addEventListener('change', () => { if (box) box.hidden = true; });
})();
