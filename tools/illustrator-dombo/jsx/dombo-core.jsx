// 브로애드 일러스트레이터 도구 핵심 기능 (ExtendScript, ES3 문법만 사용)
// 돔보마크, 칼선, 격자 칼선, 막대 + 박스, 아일렛, 분할, 치수 표시, 개수 세기. 패널(index.html)과 단독 스크립트(jsx/*.jsx)가 함께 쓴다.
// 좌표는 일러스트레이터 문서 좌표: 단위 pt, 위로 갈수록 y 가 커진다.
// 범위(bounds)는 [왼쪽, 위, 오른쪽, 아래] 순서이고 위 > 아래 이다.

var DOMBO_VERSION = '1.15.1'; // CSXS/manifest.xml 과 같게. 패널 위에 보여 준다
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
    marginMm: 5,         // 대지를 넓힐 때 마크 바깥 여백
    orientMark: true,    // 좌우(방향)를 알 수 있게 모서리 옆에 점 하나 더
    orientMm: 50,        // 모서리 마크 중심에서 방향 표시점 중심까지
    orientCorner: 'rb'   // 어느 모서리 옆: 'rb' 오른쪽 아래 / 'lb' 왼쪽 아래 / 'rt' 오른쪽 위 / 'lt' 왼쪽 위
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
  o.orientMark = o.orientMark === true || o.orientMark === 'true';
  o.orientMm = Number(o.orientMm);
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
  if (o.orientMark) {
    if (o.orientCorner !== 'rb' && o.orientCorner !== 'lb' && o.orientCorner !== 'rt' && o.orientCorner !== 'lt') {
      throw new Error('방향 표시점 위치가 잘못됐습니다.');
    }
    if (!(o.orientMm > o.diameterMm)) throw new Error('방향 표시점 거리는 마크 지름(' + o.diameterMm + 'mm)보다 커야 합니다.');
  }
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

  // 방향 표시점: 고른 모서리에서 가로 변을 따라 안쪽으로 orientMm (중심 사이 거리)
  var orient = -1;
  if (o.orientMark) {
    var d = o.orientMm * DOMBO_PT_PER_MM;
    var right = o.orientCorner.charAt(0) === 'r', top = o.orientCorner.charAt(1) === 't';
    var ox = right ? R - d : L + d, oy = top ? T : B;
    if (d >= (R - L) - 2 * r) throw new Error('방향 표시점 거리가 작업물 폭보다 깁니다. 거리를 줄이세요.');
    for (i = 0; i < centers.length; i++) {
      if (Math.abs(centers[i][1] - oy) < 1e-6 && Math.abs(centers[i][0] - ox) < 2 * r + DOMBO_PT_PER_MM) {
        throw new Error('방향 표시점이 다른 마크와 겹칩니다. 방향 표시점 거리나 마크 간격을 바꾸세요.');
      }
    }
    orient = centers.length;
    centers.push([ox, oy]);
  }

  var m = o.marginMm * DOMBO_PT_PER_MM;
  return {
    radius: r,
    centers: centers,
    orient: orient,   // 방향 표시점 번호 (없으면 -1)
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
// 숨긴 개체나 안내선만 있으면 null. geometric 이면 선 두께를 뺀 패스 범위
function domboItemBounds(item, geometric) {
  if (item.hidden || item.guides) return null;
  if (item.typename === 'GroupItem') {
    var mask = domboClipMask(item);
    if (mask) return mask.geometricBounds;
    var b = null;
    for (var i = 0; i < item.pageItems.length; i++) {
      var v = domboItemBounds(item.pageItems[i], geometric);
      if (v) b = domboUnion(b, v);
    }
    return b;
  }
  return geometric ? item.geometricBounds : item.visibleBounds;
}

function domboHasSelection(doc) {
  var sel = doc.selection;
  return !!sel && sel.typename !== 'TextRange' && sel.length > 0;
}

// 레이어(하위 레이어 포함)에서 보이는 맨 위 개체들을 모은다. 돔보·칼선·치수 레이어는 뺀다.
function domboLayerItems(layer, out) {
  if (!layer.visible || layer.name === DOMBO_LAYER || layer.name === DOMBO_CUT_LAYER || layer.name === DOMBO_DIM_LAYER || layer.name === DOMBO_GROMMET_LAYER || layer.name === DOMBO_SPLIT_LAYER || layer.name === DOMBO_SIZE_LAYER || layer.name === DOMBO_NUM_LAYER) return;
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
    p.name = i === result.orient ? '돔보_방향' : '돔보_' + (i + 1);
  }
  layer.locked = true;

  var mm = function (pt) { return Math.round(pt / DOMBO_PT_PER_MM * 10) / 10; };
  var msg = '원형 돔보 ' + (result.centers.length - (result.orient >= 0 ? 1 : 0)) + '개' +
    (result.orient >= 0 ? ' + 방향 표시점 1개' : '') + '를 찍었습니다. 실제 가로 간격 ' + mm(result.spacingX) + 'mm.';
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
// 살아있는 글자는 복제본을 아웃라인으로 바꾼다. 이미지 등은 건너뛰고 개수를 센다.
function domboCollectCut(item, layer, color, stat) {
  if (item.hidden || item.guides) return;
  var t = item.typename, dup, i;
  if (t === 'GroupItem') {
    var mask = domboClipMask(item);
    if (mask) {
      dup = mask.duplicate(layer, ElementPlacement.PLACEATEND);
      if (dup.typename === 'PathItem') {
        dup.clipping = false;
      } else {
        for (i = 0; i < dup.pathItems.length; i++) dup.pathItems[i].clipping = false;
      }
      domboStyleCutDeep(dup, color);
      stat.paths++;
      return;
    }
    for (i = 0; i < item.pageItems.length; i++) domboCollectCut(item.pageItems[i], layer, color, stat);
  } else if (t === 'PathItem' || t === 'CompoundPathItem') {
    domboStyleCutDeep(item.duplicate(layer, ElementPlacement.PLACEATEND), color);
    stat.paths++;
  } else if (t === 'TextFrame') {
    domboStyleCutDeep(item.duplicate(layer, ElementPlacement.PLACEATEND).createOutline(), color);
    stat.paths++;
  } else {
    stat.skipped++;
  }
}

function domboStyleCutDeep(item, color) {
  var t = item.typename, i;
  if (t === 'PathItem') domboStyleCutPath(item, color);
  else if (t === 'CompoundPathItem') for (i = 0; i < item.pathItems.length; i++) domboStyleCutPath(item.pathItems[i], color);
  else if (t === 'GroupItem') for (i = 0; i < item.pageItems.length; i++) domboStyleCutDeep(item.pageItems[i], color);
}

// 작업물 하나의 칼선. 기준은 크기·헤베와 같다:
//  맨 바깥 클리핑 마스크 → 마스크 모양, 마스크 없는 그룹 → 그룹 도형을 합친 외곽선 하나, 그 밖 → 그 개체 모양
// unite(group) 는 그룹 안 패스를 하나로 합쳐 돌려준다 (일러스트에서는 domboUnite). 결과: 기준(pick) 또는 null
function domboCutOne(target, layer, color, stat, unite) {
  var pick = domboHebePick([target]);
  if (!pick) return null;
  if (pick.kind !== '그룹') {
    var before0 = stat.paths;
    domboCollectCut(pick.item, layer, color, stat);
    return stat.paths > before0 ? pick : null;
  }
  var tmp = layer.groupItems.add(), before = stat.paths;
  domboCollectCut(pick.item, tmp, color, stat);
  if (stat.paths === before) { tmp.remove(); return null; }
  stat.paths = before + 1;
  domboStyleCutDeep(unite ? unite(tmp) : tmp, color);
  return pick;
}

// 그룹 안 패스를 패스파인더 '합치기' 로 외곽선 하나로. 안 되면 그대로 둔다
function domboUnite(group) {
  var doc = app.activeDocument;
  try {
    doc.selection = null;
    group.selected = true;
    app.executeMenuCommand('Live Pathfinder Add');
    app.executeMenuCommand('expandStyle');
    var r = doc.selection.length > 0 ? doc.selection[0] : group;
    doc.selection = null;
    return r;
  } catch (e) {
    doc.selection = null;
    return group;
  }
}

// 범위를 사방으로 n(pt)만큼 키우려면 가로·세로를 몇 % 로 늘려야 하는지
function domboBleedScale(bounds, n) {
  var w = bounds[2] - bounds[0], h = bounds[1] - bounds[3];
  if (!(w > 0) || !(h > 0)) throw new Error('크기가 0인 개체는 도련을 줄 수 없습니다.');
  return [(w + 2 * n) / w * 100, (h + 2 * n) / h * 100];
}

// 개체를 가로·세로로 키워 기준 범위(bounds)가 사방 n(pt) 씩 커지게, 가운데는 그대로
function domboGrow(item, bounds, n, measure) {
  var s = domboBleedScale(bounds, n);
  var cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
  item.resize(s[0], s[1], true, true, true, true, 100, Transformation.CENTER);
  var nb = measure();
  item.translate(cx - (nb[0] + nb[2]) / 2, cy - (nb[1] + nb[3]) / 2);
}

// 도련 한 개: 원본은 그대로 두고 복제본을 원본 바로 아래(뒤)에 놓아 사방 n(pt) 키운다.
//  mode 'item': 복제본 전체를 키움 / 'mask': 맨 바깥 마스크만 키워 가려졌던 그림이 보이게 (마스크가 없으면 전체를 키움)
// 결과: 실제로 쓴 방식 'item' | 'mask', 기준이 없으면 null
function domboBleedOne(target, n, mode) {
  var pick = domboHebePick([target]);
  if (!pick) return null;
  var dup = target.duplicate(target, ElementPlacement.PLACEAFTER);
  dup.name = '도련';
  var dp = domboHebePick([dup]);
  if (mode === 'mask' && dp.kind === '클리핑 마스크') {
    var mask = domboClipMask(dp.item);
    domboGrow(mask, dp.bounds, n, function () { return mask.geometricBounds; });
    return 'mask';
  }
  domboGrow(dup, dp.bounds, n, function () { return domboHebePick([dup]).bounds; });
  return 'item';
}

// 선택한 작업물마다 도련. opts: { mode: 'item' | 'mask', bleedMm: 파일에서 보이는 mm }
function domboBleed(opts) {
  var mode = opts && opts.mode === 'mask' ? 'mask' : 'item';
  var bleedMm = Number(opts && opts.bleedMm);
  if (!(bleedMm > 0 && bleedMm <= 50)) throw new Error('도련은 0 보다 크고 50mm 이하로 넣으세요.');
  var doc = domboDoc();
  if (doc.selection && doc.selection.typename === 'TextRange') throw new Error('글자 편집 중입니다. 선택 도구로 바꾼 뒤 다시 하세요.');
  if (!domboHasSelection(doc)) throw new Error('도련을 줄 작업물을 선택하세요.');
  var sel = [], i;
  for (i = 0; i < doc.selection.length; i++) sel.push(doc.selection[i]);
  var targets = domboSizeTargets(sel);
  var factor = 1;
  try { factor = Number(doc.scaleFactor) || 1; } catch (e) { factor = 1; }
  var n = bleedMm / factor * DOMBO_PT_PER_MM; // 큰 캔버스 문서는 스크립트 좌표가 1/10
  doc.selection = null;
  var done = 0, noMask = 0;
  for (i = 0; i < targets.length; i++) {
    var r = domboBleedOne(targets[i], n, mode);
    if (!r) continue;
    done++;
    if (mode === 'mask' && r === 'item') noMask++;
  }
  if (!done) throw new Error('선택한 것에 보이는 모양이 없습니다.');
  var msg = done + '개에 도련 ' + bleedMm + 'mm' +
    (mode === 'mask' ? ' 를 마스크로' : ' 를 원본 크기 키우기로') + ' 넣었습니다. 원본 바로 아래에 \'도련\' 으로 있습니다.';
  if (noMask) msg += ' 마스크가 없는 ' + noMask + '개는 원본 크기 키우기로 했습니다.';
  return msg;
}

// 선택한 작업물마다 칼선을 '칼선' 레이어에 CutContour 별색 선으로 만든다. 고르는 법은 사이즈 표시와 같다.
function domboCutContour() {
  var doc = domboDoc();
  if (doc.selection && doc.selection.typename === 'TextRange') throw new Error('글자 편집 중입니다. 선택 도구로 바꾼 뒤 다시 하세요.');
  if (!domboHasSelection(doc)) throw new Error('칼선으로 만들 작업물을 선택하세요.');
  var sel = [], i;
  for (i = 0; i < doc.selection.length; i++) sel.push(doc.selection[i]);
  var targets = domboSizeTargets(sel);
  var layer = domboGetLayer(doc, DOMBO_CUT_LAYER);
  var color = domboCutColor(doc);
  var stat = { paths: 0, skipped: 0 };
  for (i = 0; i < targets.length; i++) domboCutOne(targets[i], layer, color, stat, domboUnite);
  if (stat.paths === 0) throw new Error('칼선으로 만들 패스가 없습니다.');
  doc.selection = null;
  var msg = '칼선 ' + stat.paths + '개를 만들었습니다.';
  if (stat.skipped > 0) msg += ' 패스가 아닌 ' + stat.skipped + '개(이미지 등)는 뺐습니다.';
  return msg;
}

// ---- 격자 칼선 ----

// 숫자 목록을 정렬하고, tol 이내로 붙어 있는 값은 하나로 합친다
function domboUniqueSorted(arr, tol) {
  var a = arr.slice(0);
  a.sort(function (x, y) { return x - y; });
  var out = [];
  for (var i = 0; i < a.length; i++) {
    if (out.length === 0 || a[i] - out[out.length - 1] > tol) out.push(a[i]);
  }
  return out;
}

// 사각형 범위 목록을 받아 격자 칼선을 계산한다 (일러스트레이터 없이도 동작).
// 사각형의 모든 가로·세로 변 위치에 전체 영역을 가로지르는 선을 긋고,
// 왼쪽 위에서 시작해 칼이 빈 채로 움직이는 거리가 짧아지도록 순서와 방향을 정한다.
// 결과: [[시작x, 시작y], [끝x, 끝y]] 목록 (자를 순서대로)
function domboGridLines(boundsList, tolPt) {
  var xs = [], ys = [], i;
  for (i = 0; i < boundsList.length; i++) {
    var b = boundsList[i];
    xs.push(b[0], b[2]);
    ys.push(b[1], b[3]);
  }
  xs = domboUniqueSorted(xs, tolPt);
  ys = domboUniqueSorted(ys, tolPt);
  if (xs.length < 2 || ys.length < 2) throw new Error('사각형 크기가 너무 작습니다.');
  var minX = xs[0], maxX = xs[xs.length - 1], minY = ys[0], maxY = ys[ys.length - 1];

  var lines = [];
  for (i = 0; i < xs.length; i++) lines.push([[xs[i], maxY], [xs[i], minY]]);
  for (i = 0; i < ys.length; i++) lines.push([[minX, ys[i]], [maxX, ys[i]]]);

  // 가장 가까운 선의 가까운 끝부터 자른다. 반대쪽 끝이 더 가까우면 선 방향을 뒤집는다.
  var pen = [minX, maxY], ordered = [];
  var d2 = function (p, q) { return (p[0] - q[0]) * (p[0] - q[0]) + (p[1] - q[1]) * (p[1] - q[1]); };
  while (lines.length > 0) {
    var best = 0, bestD = Infinity, flip = false;
    for (i = 0; i < lines.length; i++) {
      var ds = d2(pen, lines[i][0]), de = d2(pen, lines[i][1]);
      if (ds < bestD) { bestD = ds; best = i; flip = false; }
      if (de < bestD) { bestD = de; best = i; flip = true; }
    }
    var ln = lines.splice(best, 1)[0];
    if (flip) ln = [ln[1], ln[0]];
    ordered.push(ln);
    pen = ln[1];
  }
  return ordered;
}

// 닫힌 4점 패스(사각형)를 그룹 안까지 찾아 모은다
function domboCollectRects(item, out) {
  if (item.hidden || item.guides) return;
  if (item.typename === 'PathItem') {
    if (item.closed && !item.clipping && item.pathPoints.length === 4) out.push(item);
  } else if (item.typename === 'GroupItem') {
    for (var i = 0; i < item.pageItems.length; i++) domboCollectRects(item.pageItems[i], out);
  }
}

// 선택한 사각형들로 격자 칼선을 만들어 '칼선' 레이어에 자를 순서대로 쌓는다 (맨 아래가 첫 번째).
function domboGridCut(opts) {
  var doc = domboDoc();
  var removeRects = !opts || opts.removeRects !== false && opts.removeRects !== 'false';
  if (!domboHasSelection(doc)) throw new Error('격자 칼선의 기준이 될 사각형을 선택하세요.');
  var rects = [], i;
  for (i = 0; i < doc.selection.length; i++) domboCollectRects(doc.selection[i], rects);
  if (rects.length === 0) throw new Error('선택한 것 중에 사각형(점 4개짜리 닫힌 패스)이 없습니다.');

  var bounds = [];
  for (i = 0; i < rects.length; i++) bounds.push(rects[i].geometricBounds);
  var lines = domboGridLines(bounds, 0.1 * DOMBO_PT_PER_MM);

  var layer = domboGetLayer(doc, DOMBO_CUT_LAYER);
  var color = domboCutColor(doc);
  var made = [];
  for (i = 0; i < lines.length; i++) {
    // 새 패스는 레이어 맨 위에 들어가므로, 순서대로 만들면 첫 번째 선이 맨 아래가 된다
    var p = layer.pathItems.add();
    p.setEntirePath(lines[i]);
    p.closed = false;
    domboStyleCutPath(p, color);
    p.name = '격자칼선_' + (i + 1);
    made.push(p);
  }
  if (removeRects) {
    for (i = 0; i < rects.length; i++) rects[i].remove();
  }
  doc.selection = null;
  for (i = 0; i < made.length; i++) made[i].selected = true;

  return '격자 칼선 ' + made.length + '개를 자르는 순서대로 만들었습니다.' +
    (removeRects ? ' 기준 사각형 ' + rects.length + '개는 지웠습니다.' : '');
}

// ---- 막대 + 박스 ----

function domboBarBoxDefaults() {
  return {
    useBar: true,       // 막대 만들기
    barHeightMm: 2,     // 막대 높이(두께)
    barGapMm: 5,        // 객체 위쪽과 막대 사이 간격
    boxMarginMm: 10,    // 박스 여백 (객체 + 막대 바깥으로)
    boxAsCut: false     // 박스를 칼선(CutContour)으로
  };
}

function domboBarBoxMerge(opts) {
  var o = domboBarBoxDefaults();
  if (opts) {
    for (var k in opts) {
      if (opts.hasOwnProperty(k) && opts[k] !== undefined && opts[k] !== null) o[k] = opts[k];
    }
  }
  o.useBar = o.useBar === true || o.useBar === 'true';
  o.boxAsCut = o.boxAsCut === true || o.boxAsCut === 'true';
  o.barHeightMm = Number(o.barHeightMm);
  o.barGapMm = Number(o.barGapMm);
  o.boxMarginMm = Number(o.boxMarginMm);
  if (o.useBar && !(o.barHeightMm > 0)) throw new Error('막대 높이는 0보다 커야 합니다.');
  if (o.useBar && !(o.barGapMm >= 0)) throw new Error('막대 간격은 0 이상이어야 합니다.');
  if (!(o.boxMarginMm >= 0)) throw new Error('박스 여백은 0 이상이어야 합니다.');
  return o;
}

// 객체 범위를 받아 막대와 박스의 [위, 왼쪽, 가로, 세로] 를 계산한다 (일러스트레이터 없이도 동작).
// 막대는 객체 위쪽으로 간격만큼 띄우고 객체와 같은 가로 길이. 박스는 객체 + 막대를 여백만큼 감싼다.
function domboBarBoxRects(bounds, opts) {
  var o = domboBarBoxMerge(opts);
  var L = bounds[0], T = bounds[1], R = bounds[2], B = bounds[3];
  var h = o.barHeightMm * DOMBO_PT_PER_MM, g = o.barGapMm * DOMBO_PT_PER_MM, m = o.boxMarginMm * DOMBO_PT_PER_MM;
  var top = T, bar = null;
  if (o.useBar) {
    top = T + g + h;
    bar = [top, L, R - L, h];
  }
  return { bar: bar, box: [top + m, L - m, R - L + 2 * m, top - B + 2 * m] };
}

// 대상 고르기: 여러 개 선택 → 각각. 그룹 하나 선택 → 안의 하위 그룹마다 (하위 그룹이 없으면 그룹 전체).
function domboBarBoxTargets(sel) {
  var targets = [], i;
  if (sel.length > 1) {
    for (i = 0; i < sel.length; i++) targets.push(sel[i]);
    return targets;
  }
  var obj = sel[0];
  if (obj.typename === 'GroupItem' && !obj.clipped) {
    for (i = 0; i < obj.pageItems.length; i++) {
      var k = obj.pageItems[i];
      if (k.typename === 'GroupItem' && !k.hidden) targets.push(k);
    }
  }
  if (targets.length === 0) targets.push(obj);
  return targets;
}

function domboBarBox(opts) {
  var doc = domboDoc();
  var o = domboBarBoxMerge(opts);
  if (!domboHasSelection(doc)) throw new Error('막대와 박스를 만들 객체를 선택하세요.');
  var layer = doc.activeLayer;
  if (layer.locked || !layer.visible || layer.name === DOMBO_LAYER) {
    throw new Error("지금 레이어('" + layer.name + "')가 잠겨 있거나 숨겨져 있습니다. 다른 레이어를 고르세요.");
  }
  var targets = domboBarBoxTargets(doc.selection);
  var black = domboBlack(doc);
  var cut = o.boxAsCut ? domboCutColor(doc) : null;
  var made = 0;
  for (var i = 0; i < targets.length; i++) {
    var b = domboItemBounds(targets[i]);
    if (!b) continue;
    var r = domboBarBoxRects(b, o);
    if (r.bar) {
      var bar = layer.pathItems.rectangle(r.bar[0], r.bar[1], r.bar[2], r.bar[3]);
      bar.filled = true;
      bar.fillColor = black;
      bar.stroked = false;
      bar.name = '막대_' + (made + 1);
    }
    var box = layer.pathItems.rectangle(r.box[0], r.box[1], r.box[2], r.box[3]);
    box.filled = false;
    if (cut) {
      domboStyleCutPath(box, cut);
    } else {
      box.stroked = true;
      box.strokeColor = black;
      box.strokeWidth = 1;
    }
    box.name = '박스_' + (made + 1);
    made++;
  }
  if (made === 0) throw new Error('선택한 것에 보이는 모양이 없습니다.');
  return made + '개 객체 기준으로 ' + (o.useBar ? '막대와 박스를' : '박스를') + ' 만들었습니다.';
}

// ---- 아일렛(타공) 표시 ----

var DOMBO_GROMMET_LAYER = '아일렛';

function domboGrommetDefaults() {
  return {
    top: 2, bottom: 2, left: 0, right: 0, // 변마다 개수 (모서리 포함)
    marginMm: 10,      // 테두리에서 원 바깥선까지
    diameterMm: 5,     // 타공 크기 (지름)
    strokePt: 1        // 원 선 두께 (pt)
  };
}

function domboGrommetMerge(opts) {
  var o = domboGrommetDefaults();
  if (opts) {
    for (var k in opts) {
      if (opts.hasOwnProperty(k) && opts[k] !== undefined && opts[k] !== null && opts[k] !== '') o[k] = opts[k];
    }
  }
  var counts = ['top', 'bottom', 'left', 'right'], i;
  for (i = 0; i < counts.length; i++) {
    var n = Number(o[counts[i]]);
    if (!(n >= 0) || Math.floor(n) !== n || n > 200) throw new Error('개수는 0 ~ 200 사이의 정수여야 합니다.');
    o[counts[i]] = n;
  }
  o.marginMm = Number(o.marginMm);
  o.diameterMm = Number(o.diameterMm);
  o.strokePt = Number(o.strokePt);
  if (!(o.marginMm >= 0)) throw new Error('여백은 0 이상이어야 합니다.');
  if (!(o.diameterMm > 0)) throw new Error('타공 크기는 0보다 커야 합니다.');
  if (!(o.strokePt > 0)) throw new Error('선 두께는 0보다 커야 합니다.');
  if (o.top + o.bottom + o.left + o.right === 0) throw new Error('개수를 하나 이상 넣으세요.');
  return o;
}

// 범위를 받아 타공 원 중심 목록을 계산한다 (일러스트레이터 없이도 동작, 단위 pt)
// 원 바깥선이 테두리에서 여백만큼 떨어지도록 중심선은 (여백 + 반지름) 안쪽.
// 변마다 모서리를 포함해 똑같이 나눈다 (1개면 가운데). 모서리처럼 겹치는 자리는 하나만.
// 결과: { radius, centers: [[x, y], ...] } 또는 너무 작으면 centers 가 빈 목록
function domboGrommetCenters(bounds, opts) {
  var o = domboGrommetMerge(opts), k = DOMBO_PT_PER_MM;
  var r = o.diameterMm * k / 2, d = o.marginMm * k + r;
  var L = bounds[0] + d, T = bounds[1] - d, R = bounds[2] - d, B = bounds[3] + d;
  var out = [];
  if (R - L < 1 || T - B < 1) return { radius: r, centers: out };
  function add(x, y) {
    for (var i = 0; i < out.length; i++) if (Math.abs(out[i][0] - x) < 1 && Math.abs(out[i][1] - y) < 1) return;
    out.push([x, y]);
  }
  function spread(x1, y1, x2, y2, n) {
    if (n < 1) return;
    if (n === 1) { add((x1 + x2) / 2, (y1 + y2) / 2); return; }
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      add(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
    }
  }
  spread(L, T, R, T, o.top);
  spread(L, B, R, B, o.bottom);
  spread(L, T, L, B, o.left);
  spread(R, T, R, B, o.right);
  return { radius: r, centers: out };
}

function domboGrommet(opts) {
  var doc = domboDoc();
  var o = domboGrommetMerge(opts);
  if (!domboHasSelection(doc)) throw new Error('아일렛을 표시할 객체를 선택하세요.');
  var items = [], i, j;
  for (i = 0; i < doc.selection.length; i++) items.push(doc.selection[i]);

  var layer = domboGetLayer(doc, DOMBO_GROMMET_LAYER);
  layer.zOrder(ZOrderMethod.BRINGTOFRONT);
  var black = domboBlack(doc), made = [], small = 0, targets = 0;
  for (i = 0; i < items.length; i++) {
    var b = domboItemBounds(items[i], true);
    if (!b) continue;
    targets++;
    var g = domboGrommetCenters(b, o);
    if (g.centers.length === 0) { small++; continue; }
    for (j = 0; j < g.centers.length; j++) {
      var c = g.centers[j], dup = false;
      // 붙어 있는 객체끼리 같은 자리에 두 번 찍지 않는다
      for (var m = 0; m < made.length && !dup; m++) dup = Math.abs(made[m][0] - c[0]) < 1 && Math.abs(made[m][1] - c[1]) < 1;
      if (dup) continue;
      var hole = layer.pathItems.ellipse(c[1] + g.radius, c[0] - g.radius, 2 * g.radius, 2 * g.radius);
      hole.filled = false;
      hole.stroked = true;
      hole.strokeColor = black;
      hole.strokeWidth = o.strokePt;
      hole.name = '아일렛_' + (made.length + 1);
      made.push(c);
    }
  }
  if (targets === 0) throw new Error('선택한 것에 보이는 모양이 없습니다.');
  var msg = '아일렛 ' + made.length + '개를 표시했습니다.';
  if (small) msg += ' ' + small + '개는 여백에 비해 너무 작아서 건너뛰었습니다.';
  return msg;
}

function domboGrommetRemove() {
  var doc = domboDoc();
  var layer = domboFindLayer(doc, DOMBO_GROMMET_LAYER);
  if (!layer) return '지울 아일렛이 없습니다.';
  layer.locked = false;
  layer.remove();
  return '아일렛을 모두 지웠습니다.';
}

// ---- 분할 (N등분, 겹침) ----

var DOMBO_SPLIT_LAYER = '분할';

function domboSplitDefaults() {
  return {
    direction: 'h',    // 'h' 가로 분할 (|||, 좌우로 나눔) / 'v' 세로 분할 (≡, 위아래로 나눔)
    count: 3,          // 몇 등분
    overlapMm: 20,     // 이음매마다 겹치는 폭 (양쪽 합계)
    gapMm: 20          // 조각을 늘어놓을 때 사이 간격
  };
}

function domboSplitMerge(opts) {
  var o = domboSplitDefaults();
  if (opts) {
    for (var k in opts) {
      if (opts.hasOwnProperty(k) && opts[k] !== undefined && opts[k] !== null && opts[k] !== '') o[k] = opts[k];
    }
  }
  o.count = Number(o.count);
  o.overlapMm = Number(o.overlapMm);
  o.gapMm = Number(o.gapMm);
  if (o.direction !== 'h' && o.direction !== 'v') throw new Error('분할 방향이 잘못됐습니다.');
  if (!(o.count >= 2) || Math.floor(o.count) !== o.count || o.count > 100) throw new Error('분할 개수는 2 ~ 100 사이의 정수여야 합니다.');
  if (!(o.overlapMm >= 0)) throw new Error('겹침은 0 이상이어야 합니다.');
  if (!(o.gapMm >= 0)) throw new Error('늘어놓는 간격은 0 이상이어야 합니다.');
  return o;
}

// 전체 범위를 N등분한 조각 범위들 (일러스트레이터 없이도 동작, 단위 pt)
// 안쪽 이음매는 양쪽으로 겹침의 절반씩 늘린다 (바깥 테두리는 그대로).
// 결과: [[왼, 위, 오른, 아래], ...] 가로 분할은 왼쪽부터, 세로 분할은 위쪽부터
function domboSplitRects(bounds, opts) {
  var o = domboSplitMerge(opts);
  var L = bounds[0], T = bounds[1], R = bounds[2], B = bounds[3];
  var half = o.overlapMm * DOMBO_PT_PER_MM / 2, n = o.count, out = [], i;
  var step = o.direction === 'h' ? (R - L) / n : (T - B) / n;
  if (step <= half * 2) throw new Error('겹침이 조각 크기보다 큽니다. 겹침을 줄이거나 개수를 줄이세요.');
  for (i = 0; i < n; i++) {
    if (o.direction === 'h') {
      var x0 = L + step * i, x1 = x0 + step;
      out.push([i === 0 ? x0 : x0 - half, T, i === n - 1 ? x1 : x1 + half, B]);
    } else {
      var y0 = T - step * i, y1 = y0 - step;
      out.push([L, i === 0 ? y0 : y0 + half, R, i === n - 1 ? y1 : y1 - half]);
    }
  }
  return out;
}

// 조각들을 원본 아래 50mm 부터 간격을 두고 위에서 아래로 늘어놓을 때의 이동량 [dx, dy]
function domboSplitMoves(bounds, rects, gapPt) {
  var y = bounds[3] - 50 * DOMBO_PT_PER_MM, out = [];
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i];
    out.push([bounds[0] - r[0], y - r[1]]);
    y -= (r[1] - r[3]) + gapPt;
  }
  return out;
}

