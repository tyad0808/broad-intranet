// 등신대 패널: 누끼 딴 PNG(배경 투명, 링크로 가져온 것)를 고르면 패널이 투명도로 외곽선을 계산하고(standee-shape.js),
// 여기서는 1) 이미지 정보를 넘기고 2) 계산된 외곽선을 흰 면(이미지 뒤)과 칼선으로 그린다.

var STANDEE_VERSION = '1.0.0'; // CSXS/manifest.xml 과 같게. 패널 위에 보여 준다
var STANDEE_PT_PER_MM = 72 / 25.4;
var STANDEE_CUT_LAYER = '칼선';
var STANDEE_CUT_SPOT = 'CutContour';

function standeeDoc() {
  if (app.documents.length === 0) throw new Error('열려 있는 문서가 없습니다.');
  return app.activeDocument;
}

function standeePrepare() {
  var doc = standeeDoc();
  var sel = doc.selection;
  if (!sel || sel.typename === 'TextRange' || sel.length !== 1) throw new Error('누끼 딴 PNG 이미지 하나를 선택하세요.');
  var it = sel[0];
  if (it.typename === 'RasterItem') throw new Error('포함(임베드)된 이미지는 읽을 수 없습니다. 파일 > 가져오기에서 \'링크\' 를 켜고 PNG 를 다시 가져오세요.');
  if (it.typename !== 'PlacedItem') throw new Error('누끼 딴 PNG 이미지(링크) 하나를 선택하세요.');
  var f;
  try { f = it.file; } catch (e) { f = null; }
  if (!f || !f.exists) throw new Error('이미지 원본 파일을 찾을 수 없습니다 (링크 끊김).');
  if (!/\.png$/i.test(f.name)) throw new Error('배경이 투명한 PNG 만 됩니다 (지금 파일: ' + f.name + ').');
  var m = it.matrix;
  if (Math.abs(m.mValueB) > 1e-6 || Math.abs(m.mValueC) > 1e-6) throw new Error('돌리거나 기울인 이미지는 안 됩니다. 돌리기 전 이미지로 하세요.');
  var factor = 1;
  try { factor = Number(doc.scaleFactor) || 1; } catch (e2) { factor = 1; } // 큰 캔버스 문서는 스크립트 좌표가 1/10
  $.global.STANDEE_PENDING = it;
  var b = it.geometricBounds;
  return '{"path":"' + f.fsName.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '","bounds":[' + b.join(',') +
    '],"flipX":' + (m.mValueA < 0) + ',"flipY":' + (m.mValueD < 0) + ',"factor":' + factor + '}';
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
  var it = $.global.STANDEE_PENDING;
  if (!it) throw new Error('준비된 이미지가 없습니다. 다시 누르세요.');
  $.global.STANDEE_PENDING = null;
  var doc = standeeDoc();
  if (!data || !data.points || data.points.length < 3) throw new Error('외곽선을 만들지 못했습니다.');
  // 이미지와 흰 외곽선을 한 그룹으로 (흰 면은 이미지 뒤)
  var grp = it.parent.groupItems.add();
  grp.move(it, ElementPlacement.PLACEBEFORE);
  grp.name = '등신대';
  it.move(grp, ElementPlacement.PLACEATEND);
  var white = standeeDrawPath(grp, data.points);
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
    '전체 ' + standeeMm(b[2] - b[0]) + ' × ' + standeeMm(b[1] - b[3]) + ' mm. 칼선은 \'' + STANDEE_CUT_LAYER + '\' 레이어에 있습니다.';
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
