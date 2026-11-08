// 등신대 패널: 누끼 사진(과 글자·도형 디자인)을 고르면 여기서 배경 투명 PNG 로 내보내고,
// 패널이 그 투명도로 외곽선을 계산한 뒤(standee-shape.js), 여기서 흰 면(맨 뒤)과 칼선으로 그린다.

var STANDEE_VERSION = '1.4.0'; // CSXS/manifest.xml 과 같게. 패널 위에 보여 준다
var STANDEE_PT_PER_MM = 72 / 25.4;
var STANDEE_CUT_LAYER = '칼선';
var STANDEE_CUT_SPOT = 'CutContour';

function standeeDoc() {
  if (app.documents.length === 0) throw new Error('열려 있는 문서가 없습니다.');
  return app.activeDocument;
}

// 선택한 것(누끼 사진, 글자, 도형 … 섞여도 됨)을 임시 문서로 복사해 배경 투명 PNG 로 내보낸다.
// 패널은 이 PNG 의 투명도로 외곽선을 계산한다. 결과 PNG 는 선택한 것의 보이는 범위(bounds)와 같은 넓이
function standeeUnion(b, v) {
  if (!b) return [v[0], v[1], v[2], v[3]];
  return [Math.min(b[0], v[0]), Math.max(b[1], v[1]), Math.max(b[2], v[2]), Math.min(b[3], v[3])];
}

function standeePrepare() {
  var doc = standeeDoc();
  var sel = doc.selection;
  if (!sel || sel.typename === 'TextRange') throw new Error('글자 편집 중입니다. 선택 도구로 바꾼 뒤 다시 하세요.');
  if (!sel.length) throw new Error('등신대로 만들 것(누끼 사진, 디자인 전체)을 선택하세요.');
  var items = [], b = null, i;
  for (i = 0; i < sel.length; i++) { items.push(sel[i]); b = standeeUnion(b, sel[i].visibleBounds); }
  var factor = 1;
  try { factor = Number(doc.scaleFactor) || 1; } catch (e) { factor = 1; } // 큰 캔버스 문서는 스크립트 좌표가 1/10
  var wPt = b[2] - b[0], hPt = b[1] - b[3];
  if (!(wPt > 0) || !(hPt > 0)) throw new Error('선택한 것의 크기가 0 입니다.');
  // 둘레에 여백을 두고, 왼쪽 위 여백에 방향 표시(네모)를 찍어 내보낸다.
  // 패널은 PNG 에서 이 네모가 어느 구석에 있는지 보고 위아래·좌우가 뒤집혔는지 알아낸다
  var m = Math.max(5, Math.max(wPt, hPt) * 0.03);
  wPt += 2 * m; hPt += 2 * m;
  // 칸 하나 = 큰 변의 1/1500 (0.5mm 보다 잘게는 안 함) → 그만큼의 픽셀로 내보낸다
  var longMm = Math.max(wPt, hPt) / STANDEE_PT_PER_MM * factor;
  var cellMm = Math.max(0.5, longMm / 1500);
  var pct = Math.min(776, Math.max(1, longMm / cellMm / Math.max(wPt, hPt) * 100));

  var tmp = app.documents.add(DocumentColorSpace.RGB, wPt + 100, hPt + 100);
  var out = new File(Folder.temp.fsName + '/broad-standee-' + new Date().getTime() + '.png');
  try {
    var tb = null;
    for (i = items.length - 1; i >= 0; i--) {
      var d = items[i].duplicate(tmp.layers[0], ElementPlacement.PLACEATBEGINNING);
      tb = standeeUnion(tb, d.visibleBounds);
    }
    tmp.artboards[0].artboardRect = [tb[0] - m, tb[1] + m, tb[2] + m, tb[3] - m];
    var mk = tmp.layers[0].pathItems.rectangle(tb[1] + m, tb[0] - m, m * 0.8, m * 0.8);
    var black = new RGBColor();
    black.red = 0; black.green = 0; black.blue = 0;
    mk.filled = true;
    mk.fillColor = black;
    mk.stroked = false;
    var o = new ExportOptionsPNG24();
    o.transparency = true;
    o.antiAliasing = true;
    o.artBoardClipping = true;
    o.horizontalScale = pct;
    o.verticalScale = pct;
    tmp.exportFile(out, ExportType.PNG24, o);
  } finally {
    tmp.close(SaveOptions.DONOTSAVECHANGES);
    doc.activate();
  }
  if (!out.exists) throw new Error('임시 PNG 를 만들지 못했습니다.');
  $.global.STANDEE_PENDING = items;
  return '{"path":"' + out.fsName.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '","bounds":[' + b.join(',') +
    '],"margin":' + m + ',"factor":' + factor + ',"temp":true}';
}

