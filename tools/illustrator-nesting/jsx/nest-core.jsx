// 브로애드 네스팅 핵심 기능 (ExtendScript, ES3 문법만 사용)
// 1) 용지 폭 네스팅: 선택한 작업물을 롤 용지 폭에 맞춰 수량만큼 빈틈없이 배치
// 2) 아크릴 텍스트 네스팅: 글자를 아웃라인·분리해서 아크릴 원판에 배치 (레이저 커팅용)
// 패널(roll.html, text.html)과 단독 스크립트(jsx/*.jsx)가 함께 쓴다.
// 좌표: 계산은 '왼쪽 위가 0, 아래로 갈수록 y 증가'. 일러스트레이터에 놓을 때 뒤집는다.
// 대지는 새로 만들지 않는다. 선택한 것이 있던 자리(왼쪽 위)부터 배치하고, 용지·원판 범위는 안내선으로 그린다.
// 원본은 숨긴 '네스팅 전 원본' 레이어로 옮겨 둔다.

var NEST_PT_PER_MM = 72 / 25.4;
var NEST_LAYER = '네스팅';
var NEST_EPS = 1e-6;
var NEST_SHEET_GAP_MM = 30;
var NEST_BACKUP_LAYER = '네스팅 전 원본';

// ---- 배치 계산 (MaxRects, 일러스트레이터 없이도 동작) ----

function nestNewBin(w, h) {
  return { w: w, h: h, free: [{ x: 0, y: 0, w: w, h: h }], used: [] };
}

function nestScore(f, w, h, heur) {
  if (heur === 'BL') return [f.y + h, f.x];                       // 위쪽부터 채우기 (롤 길이 최소)
  if (heur === 'BAF') return [f.w * f.h - w * h, Math.min(f.w - w, f.h - h)];
  var a = f.w - w, b = f.h - h;                                    // BSSF: 남는 짧은 변 최소
  return [Math.min(a, b), Math.max(a, b)];
}

// 빈칸 중 가장 잘 맞는 자리. 없으면 null
function nestFind(bin, w, h, allowRotate, heur) {
  var best = null;
  function tryFit(f, W, H, rot) {
    if (f.w + NEST_EPS < W || f.h + NEST_EPS < H) return;
    var s = nestScore(f, W, H, heur);
    if (!best || s[0] < best.s[0] - NEST_EPS || (Math.abs(s[0] - best.s[0]) <= NEST_EPS && s[1] < best.s[1])) {
      best = { x: f.x, y: f.y, w: W, h: H, rotated: rot, s: s };
    }
  }
  for (var i = 0; i < bin.free.length; i++) {
    tryFit(bin.free[i], w, h, false);
    if (allowRotate && Math.abs(w - h) > NEST_EPS) tryFit(bin.free[i], h, w, true);
  }
  return best;
}

function nestContains(a, b) { // a 가 b 를 품는가
  return b.x >= a.x - NEST_EPS && b.y >= a.y - NEST_EPS &&
    b.x + b.w <= a.x + a.w + NEST_EPS && b.y + b.h <= a.y + a.h + NEST_EPS;
}

// 자리를 차지하고, 겹친 빈칸을 쪼갠 뒤 다른 빈칸에 들어 있는 빈칸은 버린다
function nestOccupy(bin, r) {
  var kept = [], made = [], i, j, f;
  for (i = 0; i < bin.free.length; i++) {
    f = bin.free[i];
    if (r.x >= f.x + f.w - NEST_EPS || r.x + r.w <= f.x + NEST_EPS ||
        r.y >= f.y + f.h - NEST_EPS || r.y + r.h <= f.y + NEST_EPS) {
      kept.push(f);
      continue;
    }
    if (r.x > f.x + NEST_EPS) made.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
    if (r.x + r.w < f.x + f.w - NEST_EPS) made.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - r.x - r.w, h: f.h });
    if (r.y > f.y + NEST_EPS) made.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
    if (r.y + r.h < f.y + f.h - NEST_EPS) made.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - r.y - r.h });
  }
  var newOk = [];
  for (i = 0; i < made.length; i++) {
    var drop = false;
    for (j = 0; j < kept.length && !drop; j++) if (nestContains(kept[j], made[i])) drop = true;
    for (j = 0; j < made.length && !drop; j++) {
      if (j !== i && nestContains(made[j], made[i]) && (!nestContains(made[i], made[j]) || j < i)) drop = true;
    }
    if (!drop) newOk.push(made[i]);
  }
  var out = [];
  for (i = 0; i < kept.length; i++) {
    var inside = false;
    for (j = 0; j < newOk.length && !inside; j++) if (nestContains(newOk[j], kept[i])) inside = true;
    if (!inside) out.push(kept[i]);
  }
  bin.free = out.concat(newOk);
  bin.used.push(r);
}

