// 등신대 패널: 누끼 사진(과 글자·도형 디자인)을 고르면 여기서 배경 투명 PNG 로 내보내고,
// 패널이 그 투명도로 외곽선을 계산한 뒤(standee-shape.js), 여기서 흰 면(맨 뒤)과 칼선으로 그린다.

var STANDEE_VERSION = '1.1.1'; // CSXS/manifest.xml 과 같게. 패널 위에 보여 준다
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
    tmp.artboards[0].artboardRect = tb;
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
    '],"flipX":false,"flipY":false,"factor":' + factor + ',"temp":true}';
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
  // 위아래 확인: 발 아래 일자 자리는 선택한 것의 아래쪽, 외곽선만큼 넓어지는 쪽은 위쪽이어야 한다.
  // 일러스트 버전에 따라 위아래가 뒤집혀 나오면 선택 범위 가운데를 기준으로 뒤집어 다시 그린다
  var white = standeeDrawPath(grp, data.points), flipped = false;
  if (data.bounds) {
    var sb = data.bounds, wb = white.geometricBounds;
    var up = sb[1] >= sb[3] ? 1 : -1;
    var growTop = (wb[1] - sb[1]) * up, growBottom = (sb[3] - wb[3]) * up;
    if (growBottom > growTop + 1) {
      var c = sb[1] + sb[3];
      for (var q = 0; q < data.points.length; q++) {
        var pt = data.points[q];
        pt[1] = c - pt[1]; pt[3] = c - pt[3]; pt[5] = c - pt[5];
      }
      white.remove();
      white = standeeDrawPath(grp, data.points);
      flipped = true;
    }
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
    (flipped ? ' (위아래가 뒤집혀 나와서 바로잡았습니다)' : '');
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