function domboSplit(opts) {
  var doc = domboDoc();
  var o = domboSplitMerge(opts);
  if (!domboHasSelection(doc)) throw new Error('분할할 객체를 선택하세요.');
  var items = [], i, j, all = null;
  for (i = 0; i < doc.selection.length; i++) items.push(doc.selection[i]);
  for (i = 0; i < items.length; i++) {
    var b = domboItemBounds(items[i], true);
    if (b) all = domboUnion(all, b);
  }
  if (!all) throw new Error('선택한 것에 보이는 모양이 없습니다.');
  var rects = domboSplitRects(all, o);
  var moves = domboSplitMoves(all, rects, o.gapMm * DOMBO_PT_PER_MM);

  var layer = domboGetLayer(doc, DOMBO_SPLIT_LAYER), pieces = [];
  for (i = 0; i < rects.length; i++) {
    // 원본을 복제해 그룹에 담고, 맨 위에 조각 사각형을 놓아 클리핑 마스크로
    var grp = layer.groupItems.add();
    for (j = 0; j < items.length; j++) items[j].duplicate(grp, ElementPlacement.PLACEATEND);
    var r = rects[i];
    var mask = grp.pathItems.rectangle(r[1], r[0], r[2] - r[0], r[1] - r[3]);
    mask.move(grp, ElementPlacement.PLACEATBEGINNING);
    grp.clipped = true;
    grp.name = '분할 ' + (i + 1) + '/' + rects.length;
    grp.translate(moves[i][0], moves[i][1]);
    pieces.push(grp);
  }
  doc.selection = null;
  for (i = 0; i < pieces.length; i++) pieces[i].selected = true;

  var k = DOMBO_PT_PER_MM, first = rects[0], mid = rects[Math.min(1, rects.length - 1)];
  var size = function (rc) { return Math.round((rc[2] - rc[0]) / k) + '×' + Math.round((rc[1] - rc[3]) / k) + 'mm'; };
  return (o.direction === 'h' ? '가로로 ' : '세로로 ') + rects.length + '등분했습니다 (겹침 ' + o.overlapMm + 'mm).\n' +
    '조각 크기: 끝 ' + size(first) + (rects.length > 2 ? ', 가운데 ' + size(mid) : '') + '. 원본 아래에 늘어놓았습니다.';
}

