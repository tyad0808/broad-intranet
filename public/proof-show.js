// 시안 상세: 고객 링크 복사 버튼
(function () {
  var button = document.getElementById('copy-link');
  var input = document.getElementById('proof-link');
  if (!button || !input) return;
  button.addEventListener('click', function () {
    var done = function () {
      button.textContent = '복사됨';
      setTimeout(function () { button.textContent = '링크 복사'; }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(input.value).then(done);
    } else {
      input.select();
      document.execCommand('copy');
      done();
    }
  });
})();
