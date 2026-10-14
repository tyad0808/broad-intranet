// 돔보마크 핵심 기능 (ExtendScript, ES3 문법만 사용)
// 패널(index.html)과 단독 스크립트(DomboMark.jsx)가 함께 쓴다.
// 좌표는 일러스트레이터 문서 좌표: 단위 pt, 위로 갈수록 y 가 커진다.
// 범위(bounds)는 [왼쪽, 위, 오른쪽, 아래] 순서이고 위 > 아래 이다.

var DOMBO_LAYER = '돔보마크';
var DOMBO_CUT_LAYER = '칼선';
var DOMBO_CUT_SPOT = 'CutContour';
var DOMBO_PT_PER_MM = 72 / 25.4;

function domboDefaults() {
  return {
    target: 'selection', // 'selection' 선택한 작업물 / 'artboard' 현재 대지
    shape: 'L',          // 'L' 모서리 L자 / 'square' 꽉 찬 사각형
    count: 4,            // 4점 또는 3점(오른쪽 위 생략)
    sizeMm: 10,          // 마크 한 변 길이
    thickMm: 0.5,        // L자 선 두께
    offsetMm: 5,         // 작업물과 마크 사이 거리
    fitArtboard: true,   // 마크가 대지 밖으로 나가면 대지를 넓힌다
    marginMm: 5          // 대지를 넓힐 때 마크 바깥 여백
  };
}

function domboMerge(opts) {
  var o = domboDefaults();
  if (opts) {
    for (var k in opts) {
      if (opts.hasOwnProperty(k) && opts[k] !== undefined && opts[k] !== null) o[k] = opts[k];
    }
  }
  o.count = Number(o.count);
  o.sizeMm = Number(o.sizeMm);
  o.thickMm = Number(o.thickMm);
  o.offsetMm = Number(o.offsetMm);
  o.marginMm = Number(o.marginMm);
  o.fitArtboard = o.fitArtboard === true || o.fitArtboard === 'true';
  return o;
}

function domboValidate(o) {
  if (o.shape !== 'L' && o.shape !== 'square') throw new Error('마크 모양은 L 또는 square 여야 합니다.');
  if (o.count !== 3 && o.count !== 4) throw new Error('마크 개수는 3 또는 4 여야 합니다.');
  if (!(o.sizeMm > 0)) throw new Error('마크 크기는 0보다 커야 합니다.');
  if (o.shape === 'L' && !(o.thickMm > 0 && o.thickMm < o.sizeMm)) {
    throw new Error('선 두께는 0보다 크고 마크 크기보다 작아야 합니다.');
  }
  if (!(o.offsetMm >= 0)) throw new Error('작업물과의 거리는 0 이상이어야 합니다.');
  if (!(o.marginMm >= 0)) throw new Error('대지 여백은 0 이상이어야 합니다.');
}

