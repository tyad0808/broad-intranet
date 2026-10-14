// 네스팅 패널 공용: 입력값을 모아 일러스트레이터 쪽 함수(jsx/nest-core.jsx)를 부른다
// 각 화면은 <body data-fn="..." data-store="..."> 로 부를 함수와 설정 저장 이름을 정한다.
(function () {
  var fn = document.body.getAttribute('data-fn');
  var storeKey = 'broad-nesting-' + document.body.getAttribute('data-store');
  var inputs = Array.prototype.slice.call(document.querySelectorAll('[data-opt]'));

  function $(id) { return document.getElementById(id); }

  function readOptions() {
    var o = {};
    inputs.forEach(function (el) {
      var k = el.getAttribute('data-opt');
      if (el.type === 'checkbox') o[k] = el.checked;
      else if (el.type === 'radio') { if (el.checked) o[k] = el.value; }
      else o[k] = el.type === 'number' ? parseFloat(el.value) : el.value;
    });
    return o;
  }

  // 마지막 설정을 기억한다 (저장이 막힌 환경이면 그냥 넘어간다)
  function save(o) { try { localStorage.setItem(storeKey, JSON.stringify(o)); } catch (e) {} }
  function load() {
    var o;
    try { o = JSON.parse(localStorage.getItem(storeKey)); } catch (e) {}
    if (!o) return;
    inputs.forEach(function (el) {
      var v = o[el.getAttribute('data-opt')];
      if (v === undefined || v === null) return;
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'radio') el.checked = el.value === v;
      else if (typeof v === 'number' && !isNaN(v)) el.value = v;
    });
  }

  function show(result) {
    var el = $('msg');
    $('run').disabled = false;
    if (typeof result !== 'string' || result.indexOf('OK:') !== 0 && result.indexOf('ERR:') !== 0) {
      el.className = 'err';
      el.textContent = '일러스트레이터 스크립트를 실행하지 못했습니다: ' + result;
      return;
    }
    var ok = result.indexOf('OK:') === 0;
    el.className = ok ? 'ok' : 'err';
    el.textContent = result.slice(ok ? 3 : 4);
  }

  $('run').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    if (!window.__adobe_cep__) { show('ERR:일러스트레이터 안에서 열어야 합니다.'); return; }
    $('run').disabled = true;
    $('msg').className = 'busy';
    $('msg').textContent = '배치 중입니다... 개수가 많으면 조금 걸립니다.';
    window.__adobe_cep__.evalScript(fn + '(' + JSON.stringify(o) + ')', show);
  });

  load();
})();