// 패널이 다 읽은 임시 PNG 를 지운다
function standeeRemoveTemp(path) {
  var f = new File(path);
  if (f.exists && /broad-standee-\d+\.png$/.test(f.name)) f.remove();
  return '';
}

function standeeWhite(doc) {
  if (doc.documentColorSpace === DocumentColorSpace.CMYK) {
    var c = new CMYKColor();
    c.cyan = 0; c.magenta = 0; c.yellow = 0; c.black = 0;
    return c;
  }
  var r = new RGBColor();
  r.red = 255; r.green = 255; r.blue = 255;
  return r;
}

function standeeCutColor(doc) {
  var spot;
  try {
    spot = doc.spots.getByName(STANDEE_CUT_SPOT);
  } catch (e) {
    spot = doc.spots.add();
    spot.name = STANDEE_CUT_SPOT;
    spot.colorType = ColorModel.SPOT;
    if (doc.documentColorSpace === DocumentColorSpace.CMYK) {
      var c = new CMYKColor();
      c.cyan = 0; c.magenta = 100; c.yellow = 0; c.black = 0;
      spot.color = c;
    } else {
      var r = new RGBColor();
      r.red = 255; r.green = 0; r.blue = 255;
      spot.color = r;
    }
  }
  var sc = new SpotColor();
  sc.spot = spot;
  sc.tint = 100;
  return sc;
}

function standeeCutLayer(doc) {
  var layer = null;
  for (var i = 0; i < doc.layers.length; i++) if (doc.layers[i].name === STANDEE_CUT_LAYER) layer = doc.layers[i];
  if (!layer) { layer = doc.layers.add(); layer.name = STANDEE_CUT_LAYER; }
  layer.locked = false;
  layer.visible = true;
  return layer;
}

// pts: [[ax, ay, lx, ly, rx, ry, corner], ...] 문서 좌표(pt)
function standeeDrawPath(container, pts) {
  var p = container.pathItems.add(), anchors = [], i;
  for (i = 0; i < pts.length; i++) anchors.push([pts[i][0], pts[i][1]]);
  p.setEntirePath(anchors);
  for (i = 0; i < pts.length; i++) {
    var pp = p.pathPoints[i];
    pp.leftDirection = [pts[i][2], pts[i][3]];
    pp.rightDirection = [pts[i][4], pts[i][5]];
    pp.pointType = pts[i][6] ? PointType.CORNER : PointType.SMOOTH;
  }
  p.closed = true;
  return p;
}

function standeeMm(pt) { return String(Math.round(pt / STANDEE_PT_PER_MM)); }

