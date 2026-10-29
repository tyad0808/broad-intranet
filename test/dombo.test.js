// 일러스트레이터 돔보마크 패널: 마크 좌표 계산 (일러스트레이터 없이 검사할 수 있는 부분)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '../tools/illustrator-dombo/jsx/dombo-core.jsx');
const core = {};
vm.runInNewContext(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), core);

const MM = 72 / 25.4;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const nearPts = (actual, expected) => {
  assert.strictEqual(actual.length, expected.length);
  actual.forEach((p, i) => { near(p[0], expected[i][0]); near(p[1], expected[i][1]); });
};

const mmPts = pts => pts.map(([x, y]) => [x * MM, y * MM]);

// 100mm x 50mm 작업물 (왼쪽 아래가 원점)
const art = [0, 50 * MM, 100 * MM, 0];

test('기본값은 지름 6mm 원형, 마크 가장자리가 작업물에서 5mm 떨어진다', () => {
  const r = core.domboComputeMarks(art, { orientMark: false });
  near(r.radius, 3 * MM);
  // 중심은 작업물에서 거리 5mm + 반지름 3mm = 8mm 바깥. 간격 300mm 보다 작으니 네 모서리만
  nearPts(r.centers, mmPts([[-8, 58], [108, 58], [108, -8], [-8, -8]]));
  nearPts([[r.extent[0], r.extent[1]], [r.extent[2], r.extent[3]]], mmPts([[-11, 61], [111, -11]]));
  nearPts([[r.paper[0], r.paper[1]], [r.paper[2], r.paper[3]]], mmPts([[-16, 66], [116, -16]]));
});

test('위·아래 변만 간격 이하로 똑같이 나누고, 좌우 변 가운데에는 찍지 않는다', () => {
  // 중심 사각형 116mm x 66mm, 간격 50mm → 위·아래 3칸(38.67mm)
  const r = core.domboComputeMarks(art, { spacingMm: 50, orientMark: false });
  const w = 116 / 3;
  nearPts(r.centers, mmPts([
    [-8, 58], [-8 + w, 58], [-8 + 2 * w, 58], [108, 58],
    [108, -8], [-8 + 2 * w, -8], [-8 + w, -8], [-8, -8],
  ]));
  near(r.spacingX, w * MM);
  // 세로가 간격보다 길어도 좌우 변에는 모서리만
  const tall = core.domboComputeMarks([0, 500 * MM, 100 * MM, 0], { spacingMm: 50, orientMark: false });
  assert.ok(Array.from(tall.centers).every(c => Math.abs(c[1] - 508 * MM) < 1e-9 || Math.abs(c[1] + 8 * MM) < 1e-9));
});

test('길이가 간격으로 딱 나눠지면 칸을 더 만들지 않는다', () => {
  // 중심 사각형 116mm x 66mm → 간격 58mm 이면 가로 2칸
  const r = core.domboComputeMarks(art, { spacingMm: 58, orientMark: false });
  near(r.spacingX, 58 * MM);
  assert.strictEqual(r.centers.length, 2 * 3);
});

test('간격 0 이면 네 모서리만, 패널에서 온 글자 숫자도 받는다', () => {
  const r = core.domboComputeMarks(art, { diameterMm: '4', offsetMm: '2', spacingMm: '0', orientMark: false });
  nearPts(r.centers, mmPts([[-4, 54], [104, 54], [104, -4], [-4, -4]]));
});

test('방향 표시점: 기본은 오른쪽 아래 모서리 마크에서 안쪽으로 50mm', () => {
  // 1000 x 500mm 작업물 → 마크 중심 사각형 -8 ~ 1008, 아래 변 y = -8
  const big = [0, 500 * MM, 1000 * MM, 0];
  const r = core.domboComputeMarks(big, { spacingMm: 0 });
  assert.strictEqual(r.centers.length, 5, '네 모서리 + 방향 표시점');
  assert.strictEqual(r.orient, 4);
  nearPts([r.centers[4]], mmPts([[1008 - 50, -8]]));
  // 왼쪽 위, 거리 80
  const lt = core.domboComputeMarks(big, { spacingMm: 0, orientCorner: 'lt', orientMm: 80 });
  nearPts([lt.centers[lt.orient]], mmPts([[-8 + 80, 508]]));
  // 끄면 없음
  const off = core.domboComputeMarks(big, { orientMark: 'false' });
  assert.strictEqual(off.orient, -1);
});

test('방향 표시점: 다른 마크와 겹치거나 너무 멀면 알려 준다', () => {
  const big = [0, 500 * MM, 1000 * MM, 0];
  // 간격 50mm 면 아래 변 마크가 50mm 마다 → 방향 표시점과 겹침
  assert.throws(() => core.domboComputeMarks(big, { spacingMm: 50.4 }), /겹칩니다/);
  assert.throws(() => core.domboComputeMarks(art, { orientMm: 200 }), /작업물 폭보다/);
  assert.throws(() => core.domboComputeMarks(art, { orientMm: 5 }), /지름/);
  assert.throws(() => core.domboComputeMarks(art, { orientCorner: 'xx' }), /위치/);
});