// ---- 치수 표시 ----

var DOMBO_DIM_LAYER = '치수';

function domboDimDefaults() {
  return {
    target: 'each',     // 'each' 선택한 것마다 / 'all' 전체를 하나로
    showW: true,        // 가로 치수
    showH: true,        // 세로 치수
    hSide: 'top',       // 가로 치수 위치 'top' / 'bottom'
    vSide: 'right',     // 세로 치수 위치 'right' / 'left'
    offsetMm: 10,       // 객체와 치수선 사이
    textAuto: true,     // 글자 크기를 객체 크기에 맞춤
    textMm: 5,          // 글자 크기 (자동이 아닐 때)
    decimals: 0,        // 소수점 자리
    unit: true,         // 'mm' 붙이기
    stroke: false       // 선 두께 포함해서 재기 (기본은 패스 크기)
  };
}

function domboDimMerge(opts) {
  var o = domboDimDefaults();
  if (opts) {
    for (var k in opts) {
      if (opts.hasOwnProperty(k) && opts[k] !== undefined && opts[k] !== null) o[k] = opts[k];
    }
  }
  var bools = ['showW', 'showH', 'textAuto', 'unit', 'stroke'];
  for (var i = 0; i < bools.length; i++) o[bools[i]] = o[bools[i]] === true || o[bools[i]] === 'true';
  o.offsetMm = Number(o.offsetMm);
  o.textMm = Number(o.textMm);
  o.decimals = Number(o.decimals);
  if (o.target !== 'each' && o.target !== 'all') throw new Error('치수 기준이 잘못됐습니다.');
  if (o.hSide !== 'top' && o.hSide !== 'bottom') throw new Error('가로 치수 위치가 잘못됐습니다.');
  if (o.vSide !== 'right' && o.vSide !== 'left') throw new Error('세로 치수 위치가 잘못됐습니다.');
  if (!o.showW && !o.showH) throw new Error('가로·세로 중 하나는 골라야 합니다.');
  if (!(o.offsetMm >= 0)) throw new Error('치수선 거리는 0 이상이어야 합니다.');
  if (!o.textAuto && !(o.textMm > 0)) throw new Error('글자 크기는 0보다 커야 합니다.');
  if (o.decimals !== 0 && o.decimals !== 1 && o.decimals !== 2) throw new Error('소수점 자리는 0, 1, 2 중 하나여야 합니다.');
  return o;
}

