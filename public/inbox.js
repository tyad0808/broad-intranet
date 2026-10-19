// 문의 답장: 첨부파일 합계가 한도를 넘으면 보내기 전에 알려준다 (서버에서도 다시 검사함)
document.addEventListener('change', event => {
  const input = event.target;
  if (!input.matches('input[type="file"][data-max-total]')) return;
  const total = [...input.files].reduce((sum, f) => sum + f.size, 0);
  const max = Number(input.dataset.maxTotal);
  if (total > max) {
    alert(`첨부파일 합계가 ${(total / 1024 / 1024).toFixed(1)}MB 입니다. ${Math.round(max / 1024 / 1024)}MB 까지 보낼 수 있어요.\n큰 파일은 웹하드에 올리고 링크를 답장에 적어 주세요.`);
    input.value = '';
  }
});