test('잘못된 설정은 거절한다', () => {
  assert.throws(() => core.domboComputeMarks(art, { diameterMm: 0 }), /지름/);
  assert.throws(() => core.domboComputeMarks(art, { diameterMm: NaN }), /지름/);
  assert.throws(() => core.domboComputeMarks(art, { offsetMm: -1 }), /거리/);
  assert.throws(() => core.domboComputeMarks(art, { spacingMm: 6 }), /지름\(6mm\)보다/);
  assert.throws(() => core.domboComputeMarks([0, 5000 * MM, 5000 * MM, 0], { spacingMm: 10 }), /너무 많습니다/);
});

// 일러스트레이터 개체 흉내
const pathItem = (b, extra = {}) => ({ typename: 'PathItem', geometricBounds: b, visibleBounds: b, ...extra });
const group = (kids, extra = {}) => ({ typename: 'GroupItem', pageItems: kids, visibleBounds: [-999, 999, 999, -999], ...extra });

test('클리핑 마스크는 가려진 부분이 아니라 마스크 모양을 기준으로 찍는다', () => {
  const hiddenArt = pathItem([-500, 500, 500, -500]);
  const mask = pathItem([0, 50, 100, 0], { clipping: true });
  const clip = group([mask, hiddenArt], { clipped: true });
  assert.deepStrictEqual(Array.from(core.domboItemBounds(clip)), [0, 50, 100, 0]);

  // 복합 패스 마스크, 그룹 안의 마스크, 여러 개 선택
  const compoundMask = { typename: 'CompoundPathItem', geometricBounds: [10, 40, 60, 5], pathItems: [{ clipping: true }] };
  const clip2 = group([compoundMask, hiddenArt], { clipped: true });
  const outer = group([clip2, pathItem([70, 20, 120, -10])]);
  const doc = { selection: [outer, clip] };
  assert.deepStrictEqual(Array.from(core.domboArtworkBounds(doc)), [0, 50, 120, -10]);
});

test('숨긴 개체는 범위에서 뺀다', () => {
  const g = group([pathItem([0, 10, 10, 0]), pathItem([-100, 100, 100, -100], { hidden: true })]);
  assert.deepStrictEqual(Array.from(core.domboItemBounds(g)), [0, 10, 10, 0]);
});

const layer = (name, items, extra = {}) => ({ name, visible: true, pageItems: items, layers: [], ...extra });
const docWith = (layers, artboardRect = [0, 300, 300, 0]) => ({
  selection: [],
  layers,
  artboards: { 0: { artboardRect }, getActiveArtboardIndex: () => 0 },
});

test('아무것도 선택하지 않으면 대지 밖까지 문서의 보이는 개체 전체를 기준으로 한다', () => {
  const clip = group([pathItem([10, 100, 110, 20], { clipping: true }), pathItem([-500, 500, 500, -500])], { clipped: true });
  const doc = docWith([
    layer('작업', [clip, pathItem([150, 80, 200, 40])], {
      layers: [layer('하위', [pathItem([50, 150, 60, 140])])],
    }),
    layer('숨김', [pathItem([-50, 400, 400, -50])], { visible: false }),
    layer('돔보마크', [pathItem([-30, 330, 330, -30])]),
    layer('칼선', [pathItem([-30, 330, 330, -30])]),
    layer('대지밖', [pathItem([1000, 1100, 1100, 1000]), pathItem([0, 0, 0, 0], { guides: true })]),
  ]);
  assert.deepStrictEqual(Array.from(core.domboArtworkBounds(doc)), [10, 1100, 1100, 20]);
});

test('선택도 없고 개체도 없으면 알려준다', () => {
  assert.throws(() => core.domboArtworkBounds(docWith([layer('작업', [])])), /개체가 없습니다/);
});

test('칼선: 클리핑 마스크는 안쪽 내용 없이 마스크 모양 하나만 만든다', () => {
  core.ElementPlacement = { PLACEATEND: 'end' };
  const out = [];
  const cutLayer = { items: out };
  const dupable = (item) => Object.assign(item, {
    duplicate(target) { const c = { ...this }; target.items.push(c); return c; },
  });
  const mask = dupable(pathItem([0, 50, 100, 0], { clipping: true, filled: true }));
  const inner = dupable(pathItem([-500, 500, 500, -500]));
  const innerClip = group([dupable(pathItem([1, 2, 3, 0], { clipping: true })), inner], { clipped: true });
  const clip = group([mask, inner, innerClip], { clipped: true });
  const loose = dupable(pathItem([200, 50, 250, 0]));
  // 글자는 복제본을 아웃라인으로, 이미지는 건너뛴다
  const outlined = pathItem([300, 20, 340, 0]);
  const text = dupable({ typename: 'TextFrame', createOutline() { return outlined; } });
  const image = { typename: 'PlacedItem', geometricBounds: [0, 1, 1, 0] };
  const stat = { paths: 0, skipped: 0 };
  [clip, group([loose, text, image])].forEach(it => core.domboCollectCut(it, cutLayer, 'SPOT', stat));

  assert.deepStrictEqual({ ...stat }, { paths: 3, skipped: 1 });
  assert.deepStrictEqual(out.slice(0, 2).map(o => Array.from(o.geometricBounds)), [[0, 50, 100, 0], [200, 50, 250, 0]]);
  assert.strictEqual(outlined.strokeColor, 'SPOT', '아웃라인한 글자도 칼선');
  assert.strictEqual(out[0].clipping, false);
  assert.strictEqual(out[0].filled, false);
  assert.strictEqual(out[0].strokeColor, 'SPOT');
  assert.strictEqual(mask.clipping, true, '원본 마스크는 그대로');
});