// 치수 글자: 300 → '300 mm', 소수점 자리 맞춤
function domboDimLabel(mm, decimals, unit) {
  var f = Math.pow(10, decimals), v = Math.round(mm * f) / f;
  var str = decimals > 0 ? v.toFixed(decimals) : String(v);
  // 천 단위 쉼표
  var parts = str.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.') + (unit ? ' mm' : '');
}

// 범위를 받아 치수선·화살표·글자 자리를 계산한다 (일러스트레이터 없이도 동작, 단위 pt)
// 결과: { textPt, strokePt, lines: [[[x,y],[x,y]], ...], arrows: [[[x,y]x3], ...], texts: [{ x, y, angle, str }] }
//  - 글자 x, y 는 글자 가운데 자리, angle 90 이면 세로(아래에서 위로 읽음)
function domboDimGeometry(bounds, opts) {
  var o = domboDimMerge(opts), k = DOMBO_PT_PER_MM;
  var L = bounds[0], T = bounds[1], R = bounds[2], B = bounds[3];
  var wMm = (R - L) / k, hMm = (T - B) / k;
  var textMm = o.textAuto ? Math.min(60, Math.max(2.5, Math.max(wMm, hMm) * 0.03)) : o.textMm;
  var tp = textMm * k;                         // 글자 크기 (pt)
  var arrow = tp * 0.6, half = arrow * 0.3;   // 화살표 길이, 반폭
  var gap = tp * 0.25;                         // 객체와 보조선 사이 틈
  var over = tp * 0.4;                         // 보조선이 치수선 너머로 나가는 길이
  var off = o.offsetMm * k + tp * 0.5;
  var lines = [], arrows = [], texts = [];

  if (o.showW) {
    var dir = o.hSide === 'top' ? 1 : -1, edge = dir > 0 ? T : B, y = edge + dir * off;
    lines.push([[L, edge + dir * gap], [L, y + dir * over]]);
    lines.push([[R, edge + dir * gap], [R, y + dir * over]]);
    lines.push([[L, y], [R, y]]);
    arrows.push([[L, y], [L + arrow, y + half], [L + arrow, y - half]]);
    arrows.push([[R, y], [R - arrow, y + half], [R - arrow, y - half]]);
    texts.push({ x: (L + R) / 2, y: y + dir * tp * 0.75, angle: 0, str: domboDimLabel(wMm, o.decimals, o.unit) });
  }
  if (o.showH) {
    var dx = o.vSide === 'right' ? 1 : -1, side = dx > 0 ? R : L, x = side + dx * off;
    lines.push([[side + dx * gap, T], [x + dx * over, T]]);
    lines.push([[side + dx * gap, B], [x + dx * over, B]]);
    lines.push([[x, T], [x, B]]);
    arrows.push([[x, T], [x - half, T - arrow], [x + half, T - arrow]]);
    arrows.push([[x, B], [x - half, B + arrow], [x + half, B + arrow]]);
    texts.push({ x: x + dx * tp * 0.75, y: (T + B) / 2, angle: 90, str: domboDimLabel(hMm, o.decimals, o.unit) });
  }
  return { textPt: tp, strokePt: Math.max(0.3, tp / 25), lines: lines, arrows: arrows, texts: texts };
}

