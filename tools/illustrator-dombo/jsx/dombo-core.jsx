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
    diameterMm: 6,       // 원형 마크 지름
    offsetMm: 5,         // 작업물 테두리와 마크 가장자리 사이 거리
    spacingMm: 300,      // 위·아래 변의 마크 중심 사이 최대 간격 (0 이면 네 모서리만)
    fitArtboard: true,   // 마크가 대지 밖으로 나가면 대지를 넓힌다
    marginMm: 5          // 대지를 넓힐 때 마크 바깥 여백
  };
}

var DOMBO_MAX_MARKS = 400;

function domboMerge(opts) {
  var o = domboDefaults();
  if (opts) {
    for (var k in opts) {
      if (opts.hasOwnProperty(k) && opts[k] !== undefined && opts[k] !== null) o[k] = opts[k];
    }
  }
  o.diameterMm = Number(o.diameterMm);
  o.offsetMm = Number(o.offsetMm);
  o.spacingMm = Number(o.spacingMm);
  o.marginMm = Number(o.marginMm);
  o.fitArtboard = o.fitArtboard === true || o.fitArtboard === 'true';
  return o;
}

function domboValidate(o) {
  if (!(o.diameterMm > 0)) throw new Error('마크 지름은 0보다 커야 합니다.');
  if (!(o.offsetMm >= 0)) throw new Error('작업물과의 거리는 0 이상이어야 합니다.');
  if (!(o.spacingMm >= 0)) throw new Error('마크 간격은 0 이상이어야 합니다. (0 이면 네 모서리만)');
  if (o.spacingMm > 0 && o.spacingMm <= o.diameterMm) {
    throw new Error('마크 간격은 마크 지름(' + o.diameterMm + 'mm)보다 커야 합니다.');
  }
  if (!(o.marginMm >= 0)) throw new Error('대지 여백은 0 이상이어야 합니다.');
}

// a 에서 b 까지를 간격이 spacing 이하가 되도록 똑같이 나눈 점들 (양 끝 포함)
function domboSteps(a, b, spacing) {
  var n = spacing > 0 ? Math.ceil((b - a) / spacing - 1e-9) : 1;
  if (n < 1) n = 1;
  var list = [];
  for (var i = 0; i <= n; i++) list.push(a + (b - a) * i / n);
  return list;
}

// 범위와 설정을 받아 원형 마크의 중심 목록을 계산한다 (일러스트레이터 없이도 동작).
// 마크는 작업물 둘레에 놓이고, 마크 가장자리와 작업물 테두리 사이가 정확히 '거리' 만큼 떨어진다.
// 네 모서리에는 항상 마크가 있고, 위·아래 변만 간격이 설정값을 넘지 않도록 똑같이 나눈다.
// 왼쪽·오른쪽 변 가운데에는 찍지 않는다.
function domboComputeMarks(bounds, opts) {
  var o = domboMerge(opts);
  domboValidate(o);
  var r = o.diameterMm * DOMBO_PT_PER_MM / 2;
  var e = o.offsetMm * DOMBO_PT_PER_MM + r;
  var sp = o.spacingMm * DOMBO_PT_PER_MM;
  var L = bounds[0] - e, T = bounds[1] + e, R = bounds[2] + e, B = bounds[3] - e;

  var xs = domboSteps(L, R, sp);
  var count = 2 * xs.length;
  if (count > DOMBO_MAX_MARKS) {
    throw new Error('마크가 ' + count + '개로 너무 많습니다. 간격을 늘리세요.');
  }

  // 왼쪽 위에서 시작해 시계 방향
  var centers = [], i;
  for (i = 0; i < xs.length; i++) centers.push([xs[i], T]);
  for (i = xs.length - 1; i >= 0; i--) centers.push([xs[i], B]);

  var m = o.marginMm * DOMBO_PT_PER_MM;
  return {
    radius: r,
    centers: centers,
    spacingX: (R - L) / (xs.length - 1),
    extent: [L - r, T + r, R + r, B - r],
    paper: [L - r - m, T + r + m, R + r + m, B - r - m]
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

function domboUnion(b, v) {
  if (!b) return [v[0], v[1], v[2], v[3]];
  return [Math.min(b[0], v[0]), Math.max(b[1], v[1]), Math.max(b[2], v[2]), Math.min(b[3], v[3])];
}

// 클리핑 마스크 그룹에서 마스크 모양(패스 또는 복합 패스)을 찾는다. 없으면 null
function domboClipMask(group) {
  if (group.typename !== 'GroupItem' || !group.clipped) return null;
  var kids = group.pageItems;
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i];
    if (k.typename === 'PathItem' && k.clipping) return k;
    if (k.typename === 'CompoundPathItem' && k.pathItems.length > 0 && k.pathItems[0].clipping) return k;
  }
  return null;
}

// 눈에 보이는 범위. 클리핑 마스크 그룹은 가려진 부분을 빼고 마스크 모양만 기준으로 삼는다.
// (일러스트레이터의 visibleBounds 는 마스크에 가려진 부분까지 포함하기 때문)
// 숨긴 개체나 안내선만 있으면 null
function domboItemBounds(item) {
  if (item.hidden || item.guides) return null;
  if (item.typename === 'GroupItem') {
    var mask = domboClipMask(item);
    if (mask) return mask.geometricBounds;
    var b = null;
    for (var i = 0; i < item.pageItems.length; i++) {
      var v = domboItemBounds(item.pageItems[i]);
      if (v) b = domboUnion(b, v);
    }
    return b;
  }
  return item.visibleBounds;
}