test('격자 칼선: 사각형 변마다 전체를 가로지르는 선, 붙은 변은 하나로', () => {
  // 2 x 2 로 붙은 사각형 (변 하나는 0.01pt 어긋남) → 세로 3개, 가로 3개
  const rects = [[0, 100, 50, 50], [50.01, 100, 100, 50], [0, 50, 50, 0], [50, 50, 100, 0]];
  const lines = Array.from(core.domboGridLines(rects, 0.1 * MM), l => Array.from(l, p => Array.from(p)));
  assert.strictEqual(lines.length, 6);
  const vertical = lines.filter(l => l[0][0] === l[1][0]).map(l => l[0][0]).sort((a, b) => a - b);
  const horizontal = lines.filter(l => l[0][1] === l[1][1]).map(l => l[0][1]).sort((a, b) => a - b);
  assert.deepStrictEqual(vertical, [0, 50, 100]);
  assert.deepStrictEqual(horizontal, [0, 50, 100]);
  lines.forEach(l => {
    const len = Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]);
    assert.strictEqual(len, 100, '선은 전체 영역을 가로지른다');
  });
});

test('격자 칼선: 왼쪽 위에서 시작해 지그재그로 이어 자른다', () => {
  const rects = [[0, 100, 50, 50], [50, 100, 100, 50], [0, 50, 50, 0], [50, 50, 100, 0]];
  const lines = Array.from(core.domboGridLines(rects, 0.1 * MM), l => Array.from(l, p => Array.from(p)));
  assert.deepStrictEqual(lines[0][0], [0, 100], '왼쪽 위에서 시작');
  // 칼을 든 채 움직이는 거리 합: 지그재그면 모서리끼리 이어져 거의 0
  let travel = 0;
  for (let i = 1; i < lines.length; i++) {
    travel += Math.hypot(lines[i][0][0] - lines[i - 1][1][0], lines[i][0][1] - lines[i - 1][1][1]);
  }
  // 중심점 기준 정렬(방향 안 바꿈)은 매번 100 이상 되돌아간다
  assert.ok(travel <= 200, `빈 이동 ${travel}`);
});

test('개수 세기: 글자 수, 아웃라인 도형 수, 마스크 틀과 숨긴 것은 빼기', () => {
  const c = { frames: 0, chars: 0, charsNoSpace: 0, shapes: 0 };
  const items = [
    { typename: 'TextFrame', contents: '털보 농장\r' },
    group([
      pathItem([0, 1, 1, 0], { clipping: true }),
      pathItem([0, 1, 1, 0]),
      { typename: 'CompoundPathItem', pathItems: [{ clipping: false }] },
      { typename: 'CompoundPathItem', pathItems: [{ clipping: true }] },
      pathItem([0, 1, 1, 0], { hidden: true }),
      { typename: 'TextFrame', contents: 'AB', hidden: true },
    ], { clipped: true }),
  ];
  items.forEach(it => core.domboCountItem(it, c));
  assert.deepStrictEqual({ ...c }, { frames: 1, chars: 6, charsNoSpace: 4, shapes: 2 });
});

test('막대 + 박스: 막대는 객체 위로 간격만큼, 박스는 객체 + 막대를 여백만큼 감싼다', () => {
  // 객체 100 x 50mm, 기본값: 막대 높이 2mm, 간격 5mm, 박스 여백 10mm
  const r = core.domboBarBoxRects(art, {});
  nearPts([r.bar.slice(0, 2), r.bar.slice(2)], mmPts([[57, 0], [100, 2]]));
  // 박스: 위 = 막대 위 57 + 10, 왼쪽 -10, 가로 120, 세로 (57 - 0) + 20
  nearPts([r.box.slice(0, 2), r.box.slice(2)], mmPts([[67, -10], [120, 77]]));

  const noBar = core.domboBarBoxRects(art, { useBar: false, boxMarginMm: '3' });
  assert.strictEqual(noBar.bar, null);
  nearPts([noBar.box.slice(0, 2), noBar.box.slice(2)], mmPts([[53, -3], [106, 56]]));

  assert.throws(() => core.domboBarBoxRects(art, { barHeightMm: 0 }), /막대 높이/);
  assert.throws(() => core.domboBarBoxRects(art, { boxMarginMm: NaN }), /박스 여백/);
});

test('막대 + 박스 대상: 여러 개면 각각, 그룹 하나면 하위 그룹마다', () => {
  const a = pathItem([0, 1, 1, 0]), b = pathItem([2, 3, 3, 2]);
  assert.deepStrictEqual(Array.from(core.domboBarBoxTargets([a, b])), [a, b]);
  const sub1 = group([a]), sub2 = group([b]);
  const parent = group([sub1, pathItem([5, 6, 6, 5]), sub2]);
  assert.deepStrictEqual(Array.from(core.domboBarBoxTargets([parent])), [sub1, sub2]);
  const flat = group([a, b]);
  assert.deepStrictEqual(Array.from(core.domboBarBoxTargets([flat])), [flat]);
  const clip = group([pathItem([0, 1, 1, 0], { clipping: true }), group([a])], { clipped: true });
  assert.deepStrictEqual(Array.from(core.domboBarBoxTargets([clip])), [clip], '마스크 그룹은 통째로');
});