// 치수 색: 시안(파랑). 레이저 빨강·칼선 마젠타와 헷갈리지 않게
function domboDimColor(doc) {
  if (doc.documentColorSpace === DocumentColorSpace.CMYK) {
    var c = new CMYKColor();
    c.cyan = 100; c.magenta = 30; c.yellow = 0; c.black = 0;
    return c;
  }
  var r = new RGBColor();
  r.red = 0; r.green = 120; r.blue = 220;
  return r;
}

function domboDimDraw(doc, layer, bounds, o, color) {
  var g = domboDimGeometry(bounds, o);
  var grp = layer.groupItems.add(), i;
  grp.name = '치수';
  for (i = 0; i < g.lines.length; i++) {
    var ln = grp.pathItems.add();
    ln.setEntirePath(g.lines[i]);
    ln.closed = false;
    ln.filled = false;
    ln.stroked = true;
    ln.strokeColor = color;
    ln.strokeWidth = g.strokePt;
  }
  for (i = 0; i < g.arrows.length; i++) {
    var ar = grp.pathItems.add();
    ar.setEntirePath(g.arrows[i]);
    ar.closed = true;
    ar.filled = true;
    ar.fillColor = color;
    ar.stroked = false;
  }
  for (i = 0; i < g.texts.length; i++) {
    var t = g.texts[i], tf = grp.textFrames.add();
    tf.contents = t.str;
    var ca = tf.textRange.characterAttributes;
    ca.size = g.textPt;
    ca.fillColor = color;
    if (t.angle) tf.rotate(t.angle);
    // 글자 가운데를 계산한 자리로
    var b = tf.geometricBounds;
    tf.translate(t.x - (b[0] + b[2]) / 2, t.y - (b[1] + b[3]) / 2);
  }
  return grp;
}