var NEST_SORTS = {
  area: function (a, b) { return b.w * b.h - a.w * a.h; },
  maxSide: function (a, b) { return Math.max(b.w, b.h) - Math.max(a.w, a.h); },
  height: function (a, b) { return b.h - a.h; },
  width: function (a, b) { return b.w - a.w; },
  perimeter: function (a, b) { return b.w + b.h - a.w - a.h; }
};

function nestRun(items, W, H, allowRotate, sortName, heur) {
  var list = items.slice(0), cmp = NEST_SORTS[sortName];
  list.sort(function (a, b) { return cmp(a, b) || a.order - b.order; });
  var bins = [], places = [], i, k;
  for (i = 0; i < list.length; i++) {
    var it = list[i], spot = null;
    for (k = 0; k < bins.length && !spot; k++) {
      spot = nestFind(bins[k], it.w, it.h, allowRotate, heur);
      if (spot) spot.bin = k;
    }
    if (!spot) {
      bins.push(nestNewBin(W, H));
      k = bins.length - 1;
      spot = nestFind(bins[k], it.w, it.h, allowRotate, heur);
      spot.bin = k;
    }
    nestOccupy(bins[spot.bin], spot);
    places.push({ item: it, bin: spot.bin, x: spot.x, y: spot.y, rotated: spot.rotated, h: spot.h });
  }
  return nestSummary(places, bins.length);
}

// 스카이라인 방식 (롤 용지용): 위에서부터 채운 높이선을 따라 가장 높은 곳(위쪽)에 붙인다. 빠르다.
function nestSkylineRun(items, W, H, allowRotate, sortName) {
  var list = items.slice(0), cmp = NEST_SORTS[sortName];
  list.sort(function (a, b) { return cmp(a, b) || a.order - b.order; });
  var bins = [], places = [], i;
  function newSky() { return [{ x: 0, y: 0, w: W }]; }
  // 세그먼트 i 의 왼쪽 끝에 폭 w 를 놓을 때 바닥 높이. 폭을 넘으면 -1
  function fitY(sky, i, w) {
    var x = sky[i].x;
    if (x + w > W + NEST_EPS) return -1;
    var y = 0, left = w;
    for (var j = i; j < sky.length && left > NEST_EPS; j++) {
      if (sky[j].y > y) y = sky[j].y;
      left -= sky[j].w;
    }
    return y;
  }
  function findIn(sky, w, h, rot, best) {
    for (var i = 0; i < sky.length; i++) {
      var y = fitY(sky, i, w);
      if (y < 0 || y + h > H + NEST_EPS) continue;
      if (!best || y + h < best.y + best.h - NEST_EPS ||
          (Math.abs(y + h - best.y - best.h) <= NEST_EPS && sky[i].x < best.x)) {
        best = { x: sky[i].x, y: y, w: w, h: h, rotated: rot };
      }
    }
    return best;
  }
  function addSky(sky, r) {
    var out = [], seg = { x: r.x, y: r.y + r.h, w: r.w }, placed = false;
    for (var j = 0; j < sky.length; j++) {
      var s = sky[j], sEnd = s.x + s.w, rEnd = r.x + r.w;
      if (sEnd <= r.x + NEST_EPS || s.x >= rEnd - NEST_EPS) {
        if (!placed && s.x >= rEnd - NEST_EPS) { out.push(seg); placed = true; }
        out.push(s);
        continue;
      }
      if (s.x < r.x - NEST_EPS) out.push({ x: s.x, y: s.y, w: r.x - s.x });
      if (!placed) { out.push(seg); placed = true; }
      if (sEnd > rEnd + NEST_EPS) out.push({ x: rEnd, y: s.y, w: sEnd - rEnd });
    }
    if (!placed) out.push(seg);
    var merged = [];
    for (j = 0; j < out.length; j++) {
      var last = merged[merged.length - 1];
      if (last && Math.abs(last.y - out[j].y) <= NEST_EPS) last.w += out[j].w;
      else merged.push({ x: out[j].x, y: out[j].y, w: out[j].w });
    }
    return merged;
  }
  for (i = 0; i < list.length; i++) {
    var it = list[i], spot = null, k;
    for (k = 0; k < bins.length && !spot; k++) {
      spot = findIn(bins[k], it.w, it.h, false, null);
      if (allowRotate && Math.abs(it.w - it.h) > NEST_EPS) spot = findIn(bins[k], it.h, it.w, true, spot);
      if (spot) spot.bin = k;
    }
    if (!spot) {
      bins.push(newSky());
      k = bins.length - 1;
      spot = findIn(bins[k], it.w, it.h, false, null);
      if (allowRotate && Math.abs(it.w - it.h) > NEST_EPS) spot = findIn(bins[k], it.h, it.w, true, spot);
      spot.bin = k;
    }
    bins[spot.bin] = addSky(bins[spot.bin], spot);
    places.push({ item: it, bin: spot.bin, x: spot.x, y: spot.y, rotated: spot.rotated, h: spot.h });
  }
  return nestSummary(places, bins.length);
}

