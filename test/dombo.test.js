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