// 범위와 설정을 받아 마크 도형의 꼭짓점 목록을 계산한다 (일러스트레이터 없이도 동작).
// 각 마크의 바깥 모서리가 (작업물 범위 + 거리) 사각형의 꼭짓점에 정확히 놓인다.
function domboComputeMarks(bounds, opts) {
  var o = domboMerge(opts);
  domboValidate(o);
  var s = o.sizeMm * DOMBO_PT_PER_MM;
  var w = o.thickMm * DOMBO_PT_PER_MM;
  var d = o.offsetMm * DOMBO_PT_PER_MM;
  var L = bounds[0] - d, T = bounds[1] + d, R = bounds[2] + d, B = bounds[3] - d;

  if (R - L < 2 * s || T - B < 2 * s) {
    throw new Error('작업물이 마크에 비해 너무 작습니다. 마크 크기를 줄이거나 거리를 늘리세요.');
  }

  // sx, sy: 꼭짓점에서 안쪽을 향하는 방향
  var corners = [
    { corner: 'leftTop', x: L, y: T, sx: 1, sy: -1 },
    { corner: 'rightTop', x: R, y: T, sx: -1, sy: -1 },
    { corner: 'rightBottom', x: R, y: B, sx: -1, sy: 1 },
    { corner: 'leftBottom', x: L, y: B, sx: 1, sy: 1 }
  ];

  var marks = [];
  for (var i = 0; i < corners.length; i++) {
    var c = corners[i];
    if (o.count === 3 && c.corner === 'rightTop') continue;
    var x = c.x, y = c.y, sx = c.sx, sy = c.sy, pts;
    if (o.shape === 'square') {
      pts = [[x, y], [x + sx * s, y], [x + sx * s, y + sy * s], [x, y + sy * s]];
    } else {
      pts = [[x, y], [x + sx * s, y], [x + sx * s, y + sy * w],
             [x + sx * w, y + sy * w], [x + sx * w, y + sy * s], [x, y + sy * s]];
    }
    marks.push({ corner: c.corner, points: pts });
  }

  var m = o.marginMm * DOMBO_PT_PER_MM;
  return {
    marks: marks,
    extent: [L, T, R, B],
    paper: [L - m, T + m, R + m, B - m]
  };
}

// ---- 여기부터는 일러스트레이터 안에서만 동작 ----

function domboDoc() {
  if (app.documents.length === 0) throw new Error('열려 있는 문서가 없습니다.');
  return app.activeDocument;
}

function domboArtboardRect(doc) {
  return doc.artboards[doc.artboards.getActiveArtboardIndex()].artboardRect;
}

function domboSelectionBounds(doc) {
  var sel = doc.selection;
  if (!sel || sel.typename === 'TextRange' || sel.length === 0) {
    throw new Error('돔보를 찍을 작업물을 선택하세요. (글자 편집 중이면 선택 도구로 바꾸세요)');
  }
  var b = null;
  for (var i = 0; i < sel.length; i++) {
    var v = sel[i].visibleBounds;
    if (!b) { b = [v[0], v[1], v[2], v[3]]; continue; }
    if (v[0] < b[0]) b[0] = v[0];
    if (v[1] > b[1]) b[1] = v[1];
    if (v[2] > b[2]) b[2] = v[2];
    if (v[3] < b[3]) b[3] = v[3];
  }
  return b;
}

function domboFindLayer(doc, name) {
  for (var i = 0; i < doc.layers.length; i++) {
    if (doc.layers[i].name === name) return doc.layers[i];
  }
  return null;
}

function domboGetLayer(doc, name) {
  var layer = domboFindLayer(doc, name);
  if (!layer) {
    layer = doc.layers.add();
    layer.name = name;
  }
  layer.locked = false;
  layer.visible = true;
  return layer;
}

// 센서가 읽을 수 있도록 먹 100% (CMYK 문서) 또는 검정 (RGB 문서)
function domboBlack(doc) {
  if (doc.documentColorSpace === DocumentColorSpace.CMYK) {
    var k = new CMYKColor();
    k.cyan = 0; k.magenta = 0; k.yellow = 0; k.black = 100;
    return k;
  }
  var rgb = new RGBColor();
  rgb.red = 0; rgb.green = 0; rgb.blue = 0;
  return rgb;
}

function domboRemove() {
  var doc = domboDoc();
  var layer = domboFindLayer(doc, DOMBO_LAYER);
  if (!layer) return '지울 돔보마크가 없습니다.';
  layer.locked = false;
  layer.remove();
  return '돔보마크를 지웠습니다.';
}