test('치수 글자: 소수점·천 단위 쉼표·단위', () => {
  assert.strictEqual(core.domboDimLabel(300, 0, true), '300 mm');
  assert.strictEqual(core.domboDimLabel(1234.56, 1, true), '1,234.6 mm');
  assert.strictEqual(core.domboDimLabel(5000, 0, false), '5,000');
  assert.strictEqual(core.domboDimLabel(12.004, 2, false), '12.00');
});

test('치수선: 가로는 위, 세로는 오른쪽에 거리만큼 띄우고 양 끝에 화살표', () => {
  // 객체 100 x 50mm, 거리 10mm, 글자 5mm (자동 아님)
  const g = core.domboDimGeometry(art, { offsetMm: 10, textAuto: false, textMm: 5 });
  near(g.textPt, 5 * MM);
  const lines = Array.from(g.lines, l => Array.from(l, p => Array.from(p)));
  assert.strictEqual(lines.length, 6, '보조선 2 + 치수선 1, 가로·세로');
  // 가로 치수선: 객체 위 50mm 에서 10mm + 글자 반 만큼 위, 왼쪽~오른쪽 끝
  const yW = (50 + 10 + 2.5) * MM;
  near(lines[2][0][1], yW); near(lines[2][1][1], yW);
  near(lines[2][0][0], 0); near(lines[2][1][0], 100 * MM);
  // 세로 치수선: 객체 오른쪽 100mm 에서 같은 만큼 오른쪽, 위~아래 끝
  const xH = (100 + 10 + 2.5) * MM;
  near(lines[5][0][0], xH); near(lines[5][1][0], xH);
  near(lines[5][0][1], 50 * MM); near(lines[5][1][1], 0);
  assert.strictEqual(g.arrows.length, 4);
  const texts = Array.from(g.texts, t => ({ ...t }));
  assert.deepStrictEqual(texts.map(t => [t.str, t.angle]), [['100 mm', 0], ['50 mm', 90]]);
  near(texts[0].x, 50 * MM);
  assert.ok(texts[0].y > yW, '가로 글자는 치수선 위');
  assert.ok(texts[1].x > xH, '세로 글자는 치수선 오른쪽');
});

test('치수선: 아래·왼쪽, 가로만, 글자 크기 자동', () => {
  const g = core.domboDimGeometry(art, { hSide: 'bottom', showH: false, offsetMm: 0 });
  assert.strictEqual(g.lines.length, 3);
  assert.ok(g.lines[2][0][1] < 0, '아래쪽');
  near(g.textPt, 3 * MM); // 큰 변 100mm × 3% = 3mm
  const big = core.domboDimGeometry([0, 5000 * MM, 5000 * MM, 0], { vSide: 'left', showW: false });
  near(big.textPt, 60 * MM); // 상한 60mm
  assert.ok(big.lines[2][0][0] < 0, '왼쪽');
  const tiny = core.domboDimGeometry([0, 10 * MM, 10 * MM, 0], {});
  near(tiny.textPt, 2.5 * MM); // 하한 2.5mm
  assert.throws(() => core.domboDimGeometry(art, { showW: false, showH: false }), /하나는/);
  assert.throws(() => core.domboDimGeometry(art, { decimals: 3 }), /소수점/);
});

test('돔보·개수 세기 전체 기준에서 치수 레이어는 뺀다', () => {
  const doc = docWith([
    layer('작업', [pathItem([0, 100, 100, 0])]),
    layer('치수', [pathItem([-50, 200, 200, -50])]),
  ]);
  assert.deepStrictEqual(Array.from(core.domboArtworkBounds(doc)), [0, 100, 100, 0]);
});

test('아일렛: 원 바깥선이 테두리에서 여백만큼, 모서리 포함 똑같이 나누고 겹치면 하나만', () => {
  // 현수막 1000 x 500mm, 여백 10mm, 지름 5mm → 중심선은 테두리에서 12.5mm 안쪽
  const banner = [0, 500 * MM, 1000 * MM, 0];
  const r = core.domboGrommetCenters(banner, {});
  near(r.radius, 2.5 * MM);
  nearPts(Array.from(r.centers), mmPts([[12.5, 487.5], [987.5, 487.5], [12.5, 12.5], [987.5, 12.5]]));

  // 위 5개, 왼쪽 3개 (모서리는 위·아래와 겹치니 가운데 하나만 더)
  const r2 = core.domboGrommetCenters(banner, { top: 5, bottom: 2, left: 3 });
  assert.strictEqual(r2.centers.length, 5 + 2 + 1);
  const step = (987.5 - 12.5) / 4;
  nearPts(Array.from(r2.centers).slice(0, 5), mmPts([0, 1, 2, 3, 4].map(i => [12.5 + step * i, 487.5])));
  nearPts([r2.centers[7]], mmPts([[12.5, 250]]));

  // 1개면 가운데
  const r3 = core.domboGrommetCenters(banner, { top: 1, bottom: 0 });
  nearPts(Array.from(r3.centers), mmPts([[500, 487.5]]));
});

test('아일렛: 너무 작으면 건너뛰고, 잘못된 값은 거절', () => {
  assert.strictEqual(core.domboGrommetCenters([0, 20 * MM, 20 * MM, 0], {}).centers.length, 0);
  assert.throws(() => core.domboGrommetCenters(art, { top: 1.5 }), /정수/);
  assert.throws(() => core.domboGrommetCenters(art, { top: 0, bottom: 0 }), /하나 이상/);
  assert.throws(() => core.domboGrommetCenters(art, { diameterMm: 0 }), /타공 크기/);
  // 패널·대화상자에서 온 글자 숫자
  assert.strictEqual(core.domboGrommetCenters([0, 500 * MM, 1000 * MM, 0], { top: '3', bottom: '0', marginMm: '20' }).centers.length, 3);
});