function nestSummary(places, binCount) {
  var bottoms = [], i, total = 0;
  for (i = 0; i < binCount; i++) bottoms.push(0);
  for (i = 0; i < places.length; i++) {
    var b = places[i].y + places[i].h;
    if (b > bottoms[places[i].bin]) bottoms[places[i].bin] = b;
  }
  for (i = 0; i < bottoms.length; i++) total += bottoms[i];
  return { places: places, bins: binCount, bottoms: bottoms, total: total };
}

// sizes: [{ id, w, h }] (pt). o: { binW, binH, gap, margin, allowRotate, mode: 'roll' | 'sheet' }
// 결과: { placements: [{ id, bin, x, y, w, h, rotated }], bins, binHeights, usedArea }
//  - x, y 는 원판 왼쪽 위 기준 (여백 포함), w, h 는 회전 뒤 크기
//  - binHeights: 롤이면 실제로 쓴 길이(여백 포함)로 자른 높이, 원판이면 원판 높이
function nestPack(sizes, o) {
  var gap = o.gap, m = o.margin;
  var W = o.binW - 2 * m + gap, H = o.binH - 2 * m + gap;
  if (W <= gap || H <= gap) throw new Error('여백이 용지보다 큽니다.');
  var items = [], tooBig = [], area = 0, i;
  for (i = 0; i < sizes.length; i++) {
    var s = sizes[i], w = s.w + gap, h = s.h + gap;
    var fits = (w <= W + NEST_EPS && h <= H + NEST_EPS) || (o.allowRotate && h <= W + NEST_EPS && w <= H + NEST_EPS);
    if (!fits) tooBig.push(s.id);
    items.push({ id: s.id, w: w, h: h, order: i });
    area += s.w * s.h;
  }
  if (tooBig.length > 0) {
    var e = new Error('용지보다 큰 작업물이 ' + tooBig.length + '개 있습니다.');
    e.tooBig = tooBig;
    throw e;
  }
  if (items.length === 0) throw new Error('배치할 작업물이 없습니다.');

  // 정렬 순서와 배치 규칙을 여러 가지로 해 보고 가장 좋은 결과를 고른다.
  // 롤: 스카이라인(빠름) + 개수가 적으면 MaxRects 위쪽 채우기도. 원판: MaxRects
  var sortNames = ['area', 'maxSide', 'height', 'width', 'perimeter'];
  var runs = [], n = items.length, a, b;
  if (o.mode === 'roll') {
    for (a = 0; a < sortNames.length; a++) runs.push(['sky', sortNames[a]]);
    if (n <= 80) for (a = 0; a < sortNames.length; a++) runs.push(['BL', sortNames[a]]);
  } else {
    var heurs = n <= 80 ? ['BSSF', 'BAF', 'BL'] : ['BSSF', 'BL'];
    var sorts = n <= 80 ? sortNames : (n <= 250 ? ['area', 'maxSide', 'height'] : ['area']);
    for (a = 0; a < sorts.length; a++) for (b = 0; b < heurs.length; b++) runs.push([heurs[b], sorts[a]]);
  }
  var best = null;
  for (a = 0; a < runs.length; a++) {
    var r = runs[a][0] === 'sky' ? nestSkylineRun(items, W, H, o.allowRotate, runs[a][1])
      : nestRun(items, W, H, o.allowRotate, runs[a][1], runs[a][0]);
    // 원판 수가 적을수록, 그다음 쓴 길이 합이 짧을수록 좋다
    if (!best || r.bins < best.bins || (r.bins === best.bins && r.total < best.total - NEST_EPS)) best = r;
  }

  var placements = [];
  for (i = 0; i < best.places.length; i++) {
    var p = best.places[i];
    placements.push({
      id: p.item.id, bin: p.bin, x: m + p.x, y: m + p.y,
      w: (p.rotated ? p.item.h : p.item.w) - gap, h: (p.rotated ? p.item.w : p.item.h) - gap, rotated: p.rotated
    });
  }
  var heights = [];
  for (i = 0; i < best.bins; i++) heights.push(o.mode === 'roll' ? best.bottoms[i] - gap + 2 * m : o.binH);
  return { placements: placements, bins: best.bins, binHeights: heights, usedArea: area };
}

