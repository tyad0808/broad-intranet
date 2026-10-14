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
  const r = core.domboComputeMarks(art, {});
  near(r.radius, 3 * MM);
  // 중심은 작업물에서 거리 5mm + 반지름 3mm = 8mm 바깥. 간격 300mm 보다 작으니 네 모서리만
  nearPts(r.centers, mmPts([[-8, 58], [108, 58], [108, -8], [-8, -8]]));
  nearPts([[r.extent[0], r.extent[1]], [r.extent[2], r.extent[3]]], mmPts([[-11, 61], [111, -11]]));
  nearPts([[r.paper[0], r.paper[1]], [r.paper[2], r.paper[3]]], mmPts([[-16, 66], [116, -16]]));
});

test('위·아래 변만 간격 이하로 똑같이 나누고, 좌우 변 가운데에는 찍지 않는다', () => {
  // 중심 사각형 116mm x 66mm, 간격 50mm → 위·아래 3칸(38.67mm)
  const r = core.domboComputeMarks(art, { spacingMm: 50 });
  const w = 116 / 3;
  nearPts(r.centers, mmPts([
    [-8, 58], [-8 + w, 58], [-8 + 2 * w, 58], [108, 58],
    [108, -8], [-8 + 2 * w, -8], [-8 + w, -8], [-8, -8],
  ]));
  near(r.spacingX, w * MM);
  // 세로가 간격보다 길어도 좌우 변에는 모서리만
  const tall = core.domboComputeMarks([0, 500 * MM, 100 * MM, 0], { spacingMm: 50 });
  assert.ok(Array.from(tall.centers).every(c => Math.abs(c[1] - 508 * MM) < 1e-9 || Math.abs(c[1] + 8 * MM) < 1e-9));
});

test('길이가 간격으로 딱 나눠지면 칸을 더 만들지 않는다', () => {
  // 중심 사각형 116mm x 66mm → 간격 58mm 이면 가로 2칸
  const r = core.domboComputeMarks(art, { spacingMm: 58 });
  near(r.spacingX, 58 * MM);
  assert.strictEqual(r.centers.length, 2 * 3);
});

test('간격 0 이면 네 모서리만, 패널에서 온 글자 숫자도 받는다', () => {
  const r = core.domboComputeMarks(art, { diameterMm: '4', offsetMm: '2', spacingMm: '0' });
  nearPts(r.centers, mmPts([[-4, 54], [104, 54], [104, -4], [-4, -4]]));
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
  const text = { typename: 'TextFrame' };
  const stat = { paths: 0, skipped: 0 };
  [clip, group([loose, text])].forEach(it => core.domboCollectCut(it, cutLayer, 'SPOT', stat));

  assert.deepStrictEqual({ ...stat }, { paths: 2, skipped: 1 });
  assert.deepStrictEqual(out.map(o => Array.from(o.geometricBounds)), [[0, 50, 100, 0], [200, 50, 250, 0]]);
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