test('분할: 가로 3등분, 안쪽 이음매만 겹침 절반씩', () => {
  // 900 x 300mm, 겹침 20mm → 조각 300mm, 이음매 양쪽 10mm
  const b = [0, 300 * MM, 900 * MM, 0];
  const r = Array.from(core.domboSplitRects(b, { count: 3, overlapMm: 20 }), x => Array.from(x));
  nearPts(r.map(x => [x[0], x[2]]), mmPts([[0, 310], [290, 610], [590, 900]]));
  r.forEach(x => { near(x[1], 300 * MM); near(x[3], 0); });
  // 세로 2등분: 위쪽부터
  const v = Array.from(core.domboSplitRects(b, { direction: 'v', count: 2, overlapMm: 10 }), x => Array.from(x));
  nearPts(v.map(x => [x[1], x[3]]), mmPts([[300, 145], [155, 0]]));
  v.forEach(x => { near(x[0], 0); near(x[2], 900 * MM); });
});

test('분할: 원본 아래 50mm 부터 간격을 두고 위에서 아래로 늘어놓는다', () => {
  const b = [100, 300 * MM, 900 * MM, 0];
  const rects = core.domboSplitRects(b, { count: 3, overlapMm: 0 });
  const m = Array.from(core.domboSplitMoves(b, rects, 20 * MM), x => Array.from(x));
  // 각 조각의 왼쪽 위가 (원본 왼쪽, 아래 50mm), 그다음은 조각 높이 + 20mm 아래
  rects.forEach((r, i) => {
    near(r[0] + m[i][0], 100);
    near(r[1] + m[i][1], -50 * MM - i * (300 + 20) * MM);
  });
});

test('분할: 잘못된 값은 거절', () => {
  const b = [0, 100 * MM, 100 * MM, 0];
  assert.throws(() => core.domboSplitRects(b, { count: 1 }), /2 ~ 100/);
  assert.throws(() => core.domboSplitRects(b, { count: 2.5 }), /정수/);
  assert.throws(() => core.domboSplitRects(b, { count: 5, overlapMm: 40 }), /겹침이 조각 크기보다/);
  assert.throws(() => core.domboSplitRects(b, { direction: 'x' }), /방향/);
});

test('분할: 조각마다 원본 복제 + 맨 위 사각형으로 클리핑 마스크, 원본은 그대로', () => {
  const groups = [];
  const mkGroup = () => {
    const g = {
      typename: 'GroupItem', kids: [], dx: 0, dy: 0,
      pathItems: { rectangle: (t, l, w, h) => { const r = { typename: 'PathItem', rect: [l, t, l + w, t - h], move(tg, where) { g.kids.splice(g.kids.indexOf(r), 1); where === 'begin' ? g.kids.unshift(r) : g.kids.push(r); } }; g.kids.push(r); return r; } },
      translate(dx, dy) { g.dx += dx; g.dy += dy; },
    };
    groups.push(g);
    return g;
  };
  const art = pathItem([0, 300 * MM, 900 * MM, 0], { duplicate(target) { const c = { typename: 'PathItem', copyOf: 'art' }; target.kids.push(c); return c; } });
  const lyr = { name: '분할', locked: false, visible: true, groupItems: { add: mkGroup }, zOrder() {} };
  const doc = {
    selection: [art], layers: { length: 1, 0: lyr, add: () => lyr },
  };
  doc.layers[0] = lyr;
  core.app = { documents: { length: 1 }, activeDocument: doc };
  core.ElementPlacement = { PLACEATEND: 'end', PLACEATBEGINNING: 'begin' };
  const msg = core.domboSplit({ count: 3, overlapMm: 20 });
  assert.match(msg, /가로로 3등분/);
  assert.strictEqual(groups.length, 3);
  groups.forEach((g, i) => {
    assert.strictEqual(g.clipped, true);
    assert.strictEqual(g.kids[0].typename, 'PathItem');
    assert.ok(g.kids[0].rect, '맨 위가 조각 사각형');
    assert.strictEqual(g.kids[1].copyOf, 'art', '그 아래 원본 복제');
    assert.strictEqual(g.name, `분할 ${i + 1}/3`);
  });
  near(groups[1].kids[0].rect[0], 290 * MM);
  assert.deepStrictEqual(art.geometricBounds, [0, 300 * MM, 900 * MM, 0], '원본은 그대로');
});