// ---- 글자 조각 나누기 (일러스트레이터 없이도 동작) ----

function nestPolyArea(poly) {
  var s = 0;
  for (var i = 0, n = poly.length; i < n; i++) {
    var a = poly[i], b = poly[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s / 2);
}

function nestPointInPoly(pt, poly) {
  var inside = false, x = pt[0], y = pt[1];
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 복합 패스의 윤곽선들을 '실제로 떨어지는 조각' 으로 묶는다.
// 바깥 윤곽(짝수 겹) 하나와 그 바로 안의 구멍(홀수 겹)들이 한 조각. 구멍 안의 섬은 따로 한 조각.
// polys: 윤곽선마다 꼭짓점 목록. 결과: 조각마다 윤곽선 번호 목록
function nestPieces(polys) {
  var n = polys.length, area = [], depth = [], parent = [], i, j;
  for (i = 0; i < n; i++) area.push(nestPolyArea(polys[i]));
  for (i = 0; i < n; i++) {
    depth.push(0);
    parent.push(-1);
    for (j = 0; j < n; j++) {
      if (j === i || area[j] <= area[i] || polys[i].length === 0) continue;
      if (nestPointInPoly(polys[i][0], polys[j])) {
        depth[i]++;
        if (parent[i] === -1 || area[j] < area[parent[i]]) parent[i] = j;
      }
    }
  }
  var pieceOf = {}, pieces = [];
  for (i = 0; i < n; i++) {
    if (depth[i] % 2 === 0) { pieceOf[i] = pieces.length; pieces.push([i]); }
  }
  for (i = 0; i < n; i++) {
    if (depth[i] % 2 === 1 && pieceOf[parent[i]] !== undefined) pieces[pieceOf[parent[i]]].push(i);
  }
  for (i = 0; i < pieces.length; i++) pieces[i].sort(function (a, b) { return a - b; });
  return pieces;
}

// 베지어 곡선을 잘게 나눠 꼭짓점 목록으로 (조각 판정용)
function nestFlatten(points, closed, steps) {
  var out = [], n = points.length;
  for (var i = 0; i < n; i++) {
    if (!closed && i === n - 1) { out.push(points[i].anchor); break; }
    var a = points[i], b = points[(i + 1) % n];
    var p0 = a.anchor, p1 = a.rightDirection, p2 = b.leftDirection, p3 = b.anchor;
    for (var s = 0; s < steps; s++) {
      var t = s / steps, u = 1 - t;
      var c0 = u * u * u, c1 = 3 * u * u * t, c2 = 3 * u * t * t, c3 = t * t * t;
      out.push([c0 * p0[0] + c1 * p1[0] + c2 * p2[0] + c3 * p3[0], c0 * p0[1] + c1 * p1[1] + c2 * p2[1] + c3 * p3[1]]);
    }
  }
  return out;
}

// ---- 설정 ----

function nestNum(v) { return Number(v); }
function nestBool(v) { return v === true || v === 'true'; }
function nestMerge(def, opts) {
  if (opts) for (var k in opts) if (opts.hasOwnProperty(k) && opts[k] !== undefined && opts[k] !== null) def[k] = opts[k];
  return def;
}

function nestRollDefaults() {
  return { widthMm: 1200, maxLengthMm: 5000, marginMm: 10, gapMm: 5, quantity: 1, allowRotate: true };
}

function nestTextDefaults() {
  return {
    sheetWMm: 900, sheetHMm: 600, marginMm: 5, gapMm: 3, quantity: 1, allowRotate: true,
    unit: 'glyph',     // 'glyph' 글자 단위 / 'piece' 떨어지는 조각 단위
    laserLine: true    // 면 없이 빨강 헤어라인으로
  };
}

function nestCheckRoll(o) {
  o = nestMerge(nestRollDefaults(), o);
  o.widthMm = nestNum(o.widthMm); o.maxLengthMm = nestNum(o.maxLengthMm); o.marginMm = nestNum(o.marginMm);
  o.gapMm = nestNum(o.gapMm); o.quantity = nestNum(o.quantity); o.allowRotate = nestBool(o.allowRotate);
  if (!(o.widthMm > 0)) throw new Error('용지 폭은 0보다 커야 합니다.');
  if (!(o.maxLengthMm > 0)) throw new Error('최대 길이는 0보다 커야 합니다.');
  if (!(o.marginMm >= 0) || !(o.gapMm >= 0)) throw new Error('여백과 간격은 0 이상이어야 합니다.');
  if (!(o.quantity >= 1) || Math.floor(o.quantity) !== o.quantity) throw new Error('수량은 1 이상의 정수여야 합니다.');
  if (o.quantity > 2000) throw new Error('수량이 너무 많습니다 (최대 2000).');
  return o;
}

function nestCheckText(o) {
  o = nestMerge(nestTextDefaults(), o);
  o.sheetWMm = nestNum(o.sheetWMm); o.sheetHMm = nestNum(o.sheetHMm); o.marginMm = nestNum(o.marginMm);
  o.gapMm = nestNum(o.gapMm); o.quantity = nestNum(o.quantity);
  o.allowRotate = nestBool(o.allowRotate); o.laserLine = nestBool(o.laserLine);
  if (!(o.sheetWMm > 0) || !(o.sheetHMm > 0)) throw new Error('원판 크기는 0보다 커야 합니다.');
  if (!(o.marginMm >= 0) || !(o.gapMm >= 0)) throw new Error('여백과 간격은 0 이상이어야 합니다.');
  if (!(o.quantity >= 1) || Math.floor(o.quantity) !== o.quantity) throw new Error('수량은 1 이상의 정수여야 합니다.');
  if (o.quantity > 100) throw new Error('세트 수량이 너무 많습니다 (최대 100).');
  if (o.unit !== 'glyph' && o.unit !== 'piece') throw new Error('나누기 단위가 잘못됐습니다.');
  return o;
}

// 용지·원판 자리: 시작점(왼쪽 위, 문서 좌표)에서 아래로 간격을 두고 차례로 쌓는다
function nestOrigins(start, heights, gapPt) {
  var out = [], y = start[1];
  for (var i = 0; i < heights.length; i++) {
    out.push([start[0], y]);
    y -= heights[i] + gapPt;
  }
  return out;
}

// ---- 여기부터는 일러스트레이터 안에서만 동작 ----

function nestDoc() {
  if (app.documents.length === 0) throw new Error('열려 있는 문서가 없습니다.');
  return app.activeDocument;
}

function nestSelection(doc, what) {
  var sel = doc.selection;
  if (!sel || sel.typename === 'TextRange') throw new Error('글자 편집 중입니다. 선택 도구로 바꾼 뒤 다시 하세요.');
  if (sel.length === 0) throw new Error(what + ' 선택하세요.');
  var out = [];
  for (var i = 0; i < sel.length; i++) out.push(sel[i]);
  return out;
}

function nestUnion(b, v) {
  if (!b) return [v[0], v[1], v[2], v[3]];
  return [Math.min(b[0], v[0]), Math.max(b[1], v[1]), Math.max(b[2], v[2]), Math.min(b[3], v[3])];
}

// 보이는 범위. 클리핑 마스크는 마스크 모양 기준. geometric 이면 선 두께를 뺀 패스 범위
function nestBounds(item, geometric) {
  if (item.hidden || item.guides) return null;
  if (item.typename === 'GroupItem') {
    var kids = item.pageItems, i;
    if (item.clipped) {
      for (i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.typename === 'PathItem' && k.clipping) return k.geometricBounds;
        if (k.typename === 'CompoundPathItem' && k.pathItems.length > 0 && k.pathItems[0].clipping) return k.geometricBounds;
      }
    }
    var b = null;
    for (i = 0; i < kids.length; i++) {
      var v = nestBounds(kids[i], geometric);
      if (v) b = nestUnion(b, v);
    }
    return b;
  }
  return geometric ? item.geometricBounds : item.visibleBounds;
}

function nestGetLayer(doc) {
  var layer = null;
  for (var i = 0; i < doc.layers.length; i++) if (doc.layers[i].name === NEST_LAYER) layer = doc.layers[i];
  if (!layer) { layer = doc.layers.add(); layer.name = NEST_LAYER; }
  layer.locked = false;
  layer.visible = true;
  return layer;
}

function nestFindLayer(doc, name) {
  for (var i = 0; i < doc.layers.length; i++) if (doc.layers[i].name === name) return doc.layers[i];
  return null;
}

// 선택한 것들의 왼쪽 위 (배치 시작점)
function nestStart(items, geometric) {
  var b = null;
  for (var i = 0; i < items.length; i++) {
    var v = nestBounds(items[i], geometric);
    if (v) b = nestUnion(b, v);
  }
  return [b[0], b[1]];
}

// 용지·원판 범위를 안내선 사각형으로 그린다 (출력·커팅에 나오지 않음)
function nestDrawSheets(layer, origins, widthPt, heights, label) {
  for (var i = 0; i < origins.length; i++) {
    var r = layer.pathItems.rectangle(origins[i][1], origins[i][0], widthPt, heights[i]);
    r.filled = false;
    r.stroked = true;
    r.name = label + ' ' + (i + 1);
    r.guides = true;
  }
}

// 원본을 숨긴 '네스팅 전 원본' 레이어로 옮겨 둔다
function nestBackup(doc, items) {
  var layer = nestFindLayer(doc, NEST_BACKUP_LAYER);
  if (!layer) { layer = doc.layers.add(); layer.name = NEST_BACKUP_LAYER; }
  layer.locked = false;
  layer.visible = true;
  for (var i = 0; i < items.length; i++) items[i].move(layer, ElementPlacement.PLACEATEND);
  layer.visible = false;
  layer.locked = true;
}

// 결과가 지금 대지 밖으로 나가면 알려 준다
function nestOutsideNote(doc, origins, widthPt, heights) {
  var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()].artboardRect;
  var last = origins.length - 1;
  var L = origins[0][0], T = origins[0][1], R = L + widthPt, B = origins[last][1] - heights[last];
  if (L < ab[0] || T > ab[1] || R > ab[2] || B < ab[3]) return '\n주의: 결과 일부가 지금 대지 밖에 있습니다.';
  return '';
}