function domboPlace(opts) {
  var doc = domboDoc();
  var o = domboMerge(opts);
  domboValidate(o);
  var bounds = o.target === 'artboard' ? domboArtboardRect(doc) : domboSelectionBounds(doc);
  var result = domboComputeMarks(bounds, o);

  // 다시 찍으면 기존 마크를 지우고 새로 만든다
  var old = domboFindLayer(doc, DOMBO_LAYER);
  if (old) { old.locked = false; old.remove(); }
  var layer = domboGetLayer(doc, DOMBO_LAYER);
  layer.zOrder(ZOrderMethod.BRINGTOFRONT);

  var black = domboBlack(doc);
  for (var i = 0; i < result.marks.length; i++) {
    var p = layer.pathItems.add();
    p.setEntirePath(result.marks[i].points);
    p.closed = true;
    p.filled = true;
    p.fillColor = black;
    p.stroked = false;
    p.name = '돔보_' + result.marks[i].corner;
  }
  layer.locked = true;

  var msg = result.marks.length + '점 돔보마크를 찍었습니다.';
  var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
  var r = ab.artboardRect, e = result.extent;
  var outside = e[0] < r[0] || e[1] > r[1] || e[2] > r[2] || e[3] < r[3];
  if (outside) {
    if (o.fitArtboard) {
      ab.artboardRect = result.paper;
      msg += ' 대지를 마크 바깥 ' + o.marginMm + 'mm 까지 넓혔습니다.';
    } else {
      msg += ' 주의: 마크가 대지 밖으로 나갔습니다.';
    }
  }
  return msg;
}

// 칼선 별색(CutContour) 견본을 찾거나 만든다
function domboCutColor(doc) {
  var spot;
  try {
    spot = doc.spots.getByName(DOMBO_CUT_SPOT);
  } catch (e) {
    spot = doc.spots.add();
    spot.name = DOMBO_CUT_SPOT;
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

// 복제본 안의 패스를 칼선 모양(면 없음, 별색 0.25pt 실선)으로 바꾼다. 글자 등은 지우고 개수를 센다.
function domboStyleCut(item, color, stat) {
  var t = item.typename;
  if (t === 'PathItem') {
    item.filled = false;
    item.stroked = true;
    item.strokeColor = color;
    item.strokeWidth = 0.25;
    item.strokeDashes = [];
    stat.paths++;
  } else if (t === 'CompoundPathItem') {
    for (var i = 0; i < item.pathItems.length; i++) domboStyleCut(item.pathItems[i], color, stat);
  } else if (t === 'GroupItem') {
    for (var j = item.pageItems.length - 1; j >= 0; j--) domboStyleCut(item.pageItems[j], color, stat);
  } else {
    item.remove();
    stat.skipped++;
  }
}

// 선택한 패스를 복제해 '칼선' 레이어에 CutContour 별색 선으로 만든다. 원본 작업물은 건드리지 않는다.
function domboCutContour() {
  var doc = domboDoc();
  var sel = doc.selection;
  if (!sel || sel.typename === 'TextRange' || sel.length === 0) {
    throw new Error('칼선으로 만들 패스를 선택하세요.');
  }
  var items = [];
  for (var i = 0; i < sel.length; i++) items.push(sel[i]);

  var layer = domboGetLayer(doc, DOMBO_CUT_LAYER);
  var color = domboCutColor(doc);
  var stat = { paths: 0, skipped: 0 };
  for (var j = 0; j < items.length; j++) {
    domboStyleCut(items[j].duplicate(layer, ElementPlacement.PLACEATEND), color, stat);
  }
  var msg = '칼선 ' + stat.paths + '개를 만들었습니다.';
  if (stat.skipped > 0) msg += ' 패스가 아닌 ' + stat.skipped + '개(글자·이미지 등)는 뺐습니다. 글자는 윤곽선 만들기 후 다시 하세요.';
  return msg;
}

// 패널에서 부르는 함수: 결과를 'OK:' 또는 'ERR:' 로 시작하는 글자로 돌려준다
function domboCall(fn, arg) {
  try {
    return 'OK:' + fn(arg);
  } catch (e) {
    return 'ERR:' + e.message;
  }
}
function domboPanelPlace(opts) { return domboCall(domboPlace, opts); }
function domboPanelRemove() { return domboCall(domboRemove); }
function domboPanelCut() { return domboCall(domboCutContour); }