// data: { points: [...], outlineMm, roundMm }
function standeeApply(data) {
  var items = $.global.STANDEE_PENDING;
  if (!items || !items.length) throw new Error('준비된 것이 없습니다. 다시 누르세요.');
  $.global.STANDEE_PENDING = null;
  var doc = standeeDoc();
  if (!data || !data.points || data.points.length < 3) throw new Error('외곽선을 만들지 못했습니다.');
  // 선택한 것과 흰 외곽선을 한 그룹으로 (쌓인 순서 그대로, 흰 면은 맨 뒤)
  try { items.sort(function (p, q) { return q.absoluteZOrderPosition - p.absoluteZOrderPosition; }); } catch (e) { /* 순서를 못 읽으면 선택 순서대로 */ }
  var grp = items[0].parent.groupItems.add();
  grp.move(items[0], ElementPlacement.PLACEBEFORE);
  grp.name = '등신대';
  for (var i = 0; i < items.length; i++) items[i].move(grp, ElementPlacement.PLACEATEND);
  var white = standeeDrawPath(grp, data.points);
  // 보낸 좌표와 그려진 좌표가 같은지 (다르면 원인을 찾게 메시지에 남긴다)
  var a0 = white.pathPoints[0].anchor, check = '';
  if (Math.abs(a0[0] - data.points[0][0]) > 1 || Math.abs(a0[1] - data.points[0][1]) > 1) {
    check = ' [좌표 확인: 보냄 ' + Math.round(data.points[0][0]) + ',' + Math.round(data.points[0][1]) + ' / 그려짐 ' + Math.round(a0[0]) + ',' + Math.round(a0[1]) + ']';
  }
  white.move(grp, ElementPlacement.PLACEATEND);
  white.name = '외곽선';
  white.filled = true;
  white.fillColor = standeeWhite(doc);
  white.stroked = false;
  // 같은 모양 칼선
  var cut = standeeDrawPath(standeeCutLayer(doc), data.points);
  cut.name = '등신대 칼선';
  cut.filled = false;
  cut.stroked = true;
  cut.strokeColor = standeeCutColor(doc);
  cut.strokeWidth = 0.25;
  cut.strokeDashes = [];
  doc.selection = null;
  grp.selected = true;
  var b = white.geometricBounds;
  return '등신대 외곽선을 만들었습니다 (외곽선 ' + data.outlineMm + 'mm, 예각 정리 ' + data.roundMm + 'mm, 발 아래 일자). ' +
    '전체 ' + standeeMm(b[2] - b[0]) + ' × ' + standeeMm(Math.abs(b[1] - b[3])) + ' mm. 칼선은 \'' + STANDEE_CUT_LAYER + '\' 레이어에 있습니다.' +
    (data.orient ? ' (그림 방향: ' + data.orient + ')' : '') + check;
}

// ---- 선택한 칼선 예각 없애기 ----
// 선택한 닫힌 패스(그룹 안 포함)의 점·손잡이를 패널로 넘긴다. 패널이 다듬은 모양을 standeeCutApply 로 돌려준다

function standeeCutCollect(item, out, skip) {
  if (item.typename === 'PathItem') {
    if (item.closed && item.pathPoints.length >= 3 && !item.guides && !item.clipping) out.push(item); else skip.n++;
  } else if (item.typename === 'GroupItem') {
    for (var i = 0; i < item.pageItems.length; i++) standeeCutCollect(item.pageItems[i], out, skip);
  } else if (item.typename === 'CompoundPathItem') {
    skip.compound++;
  } else {
    skip.n++;
  }
}

function standeeNum(v) { return String(Math.round(v * 1000) / 1000); }

