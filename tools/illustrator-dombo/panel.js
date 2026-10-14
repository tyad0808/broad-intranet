// 패널 화면: 입력값을 모아 일러스트레이터 쪽 함수(jsx/dombo-core.jsx)를 부른다
(function () {
  var FIELDS = ['diameterMm', 'offsetMm', 'spacingMm', 'marginMm', 'barHeightMm', 'barGapMm', 'boxMarginMm', 'dimOffsetMm', 'dimTextMm', 'cutBleedMm'];
  var CHECKS = ['fitArtboard', 'removeRects', 'useBar', 'boxAsCut', 'dimShowW', 'dimShowH', 'dimTextAuto', 'dimUnit', 'dimStroke'];
  var SELECTS = ['dimHSide', 'dimVSide', 'dimDecimals'];
  var STORE_KEY = 'broad-dombo-settings';

  function $(id) { return document.getElementById(id); }
  function radio(name) { return document.querySelector('input[name="' + name + '"]:checked').value; }
  function setRadio(name, value) {
    var el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }

  function readOptions() {
    var o = { target: radio('target'), dimTarget: radio('dimTarget') };
    CHECKS.forEach(function (c) { o[c] = $(c).checked; });
    SELECTS.forEach(function (c) { o[c] = $(c).value; });
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
    if (o.dimTarget) setRadio('dimTarget', o.dimTarget);
    SELECTS.forEach(function (c) { if (typeof o[c] === 'string') $(c).value = o[c]; });
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
  $('cut').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    call('domboPanelCut', { bleedMm: o.cutBleedMm || 0 });
  });
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
  $('dim').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    call('domboPanelDim', {
      target: o.dimTarget, showW: o.dimShowW, showH: o.dimShowH, hSide: o.dimHSide, vSide: o.dimVSide,
      offsetMm: o.dimOffsetMm, textAuto: o.dimTextAuto, textMm: o.dimTextMm,
      decimals: Number(o.dimDecimals), unit: o.dimUnit, stroke: o.dimStroke
    });
  });
  $('dimRemove').addEventListener('click', function () { call('domboPanelDimRemove'); });
  $('count').addEventListener('click', function () { call('domboPanelCount'); });

  // ---- 칸 순서·이름 바꾸기 (이 컴퓨터에 기억) ----
  var LAYOUT_KEY = 'broad-dombo-layout';
  // 예전 기본 이름: 저장돼 있어도 직접 바꾼 이름이 아니므로 새 기본 이름으로 보여 준다
  var LEGACY_NAMES = { barbox: ['막대 + 박스'] };
  var box = $('sections');
  var sections = {}, defaults = [];
  Array.prototype.forEach.call(box.querySelectorAll('details[data-id]'), function (d) {
    var id = d.getAttribute('data-id');
    sections[id] = d;
    defaults.push({ id: id, name: d.querySelector('summary').textContent });
  });

  function readLayout() {
    var saved;
    try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY)); } catch (e) {}
    var list = [], seen = {};
    // 저장된 순서를 따르되, 없어진 칸은 빼고 새로 생긴 칸은 뒤에 붙인다
    ((saved && saved.items) || []).concat(defaults).forEach(function (it) {
      if (!it || !sections[it.id] || seen[it.id]) return;
      seen[it.id] = true;
      var def = defaults.filter(function (x) { return x.id === it.id; })[0];
      var name = typeof it.name === 'string' && it.name.trim();
      if (!name || (LEGACY_NAMES[it.id] || []).indexOf(name) >= 0) name = def.name;
      list.push({ id: it.id, name: name, open: it.open !== false });
    });
    return list;
  }

  var layout = readLayout();

  function saveLayout() {
    layout.forEach(function (it) { it.open = sections[it.id].open; });
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ items: layout })); } catch (e) {}
  }

  function applyLayout() {
    layout.forEach(function (it) {
      var d = sections[it.id];
      d.querySelector('summary').textContent = it.name;
      d.open = it.open;
      box.appendChild(d);
    });
  }

  function renderEditor() {
    var list = $('editList');
    list.innerHTML = '';
    layout.forEach(function (it, i) {
      var row = document.createElement('div');
      row.className = 'editRow';
      var name = document.createElement('input');
      name.type = 'text';
      name.value = it.name;
      name.addEventListener('input', function () {
        it.name = name.value.trim() || defaults.filter(function (x) { return x.id === it.id; })[0].name;
        sections[it.id].querySelector('summary').textContent = it.name;
        saveLayout();
      });
      var up = document.createElement('button');
      up.textContent = '▲';
      up.disabled = i === 0;
      up.addEventListener('click', function () { move(i, -1); });
      var down = document.createElement('button');
      down.textContent = '▼';
      down.disabled = i === layout.length - 1;
      down.addEventListener('click', function () { move(i, 1); });
      row.appendChild(name);
      row.appendChild(up);
      row.appendChild(down);
      list.appendChild(row);
    });
  }

  function move(i, dir) {
    var j = i + dir;
    if (j < 0 || j >= layout.length) return;
    var t = layout[i]; layout[i] = layout[j]; layout[j] = t;
    applyLayout();
    saveLayout();
    renderEditor();
  }

  $('editToggle').addEventListener('click', function () {
    var ed = $('editor');
    ed.hidden = !ed.hidden;
    if (!ed.hidden) renderEditor();
  });
  $('editDone').addEventListener('click', function () { $('editor').hidden = true; });
  $('editReset').addEventListener('click', function () {
    layout = defaults.map(function (d) { return { id: d.id, name: d.name, open: true }; });
    applyLayout();
    saveLayout();
    renderEditor();
  });
  // 칸을 접거나 펼친 상태도 기억한다
  Object.keys(sections).forEach(function (id) {
    sections[id].addEventListener('toggle', saveLayout);
  });

  applyLayout();
  load();
})();