function domboDimension(opts) {
  var doc = domboDoc();
  var o = domboDimMerge(opts);
  if (!domboHasSelection(doc)) throw new Error('치수를 표시할 객체를 선택하세요.');
  var items = [], i;
  for (i = 0; i < doc.selection.length; i++) items.push(doc.selection[i]);
  var boundsList = [], all = null;
  for (i = 0; i < items.length; i++) {
    var b = domboItemBounds(items[i], !o.stroke);
    if (!b) continue;
    boundsList.push(b);
    all = domboUnion(all, b);
  }
  if (!all) throw new Error('선택한 것에 보이는 모양이 없습니다.');
  if (o.target === 'all') boundsList = [all];

  var layer = domboGetLayer(doc, DOMBO_DIM_LAYER);
  layer.zOrder(ZOrderMethod.BRINGTOFRONT);
  var color = domboDimColor(doc), k = DOMBO_PT_PER_MM;
  for (i = 0; i < boundsList.length; i++) domboDimDraw(doc, layer, boundsList[i], o, color);
  doc.selection = null;

  var msg = boundsList.length + '개에 치수를 표시했습니다.';
  if (boundsList.length === 1) {
    var one = boundsList[0];
    msg += ' (' + domboDimLabel((one[2] - one[0]) / k, o.decimals, false) + ' × ' +
      domboDimLabel((one[1] - one[3]) / k, o.decimals, false) + ' mm)';
  }
  return msg + " '치수' 레이어에 있습니다.";
}

function domboDimRemove() {
  var doc = domboDoc();
  var layer = domboFindLayer(doc, DOMBO_DIM_LAYER);
  if (!layer) return '지울 치수가 없습니다.';
  layer.locked = false;
  layer.remove();
  return '치수를 모두 지웠습니다.';
}

// ---- 개수 세기 ----

function domboCountItem(item, c) {
  if (item.hidden || item.guides) return;
  var t = item.typename;
  if (t === 'TextFrame') {
    var txt = item.contents;
    c.frames++;
    c.chars += txt.length;
    c.charsNoSpace += txt.replace(/\s/g, '').length;
  } else if (t === 'CompoundPathItem') {
    if (!(item.pathItems.length > 0 && item.pathItems[0].clipping)) c.shapes++;
  } else if (t === 'PathItem') {
    if (!item.clipping) c.shapes++;
  } else if (t === 'GroupItem') {
    for (var i = 0; i < item.pageItems.length; i++) domboCountItem(item.pageItems[i], c);
  }
}

// 선택한 것(없으면 문서 전체)의 글자 수와 아웃라인 도형 수를 센다
function domboCount() {
  var doc = domboDoc();
  var items = [], i, scope;
  if (domboHasSelection(doc)) {
    for (i = 0; i < doc.selection.length; i++) items.push(doc.selection[i]);
    scope = '선택한 것';
  } else {
    for (i = 0; i < doc.layers.length; i++) domboLayerItems(doc.layers[i], items);
    scope = '문서 전체';
  }
  var c = { frames: 0, chars: 0, charsNoSpace: 0, shapes: 0 };
  for (i = 0; i < items.length; i++) domboCountItem(items[i], c);
  return '[' + scope + ']\n' +
    '살아있는 글자: ' + c.charsNoSpace + '자 (공백 포함 ' + c.chars + '자, 글상자 ' + c.frames + '개)\n' +
    '아웃라인 도형: ' + c.shapes + '개 (i·j 점처럼 떨어진 조각은 따로 셉니다)';
}

// ---- 크기·헤베 ----
// 기준 개체: 맨 바깥 클리핑 마스크(마지막에 씌운 마스크) > 그룹 > 선택한 것 중 가장 큰 개체. 같은 순위가 여럿이면 가장 큰 것
// 크기는 패스 기준(선 두께 제외), 마스크는 마스크 모양 기준

function domboArea(b) { return (b[2] - b[0]) * (b[1] - b[3]); }

// 그룹 안까지 내려가며 맨 바깥 클리핑 마스크 그룹을 모은다 (마스크 안의 마스크는 보지 않는다)
function domboOuterClips(item, out) {
  if (item.hidden || item.guides || item.typename !== 'GroupItem') return;
  if (domboClipMask(item)) { out.push(item); return; }
  for (var i = 0; i < item.pageItems.length; i++) domboOuterClips(item.pageItems[i], out);
}

function domboLargest(items) {
  var best = null;
  for (var i = 0; i < items.length; i++) {
    var b = domboItemBounds(items[i], true);
    if (b && (!best || domboArea(b) > domboArea(best.bounds))) best = { item: items[i], bounds: b };
  }
  return best;
}

// 결과: { kind: '클리핑 마스크' | '그룹' | '가장 큰 개체', item, bounds }
function domboHebePick(items) {
  var clips = [], groups = [], i, best;
  for (i = 0; i < items.length; i++) domboOuterClips(items[i], clips);
  best = domboLargest(clips);
  if (best) { best.kind = '클리핑 마스크'; return best; }
  for (i = 0; i < items.length; i++) if (items[i].typename === 'GroupItem') groups.push(items[i]);
  best = domboLargest(groups);
  if (best) { best.kind = '그룹'; return best; }
  best = domboLargest(items);
  if (best) { best.kind = '가장 큰 개체'; return best; }
  return null;
}

// 범위(pt)와 배율로 글자를 만든다. scale 10 = 1/10 로 그린 파일 (10:1). factor = 큰 캔버스 문서의 배율
// mm 를 정수면 정수로, 아니면 소수 1자리로 (천 단위 쉼표)
function domboMmLabel(mm, unit) {
  var whole = Math.abs(mm - Math.round(mm)) < 0.05;
  return domboDimLabel(mm, whole ? 0 : 1, unit);
}

function domboHebeText(pick, scale, factor) {
  var k = DOMBO_PT_PER_MM, b = pick.bounds, mul = scale * (factor || 1);
  var w = (b[2] - b[0]) / k * mul, h = (b[1] - b[3]) / k * mul;
  var m2 = Math.round(w * h / 1e4) / 100;
  var lines = ['기준: ' + pick.kind + (pick.item.name ? ' (' + pick.item.name + ')' : '') + ' · ' + (scale === 10 ? '10:1 파일 (×10)' : '1:1 파일')];
  lines.push('실제 크기: 가로 ' + domboMmLabel(w, true) + ' × 세로 ' + domboMmLabel(h, true));
  if (scale === 10) lines.push('(파일 크기 ' + domboMmLabel(w / 10, false) + ' × ' + domboMmLabel(h / 10, false) + ' mm)');
  lines.push('헤베: ' + m2.toFixed(2) + ' ㎡');
  return lines.join('\n');
}

