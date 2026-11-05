// AI 답변 초안: [답장 칸에 넣기] → 초안 글을 아래 답장 칸에 넣는다 (보내기는 직원이 직접)
(function () {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-ai-insert]');
    if (!btn) return;
    var box = btn.closest('.ai-draft');
    var text = box && box.querySelector('[data-ai-text]');
    var area = document.querySelector('form.reply-form textarea[name="body"]');
    if (!text || !area) return;
    var draft = text.getAttribute('data-ai-text') || '';
    // 이미 적어 둔 글이 있으면 바꿀지 묻는다
    if (area.value.trim() && area.value.trim() !== draft.trim() && !window.confirm('답장 칸에 적어 둔 글을 AI 초안으로 바꿀까요?')) return;
    area.value = draft;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.focus();
    area.setSelectionRange(0, 0);
    area.scrollTop = 0;
  });
})();