// 개체를 계산된 자리로 옮긴다 (필요하면 90도 회전)
function nestMoveTo(item, pl, origin, geometric) {
  if (pl.rotated) item.rotate(90);
  var b = nestBounds(item, geometric);
  item.translate(origin[0] + pl.x - b[0], origin[1] - pl.y - b[1]);
}

function nestTooBigMessage(e, names) {
  if (!e.tooBig) return e.message;
  var list = [];
  for (var i = 0; i < e.tooBig.length && i < 5; i++) list.push(names[e.tooBig[i]]);
  return e.message + ' (' + list.join(', ') + (e.tooBig.length > 5 ? ' 등' : '') + ') 크기를 줄이거나 용지를 키우세요.';
}

function nestFmt(mm) { return String(Math.round(mm)); }

// ---- 1) 용지 폭 네스팅 ----

function nestRoll(opts) {
  var o = nestCheckRoll(opts);
  var doc = nestDoc();
  var src = nestSelection(doc, '배치할 작업물을');
  var k = NEST_PT_PER_MM, sizes = [], bounds = [], names = [], i, q;
  for (i = 0; i < src.length; i++) {
    var b = nestBounds(src[i], false);
    if (!b) throw new Error('선택한 것 중에 보이는 모양이 없는 개체가 있습니다.');
    bounds.push(b);
    names.push((src[i].name || src[i].typename) + ' ' + Math.round((b[2] - b[0]) / k) + '×' + Math.round((b[1] - b[3]) / k) + 'mm');
  }
  for (q = 0; q < o.quantity; q++) {
    for (i = 0; i < src.length; i++) sizes.push({ id: i, w: bounds[i][2] - bounds[i][0], h: bounds[i][1] - bounds[i][3] });
  }
  var r;
  try {
    r = nestPack(sizes, {
      binW: o.widthMm * k, binH: o.maxLengthMm * k, gap: o.gapMm * k, margin: o.marginMm * k,
      allowRotate: o.allowRotate, mode: 'roll'
    });
  } catch (e) {
    throw new Error(nestTooBigMessage(e, names));
  }

  var start = nestStart(src, false);
  var origins = nestOrigins(start, r.binHeights, NEST_SHEET_GAP_MM * k);
  var layer = nestGetLayer(doc), placed = [];
  nestDrawSheets(layer, origins, o.widthMm * k, r.binHeights, '용지');
  for (i = 0; i < r.placements.length; i++) {
    var pl = r.placements[i];
    var d = src[pl.id].duplicate(layer, ElementPlacement.PLACEATEND);
    nestMoveTo(d, pl, origins[pl.bin], false);
    placed.push(d);
  }
  nestBackup(doc, src);
  doc.selection = null;
  for (i = 0; i < placed.length; i++) placed[i].selected = true;

  var total = 0;
  for (i = 0; i < r.binHeights.length; i++) total += r.binHeights[i];
  var eff = Math.round(r.usedArea / (o.widthMm * k * total) * 100);
  return placed.length + '개를 폭 ' + nestFmt(o.widthMm) + 'mm 용지에 배치했습니다.\n' +
    '사용 길이 ' + nestFmt(total / k) + 'mm' + (r.bins > 1 ? ' (' + r.bins + '장으로 나눔)' : '') +
    ', 용지 효율 ' + eff + '%.\n원본은 숨긴 \'' + NEST_BACKUP_LAYER + '\' 레이어에 있습니다.' +
    nestOutsideNote(doc, origins, o.widthMm * k, r.binHeights);
}