function standeeCutPrepare() {
  var doc = standeeDoc();
  var sel = doc.selection;
  if (!sel || sel.typename === 'TextRange') throw new Error('글자 편집 중입니다. 선택 도구로 바꾼 뒤 다시 하세요.');
  if (!sel.length) throw new Error('다듬을 칼선(닫힌 패스)을 선택하세요.');
  var paths = [], skip = { n: 0, compound: 0 }, i, j;
  for (i = 0; i < sel.length; i++) standeeCutCollect(sel[i], paths, skip);
  if (!paths.length) throw new Error(skip.compound ? '컴파운드 패스는 다듬지 못합니다. 컴파운드 패스를 풀고(Alt+Shift+Ctrl+8) 바깥 칼선만 선택하세요.' : '선택한 것 중에 닫힌 패스(칼선)가 없습니다.');
  var factor = 1;
  try { factor = Number(doc.scaleFactor) || 1; } catch (e) { factor = 1; }
  var json = [];
  for (i = 0; i < paths.length; i++) {
    var pp = paths[i].pathPoints, pts = [];
    for (j = 0; j < pp.length; j++) {
      var a = pp[j].anchor, l = pp[j].leftDirection, r = pp[j].rightDirection;
      pts.push('[' + standeeNum(a[0]) + ',' + standeeNum(a[1]) + ',' + standeeNum(l[0]) + ',' + standeeNum(l[1]) + ',' + standeeNum(r[0]) + ',' + standeeNum(r[1]) + ']');
    }
    var b = paths[i].geometricBounds;
    json.push('{"bounds":[' + standeeNum(b[0]) + ',' + standeeNum(b[1]) + ',' + standeeNum(b[2]) + ',' + standeeNum(b[3]) + '],"pts":[' + pts.join(',') + ']}');
  }
  $.global.STANDEE_CUT_PENDING = paths;
  return '{"factor":' + factor + ',"skipped":' + (skip.n + skip.compound) + ',"paths":[' + json.join(',') + ']}';
}

// data: { paths: [{ i, points }], radiusMm, filled, trimmed, skipped }  points 는 standeeDrawPath 모양
function standeeCutApply(data) {
  var items = $.global.STANDEE_CUT_PENDING;
  if (!items || !items.length) throw new Error('준비된 칼선이 없습니다. 다시 누르세요.');
  $.global.STANDEE_CUT_PENDING = null;
  var doc = standeeDoc(), done = [], i;
  for (i = 0; i < data.paths.length; i++) {
    var d = data.paths[i], old = items[d.i];
    if (!old || !d.points || d.points.length < 3) continue;
    var np = standeeDrawPath(old.parent, d.points);
    np.move(old, ElementPlacement.PLACEBEFORE);
    np.filled = old.filled;
    if (old.filled) np.fillColor = old.fillColor;
    np.stroked = old.stroked;
    if (old.stroked) {
      np.strokeColor = old.strokeColor;
      np.strokeWidth = old.strokeWidth;
      np.strokeDashes = old.strokeDashes;
    }
    try { np.fillOverprint = old.fillOverprint; np.strokeOverprint = old.strokeOverprint; } catch (e) { /* 없는 버전 */ }
    np.name = old.name;
    old.remove();
    done.push(np);
  }
  doc.selection = null;
  for (i = 0; i < done.length; i++) done[i].selected = true;
  var total = items.length;
  if (!done.length) return '예각이 없습니다 (' + data.radiusMm + 'mm 기준). 칼선 ' + total + '개 그대로입니다.';
  return '칼선 ' + done.length + '개의 예각을 없앴습니다 (' + data.radiusMm + 'mm 기준: 틈 메움 ' + data.filled + '곳, 뾰족한 끝 다듬음 ' + data.trimmed + '곳).' +
    (total > done.length ? ' 나머지 ' + (total - done.length) + '개는 예각이 없어 그대로.' : '') +
    (data.skipped ? ' 닫힌 패스가 아닌 것 ' + data.skipped + '개는 건너뜀.' : '') + ' 되돌리려면 Ctrl+Z.';
}

// 패널에서 부르는 함수: 결과를 'OK:' 또는 'ERR:' 로 시작하는 글자로 돌려준다
function standeeCall(fn, arg) {
  try {
    return 'OK:' + fn(arg);
  } catch (e) {
    return 'ERR:' + e.message;
  }
}
function standeePanelPrepare() { return standeeCall(standeePrepare); }
function standeePanelApply(data) { return standeeCall(standeeApply, data); }
function standeePanelRemoveTemp(path) { return standeeCall(standeeRemoveTemp, path); }
function standeePanelCutPrepare() { return standeeCall(standeeCutPrepare); }
function standeePanelCutApply(data) { return standeeCall(standeeCutApply, data); }