test('크기·헤베: 기준은 맨 바깥 클리핑 마스크 > 그룹 > 가장 큰 개체', () => {
  const mm = (x1, y1, x2, y2) => [x1 * MM, y1 * MM, x2 * MM, y2 * MM];
  // 마스크 안의 마스크는 보지 않고, 그룹 안에 있어도 맨 바깥 마스크를 쓴다. 큰 개체가 있어도 마스크가 먼저
  const inner = group([pathItem(mm(0, 50, 50, 0), { clipping: true }), pathItem(mm(0, 900, 900, 0))], { clipped: true });
  const outerClip = group([pathItem(mm(0, 900, 300, 0), { clipping: true }), inner], { clipped: true, name: '현수막' });
  const big = pathItem(mm(0, 2000, 2000, 0));
  let p = core.domboHebePick([big, group([outerClip, pathItem(mm(-10, 1000, 1000, -10))])]);
  assert.strictEqual(p.kind, '클리핑 마스크');
  assert.strictEqual(p.item, outerClip);
  // 마스크가 없으면 그룹 (그룹이 개체보다 작아도)
  const g = group([pathItem(mm(0, 100, 100, 0)), pathItem(mm(200, 100, 300, 0))]);
  p = core.domboHebePick([big, g]);
  assert.strictEqual(p.kind, '그룹');
  assert.deepStrictEqual(Array.from(p.bounds), mm(0, 100, 300, 0));
  // 그룹도 없으면 가장 큰 개체, 패스 기준(선 두께 제외)
  const thick = pathItem(mm(0, 10, 10, 0), { visibleBounds: mm(-50, 60, 60, -50) });
  p = core.domboHebePick([thick, pathItem(mm(0, 20, 20, 0))]);
  assert.strictEqual(p.kind, '가장 큰 개체');
  assert.deepStrictEqual(Array.from(p.bounds), mm(0, 20, 20, 0));
  assert.strictEqual(core.domboHebePick([pathItem(mm(0, 1, 1, 0), { hidden: true })]), null);
});

test('크기·헤베: 1:1 과 10:1 파일, 큰 캔버스 배율', () => {
  const pick = { kind: '클리핑 마스크', item: { name: '' }, bounds: [0, 900 * MM, 3000 * MM, 0] };
  let t = core.domboHebeText(pick, 1, 1);
  assert.match(t, /1:1 파일/);
  assert.match(t, /가로 3,000 mm × 세로 900 mm/);
  assert.match(t, /헤베: 2\.70 ㎡/);
  // 1/10 로 그린 파일: 300 x 90mm → 실제 3,000 x 900mm
  t = core.domboHebeText({ ...pick, bounds: [0, 90 * MM, 300 * MM, 0] }, 10, 1);
  assert.match(t, /가로 3,000 mm × 세로 900 mm/);
  assert.match(t, /파일 크기 300 × 90 mm/);
  assert.match(t, /헤베: 2\.70 ㎡/);
  // 큰 캔버스 문서(배율 10)는 스크립트 좌표가 1/10
  t = core.domboHebeText({ ...pick, bounds: [0, 90 * MM, 300 * MM, 0] }, 1, 10);
  assert.match(t, /헤베: 2\.70 ㎡/);
  t = core.domboHebeText({ ...pick, bounds: [0, 333.33 * MM, 1234.5 * MM, 0] }, 1, 1);
  assert.match(t, /가로 1,234\.5 mm × 세로 333\.3 mm/);
  assert.match(t, /헤베: 0\.41 ㎡/);
});

test('사이즈 표시: 글자는 103*105cm(가로*세로), 10:1 이면 ×10, 소수는 1자리', () => {
  assert.strictEqual(core.domboSizeLabel([0, 1050 * MM, 1030 * MM, 0], 1), '103*105cm(가로*세로)');
  assert.strictEqual(core.domboSizeLabel([0, 105 * MM, 103 * MM, 0], 10), '103*105cm(가로*세로)');
  assert.strictEqual(core.domboSizeLabel([0, 900 * MM, 12345 * MM, 0], 1), '1,234.5*90cm(가로*세로)');
});

test('사이즈 표시 대상: 고른 것마다 (그룹이 아닌 패스도), 그룹 하나면 안의 것마다', () => {
  const targets = sel => Array.from(core.domboSizeTargets(sel));
  const small = pathItem([0, 10, 10, 0]), large = pathItem([0, 100, 100, 0]);
  const g1 = group([small]), g2 = group([large]);
  // 그룹과 패스를 섞어 골라도 하나도 빠지지 않는다
  assert.deepStrictEqual(targets([g1, small, g2, large]), [g1, small, g2, large]);
  assert.deepStrictEqual(targets([small, pathItem([0, 1, 1, 0], { hidden: true })]), [small]);
  // 그룹 하나 안에 하위 그룹이 있으면 안의 것마다 (패스도)
  const loose = pathItem([0, 1, 1, 0]);
  assert.deepStrictEqual(targets([group([g1, g2, loose])]), [g1, g2, loose]);
  // 하위 그룹이 없는 그룹(한 작업물) 은 그 그룹 하나
  const piece = group([small, large]);
  assert.deepStrictEqual(targets([piece]), [piece]);
  const clip = group([pathItem([0, 50, 50, 0], { clipping: true }), g1], { clipped: true });
  assert.deepStrictEqual(targets([clip]), [clip], '클리핑 그룹은 안으로 들어가지 않는다');
  // 각 작업물 안의 기준은 맨 바깥 마스크
  assert.strictEqual(core.domboHebePick([group([clip, large])]).item, clip);
});