function domboHebe(opts) {
  var scale = opts && Number(opts.scale) === 10 ? 10 : 1;
  var doc = domboDoc();
  if (doc.selection && doc.selection.typename === 'TextRange') throw new Error('글자 편집 중입니다. 선택 도구로 바꾼 뒤 다시 하세요.');
  if (!domboHasSelection(doc)) throw new Error('크기를 잴 작업물을 선택하세요.');
  var items = [];
  for (var i = 0; i < doc.selection.length; i++) items.push(doc.selection[i]);
  var pick = domboHebePick(items);
  if (!pick) throw new Error('선택한 개체에 보이는 모양이 없습니다.');
  var factor = 1;
  try { factor = Number(doc.scaleFactor) || 1; } catch (e) { factor = 1; } // 큰 캔버스 문서는 스크립트 좌표가 1/10
  return domboHebeText(pick, scale, factor);
}

// ---- 사이즈 표시 ----
// 작업물마다 위쪽에 '103*105cm(가로*세로)' 글자를 쓴다. 작업물 안의 기준은 크기·헤베와 같다 (맨 바깥 마스크 > 그룹 > 가장 큰 개체)

var DOMBO_SIZE_LAYER = '사이즈';
var DOMBO_SIZE_FONTS = ['MalgunGothic', 'NanumGothic', 'NanumSquareOTF_acB', 'AppleSDGothicNeo-Regular', 'KoPubDotumMedium'];

// 여러 개를 골랐으면 고른 것마다 (그룹이든 패스든). 그룹 하나만 골랐고 안에 하위 그룹이 있으면
// 그 안의 보이는 것마다 (그룹이 아닌 패스·복합 패스도), 하위 그룹이 없으면 그 그룹 하나
function domboSizeTargets(sel) {
  var out = [], i, hasGroup = false;
  if (sel.length === 1 && sel[0].typename === 'GroupItem' && !sel[0].clipped) {
    for (i = 0; i < sel[0].pageItems.length; i++) {
      var k = sel[0].pageItems[i];
      if (k.hidden || k.guides) continue;
      out.push(k);
      if (k.typename === 'GroupItem') hasGroup = true;
    }
    if (hasGroup) return out;
    out = [];
  }
  for (i = 0; i < sel.length; i++) if (!sel[i].hidden && !sel[i].guides) out.push(sel[i]);
  return out;
}

// cm 를 정수면 정수로, 아니면 소수 1자리로
function domboCmLabel(mm) {
  var cm = Math.round(mm) / 10;
  return domboDimLabel(cm, cm === Math.round(cm) ? 0 : 1, false);
}

// 범위(pt) → '103*105cm(가로*세로)'. mul = 배율 (10:1 파일이면 10)
function domboSizeLabel(bounds, mul) {
  var k = DOMBO_PT_PER_MM;
  return domboCmLabel((bounds[2] - bounds[0]) / k * mul) + '*' + domboCmLabel((bounds[1] - bounds[3]) / k * mul) + 'cm(가로*세로)';
}

function domboSizeFont() {
  for (var i = 0; i < DOMBO_SIZE_FONTS.length; i++) {
    try { return app.textFonts.getByName(DOMBO_SIZE_FONTS[i]); } catch (e) { /* 없으면 다음 */ }
  }
  return null;
}

// opts: { scale: 1 | 10, textMm: 실제 크기 기준 글자 높이(mm), 10:1 파일이면 1/10 로 }
function domboSize(opts) {
  var scale = opts && Number(opts.scale) === 10 ? 10 : 1;
  var textMm = Number(opts && opts.textMm) || 40;
  if (textMm <= 0 || textMm > 1000) throw new Error('글자 크기는 0 ~ 1000mm 사이여야 합니다.');
  var doc = domboDoc();
  if (doc.selection && doc.selection.typename === 'TextRange') throw new Error('글자 편집 중입니다. 선택 도구로 바꾼 뒤 다시 하세요.');
  if (!domboHasSelection(doc)) throw new Error('사이즈를 표시할 작업물을 선택하세요.');
  var sel = [], i;
  for (i = 0; i < doc.selection.length; i++) sel.push(doc.selection[i]);
  var factor = 1;
  try { factor = Number(doc.scaleFactor) || 1; } catch (e) { factor = 1; }
  var targets = domboSizeTargets(sel), picks = [];
  for (i = 0; i < targets.length; i++) {
    var p = domboHebePick([targets[i]]);
    if (p) picks.push(p);
  }
  if (!picks.length) throw new Error('선택한 것에 보이는 모양이 없습니다.');

  var layer = domboGetLayer(doc, DOMBO_SIZE_LAYER);
  layer.zOrder(ZOrderMethod.BRINGTOFRONT);
  var black = domboBlack(doc), font = domboSizeFont();
  var sizePt = textMm / scale / factor * DOMBO_PT_PER_MM;  // 파일 안 글자 크기
  for (i = 0; i < picks.length; i++) {
    var b = picks[i].bounds, tf = layer.textFrames.add();
    tf.contents = domboSizeLabel(b, scale * factor);
    tf.name = '사이즈';
    var ca = tf.textRange.characterAttributes;
    ca.size = sizePt;
    ca.fillColor = black;
    if (font) ca.textFont = font;
    // 글자 왼쪽 아래를 작업물 왼쪽 위에서 글자 크기의 30% 위로
    var tb = tf.geometricBounds;
    tf.translate(b[0] - tb[0], b[1] + sizePt * 0.3 - tb[3]);
  }
  doc.selection = null;
  var msg = picks.length + '개에 사이즈를 표시했습니다 (' + (scale === 10 ? '10:1' : '1:1') + ').';
  if (picks.length === 1) msg += ' ' + domboSizeLabel(picks[0].bounds, scale * factor);
  return msg + " '" + DOMBO_SIZE_LAYER + "' 레이어에 있습니다.";
}

function domboSizeRemove() {
  var doc = domboDoc();
  var layer = domboFindLayer(doc, DOMBO_SIZE_LAYER);
  if (!layer) return '지울 사이즈 표시가 없습니다.';
  layer.locked = false;
  layer.remove();
  return '사이즈 표시를 지웠습니다.';
}

// ---- 넘버링 ----
// 출력물(작업물)마다 번호, 작업물 안에 조각이 여러 개면 '작업물-조각' 번호를 붙인다.
// 순서: 줄(세로로 반 이상 겹치는 것끼리 한 줄)마다 왼쪽 → 오른쪽, 위 줄 → 아래 줄

var DOMBO_NUM_LAYER = '넘버링';

// 범위 목록을 읽는 순서로: 결과는 번호 순서대로 늘어놓은 인덱스
function domboReadingOrder(list) {
  var idx = [], rows = [], i, j;
  for (i = 0; i < list.length; i++) idx.push(i);
  idx.sort(function (a, b) { return list[b][1] - list[a][1]; }); // 위가 먼저
  for (i = 0; i < idx.length; i++) {
    var b = list[idx[i]], h = b[1] - b[3], placed = false;
    for (j = 0; j < rows.length && !placed; j++) {
      var r = rows[j];
      var ov = Math.min(r.top, b[1]) - Math.max(r.bottom, b[3]);
      if (ov >= 0.5 * Math.min(h, r.top - r.bottom)) {
        r.items.push(idx[i]);
        placed = true;
      }
    }
    if (!placed) rows.push({ top: b[1], bottom: b[3], items: [idx[i]] });
  }
  rows.sort(function (a, b) { return b.top - a.top; });
  var out = [];
  for (j = 0; j < rows.length; j++) {
    rows[j].items.sort(function (a, b) { return list[a][0] - list[b][0]; });
    for (i = 0; i < rows[j].items.length; i++) out.push(rows[j].items[i]);
  }
  return out;
}

