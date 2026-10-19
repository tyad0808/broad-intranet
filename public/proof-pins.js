// 고객 시안 화면: 그림을 누르면 번호 표시가 찍히고, 아래 수정 요청 칸에 그 번호의 메모 칸이 생긴다
(function () {
  var box = document.querySelector('#proof-image.pinnable .pin-wrap');
  var list = document.getElementById('pin-list');
  var hidden = document.getElementById('pins');
  var form = document.getElementById('revise-form');
  if (!box || !list || !hidden || !form) return;
  var pins = [];
  var MAX = 20;

  function render() {
    Array.prototype.slice.call(box.querySelectorAll('.pin')).forEach(function (el) { el.remove(); });
    list.innerHTML = '';
    pins.forEach(function (pin, i) {
      var mark = document.createElement('span');
      mark.className = 'pin';
      mark.style.left = (pin.x * 100) + '%';
      mark.style.top = (pin.y * 100) + '%';
      mark.textContent = String(i + 1);
      box.appendChild(mark);

      var li = document.createElement('li');
      var input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 200;
      input.placeholder = (i + 1) + '번 위치를 어떻게 고칠까요?';
      input.value = pin.note;
      input.addEventListener('input', function () { pin.note = input.value; });
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-sm';
      remove.textContent = '삭제';
      remove.addEventListener('click', function () {
        pins.splice(i, 1);
        render();
      });
      li.appendChild(input);
      li.appendChild(remove);
      list.appendChild(li);
    });
  }

  box.addEventListener('click', function (event) {
    if (pins.length >= MAX) return;
    var img = box.querySelector('img');
    var rect = img.getBoundingClientRect();
    var x = (event.clientX - rect.left) / rect.width;
    var y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    pins.push({ x: x, y: y, note: '' });
    render();
  });

  form.addEventListener('submit', function () {
    hidden.value = JSON.stringify(pins.map(function (p) { return { x: p.x, y: p.y, note: p.note }; }));
  });
})();