test('칼선: 작업물마다 하나 — 마스크는 마스크 모양, 마스크 없는 그룹은 합친 외곽선, 그 밖은 개체 모양', () => {
  core.ElementPlacement = { PLACEATEND: 'end' };
  const dupable = (item) => Object.assign(item, {
    duplicate(target) { const c = { ...this }; target.items.push(c); return c; },
  });
  const mkLayer = () => {
    const l = { items: [] };
    l.groupItems = { add() { const g = { typename: 'GroupItem', items: [], removed: false, remove() { this.removed = true; } }; g.pageItems = g.items; l.items.push(g); return g; } };
    return l;
  };
  const stat = { paths: 0, skipped: 0 };
  const united = [];
  const unite = g => { united.push(g); return g; };

  // 마스크: 그룹 안에 있어도 맨 바깥 마스크 하나
  let l = mkLayer();
  const mask = dupable(pathItem([0, 50, 100, 0], { clipping: true }));
  const clip = group([mask, dupable(pathItem([-500, 500, 500, -500]))], { clipped: true });
  let p = core.domboCutOne(group([clip, dupable(pathItem([0, 10, 10, 0]))]), l, 'SPOT', stat, unite);
  assert.strictEqual(p.kind, '클리핑 마스크');
  assert.strictEqual(l.items.length, 1);
  assert.deepStrictEqual(Array.from(l.items[0].geometricBounds), [0, 50, 100, 0]);
  assert.strictEqual(united.length, 0);

  // 마스크 없는 그룹: 도형을 모아 합치기 → 칼선 1개
  l = mkLayer();
  const before = stat.paths;
  p = core.domboCutOne(group([dupable(pathItem([0, 50, 80, 0])), dupable(pathItem([70, 30, 100, 0]))]), l, 'SPOT', stat, unite);
  assert.strictEqual(p.kind, '그룹');
  assert.strictEqual(united.length, 1);
  assert.strictEqual(united[0].items.length, 2, '두 도형을 모아서');
  assert.strictEqual(stat.paths - before, 1, '칼선은 하나로 셈');

  // 그룹이 아닌 개체 하나: 그 모양
  l = mkLayer();
  p = core.domboCutOne(dupable(pathItem([0, 20, 30, 0])), l, 'SPOT', stat, unite);
  assert.strictEqual(p.kind, '가장 큰 개체');
  assert.strictEqual(l.items[0].strokeColor, 'SPOT');
  assert.strictEqual(l.items[0].filled, false);

  // 이미지만 있는 그룹은 칼선 없음
  l = mkLayer();
  assert.strictEqual(core.domboCutOne(group([{ typename: 'PlacedItem', geometricBounds: [0, 1, 1, 0] }]), l, 'SPOT', stat, unite), null);
  assert.ok(l.items[0].removed, '빈 임시 그룹은 지운다');
});

test('도련: 사방 n 씩 커지도록 가로·세로 비율', () => {
  const s = Array.from(core.domboBleedScale([0, 50 * MM, 100 * MM, 0], 3 * MM));
  near(s[0], 106);
  near(s[1], 112);
  assert.throws(() => core.domboBleedScale([0, 0, 10, 0], 1), /크기가 0/);
});

test('도련: 원본은 그대로, 복제본을 원본 바로 아래에 키운다 — (원본) 전체 / (마스크) 마스크만', () => {
  core.ElementPlacement = { PLACEAFTER: 'after' };
  core.Transformation = { CENTER: 'center' };
  // 크기 바꾸기·옮기기를 흉내 내는 패스 (가운데 기준)
  const shape = (b, extra = {}) => ({
    typename: 'PathItem', b: b.slice(), ...extra,
    get geometricBounds() { return this.b; }, get visibleBounds() { return this.b; },
    resize(sx, sy) {
      const [l, t, r, btm] = this.b, cx = (l + r) / 2, cy = (t + btm) / 2, w = (r - l) * sx / 100, h = (t - btm) * sy / 100;
      this.b = [cx - w / 2, cy + h / 2, cx + w / 2, cy - h / 2];
    },
    translate(dx, dy) { this.b = [this.b[0] + dx, this.b[1] + dy, this.b[2] + dx, this.b[3] + dy]; },
  });
  const placed = [];
  const clone = it => {
    if (it.typename === 'GroupItem') {
      const kids = it.pageItems.map(clone);
      const g = { typename: 'GroupItem', clipped: it.clipped, pageItems: kids,
        resize(sx, sy) { kids.forEach(k => k.resize(sx, sy)); }, translate(dx, dy) { kids.forEach(k => k.translate(dx, dy)); } };
      return g;
    }
    return shape(it.b, { clipping: it.clipping });
  };
  const dupable = it => Object.assign(it, { duplicate(rel, where) { const c = clone(this); placed.push([rel, where]); this.copy = c; return c; } });
  const n = 3 * MM;

  // 마스크 방식: 마스크만 사방 3mm, 안의 그림은 그대로
  const mask = shape([0, 50 * MM, 100 * MM, 0], { clipping: true });
  const art = shape([-20 * MM, 70 * MM, 120 * MM, -20 * MM]);
  const clip = dupable({ typename: 'GroupItem', clipped: true, pageItems: [mask, art] });
  assert.strictEqual(core.domboBleedOne(clip, n, 'mask'), 'mask');
  assert.deepStrictEqual(placed[0], [clip, 'after'], '원본 바로 아래(뒤)');
  const copy = clip.copy;
  copy.pageItems[0].b.forEach((v, i) => near(v, [-3 * MM, 53 * MM, 103 * MM, -3 * MM][i]));
  assert.deepStrictEqual(copy.pageItems[1].b, art.b, '그림은 그대로');
  assert.deepStrictEqual(mask.b, [0, 50 * MM, 100 * MM, 0], '원본 마스크는 그대로');
  assert.strictEqual(copy.name, '도련');

  // 원본 방식: 복제본 전체를 키운다
  const p = dupable(shape([0, 50 * MM, 100 * MM, 0]));
  assert.strictEqual(core.domboBleedOne(p, n, 'item'), 'item');
  p.copy.b.forEach((v, i) => near(v, [-3 * MM, 53 * MM, 103 * MM, -3 * MM][i]));
  assert.deepStrictEqual(p.b, [0, 50 * MM, 100 * MM, 0], '원본은 그대로');

  // 마스크 방식인데 마스크가 없으면 원본 방식
  const q = dupable(shape([0, 10 * MM, 10 * MM, 0]));
  assert.strictEqual(core.domboBleedOne(q, n, 'mask'), 'item');
});

