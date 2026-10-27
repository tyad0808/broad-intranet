// 관리자 › 알림 소리: [▶ 들어보기] (지금 소리), 파일을 고르면 [▶ 고른 파일] 로 올리기 전에 들어보기
document.querySelectorAll('[data-play-sound]').forEach(button => {
  button.addEventListener('click', () => {
    if (typeof window.playNotifySound === 'function') window.playNotifySound(button.dataset.playSound, button.dataset.url || null);
  });
});
document.querySelectorAll('[data-sound-file]').forEach(input => {
  const preview = input.form.querySelector('[data-preview-file]');
  let url = null;
  input.addEventListener('change', () => {
    if (url) URL.revokeObjectURL(url);
    const file = input.files[0];
    url = file ? URL.createObjectURL(file) : null;
    preview.hidden = !url;
  });
  preview.addEventListener('click', () => {
    if (url && typeof window.playNotifySound === 'function') window.playNotifySound(input.dataset.soundFile, url);
  });
});
