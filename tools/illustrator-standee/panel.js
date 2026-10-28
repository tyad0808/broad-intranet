// 등신대 패널: 일러스트에서 이미지 정보 → 패널에서 투명도로 외곽선 계산 → 일러스트에서 그리기
(function () {
  var STORE_KEY = 'broad-standee-settings';
  function $(id) { return document.getElementById(id); }

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

  function readOptions() { return { outlineMm: parseFloat($('outlineMm').value), roundMm: parseFloat($('roundMm').value) }; }
  function save(o) { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (e) {} }
  (function load() {
    var o;
    try { o = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) {}
    if (!o) return;
    if (typeof o.outlineMm === 'number' && !isNaN(o.outlineMm)) $('outlineMm').value = o.outlineMm;
    if (typeof o.roundMm === 'number' && !isNaN(o.roundMm)) $('roundMm').value = o.roundMm;
  })();
  document.addEventListener('change', function () { save(readOptions()); });

  function evalP(code, done) {
    window.__adobe_cep__.evalScript(code, function (r) {
      if (typeof r !== 'string' || r.indexOf('OK:') !== 0) { show(r); return; }
      done(r.slice(3));
    });
  }

  $('make').addEventListener('click', function () {
    if (!window.__adobe_cep__) { show('ERR:일러스트레이터 안에서 열어야 합니다.'); return; }
    var o = readOptions();
    save(o);
    if (!(o.outlineMm > 0)) { show('ERR:외곽선은 0 보다 커야 합니다.'); return; }
    if (!(o.roundMm >= 0)) o.roundMm = 0;
    evalP('standeePanelPrepare()', function (json) {
      var info = JSON.parse(json);
      var file = window.cep && window.cep.fs ? window.cep.fs.readFile(info.path, window.cep.encoding.Base64) : null;
      if (!file || file.err) { show('ERR:이미지 파일을 읽지 못했습니다: ' + info.path); return; }
      show('OK:외곽선 계산 중…');
      var img = new Image();
      img.onerror = function () { show('ERR:PNG 를 열지 못했습니다.'); };
      img.onload = function () {
        try {
          var b = info.bounds, k = 72 / 25.4, f = info.factor || 1;
          var physW = (b[2] - b[0]) / k * f, physH = (b[1] - b[3]) / k * f;
          // 칸 하나 = 큰 변의 1/1500 (0.5mm 보다 잘게는 안 함), 원본 픽셀보다 잘게도 안 함
          var cell = Math.max(0.5, Math.max(physW, physH) / 1500, physW / img.naturalWidth);
          var gw = Math.max(1, Math.round(physW / cell)), gh = Math.max(1, Math.round(physH / cell));
          var cv = document.createElement('canvas');
          cv.width = gw; cv.height = gh;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, gw, gh);
          var px = ctx.getImageData(0, 0, gw, gh).data, alpha = new Uint8Array(gw * gh);
          for (var i = 0; i < gw * gh; i++) alpha[i] = px[i * 4 + 3];
          var r = window.standeeShape.outline(alpha, gw, gh, {
            cellMm: (physW / gw + physH / gh) / 2, outlineMm: o.outlineMm, roundMm: o.roundMm
          });
          // 칸 좌표 → 문서 좌표 (pt)
          var sx = (b[2] - b[0]) / gw, sy = (b[1] - b[3]) / gh;
          var X = function (x) { return info.flipX ? b[2] - x * sx : b[0] + x * sx; };
          var Y = function (y) { return info.flipY ? b[3] + y * sy : b[1] - y * sy; };
          var pts = r.points.map(function (p) {
            return [X(p.a[0]), Y(p.a[1]), X(p.l[0]), Y(p.l[1]), X(p.r[0]), Y(p.r[1]), p.corner ? 1 : 0];
          });
          window.__adobe_cep__.evalScript('standeePanelApply(' + JSON.stringify({ points: pts, bounds: b, outlineMm: o.outlineMm, roundMm: o.roundMm }) + ')', show);
        } catch (e) {
          show('ERR:' + e.message);
        }
      };
      if (info.temp) window.__adobe_cep__.evalScript('standeePanelRemoveTemp(' + JSON.stringify(info.path) + ')', function () {});
      img.src = 'data:image/png;base64,' + file.data;
    });
  });

  // 일러스트에 실제로 올라간 스크립트 버전 (새로 설치했는데 옛 버전이면 일러스트를 완전히 껐다 켜야 함)
  if (window.__adobe_cep__) {
    window.__adobe_cep__.evalScript("typeof STANDEE_VERSION === 'string' ? STANDEE_VERSION : '?'", function (v) { $('ver').textContent = 'v' + v; });
  }
})();