// ---- 2) 아크릴 텍스트 네스팅 ----

// 복합 패스를 떨어지는 조각마다 따로 떼어낸다
function nestSplitCompound(cp, layer, out) {
  var polys = [], i, j;
  for (i = 0; i < cp.pathItems.length; i++) {
    var p = cp.pathItems[i];
    polys.push(nestFlatten(p.pathPoints, p.closed, 8));
  }
  var pieces = nestPieces(polys);
  if (pieces.length <= 1) { out.push(cp); return; }
  for (i = 0; i < pieces.length; i++) {
    var keep = {};
    for (j = 0; j < pieces[i].length; j++) keep[pieces[i][j]] = true;
    var d = cp.duplicate(layer, ElementPlacement.PLACEATEND);
    for (j = d.pathItems.length - 1; j >= 0; j--) if (!keep[j]) d.pathItems[j].remove();
    out.push(d);
  }
  cp.remove();
}

// 복제본을 글자(또는 조각) 단위로 풀어 out 에 모은다. 살아있는 글자는 아웃라인으로 바꾼다.
function nestExplode(item, layer, unit, out) {
  if (item.hidden || item.guides) { item.remove(); return; }
  var t = item.typename, i;
  if (t === 'TextFrame') {
    nestExplode(item.createOutline(), layer, unit, out);
  } else if (t === 'GroupItem' && !item.clipped) {
    var kids = [];
    for (i = 0; i < item.pageItems.length; i++) kids.push(item.pageItems[i]);
    for (i = 0; i < kids.length; i++) {
      kids[i].move(layer, ElementPlacement.PLACEATEND);
      nestExplode(kids[i], layer, unit, out);
    }
    item.remove();
  } else if (t === 'CompoundPathItem' && unit === 'piece') {
    nestSplitCompound(item, layer, out);
  } else if (t === 'PathItem' && item.clipping) {
    item.remove();
  } else {
    out.push(item);
  }
}

