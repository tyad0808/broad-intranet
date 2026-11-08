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

  function readOptions() {
    return { outlineMm: parseFloat($('outlineMm').value), roundMm: parseFloat($('roundMm').value), baseMm: parseFloat($('baseMm').value), fillLegs: $('fillLegs').checked,
      cutRoundMm: parseFloat($('cutRoundMm').value), cutFill: $('cutFill').checked, cutTrim: $('cutTrim').checked };
  }
  function save(o) { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (e) {} }
  (function load() {
    var o;
    try { o = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) {}
    if (!o) return;
    if (typeof o.outlineMm === 'number' && !isNaN(o.outlineMm)) $('outlineMm').value = o.outlineMm;
    if (typeof o.roundMm === 'number' && !isNaN(o.roundMm)) $('roundMm').value = o.roundMm;
    if (typeof o.baseMm === 'number' && !isNaN(o.baseMm)) $('baseMm').value = o.baseMm;
    if (typeof o.fillLegs === 'boolean') $('fillLegs').checked = o.fillLegs;
    if (typeof o.cutRoundMm === 'number' && !isNaN(o.cutRoundMm)) $('cutRoundMm').value = o.cutRoundMm;
    if (typeof o.cutFill === 'boolean') $('cutFill').checked = o.cutFill;
    if (typeof o.cutTrim === 'boolean') $('cutTrim').checked = o.cutTrim;
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
    if (!(o.baseMm >= 0)) o.baseMm = 0;
    evalP('standeePanelPrepare()', function (json) {
      var info = JSON.parse(json);
      var file = window.cep && window.cep.fs ? window.cep.fs.readFile(info.path, window.cep.encoding.Base64) : null;
      if (!file || file.err) { show('ERR:이미지 파일을 읽지 못했습니다: ' + info.path); return; }
      show('OK:외곽선 계산 중…');
      var img = new Image();
      img.onerror = function () { show('ERR:PNG 를 열지 못했습니다.'); };
      img.onload = function () {
        try {
          var b0 = info.bounds, mg = info.margin || 0, k = 72 / 25.4, f = info.factor || 1;
          // PNG 는 선택 범위 + 사방 여백 (여백 왼쪽 위에 방향 표시 네모)
          var b = [b0[0] - mg, b0[1] + mg, b0[2] + mg, b0[3] - mg];
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
          var orient = '';
          if (mg > 0) {
            // 방향 표시 네모 찾기: 네 구석 중 가장 진한 곳
            var bx = Math.max(1, Math.floor(mg / (b[2] - b[0]) * gw * 0.6)), by = Math.max(1, Math.floor(mg / (b[1] - b[3]) * gh * 0.6));
            var mean = function (x0, y0) {
              var sum = 0;
              for (var yy = y0; yy < y0 + by; yy++) for (var xx = x0; xx < x0 + bx; xx++) sum += alpha[yy * gw + xx];
              return sum / (bx * by);
            };
            var c = [mean(0, 0), mean(gw - bx, 0), mean(0, gh - by), mean(gw - bx, gh - by)]; // 왼위, 오위, 왼아래, 오아래
            var best = 0;
            for (var q = 1; q < 4; q++) if (c[q] > c[best]) best = q;
            if (c[best] < 128) throw new Error('방향 표시를 찾지 못했습니다. 다시 눌러 보세요.');
            var fx = best === 1 || best === 3, fy = best === 2 || best === 3;
            orient = fy ? (fx ? '위아래·좌우 뒤집힘 → 바로잡음' : '위아래 뒤집힘 → 바로잡음') : (fx ? '좌우 뒤집힘 → 바로잡음' : '정상');
            // 뒤집힌 만큼 되돌리고, 여백(방향 표시 포함)은 지운다
            var fixed = new Uint8Array(gw * gh);
            var mx = Math.ceil(mg / (b[2] - b[0]) * gw) + 1, my = Math.ceil(mg / (b[1] - b[3]) * gh) + 1;
            for (var yy2 = 0; yy2 < gh; yy2++) for (var xx2 = 0; xx2 < gw; xx2++) {
              if (xx2 < mx || yy2 < my || xx2 >= gw - mx || yy2 >= gh - my) continue;
              var sxp = fx ? gw - 1 - xx2 : xx2, syp = fy ? gh - 1 - yy2 : yy2;
              fixed[yy2 * gw + xx2] = alpha[syp * gw + sxp];
            }
            alpha = fixed;
          }
          var r = window.standeeShape.outline(alpha, gw, gh, {
            cellMm: (physW / gw + physH / gh) / 2, outlineMm: o.outlineMm, roundMm: o.roundMm, baseMm: o.baseMm, fillLegs: o.fillLegs
          });
          // 칸 좌표 → 문서 좌표 (pt). 칸 (0,0) = 범위 왼쪽 위
          var sx = (b[2] - b[0]) / gw, sy = (b[1] - b[3]) / gh;
          var X = function (x) { return b[0] + x * sx; };
          var Y = function (y) { return b[1] - y * sy; };
          var pts = r.points.map(function (p) {
            return [X(p.a[0]), Y(p.a[1]), X(p.l[0]), Y(p.l[1]), X(p.r[0]), Y(p.r[1]), p.corner ? 1 : 0];
          });
          window.__adobe_cep__.evalScript('standeePanelApply(' + JSON.stringify({ points: pts, outlineMm: o.outlineMm, roundMm: o.roundMm, orient: orient }) + ')', show);
        } catch (e) {
          show('ERR:' + e.message);
        }
      };
      if (info.temp) window.__adobe_cep__.evalScript('standeePanelRemoveTemp(' + JSON.stringify(info.path) + ')', function () {});
      img.src = 'data:image/png;base64,' + file.data;
    });
  });

  // 선택한 칼선 예각 없애기: 일러스트에서 패스 점·손잡이 → 캔버스에 칠해 칸 그림 → 다듬기 → 일러스트에서 바꿔 넣기
  $('cutSmooth').addEventListener('click', function () {
    if (!window.__adobe_cep__) { show('ERR:일러스트레이터 안에서 열어야 합니다.'); return; }
    var o = readOptions();
    save(o);
    if (!(o.cutRoundMm > 0)) { show('ERR:예각 크기는 0 보다 커야 합니다.'); return; }
    if (!o.cutFill && !o.cutTrim) { show('ERR:틈 메우기와 끝 다듬기 중 하나는 켜야 합니다.'); return; }
    evalP('standeePanelCutPrepare()', function (json) {
      try {
        var info = JSON.parse(json), k = 72 / 25.4, f = info.factor || 1, out = [], filled = 0, trimmed = 0;
        for (var n = 0; n < info.paths.length; n++) {
          var path = info.paths[n], b = path.bounds;
          var physW = (b[2] - b[0]) / k * f, physH = (b[1] - b[3]) / k * f, longMm = Math.max(physW, physH);
          // 칸 하나: 큰 변의 1/1500 (0.3mm 보다 잘게는 안 함), 예각 크기의 1/4 보다 크지 않게, 그래도 큰 변 2500칸까지만
          var cell = Math.max(longMm / 2500, Math.min(Math.max(0.3, longMm / 1500), o.cutRoundMm / 4));
          var rad = o.cutRoundMm / cell, P = Math.ceil(rad) + 4;
          var gw = Math.ceil(physW / cell) + 2 * P, gh = Math.ceil(physH / cell) + 2 * P;
          var s = cell / f * k; // 칸 하나 = 문서 좌표 s pt
          var cx = function (x) { return (x - b[0]) / s + P; }, cy = function (y) { return (b[1] - y) / s + P; };
          var cv = document.createElement('canvas');
          cv.width = gw; cv.height = gh;
          var ctx = cv.getContext('2d'), pts = path.pts, m = pts.length;
          ctx.fillStyle = '#000';
          ctx.beginPath();
          ctx.moveTo(cx(pts[0][0]), cy(pts[0][1]));
          for (var i = 0; i < m; i++) {
            var p0 = pts[i], p1 = pts[(i + 1) % m];
            ctx.bezierCurveTo(cx(p0[4]), cy(p0[5]), cx(p1[2]), cy(p1[3]), cx(p1[0]), cy(p1[1]));
          }
          ctx.closePath();
          ctx.fill();
          var px = ctx.getImageData(0, 0, gw, gh).data, mask = new Uint8Array(gw * gh);
          for (var q = 0; q < gw * gh; q++) mask[q] = px[q * 4 + 3] >= 128 ? 1 : 0;
          var r = window.standeeShape.smoothCut(mask, gw, gh, { radius: rad, fillGaps: o.cutFill, trimSpikes: o.cutTrim });
          filled += r.filled; trimmed += r.trimmed;
          if (!r.points) continue;
          var X = function (x) { return b[0] + (x - P) * s; }, Y = function (y) { return b[1] - (y - P) * s; };
          out.push({ i: n, points: r.points.map(function (p) {
            return [X(p.a[0]), Y(p.a[1]), X(p.l[0]), Y(p.l[1]), X(p.r[0]), Y(p.r[1]), p.corner ? 1 : 0];
          }) });
        }
        window.__adobe_cep__.evalScript('standeePanelCutApply(' + JSON.stringify({ paths: out, radiusMm: o.cutRoundMm, filled: filled, trimmed: trimmed, skipped: info.skipped }) + ')', show);
      } catch (e) {
        show('ERR:' + e.message);
      }
    });
  });

  // 일러스트에 실제로 올라간 스크립트 버전 (새로 설치했는데 옛 버전이면 일러스트를 완전히 껐다 켜야 함)
  if (window.__adobe_cep__) {
    window.__adobe_cep__.evalScript("typeof STANDEE_VERSION === 'string' ? STANDEE_VERSION : '?'", function (v) { $('ver').textContent = 'v' + v; });
  }
})();