test('넘버링 순서: 줄마다 왼쪽 → 오른쪽, 위 줄 → 아래 줄 (높이가 달라도 반 이상 겹치면 같은 줄)', () => {
  // 그림처럼: 맨 위 작은 것 1개, 다음 줄 6개(높이 제각각), 그다음 줄 6개, 맨 아래 1개 (y 위로 증가)
  const R = (l, t, w, h) => [l, t, l + w, t - h];
  const list = [
    R(240, 300, 250, 60), R(20, 300, 210, 60), R(500, 300, 130, 60), R(640, 305, 110, 60), R(760, 300, 200, 55), R(970, 298, 100, 55),  // 2줄 (섞어서)
    R(20, 360, 55, 55),                                                                                                            // 1줄
    R(15, 210, 100, 50), R(130, 215, 200, 60), R(350, 215, 240, 60), R(610, 210, 130, 55), R(755, 210, 110, 52),                  // 3줄
    R(15, 90, 200, 65),                                                                                                            // 4줄
  ];
  list.push(R(880, 140, 60, 20)); // 3줄 아래쪽에 살짝 걸친 것 → 반도 안 겹치면 다른 줄
  const order = Array.from(core.domboReadingOrder(list));
  assert.deepStrictEqual(order, [6, 1, 0, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13, 12]);
});

test('넘버링: 작업물 번호와 조각 번호 (작업물-조각), 앞 글자, 선·가는 것은 조각이 아님', () => {
  const MMp = MM;
  const P = (l, t, r, b, extra = {}) => pathItem([l * MMp, t * MMp, r * MMp, b * MMp], extra);
  // 작업물 A: 2 x 2 조각 + 가는 흰 선 (넓이 0)
  const A = group([P(0, 100, 50, 50), P(50, 100, 100, 50), P(0, 50, 50, 0), P(50, 50, 100, 0), P(0, 50, 100, 50)]);
  // 작업물 B: 조각 하나뿐 (그냥 번호), 오른쪽에
  const B = group([P(200, 100, 300, 0)]);
  // 작업물 C: 클리핑 마스크 안에 그룹 하나, 그 안에 조각 3개 (가로로)
  const inner = group([P(0, -50, 30, -100), P(30, -50, 60, -100), P(60, -50, 90, -100)]);
  const C = group([P(0, -50, 90, -100, { clipping: true }), inner], { clipped: true });
  const labels = Array.from(core.domboNumberLabels([B, C, A], { pieces: true, prefix: '1028-' }), l => l.text);
  assert.deepStrictEqual(labels, ['1028-1-1', '1028-1-2', '1028-1-3', '1028-1-4', '1028-2', '1028-3-1', '1028-3-2', '1028-3-3']);
  const plain = Array.from(core.domboNumberLabels([B, C, A], { pieces: false }), l => l.text);
  assert.deepStrictEqual(plain, ['1', '2', '3']);
});

test('넘버링 자리: 늘 작업물 바깥 — 윗줄 조각은 위, 아랫줄은 아래, 가운데 줄은 왼쪽·오른쪽', () => {
  const P = (l, t, r, b) => pathItem([l * MM, t * MM, r * MM, b * MM]);
  // 3줄 x 3칸 작업물 (0~90 x 0~90mm)
  const kids = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) kids.push(P(i * 30, 90 - j * 30, (i + 1) * 30, 60 - j * 30));
  const labels = Array.from(core.domboNumberLabels([group(kids)], { pieces: true }));
  assert.deepStrictEqual(labels.map(l => l.side), ['top', 'top', 'top', 'left', 'left', 'right', 'bottom', 'bottom', 'bottom']);
  // 글자(가로 8 x 세로 4mm)를 옮긴 자리는 작업물 범위와 겹치지 않는다
  const edge = [0, 90 * MM, 90 * MM, 0], gap = 2 * MM;
  labels.forEach(l => {
    const tb = [0, 4 * MM, 8 * MM, 0], mv = Array.from(core.domboNumberMove(tb, l.bounds, l.edge, l.side, gap));
    const t = [tb[0] + mv[0], tb[1] + mv[1], tb[2] + mv[0], tb[3] + mv[1]];
    const overlap = t[0] < edge[2] && t[2] > edge[0] && t[3] < edge[1] && t[1] > edge[3];
    assert.ok(!overlap, `${l.text} 가 작업물 위에 있다`);
  });
  // 조각이 없으면 작업물 번호는 위쪽 바깥
  assert.strictEqual(core.domboNumberLabels([P(0, 10, 10, 0)], { pieces: true })[0].side, 'top');
});
