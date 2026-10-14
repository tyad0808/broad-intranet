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
  // 글자는 복제본을 아웃라인으로, 이미지는 건너뛴다 (도련이 없을 때)
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

test('도련: 사방으로 n 만큼 키우는 비율, 구멍 찾기, 패스 이동 효과', () => {
  const sc = Array.from(core.domboBleedScale([0, 50, 100, 0], 5));
  near(sc[0], 110); near(sc[1], 120);
  assert.throws(() => core.domboBleedScale([0, 0, 10, 0], 1), /크기가 0/);
  // 바깥, 구멍, 떨어진 것, 구멍 안의 섬 → 구멍과 섬은 지운다
  const sq = (x, y, w) => [[x, y], [x + w, y], [x + w, y + w], [x, y + w]];
  assert.deepStrictEqual(Array.from(core.domboHoleIndices([sq(0, 0, 100), sq(10, 10, 80), sq(200, 0, 10), sq(40, 40, 10)])), [1, 3]);
  assert.strictEqual(core.domboOffsetXml(8.5039, 'round'),
    '<LiveEffect name="Adobe Offset Path"><Dict data="R mlim 4 R ofst 8.504 I jntp 0 "/></LiveEffect>');
  assert.throws(() => core.domboCutMerge({ bleedMm: -1 }), /0 이상/);
  assert.strictEqual(core.domboCutMerge({ bleedMm: '3' }).bleedMm, 3);
});

test('도련: 클리핑 마스크는 마스크를 키우고, 그림이 모자라면 알려 준다', () => {
  core.Transformation = { CENTER: 'center' };
  const mkMask = b => pathItem(b, {
    clipping: true,
    resize(sx, sy, changePos, a, b2, c, lw, about) {
      assert.strictEqual(about, 'center');
      const g = this.geometricBounds, cx = (g[0] + g[2]) / 2, cy = (g[1] + g[3]) / 2;
      const w = (g[2] - g[0]) * sx / 100, h = (g[1] - g[3]) * sy / 100;
      this.geometricBounds = [cx - w / 2, cy + h / 2, cx + w / 2, cy - h / 2];
    },
  });
  const mask = mkMask([0, 100, 100, 0]);
  const photo = pathItem([-50, 150, 150, -50]);
  const clip = group([mask, photo], { clipped: true });
  assert.strictEqual(core.domboAddBleed({}, clip, null, 10), 'mask');
  assert.deepStrictEqual(Array.from(mask.geometricBounds), [-10, 110, 110, -10]);

  const mask2 = mkMask([0, 100, 100, 0]);
  const tight = group([mask2, pathItem([0, 100, 100, 0])], { clipped: true });
  assert.strictEqual(core.domboAddBleed({}, tight, null, 10), 'mask-short');
});

