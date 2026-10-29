// 패널 화면: 입력값을 모아 일러스트레이터 쪽 함수(jsx/dombo-core.jsx)를 부른다
(function () {
  var FIELDS = ['orientMm', 'diameterMm', 'offsetMm', 'spacingMm', 'marginMm', 'barHeightMm', 'barGapMm', 'boxMarginMm', 'dimOffsetMm', 'dimTextMm', 'gTop', 'gBottom', 'gLeft', 'gRight', 'gMarginMm', 'gDiameterMm', 'gStrokePt', 'splitCount', 'splitOverlapMm', 'splitGapMm', 'sizeTextMm', 'bleedMm', 'numTextMm'];
  var CHECKS = ['numPieces', 'orientMark', 'fitArtboard', 'removeRects', 'useBar', 'boxAsCut', 'dimShowW', 'dimShowH', 'dimTextAuto', 'dimUnit', 'dimStroke'];
  var SELECTS = ['orientCorner', 'dimHSide', 'dimVSide', 'dimDecimals'];
  var STORE_KEY = 'broad-dombo-settings';

  function $(id) { return document.getElementById(id); }
  function radio(name) { return document.querySelector('input[name="' + name + '"]:checked').value; }
  function setRadio(name, value) {
    var el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }

  function readOptions() {
    var o = { target: radio('target'), dimTarget: radio('dimTarget'), splitDir: radio('splitDir'), hebeScale: radio('hebeScale'), numScale: radio('numScale'), numPrefix: $('numPrefix').value };
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
    if (o.splitDir) setRadio('splitDir', o.splitDir);
    if (o.hebeScale) setRadio('hebeScale', o.hebeScale);
    if (o.numScale) setRadio('numScale', o.numScale);
    if (typeof o.numPrefix === 'string') $('numPrefix').value = o.numPrefix;
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
  $('cut').addEventListener('click', function () { call('domboPanelCut'); });
  function bleed(mode) {
    var o = readOptions();
    save(o);
    call('domboPanelBleed', { mode: mode, bleedMm: o.bleedMm });
  }
  $('bleedItem').addEventListener('click', function () { bleed('item'); });
  $('bleedMask').addEventListener('click', function () { bleed('mask'); });
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
  $('grommet').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    call('domboPanelGrommet', {
      top: o.gTop, bottom: o.gBottom, left: o.gLeft, right: o.gRight,
      marginMm: o.gMarginMm, diameterMm: o.gDiameterMm, strokePt: o.gStrokePt
    });
  });
  $('grommetRemove').addEventListener('click', function () { call('domboPanelGrommetRemove'); });
  $('split').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    call('domboPanelSplit', { direction: o.splitDir, count: o.splitCount, overlapMm: o.splitOverlapMm, gapMm: o.splitGapMm });
  });
  $('count').addEventListener('click', function () { call('domboPanelCount'); });
  $('hebe').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    call('domboPanelHebe', { scale: Number(o.hebeScale) });
  });
  $('size').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    call('domboPanelSize', { scale: Number(o.hebeScale), textMm: o.sizeTextMm });
  });
  $('sizeRemove').addEventListener('click', function () { call('domboPanelSizeRemove'); });
  $('number').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    call('domboPanelNumber', { pieces: o.numPieces, prefix: o.numPrefix, textMm: o.numTextMm, scale: Number(o.numScale) });
  });
  $('numberRemove').addEventListener('click', function () { call('domboPanelNumberRemove'); });

  // ---- 접힌 '설정' 줄에 지금 값을 한 줄로 ----
  var SUMS = {
    dombo: function (o) {
      return (o.target === 'artboard' ? '대지 · ' : '') + 'Ø' + o.diameterMm + ' · 거리 ' + o.offsetMm +
        ' · 간격 ' + o.spacingMm + (o.orientMark ? ' · 방향점 ' + o.orientMm : '');
    },
    barbox: function (o) {
      return (o.useBar ? '막대 ' + o.barHeightMm + ' (간격 ' + o.barGapMm + ')' : '막대 없음') +
        ' · 박스 여백 ' + o.boxMarginMm + (o.boxAsCut ? ' · 칼선' : '');
    },
    grommet: function (o) {
      return '위' + o.gTop + ' 아래' + o.gBottom + ' 왼' + o.gLeft + ' 오' + o.gRight + ' · 여백 ' + o.gMarginMm + ' · Ø' + o.gDiameterMm;
    },
    split: function (o) {
      return (o.splitDir === 'v' ? '세로 ' : '가로 ') + o.splitCount + '등분 · 겹침 ' + o.splitOverlapMm;
    },
    cut: function (o) {
      return '도련 ' + o.bleedMm + 'mm';
    },
    number: function (o) {
      return (o.numPrefix || '') + '1' + (o.numPieces ? ', ' + (o.numPrefix || '') + '1-1 …' : ' …') + ' · 우측 상단 · ' + (o.numScale === '10' ? '10:1 · 글자 ' + o.numTextMm + 'mm (파일 ' + o.numTextMm / 10 + 'mm)' : '1:1 · 글자 ' + o.numTextMm + 'mm');
    },
    size: function (o) {
      return (o.hebeScale === '10' ? '10:1' : '1:1') + ' · 글자 ' + o.sizeTextMm + 'mm' + (o.hebeScale === '10' ? ' (파일 ' + o.sizeTextMm / 10 + 'mm)' : '');
    },
    dim: function (o) {
      var sides = (o.dimShowW ? '가로' : '') + (o.dimShowW && o.dimShowH ? '·' : '') + (o.dimShowH ? '세로' : '');
      return (o.dimTarget === 'all' ? '전체' : '각각') + ' · ' + (sides || '없음') + ' · 거리 ' + o.dimOffsetMm +
        ' · 글자 ' + (o.dimTextAuto ? '자동' : o.dimTextMm);
    }
  };
  function updateSums() {
    var o = readOptions();
    Array.prototype.forEach.call(document.querySelectorAll('details.opts'), function (d) {
      var f = SUMS[d.getAttribute('data-sum')];
      if (f) d.querySelector('summary').textContent = f(o);
    });
  }
  // 값을 바꾸면 바로 기억하고 한 줄 요약도 고친다
  document.addEventListener('change', function (e) {
    if (e.target.closest && e.target.closest('#editor')) return;
    save(readOptions());
    updateSums();
  });
  document.addEventListener('input', function (e) {
    if (e.target.closest && e.target.closest('#editor')) return;
    updateSums();
  });

  // ---- 도움말 (설명 글) 보이기 ----
  var HELP_KEY = 'broad-dombo-help';
  function setHelp(on) {
    document.body.classList.toggle('help', on);
    $('helpToggle').classList.toggle('main', on);
    try { localStorage.setItem(HELP_KEY, on ? '1' : ''); } catch (e) {}
  }
  $('helpToggle').addEventListener('click', function () { setHelp(!document.body.classList.contains('help')); });
  try { if (localStorage.getItem(HELP_KEY)) setHelp(true); } catch (e) {}

  // ---- 칸 순서·이름 바꾸기 (이 컴퓨터에 기억) ----
  var LAYOUT_KEY = 'broad-dombo-layout';
  // 예전 기본 이름: 저장돼 있어도 직접 바꾼 이름이 아니므로 새 기본 이름으로 보여 준다
  var LEGACY_NAMES = { barbox: ['막대 + 박스'], cut: ['칼선'] };
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
    // 저장된 순서를 따르되, 없어진 칸은 뺀다
    ((saved && saved.items) || []).forEach(function (it) {
      if (!it || !sections[it.id] || seen[it.id]) return;
      seen[it.id] = true;
      var def = defaults.filter(function (x) { return x.id === it.id; })[0];
      var name = typeof it.name === 'string' && it.name.trim();
      if (!name || (LEGACY_NAMES[it.id] || []).indexOf(name) >= 0) name = def.name;
      list.push({ id: it.id, name: name, open: it.open !== false });
    });
    // 새로 생긴 칸은 처음 순서에서 바로 앞에 있던 칸 뒤에 끼운다 (없으면 맨 뒤)
    defaults.forEach(function (def, i) {
      if (seen[def.id]) return;
      seen[def.id] = true;
      var at = list.length;
      for (var j = 0; j < list.length; j++) if (i > 0 && list[j].id === defaults[i - 1].id) at = j + 1;
      list.splice(at, 0, { id: def.id, name: def.name, open: true });
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
  updateSums();

  // 일러스트에 실제로 올라간 스크립트 버전 (새로 설치했는데 옛 버전이면 일러스트를 완전히 껐다 켜야 함)
  if (window.__adobe_cep__) {
    window.__adobe_cep__.evalScript("typeof DOMBO_VERSION === 'string' ? DOMBO_VERSION : '?'", function (v) { $('ver').textContent = 'v' + v; });
  }
})();