function domboHasSelection(doc) {
  var sel = doc.selection;
  return !!sel && sel.typename !== 'TextRange' && sel.length > 0;
}

// 레이어(하위 레이어 포함)에서 보이는 맨 위 개체들을 모은다. 돔보·칼선 레이어는 뺀다.
function domboLayerItems(layer, out) {
  if (!layer.visible || layer.name === DOMBO_LAYER || layer.name === DOMBO_CUT_LAYER) return;
  for (var i = 0; i < layer.pageItems.length; i++) out.push(layer.pageItems[i]);
  for (var j = 0; j < layer.layers.length; j++) domboLayerItems(layer.layers[j], out);
}

// 돔보 기준 범위: 선택한 개체가 있으면 그것, 없으면 문서의 보이는 개체 전체 (대지 밖에 있어도 포함)
function domboArtworkBounds(doc) {
  var items = [], i, b = null, v;
  if (domboHasSelection(doc)) {
    for (i = 0; i < doc.selection.length; i++) items.push(doc.selection[i]);
    for (i = 0; i < items.length; i++) {
      v = domboItemBounds(items[i]);
      if (v) b = domboUnion(b, v);
    }
    if (!b) throw new Error('선택한 개체에 보이는 모양이 없습니다.');
    return b;
  }
  if (doc.selection && doc.selection.typename === 'TextRange') {
    throw new Error('글자 편집 중입니다. 선택 도구로 바꾼 뒤 다시 하세요.');
  }
  for (i = 0; i < doc.layers.length; i++) domboLayerItems(doc.layers[i], items);
  for (i = 0; i < items.length; i++) {
    v = domboItemBounds(items[i]);
    if (v) b = domboUnion(b, v);
  }
  if (!b) throw new Error('돔보를 찍을 개체가 없습니다.');
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
  var bounds = o.target === 'artboard' ? domboArtboardRect(doc) : domboArtworkBounds(doc);
  var result = domboComputeMarks(bounds, o);

  // 다시 찍으면 기존 마크를 지우고 새로 만든다
  var old = domboFindLayer(doc, DOMBO_LAYER);
  if (old) { old.locked = false; old.remove(); }
  var layer = domboGetLayer(doc, DOMBO_LAYER);
  layer.zOrder(ZOrderMethod.BRINGTOFRONT);

  var black = domboBlack(doc);
  var r = result.radius;
  for (var i = 0; i < result.centers.length; i++) {
    var c = result.centers[i];
    var p = layer.pathItems.ellipse(c[1] + r, c[0] - r, 2 * r, 2 * r);
    p.filled = true;
    p.fillColor = black;
    p.stroked = false;
    p.name = '돔보_' + (i + 1);
  }
  layer.locked = true;

  var mm = function (pt) { return Math.round(pt / DOMBO_PT_PER_MM * 10) / 10; };
  var msg = '원형 돔보 ' + result.centers.length + '개를 찍었습니다. 실제 가로 간격 ' +
    mm(result.spacingX) + 'mm.';
  var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
  var ar = ab.artboardRect, e = result.extent;
  var outside = e[0] < ar[0] || e[1] > ar[1] || e[2] > ar[2] || e[3] < ar[3];
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

// 패스를 칼선 모양(면 없음, 별색 0.25pt 실선)으로 바꾼다
function domboStyleCutPath(p, color) {
  p.filled = false;
  p.stroked = true;
  p.strokeColor = color;
  p.strokeWidth = 0.25;
  p.strokeDashes = [];
}

// 개체에서 칼선이 될 패스만 '칼선' 레이어로 복제한다. 원본은 건드리지 않는다.
// 클리핑 마스크 그룹은 안쪽 내용은 빼고 마스크 모양 하나만 칼선으로 만든다.
function domboCollectCut(item, layer, color, stat) {
  if (item.hidden || item.guides) return;
  var t = item.typename, dup, i;
  if (t === 'GroupItem') {
    var mask = domboClipMask(item);
    if (mask) {
      dup = mask.duplicate(layer, ElementPlacement.PLACEATEND);
      if (dup.typename === 'PathItem') {
        dup.clipping = false;
        domboStyleCutPath(dup, color);
      } else {
        for (i = 0; i < dup.pathItems.length; i++) {
          dup.pathItems[i].clipping = false;
          domboStyleCutPath(dup.pathItems[i], color);
        }
      }
      stat.paths++;
      return;
    }
    for (i = 0; i < item.pageItems.length; i++) domboCollectCut(item.pageItems[i], layer, color, stat);
  } else if (t === 'PathItem') {
    domboStyleCutPath(item.duplicate(layer, ElementPlacement.PLACEATEND), color);
    stat.paths++;
  } else if (t === 'CompoundPathItem') {
    dup = item.duplicate(layer, ElementPlacement.PLACEATEND);
    for (i = 0; i < dup.pathItems.length; i++) domboStyleCutPath(dup.pathItems[i], color);
    stat.paths++;
  } else {
    stat.skipped++;
  }
}

// 선택한 개체의 칼선을 '칼선' 레이어에 CutContour 별색 선으로 만든다.
function domboCutContour() {
  var doc = domboDoc();
  if (!domboHasSelection(doc)) throw new Error('칼선으로 만들 개체를 선택하세요.');
  var items = [];
  for (var i = 0; i < doc.selection.length; i++) items.push(doc.selection[i]);

  var layer = domboGetLayer(doc, DOMBO_CUT_LAYER);
  var color = domboCutColor(doc);
  var stat = { paths: 0, skipped: 0 };
  for (var j = 0; j < items.length; j++) domboCollectCut(items[j], layer, color, stat);
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