// 도련용 가짜 일러스트레이터: 사각형 패스, 복제, 크기 바꾸기, 효과(되거나 안 되거나), 복합 패스, 그룹
function bleedFake(effectWorks) {
  const calls = [];
  let selection = [];
  const doc = {};
  Object.defineProperty(doc, 'selection', { get: () => selection, set: v => { selection = v || []; } });
  const groups = [];
  const containerOf = kids => ({ kids, items: kids });
  function rectPts(b) {
    // 반시계 방향 사각형 (왼쪽 아래부터)
    return [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]].map(p => ({ anchor: p, leftDirection: p, rightDirection: p, pointType: 'corner' }));
  }
  function mkPath(b, layer) {
    const it = {
      typename: 'PathItem', name: '', layer, b: b.slice(), effect: 0,
      get geometricBounds() { return this.b.slice(); },
      get visibleBounds() { const e = this.effect; return [this.b[0] - e, this.b[1] + e, this.b[2] + e, this.b[3] - e]; },
      get pathPoints() { return this.pts || rectPts(this.b); },
      set selected(v) { if (v) selection = [it]; },
      duplicate() { const c = mkPath(this.b, this.layer); c.effect = this.effect; return c; },
      move(target, where) { it.movedTo = [target, where]; if (target.kids) { if (where === 'begin') target.kids.unshift(it); else target.kids.push(it); } },
      resize(sx, sy, a1, a2, a3, a4, lw, about) {
        calls.push(['resize', Math.round(sx), Math.round(sy)]);
        const cx = (this.b[0] + this.b[2]) / 2, cy = (this.b[1] + this.b[3]) / 2;
        const w = (this.b[2] - this.b[0]) * sx / 100, h = (this.b[1] - this.b[3]) * sy / 100;
        this.b = [cx - w / 2, cy + h / 2, cx + w / 2, cy - h / 2];
      },
      applyEffect(xml) { calls.push(['effect', xml.match(/ofst ([\d.]+)/)[1]]); if (effectWorks) it.pending = Number(xml.match(/ofst ([\d.]+)/)[1]); },
      remove() { it.removed = true; },
    };
    return it;
  }
  const layer = {
    groupItems: { add: () => { const g = { typename: 'GroupItem', name: '', kids: [], move(t, w) { g.movedTo = [t, w]; } }; groups.push(g); return g; } },
    compoundPathItems: { add: () => { const c = { typename: 'CompoundPathItem', kids: [], move(t, w) { c.movedTo = [t, w]; if (t.kids) { if (w === 'begin') t.kids.unshift(c); else t.kids.push(c); } } }; c.pathItems = c.kids; groups.push(c); return c; } },
    pathItems: { add: () => { const q = mkPath([0, 0, 0, 0], layer); q.setEntirePath = pts => { q.pts = pts.map(p => ({ anchor: p, leftDirection: p, rightDirection: p })); }; return q; } },
  };
  const app = {
    redraw() { calls.push(['redraw']); },
    executeMenuCommand(cmd) {
      calls.push(['menu', cmd]);
      // 펼치기: 효과가 됐으면 실제로 커진다
      if (cmd === 'expandStyle') selection.forEach(it => { if (it.pending) { const n = it.pending; it.b = [it.b[0] - n, it.b[1] + n, it.b[2] + n, it.b[3] - n]; it.pending = 0; } });
    },
  };
  return { calls, doc, layer, groups, mkPath, app };
}

for (const effectWorks of [true, false]) {
  test(`도련: 벡터는 넓힌 복사본을 칼선 바깥 고리로 가려 원본 바로 뒤에 (패스 이동 ${effectWorks ? '됨' : '안 됨 → 가로·세로 키우기'})`, () => {
    const f = bleedFake(effectWorks);
    core.app = f.app;
    core.Transformation = { CENTER: 'center' };
    core.ElementPlacement = { PLACEATEND: 'end', PLACEATBEGINNING: 'begin', PLACEAFTER: 'after' };
    const art = f.mkPath([0, 100, 200, 0], f.layer);   // 파란 사각형
    const cut = f.mkPath([0, 100, 200, 0], f.layer);   // 칼선 (같은 크기)
    const kind = core.domboAddBleed(f.doc, art, cut, 10);
    assert.strictEqual(kind, effectWorks ? 'vector' : 'approx');

    const clip = f.groups.find(g => g.name === '도련');
    assert.ok(clip, '도련 그룹');
    assert.strictEqual(clip.clipped, true);
    assert.deepStrictEqual(clip.movedTo, [art, 'after'], '원본 바로 뒤');
    const [ring, grown] = clip.kids;
    assert.strictEqual(ring.typename, 'CompoundPathItem', '맨 위가 고리(가리개)');
    // 넓힌 그림: 사방 10
    assert.deepStrictEqual(grown.geometricBounds.map(Math.round), [-10, 110, 210, -10]);
    // 고리: 바깥은 사방 10.5, 안은 칼선 그대로, 서로 반대 방향
    const [outer, inner] = ring.kids;
    assert.deepStrictEqual(outer.geometricBounds.map(v => Math.round(v * 10) / 10), [-10.5, 110.5, 210.5, -10.5]);
    const area = pts => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length].anchor; return s + p.anchor[0] * q[1] - q[0] * p.anchor[1]; }, 0);
    assert.ok(Math.sign(area(outer.pathPoints)) !== Math.sign(area(inner.pathPoints)), '안쪽은 반대 방향 (구멍)');
    assert.ok(!f.calls.some(c => c[0] === 'menu' && /Pathfinder/.test(c[1])), '사각형 칼선은 패스파인더 없이');
    assert.ok(f.calls.some(c => c[0] === 'redraw'), '효과 뒤 화면 다시 그리기');
    if (!effectWorks) assert.ok(f.calls.some(c => c[0] === 'resize'), '가로·세로 키우기로 대신');
  });
}
