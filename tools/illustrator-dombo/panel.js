// 패널 화면: 입력값을 모아 일러스트레이터 쪽 함수(jsx/dombo-core.jsx)를 부른다
(function () {
  var FIELDS = ['diameterMm', 'offsetMm', 'spacingMm', 'marginMm', 'barHeightMm', 'barGapMm', 'boxMarginMm'];
  var CHECKS = ['fitArtboard', 'removeRects', 'useBar', 'boxAsCut'];
  var STORE_KEY = 'broad-dombo-settings';

  function $(id) { return document.getElementById(id); }
  function radio(name) { return document.querySelector('input[name="' + name + '"]:checked').value; }
  function setRadio(name, value) {
    var el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }

  function readOptions() {
    var o = { target: radio('target') };
    CHECKS.forEach(function (c) { o[c] = $(c).checked; });
    FIELDS.forEach(function (f) { o[f] = parseFloat($(f).value); });
    return o;
  }

  // 마지막 설정을 기억한다 (저장이 막힌 환경이면 그냥 넘어간다)
  function save(o) { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (e) {} }
  function load() {
    var o;
    try { o = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) {}
    if (!o) return;
    if (o.target) setRadio('target', o.target);
    FIELDS.forEach(function (f) { if (typeof o[f] === 'number' && !isNaN(o[f])) $(f).value = o[f]; });
    CHECKS.forEach(function (c) { if (typeof o[c] === 'boolean') $(c).checked = o[c]; });
  }

  function show(result) {
    var el = $('msg');
    if (typeof result !== 'string' || result.indexOf('OK:') !== 0 && result.indexOf('ERR:') !== 0) {
      el.className = 'err';
      el.textContent = '일러스트레이터 스크립트를 실행하지 못했습니다: ' + result;
      return;
    }
    var ok = result.indexOf('OK:') === 0;
    el.className = ok ? 'ok' : 'err';
    el.textContent = result.slice(ok ? 3 : 4);
  }

  function call(fn, arg) {
    if (!window.__adobe_cep__) { show('ERR:일러스트레이터 안에서 열어야 합니다.'); return; }
    var code = fn + '(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
    window.__adobe_cep__.evalScript(code, show);
  }

  $('place').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    call('domboPanelPlace', o);
  });
  $('remove').addEventListener('click', function () { call('domboPanelRemove'); });
  $('cut').addEventListener('click', function () { call('domboPanelCut'); });
  $('grid').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    call('domboPanelGrid', { removeRects: o.removeRects });
  });
  $('barbox').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    call('domboPanelBarBox', {
      useBar: o.useBar, barHeightMm: o.barHeightMm, barGapMm: o.barGapMm,
      boxMarginMm: o.boxMarginMm, boxAsCut: o.boxAsCut
    });
  });
  $('count').addEventListener('click', function () { call('domboPanelCount'); });

  load();
})();
