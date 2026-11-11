// 휴가 신청: 반차를 고르면 '끝나는 날' 칸을 숨긴다 (반차는 하루만)
(() => {
  const form = document.querySelector('.lv-form');
  if (!form) return;
  const end = form.querySelector('.lv-end');
  const sync = () => {
    const kind = (form.querySelector('input[name="kind"]:checked') || {}).value;
    if (!end) return;
    end.hidden = kind !== 'full';
    if (end.hidden) end.querySelector('input').value = '';
  };
  form.addEventListener('change', sync);
  sync();
})();
