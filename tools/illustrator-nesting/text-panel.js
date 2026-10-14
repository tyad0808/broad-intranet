// 아크릴 텍스트 네스팅 패널
// 모양대로: 일러스트레이터에서 글자 윤곽선을 받아(nestPanelTextPrepare) → 여기서 배치 계산(nest-shape.js)
//           → 결과를 돌려보내 옮긴다(nestPanelTextApply). 실패하면 준비한 복제본을 치운다(nestPanelTextCancel).
// 사각형 범위: 일러스트레이터 쪽에서 한 번에 처리(nestPanelText).
(function () {
  var STORE_KEY = 'broad-nesting-text';
  var PT_PER_MM = 72 / 25.4;
  var inputs = Array.prototype.slice.call(document.querySelectorAll('[data-opt]'));
  function $(id) { return document.getElementById(id); }

  function readOptions() {
    var o = {};
    inputs.forEach(function (el) {
      var k = el.getAttribute('data-opt');
      if (el.type === 'checkbox') o[k] = el.checked;
      else if (el.type === 'radio') { if (el.checked) o[k] = el.value; }
      else if (el.tagName === 'SELECT') o[k] = parseFloat(el.value);
      else o[k] = el.type === 'number' ? parseFloat(el.value) : el.value;
    });
    return o;
  }
  function save(o) { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (e) {} }
  function load() {
    var o;
    try { o = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) {}
    if (!o) return;
    inputs.forEach(function (el) {
      var v = o[el.getAttribute('data-opt')];
      if (v === undefined || v === null) return;
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'radio') el.checked = el.value === v;
      else if (el.tagName === 'SELECT') el.value = String(v);
      else if (typeof v === 'number' && !isNaN(v)) el.value = v;
    });
  }

  function msg(cls, text) { $('msg').className = cls; $('msg').textContent = text; }
  function done(text, ok) { $('run').disabled = false; msg(ok ? 'ok' : 'err', text); }

  // 일러스트레이터 함수 부르기: 'OK:...' 면 resolve, 'ERR:...' 면 reject
  function host(fn, arg) {
    return new Promise(function (resolve, reject) {
      var code = fn + '(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
      window.__adobe_cep__.evalScript(code, function (r) {
        if (typeof r === 'string' && r.indexOf('OK:') === 0) resolve(r.slice(3));
        else if (typeof r === 'string' && r.indexOf('ERR:') === 0) reject(new Error(r.slice(4)));
        else reject(new Error('일러스트레이터 스크립트를 실행하지 못했습니다: ' + r));
      });
    });
  }

  function runShape(o) {
    var prepared = false, names = [];
    msg('busy', '글자를 아웃라인하고 나누는 중...');
    return host('nestPanelTextPrepare', o)
      .then(function (json) {
        prepared = true;
        var data = JSON.parse(json);
        names = data.names;
        msg('busy', '배치 계산 중... 0 / ' + data.pieces.length);
        return NestShape.nestAsync(data.pieces, {
          sheetW: o.sheetWMm * PT_PER_MM, sheetH: o.sheetHMm * PT_PER_MM,
          margin: o.marginMm * PT_PER_MM, gap: o.gapMm * PT_PER_MM,
          res: o.precisionMm * PT_PER_MM, allowRotate: o.allowRotate
        }, function (n, total) { msg('busy', '배치 계산 중... ' + n + ' / ' + total); });
      })
      .then(function (plan) {
        msg('busy', '일러스트레이터에 옮기는 중...');
        return host('nestPanelTextApply', plan);
      })
      .then(function (text) { done(text, true); })
      .catch(function (e) {
        var text = e.message;
        if (e.tooBig) {
          text += ' (' + e.tooBig.slice(0, 5).map(function (id) { return names[id]; }).join(', ') +
            (e.tooBig.length > 5 ? ' 등' : '') + ') 크기를 줄이거나 원판을 키우세요.';
        }
        if (prepared) host('nestPanelTextCancel').catch(function () {});
        done(text, false);
      });
  }

  $('run').addEventListener('click', function () {
    var o = readOptions();
    save(o);
    if (!window.__adobe_cep__) { done('일러스트레이터 안에서 열어야 합니다.', false); return; }
    $('run').disabled = true;
    if (o.method === 'shape') { runShape(o); return; }
    msg('busy', '배치 중...');
    host('nestPanelText', o).then(function (t) { done(t, true); }, function (e) { done(e.message, false); });
  });

  load();
})();