// 작업물 안의 조각들 (두 개 이상일 때만). 클리핑 마스크는 안쪽 내용, 그룹 하나만 있으면 그 안으로.
// 선(넓이 0)이나 1mm 보다 가는 것은 조각으로 치지 않는다
function domboPieces(item) {
  var node = item, guard = 0;
  while (node.typename === 'GroupItem' && guard++ < 10) {
    var mask = domboClipMask(node), kids = [], i;
    for (i = 0; i < node.pageItems.length; i++) {
      var k = node.pageItems[i];
      if (k === mask || k.hidden || k.guides) continue;
      kids.push(k);
    }
    if (kids.length === 1 && kids[0].typename === 'GroupItem') { node = kids[0]; continue; }
    var out = [], min = DOMBO_PT_PER_MM;
    for (i = 0; i < kids.length; i++) {
      var b = domboItemBounds(kids[i], true);
      if (b && b[2] - b[0] >= min && b[1] - b[3] >= min) out.push({ item: kids[i], bounds: b });
    }
    return out.length >= 2 ? out : [];
  }
  return [];
}

// 번호 글자 목록 (그리기 전 계산). opts: { pieces: 조각 번호까지, prefix: 앞 글자 }
// 결과: [{ text, bounds: 번호를 붙일 것의 범위, side: 'top' | 'bottom' | 'left' | 'right', edge: 작업물 범위 }]
// 번호는 출력되지 않게 늘 작업물 바깥에 놓는다: 작업물 번호는 우측 상단 바깥, 조각 번호는 그 조각이 닿은 작업물 가장자리 바깥
// (위 → 아래 → 왼쪽 → 오른쪽 순으로 먼저 닿은 쪽). 어느 가장자리에도 닿지 않은 안쪽 조각은 작업물 왼쪽 바깥에
function domboNumberLabels(targets, opts) {
  var list = [], i, j;
  for (i = 0; i < targets.length; i++) {
    var p = domboHebePick([targets[i]]);
    if (p) list.push({ item: targets[i], bounds: p.bounds });
  }
  var order = domboReadingOrder((function () { var a = []; for (var q = 0; q < list.length; q++) a.push(list[q].bounds); return a; })());
  var prefix = opts && opts.prefix ? String(opts.prefix) : '', out = [];
  for (i = 0; i < order.length; i++) {
    var t = list[order[i]], no = prefix + (i + 1);
    var pieces = opts && opts.pieces ? domboPieces(t.item) : [];
    if (!pieces.length) { out.push({ text: no, bounds: t.bounds, side: 'top', edge: t.bounds }); continue; }
    var pb = [], e = t.bounds, tol = DOMBO_PT_PER_MM;
    for (j = 0; j < pieces.length; j++) pb.push(pieces[j].bounds);
    var po = domboReadingOrder(pb);
    for (j = 0; j < po.length; j++) {
      var b = pb[po[j]], side = 'left';
      if (b[1] >= e[1] - tol) side = 'top';
      else if (b[3] <= e[3] + tol) side = 'bottom';
      else if (b[0] <= e[0] + tol) side = 'left';
      else if (b[2] >= e[2] - tol) side = 'right';
      out.push({ text: no + '-' + (j + 1), bounds: b, side: side, edge: e });
    }
  }
  return out;
}

// 글자 범위(tb)를 옮길 거리: 작업물 가장자리(edge) 바깥 side 쪽, 붙일 것(b)에 맞춰. gap 만큼 띄운다
function domboNumberMove(tb, b, edge, side, gap) {
  // 위·아래는 오른쪽 끝에 맞춘다 (우측 상단)
  if (side === 'top') return [b[2] - tb[2], edge[1] + gap - tb[3]];
  if (side === 'bottom') return [b[2] - tb[2], edge[3] - gap - tb[1]];
  var cy = (b[1] + b[3]) / 2 - (tb[1] + tb[3]) / 2;
  if (side === 'right') return [edge[2] + gap - tb[0], cy];
  return [edge[0] - gap - tb[2], cy];
}

// opts: { pieces, prefix, textPt: 폰트 크기(pt, 기본 20), scale: 1 | 10 (1:1 파일이면 그대로, 10:1 파일이면 1/10) }. 번호는 늘 작업물 바깥에
// 작업물 기준은 맨 바깥 클리핑 마스크 > 그룹 > 가장 큰 개체 (크기·헤베와 같음)
function domboNumber(opts) {
  var o = opts || {};
  var textPt = Number(o.textPt) || 20;
  if (textPt <= 0) throw new Error('폰트 크기를 넣으세요.');
  var doc = domboDoc();
  if (doc.selection && doc.selection.typename === 'TextRange') throw new Error('글자 편집 중입니다. 선택 도구로 바꾼 뒤 다시 하세요.');
  if (!domboHasSelection(doc)) throw new Error('번호를 붙일 출력물을 선택하세요.');
  var sel = [], i;
  for (i = 0; i < doc.selection.length; i++) sel.push(doc.selection[i]);
  var labels = domboNumberLabels(domboSizeTargets(sel), o);
  if (!labels.length) throw new Error('선택한 것에 보이는 모양이 없습니다.');
  var factor = 1;
  try { factor = Number(doc.scaleFactor) || 1; } catch (e) { factor = 1; }
  var scale = Number(o.scale) === 10 ? 10 : 1;
  var sizePt = textPt / scale / factor, pad = sizePt * 0.4;
  if (sizePt < 0.1 || sizePt > 1296) throw new Error('파일에 들어갈 폰트 크기가 ' + (Math.round(sizePt * 100) / 100) + 'pt 입니다. 일러스트는 0.1 ~ 1296pt 만 됩니다.');
  var layer = domboGetLayer(doc, DOMBO_NUM_LAYER);
  layer.zOrder(ZOrderMethod.BRINGTOFRONT);
  var black = domboBlack(doc), font = domboSizeFont();
  for (i = 0; i < labels.length; i++) {
    var b = labels[i].bounds, tf = layer.textFrames.add();
    tf.contents = labels[i].text;
    tf.name = '번호 ' + labels[i].text;
    var ca = tf.textRange.characterAttributes;
    ca.size = sizePt;
    ca.fillColor = black;
    if (font) ca.textFont = font;
    var mv = domboNumberMove(tf.geometricBounds, b, labels[i].edge, labels[i].side, pad);
    tf.translate(mv[0], mv[1]);
  }
  doc.selection = null;
  return '번호 ' + labels.length + '개를 붙였습니다 (' + labels[0].text + ' ~ ' + labels[labels.length - 1].text + "). '" + DOMBO_NUM_LAYER + "' 레이어에 있습니다.";
}

function domboNumberRemove() {
  var doc = domboDoc();
  var layer = domboFindLayer(doc, DOMBO_NUM_LAYER);
  if (!layer) return '지울 번호가 없습니다.';
  layer.locked = false;
  layer.remove();
  return '번호를 지웠습니다.';
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
function domboPanelBleed(opts) { return domboCall(domboBleed, opts); }
function domboPanelGrid(opts) { return domboCall(domboGridCut, opts); }
function domboPanelCount() { return domboCall(domboCount); }
function domboPanelBarBox(opts) { return domboCall(domboBarBox, opts); }
function domboPanelDim(opts) { return domboCall(domboDimension, opts); }
function domboPanelSplit(opts) { return domboCall(domboSplit, opts); }
function domboPanelGrommet(opts) { return domboCall(domboGrommet, opts); }
function domboPanelGrommetRemove() { return domboCall(domboGrommetRemove); }
function domboPanelDimRemove() { return domboCall(domboDimRemove); }
function domboPanelHebe(opts) { return domboCall(domboHebe, opts); }
function domboPanelSize(opts) { return domboCall(domboSize, opts); }
function domboPanelSizeRemove() { return domboCall(domboSizeRemove); }
function domboPanelNumber(opts) { return domboCall(domboNumber, opts); }
function domboPanelNumberRemove() { return domboCall(domboNumberRemove); }