function nestLaserStyle(item, color) {
  var t = item.typename, i;
  if (t === 'PathItem') {
    item.filled = false;
    item.stroked = true;
    item.strokeColor = color;
    item.strokeWidth = 0.1;
    item.strokeDashes = [];
  } else if (t === 'CompoundPathItem') {
    for (i = 0; i < item.pathItems.length; i++) nestLaserStyle(item.pathItems[i], color);
  } else if (t === 'GroupItem') {
    for (i = 0; i < item.pageItems.length; i++) nestLaserStyle(item.pageItems[i], color);
  }
}

function nestRed(doc) {
  if (doc.documentColorSpace === DocumentColorSpace.CMYK) {
    var c = new CMYKColor();
    c.cyan = 0; c.magenta = 100; c.yellow = 100; c.black = 0;
    return c;
  }
  var r = new RGBColor();
  r.red = 255; r.green = 0; r.blue = 0;
  return r;
}

function nestText(opts) {
  var o = nestCheckText(opts);
  var doc = nestDoc();
  var src = nestSelection(doc, '네스팅할 글자(살아있는 글자 또는 아웃라인)를');
  var k = NEST_PT_PER_MM, layer = nestGetLayer(doc), units = [], i, q;
  var start = nestStart(src, true);

  // 원본은 두고 복제본을 글자·조각으로 푼다
  for (q = 0; q < o.quantity; q++) {
    for (i = 0; i < src.length; i++) nestExplode(src[i].duplicate(layer, ElementPlacement.PLACEATEND), layer, o.unit, units);
  }
  var sizes = [], names = [], kept = [];
  for (i = 0; i < units.length; i++) {
    var b = nestBounds(units[i], true);
    if (!b || b[2] - b[0] <= 0 || b[1] - b[3] <= 0) { units[i].remove(); continue; }
    names.push(Math.round((b[2] - b[0]) / k) + '×' + Math.round((b[1] - b[3]) / k) + 'mm');
    sizes.push({ id: kept.length, w: b[2] - b[0], h: b[1] - b[3] });
    kept.push(units[i]);
  }
  function cleanup() { for (var j = 0; j < kept.length; j++) kept[j].remove(); }

  var r;
  try {
    r = nestPack(sizes, {
      binW: o.sheetWMm * k, binH: o.sheetHMm * k, gap: o.gapMm * k, margin: o.marginMm * k,
      allowRotate: o.allowRotate, mode: 'sheet'
    });
  } catch (e) {
    cleanup();
    throw new Error(nestTooBigMessage(e, names));
  }
  var origins = nestOrigins(start, r.binHeights, NEST_SHEET_GAP_MM * k);
  nestDrawSheets(layer, origins, o.sheetWMm * k, r.binHeights, '원판');

  var red = o.laserLine ? nestRed(doc) : null;
  for (i = 0; i < r.placements.length; i++) {
    var pl = r.placements[i], it = kept[pl.id];
    nestMoveTo(it, pl, origins[pl.bin], true);
    if (red) nestLaserStyle(it, red);
    it.name = (o.unit === 'piece' ? '조각_' : '글자_') + (pl.id + 1);
  }
  nestBackup(doc, src);
  doc.selection = null;
  for (i = 0; i < kept.length; i++) kept[i].selected = true;

  var last = 0;
  for (i = 0; i < r.placements.length; i++) {
    if (r.placements[i].bin === r.bins - 1) last = Math.max(last, r.placements[i].y + r.placements[i].h);
  }
  var eff = Math.round(r.usedArea / (o.sheetWMm * o.sheetHMm * k * k * r.bins) * 100);
  return (o.unit === 'piece' ? '조각 ' : '글자 ') + kept.length + '개를 ' +
    nestFmt(o.sheetWMm) + '×' + nestFmt(o.sheetHMm) + 'mm 원판 ' + r.bins + '장에 배치했습니다.\n' +
    '마지막 원판은 위에서 ' + nestFmt((last + o.marginMm * k) / k) + 'mm 까지 사용, 원판 효율(사각형 기준) ' + eff + '%.\n' +
    '원판 범위는 안내선으로 그렸고, 원본은 숨긴 \'' + NEST_BACKUP_LAYER + '\' 레이어에 있습니다.' +
    nestOutsideNote(doc, origins, o.sheetWMm * k, r.binHeights);
}

// 패널에서 부르는 함수: 결과를 'OK:' 또는 'ERR:' 로 시작하는 글자로 돌려준다
function nestCall(fn, arg) {
  try {
    return 'OK:' + fn(arg);
  } catch (e) {
    return 'ERR:' + e.message;
  }
}
function nestPanelRoll(opts) { return nestCall(nestRoll, opts); }
function nestPanelText(opts) { return nestCall(nestText, opts); }
