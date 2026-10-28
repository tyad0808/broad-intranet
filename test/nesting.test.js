// 일러스트레이터 네스팅 패널: 배치 계산과 글자 조각 나누기 (일러스트레이터 없이 검사할 수 있는 부분)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '../tools/illustrator-nesting/jsx/nest-core.jsx');
const core = {};
vm.runInNewContext(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), core);
const plain = v => JSON.parse(JSON.stringify(v));

// 배치 결과 검사: 원판 안(여백 포함), 서로 간격 이상 떨어짐, 크기는 원래(또는 회전) 그대로
function checkLayout(sizes, o, r) {
  assert.strictEqual(r.placements.length, sizes.length, '모두 배치');
  const E = 1e-6;
  r.placements.forEach(p => {
    const s = sizes[p.id];
    const [w, h] = p.rotated ? [s.h, s.w] : [s.w, s.h];
    assert.ok(Math.abs(p.w - w) < E && Math.abs(p.h - h) < E, '크기 유지');
    if (!o.allowRotate) assert.strictEqual(p.rotated, false);
    assert.ok(p.x >= o.margin - E && p.y >= o.margin - E, '여백 안');
    assert.ok(p.x + p.w <= o.binW - o.margin + E, '폭 안');
    assert.ok(p.y + p.h <= r.binHeights[p.bin] - o.margin + E, '높이 안');
  });
  for (let i = 0; i < r.placements.length; i++) {
    for (let j = i + 1; j < r.placements.length; j++) {
      const a = r.placements[i], b = r.placements[j];
      if (a.bin !== b.bin) continue;
      const apart = a.x + a.w + o.gap <= b.x + E || b.x + b.w + o.gap <= a.x + E ||
        a.y + a.h + o.gap <= b.y + E || b.y + b.h + o.gap <= a.y + E;
      assert.ok(apart, `${i} 와 ${j} 가 간격 없이 겹침`);
    }
  }
}

test('같은 크기 사각형은 빈틈없이 격자로 들어간다', () => {
  // 100 x 100 원판, 여백 0, 간격 0 → 25 x 25 짜리 16개가 정확히 한 장
  const sizes = Array.from({ length: 16 }, (_, i) => ({ id: i, w: 25, h: 25 }));
  const o = { binW: 100, binH: 100, gap: 0, margin: 0, allowRotate: false, mode: 'sheet' };
  const r = plain(core.nestPack(sizes, o));
  assert.strictEqual(r.bins, 1);
  checkLayout(sizes, o, r);
  // 하나 더 넣으면 두 장
  sizes.push({ id: 16, w: 25, h: 25 });
  assert.strictEqual(core.nestPack(sizes, o).bins, 2);
});

test('여백과 간격을 지키며 섞인 크기를 배치한다', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const sizes = Array.from({ length: 60 }, (_, i) => ({ id: i, w: 10 + rnd() * 90, h: 10 + rnd() * 60 }));
  const o = { binW: 300, binH: 200, gap: 3, margin: 5, allowRotate: true, mode: 'sheet' };
  const r = plain(core.nestPack(sizes, o));
  checkLayout(sizes, o, r);
  const area = sizes.reduce((s, x) => s + (x.w + 3) * (x.h + 3), 0);
  assert.ok(r.bins <= Math.ceil(area / (292 * 192) / 0.8), `원판 ${r.bins}장은 너무 많다`);
});

test('회전을 허용하면 눕혀야 들어가는 것도 넣는다', () => {
  const sizes = [{ id: 0, w: 50, h: 150 }];
  const o = { binW: 200, binH: 100, gap: 0, margin: 0, allowRotate: true, mode: 'sheet' };
  const r = plain(core.nestPack(sizes, o));
  assert.strictEqual(r.placements[0].rotated, true);
  checkLayout(sizes, o, r);
  assert.throws(() => core.nestPack(sizes, { ...o, allowRotate: false }), e => {
    assert.match(e.message, /용지보다 큰 작업물이 1개/);
    assert.deepStrictEqual(Array.from(e.tooBig), [0]);
    return true;
  });
});

test('롤 용지는 쓴 길이만큼 자르고, 최대 길이를 넘으면 다음 장으로 나눈다', () => {
  // 폭 100 (여백 5, 간격 2) 에 40 x 30 짜리 → 한 줄에 2개, 줄 높이 32
  const sizes = Array.from({ length: 6 }, (_, i) => ({ id: i, w: 40, h: 30 }));
  const o = { binW: 100, binH: 10000, gap: 2, margin: 5, allowRotate: false, mode: 'roll' };
  const r = plain(core.nestPack(sizes, o));
  assert.strictEqual(r.bins, 1);
  // 3줄: 30*3 + 간격 2*2 + 여백 5*2 = 104
  assert.ok(Math.abs(r.binHeights[0] - 104) < 1e-6, `길이 ${r.binHeights[0]}`);
  checkLayout(sizes, o, r);

  const short = plain(core.nestPack(sizes, { ...o, binH: 70 }));
  assert.strictEqual(short.bins, 3, '한 장에 한 줄만 들어가면 3장으로 나눈다');
  checkLayout(sizes, { ...o, binH: 70 }, short);
});

test('롤 용지: 가로로 긴 것을 회전해서 길이를 줄인다', () => {
  const sizes = Array.from({ length: 4 }, (_, i) => ({ id: i, w: 90, h: 20 }));
  const o = { binW: 100, binH: 10000, gap: 0, margin: 0, allowRotate: true, mode: 'roll' };
  const r = plain(core.nestPack(sizes, o));
  checkLayout(sizes, o, r);
  assert.ok(r.binHeights[0] <= 80 + 1e-6, `길이 ${r.binHeights[0]}`);
});

const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

test('글자 조각: 구멍은 바깥 윤곽과 한 조각, 떨어진 획은 따로', () => {
  // 'ㅇ' 모양(바깥 + 구멍) 하나와 옆에 떨어진 획 하나, 구멍 안의 섬 하나
  const polys = [
    square(0, 0, 100),      // 0 바깥
    square(10, 10, 80),     // 1 구멍
    square(200, 0, 20),     // 2 떨어진 획
    square(40, 40, 20),     // 3 구멍 안의 섬 → 따로 떨어지는 조각
  ];
  assert.deepStrictEqual(plain(core.nestPieces(polys)), [[0, 1], [2], [3]]);
});

test('글자 조각: 베지어 곡선을 꼭짓점으로 펴서 원 안의 구멍도 알아본다', () => {
  // 반지름 r 원을 4점 베지어로
  const circle = (r) => {
    const c = 0.5523 * r;
    return [
      { anchor: [r, 0], leftDirection: [r, -c], rightDirection: [r, c] },
      { anchor: [0, r], leftDirection: [c, r], rightDirection: [-c, r] },
      { anchor: [-r, 0], leftDirection: [-r, c], rightDirection: [-r, -c] },
      { anchor: [0, -r], leftDirection: [-c, -r], rightDirection: [c, -r] },
    ];
  };
  const outer = core.nestFlatten(circle(100), true, 8);
  assert.strictEqual(outer.length, 32);
  assert.ok(Math.abs(core.nestPolyArea(outer) - Math.PI * 100 * 100) / (Math.PI * 1e4) < 0.01, '원 넓이와 비슷');
  // 구멍(반지름 90)을 45도 돌려 놓아도 바깥 원 안으로 판정
  const inner = core.nestFlatten(circle(90), true, 8).map(([x, y]) => [(x - y) * Math.SQRT1_2, (x + y) * Math.SQRT1_2]);
  assert.deepStrictEqual(plain(core.nestPieces([outer, inner])), [[0, 1]]);
});

test('설정 검사', () => {
  assert.throws(() => core.nestCheckRoll({ widthMm: 0 }), /용지 폭/);
  assert.throws(() => core.nestCheckRoll({ quantity: 1.5 }), /정수/);
  assert.throws(() => core.nestCheckText({ unit: 'word' }), /단위/);
  const o = core.nestCheckText({ sheetWMm: '600', allowRotate: 'false', quantity: '2' });
  assert.strictEqual(o.sheetWMm, 600);
  assert.strictEqual(o.allowRotate, false);
  assert.strictEqual(o.quantity, 2);
  assert.throws(() => core.nestPack([{ id: 0, w: 10, h: 10 }], { binW: 10, binH: 10, gap: 0, margin: 6, mode: 'sheet' }), /여백/);
});

// ---- 가짜 일러스트레이터로 전체 흐름 검사 ----
function fakeIllustrator() {
  const all = new Set();
  const shift = (b, dx, dy) => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
  class Item {
    constructor(typename, props = {}) { Object.assign(this, { typename, hidden: false, name: '' }, props); all.add(this); this.parent = null; }
    get geometricBounds() { return this.calc(); }
    get visibleBounds() { const b = this.calc(); return [b[0] - 1, b[1] + 1, b[2] + 1, b[3] - 1]; } // 선 두께 1pt 흉내
    calc() {
      if (this.kids) return this.kids.map(k => k.calc()).reduce((a, v) => [Math.min(a[0], v[0]), Math.max(a[1], v[1]), Math.max(a[2], v[2]), Math.min(a[3], v[3])]);
      return this.b;
    }
    clone() {
      const c = new Item(this.typename, { ...this, kids: undefined, parent: null });
      if (this.kids) { c.kids = this.kids.map(k => { const d = k.clone(); d.parent = c; return d; }); }
      if (this.pts) c.pts = this.pts.map(p => p.slice());
      return c;
    }
    duplicate(target) { const c = this.clone(); target.adopt(c); return c; }
    move(target) { this.detach(); target.adopt(this); }
    detach() { if (this.parent) { const s = this.parent.kids || this.parent.items; s.splice(s.indexOf(this), 1); this.parent = null; } }
    remove() { this.detach(); const kill = it => { all.delete(it); (it.kids || []).forEach(kill); }; kill(this); }
    translate(dx, dy) { this.each(it => { it.b = shift(it.b, dx, dy); if (it.pts) it.pts = it.pts.map(([x, y]) => [x + dx, y + dy]); }); }
    rotate(deg) {
      if (deg !== 90) { for (let i = 0; i < deg / 90; i++) this.rotate(90); return; }
      const b = this.calc(), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      const rot = ([x, y]) => [cx - (y - cy), cy + (x - cx)];
      this.each(it => {
        const p1 = rot([it.b[0], it.b[1]]), p2 = rot([it.b[2], it.b[3]]);
        it.b = [Math.min(p1[0], p2[0]), Math.max(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.min(p1[1], p2[1])];
        if (it.pts) it.pts = it.pts.map(rot);
      });
      this.rotated = (this.rotated || 0) + 90;
    }
    each(f) { if (this.kids) this.kids.forEach(k => k.each(f)); else f(this); }
    get pageItems() { return this.kids; }
    get pathItems() { return this.kids; }
    get pathPoints() { return this.pts.map(p => ({ anchor: p, leftDirection: p, rightDirection: p })); }
    createOutline() {
      const g = new Item('GroupItem', { kids: [] });
      this.glyphs.forEach(gl => { const c = gl.clone(); c.parent = g; g.kids.push(c); });
      const parent = this.parent;
      if (!this.keepsTextAfterOutline) this.remove(); // 어떤 버전에선 글상자가 남는다
      parent.adopt(g);
      return g;
    }
  }
  const rectPath = (l, t, r, b) => new Item('PathItem', { b: [l, t, r, b], pts: [[l, t], [r, t], [r, b], [l, b]], closed: true });
  const compound = (...paths) => { const c = new Item('CompoundPathItem', { kids: paths }); paths.forEach(p => { p.parent = c; }); return c; };
  const group = (...kids) => { const g = new Item('GroupItem', { kids, clipped: false }); kids.forEach(k => { k.parent = g; }); return g; };
  const mkLayer = name => {
    const l = {
      name, items: [], locked: false, visible: true, typename: 'Layer',
      adopt(it) { it.parent = this; this.items.push(it); },
      get pageItems() { return this.items; },
      remove() { layers.splice(layers.indexOf(this), 1); },
    };
    l.pathItems = { rectangle: (t, left, w, h) => { const r = rectPath(left, t, left + w, t - h); l.adopt(r); return r; } };
    return l;
  };
  const layers = [mkLayer('작업')];
  layers.add = () => { const l = mkLayer(''); layers.push(l); return l; };
  const artboards = [{ artboardRect: [0, 1000, 1000, 0], name: '대지 1' }];
  artboards.getActiveArtboardIndex = () => 0;
  artboards.add = () => { throw new Error('대지를 만들면 안 된다'); };
  const doc = { layers, artboards, selection: [], documentColorSpace: 'CMYK' };
  const app = { documents: { length: 1 }, activeDocument: doc };
  return { all, Item, rectPath, compound, group, doc, app, layers, artboards };
}

function loadWith(fake) {
  const ctx = {
    app: fake.app, ElementPlacement: { PLACEATEND: 'end' }, DocumentColorSpace: { CMYK: 'CMYK' },
    CMYKColor: function () {}, RGBColor: function () {},
  };
  ctx.$ = { global: ctx };
  vm.runInNewContext(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), ctx);
  return ctx;
}

const MM = 72 / 25.4;
const inside = (b, ab) => b[0] >= ab[0] - 1e-6 && b[1] <= ab[1] + 1e-6 && b[2] <= ab[2] + 1e-6 && b[3] >= ab[3] - 1e-6;
const apart = (a, b, gap) => a[2] + gap <= b[0] + 1e-6 || b[2] + gap <= a[0] + 1e-6 || a[3] >= b[1] + gap - 1e-6 || b[3] >= a[1] + gap - 1e-6;

test('용지 폭 네스팅: 선택한 자리부터 수량만큼 배치, 안내선 없음, 원본은 숨긴 레이어로', () => {
  const f = fakeIllustrator();
  const a = f.rectPath(0, 300, 400 * MM, 300 - 200 * MM);  // 400 x 200mm
  const b = f.rectPath(50, 0, 50 + 100 * MM, -100 * MM);   // 100 x 100mm
  f.layers[0].adopt(a); f.layers[0].adopt(b);
  f.doc.selection = [a, b];
  const ai = loadWith(f);
  const msg = ai.nestRoll({ widthMm: 1000, quantity: 3, gapMm: 5, marginMm: 10 });
  assert.match(msg, /6개를 폭 1000mm/);
  assert.strictEqual(f.artboards.length, 1, '대지는 만들지 않는다');

  const layer = f.layers.find(l => l.name === '네스팅');
  assert.ok(!layer.items.some(it => it.guides), '안내선은 그리지 않는다');
  const parts = layer.items;
  assert.strictEqual(parts.length, 6);
  // 용지: 선택한 것들의 왼쪽 위 (선 두께 뺀 패스 범위 geometricBounds) 에서 시작, 길이는 메시지의 사용 길이
  const used = Number(msg.match(/사용 길이 (\d+)mm/)[1]) * MM;
  const sb = [0, 300, 1000 * MM, 300 - used];
  assert.ok(Math.min(...parts.map(p => p.geometricBounds[0])) === 10 * MM, '왼쪽 여백부터');
  assert.ok(Math.max(...parts.map(p => p.geometricBounds[1])) === 300 - 10 * MM, '위 여백부터');

  const backup = f.layers.find(l => l.name === '네스팅 전 원본');
  assert.deepStrictEqual(backup.items, [a, b], '원본은 숨긴 레이어로');
  assert.strictEqual(backup.visible, false);
  assert.strictEqual(backup.locked, true);
  assert.deepStrictEqual(a.b, [0, 300, 400 * MM, 300 - 200 * MM], '원본 위치는 그대로');

  const vb = parts.map(it => it.geometricBounds); // 간격·여백은 패스 기준
  const inner = [sb[0] + 10 * MM, sb[1] - 10 * MM, sb[2] - 10 * MM, sb[3] + 10 * MM];
  vb.forEach(v => assert.ok(inside(v, inner), '여백 안'));
  for (let i = 0; i < vb.length; i++) for (let j = i + 1; j < vb.length; j++) assert.ok(apart(vb[i], vb[j], 5 * MM - 1e-6), '간격 유지');
  assert.match(msg, /대지 밖/, '1000mm 대지보다 크면 알려 준다');
});

test('용지 폭 네스팅은 여러 장이면 시작점에서 오른쪽 옆으로 (폭 + 간격) 씩 놓는다', () => {
  const o = Array.from(core.nestOriginsSide([10, 500], 1000, 3, 30), p => Array.from(p));
  assert.deepStrictEqual(o, [[10, 500], [1040, 500], [2070, 500]]);
});

test('원판(텍스트)은 여러 장이면 시작점에서 아래로 간격을 두고 쌓는다', () => {
  const o = Array.from(core.nestOrigins([10, 500], [100, 50, 80], 30), p => Array.from(p));
  assert.deepStrictEqual(o, [[10, 500], [10, 370], [10, 290]]);
});

test('아크릴 텍스트 네스팅: 살아있는 글자를 아웃라인해서 글자마다·조각마다 배치', () => {
  for (const unit of ['glyph', 'piece']) {
    const f = fakeIllustrator();
    // '이' 같은 글자: 바깥+구멍(ㅇ) 과 떨어진 획(ㅣ) 이 한 복합 패스
    const ieung = [f.rectPath(0, 100, 60, 40), f.rectPath(10, 90, 50, 50)];
    const bar = f.rectPath(80, 100, 90, 0);
    const glyph1 = f.compound(ieung[0], ieung[1], bar);
    const glyph2 = f.rectPath(100, 100, 140, 0);   // 'l'
    const text = new f.Item('TextFrame', { b: [0, 100, 140, 0], glyphs: [glyph1, glyph2] });
    f.layers[0].adopt(text);
    f.doc.selection = [text];
    const ai = loadWith(f);
    const msg = ai.nestText({ sheetWMm: 100, sheetHMm: 100, gapMm: 2, marginMm: 3, unit, laserLine: true });
    const layer = f.layers.find(l => l.name === '네스팅');
    assert.ok(!layer.items.some(it => it.guides), '안내선은 그리지 않는다');
    const expected = unit === 'glyph' ? 2 : 3;
    assert.strictEqual(layer.items.length, expected, `${unit}: ${msg}`);
    const backup = f.layers.find(l => l.name === '네스팅 전 원본');
    assert.ok(f.all.has(text) && text.parent === backup && backup.visible === false, '원본 글자는 숨긴 레이어에');
    assert.strictEqual(f.artboards.length, 1);
    if (unit === 'piece') {
      const withHole = layer.items.find(it => it.kids && it.kids.length === 2);
      assert.ok(withHole, 'ㅇ 은 구멍과 함께 한 조각');
    }
    layer.items.forEach(it => it.each(p => {
      assert.strictEqual(p.filled, false);
      assert.strictEqual(p.strokeWidth, 0.1);
    }));
    const ab = [0, 100, 100 * MM, 100 - 100 * MM]; // 원판: 글자가 있던 자리(왼쪽 위)부터
    layer.items.forEach(it => assert.ok(inside(it.geometricBounds, [ab[0] + 3 * MM, ab[1] - 3 * MM, ab[2] - 3 * MM, ab[3] + 3 * MM])));
    assert.match(layer.items[0].name, unit === 'glyph' ? /^글자_/ : /^조각_/);
  }
});

test('네스팅: 원판보다 큰 글자는 알려주고 만든 것을 치운다', () => {
  const f = fakeIllustrator();
  const big = f.rectPath(0, 1000, 1000, 0); // 약 353mm
  f.layers[0].adopt(big);
  f.doc.selection = [big];
  const ai = loadWith(f);
  assert.throws(() => ai.nestText({ sheetWMm: 100, sheetHMm: 100 }), /용지보다 큰 작업물이 1개 .*353×353mm/);
  const layer = f.layers.find(l => l.name === '네스팅');
  assert.strictEqual(layer.items.length, 0, '복제본을 남기지 않는다');
  assert.strictEqual(big.parent, f.layers[0], '실패하면 원본도 그대로');
});

const nestShape = require('../tools/illustrator-nesting/nest-shape.js');

test('모양대로 네스팅: 준비 → 패널 계산 → 적용, ㅁ 구멍 안에 작은 글자가 들어간다', () => {
  const f = fakeIllustrator();
  // 'ㅁ' (바깥 100 x 100mm, 두께 10mm) 와 작은 'l' 네 개 (15 x 15mm)
  const s = 100 * MM, t = 10 * MM, q = 15 * MM;
  const mieum = f.compound(f.rectPath(0, s, s, 0), f.rectPath(t, s - t, s - t, t));
  const smalls = [0, 1, 2, 3].map(i => f.rectPath(200 * MM + i * 20 * MM, q, 200 * MM + i * 20 * MM + q, 0));
  const text = new f.Item('TextFrame', { b: [0, s, 300 * MM, 0], glyphs: [mieum, ...smalls] });
  f.layers[0].adopt(text);
  f.doc.selection = [text];
  const ai = loadWith(f);
  const opts = { sheetWMm: 110, sheetHMm: 110, marginMm: 3, gapMm: 3, unit: 'glyph', method: 'shape', precisionMm: 1 };

  const data = JSON.parse(ai.nestTextPrepare(opts));
  assert.strictEqual(data.pieces.length, 5);
  assert.strictEqual(data.pieces[0].polys.length, 2, 'ㅁ 은 바깥 + 구멍 윤곽선');
  const plan = nestShape.nest(data.pieces, {
    sheetW: 110 * MM, sheetH: 110 * MM, margin: 3 * MM, gap: 3 * MM, res: 1 * MM, allowRotate: true,
  });
  assert.strictEqual(plan.bins, 1, '구멍 안에 넣어서 한 장');
  // 패널은 JSON 으로 넘긴다
  const msg = ai.nestTextApply(JSON.parse(JSON.stringify(plan)));
  assert.match(msg, /글자 5개를 모양대로 110×110mm 원판 1장/);

  const layer = f.layers.find(l => l.name === '네스팅');
  assert.ok(!layer.items.some(it => it.guides), '안내선은 그리지 않는다');
  const parts = layer.items;
  const sheet = [0, 100 * MM, 110 * MM, 100 * MM - 110 * MM]; // 원판: 글자가 있던 자리(왼쪽 위)부터
  assert.strictEqual(parts.length, 5);
  // 실제 자리에서: 원판 여백 안, 작은 것들은 ㅁ 구멍 안, 서로 간격 유지
  const big = parts.find(p => p.kids && p.kids.length === 2);
  parts.forEach(p => assert.ok(inside(p.geometricBounds, [sheet[0] + 3 * MM, sheet[1] - 3 * MM, sheet[2] - 3 * MM, sheet[3] + 3 * MM]), '여백 안'));
  const hole = big.kids.map(k => k.b).sort((a, b) => (a[2] - a[0]) - (b[2] - b[0]))[0];
  const others = parts.filter(p => p !== big);
  others.forEach(p => assert.ok(inside(p.b, [hole[0] + 3 * MM - 1e-6, hole[1] - 3 * MM + 1e-6, hole[2] - 3 * MM + 1e-6, hole[3] + 3 * MM - 1e-6]), '구멍 안, 간격 유지'));
  for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) assert.ok(apart(others[i].b, others[j].b, 3 * MM - 1e-6));
  assert.ok(f.layers.find(l => l.name === '네스팅 전 원본').items.includes(text), '원본은 숨긴 레이어로');
  assert.strictEqual(ai.$.global.NEST_PENDING, null);
});

test('모양대로 네스팅: 계산이 실패하면 준비한 복제본을 치우고 원본은 그대로', () => {
  const f = fakeIllustrator();
  const a = f.rectPath(0, 100, 100, 0);
  f.layers[0].adopt(a);
  f.doc.selection = [a];
  const ai = loadWith(f);
  JSON.parse(ai.nestTextPrepare({ method: 'shape' }));
  const layer = f.layers.find(l => l.name === '네스팅');
  assert.strictEqual(layer.items.length, 1);
  ai.nestTextCancel();
  assert.strictEqual(layer.items.length, 0);
  assert.strictEqual(a.parent, f.layers[0]);
  assert.throws(() => ai.nestTextApply({ placements: [], bins: 0, area: 0 }), /준비된 글자가 없습니다/);
});

for (const method of ['shape', 'rect']) {
  test(`세트 수량 1 이면 한 세트만: 아웃라인 뒤 글상자가 남아도, 그룹과 안의 글자가 같이 선택돼도 (${method})`, () => {
    const f = fakeIllustrator();
    const glyphA = f.rectPath(0, 100, 40, 0), glyphB = f.rectPath(50, 100, 90, 0);
    const text = new f.Item('TextFrame', { b: [0, 100, 90, 0], glyphs: [glyphA, glyphB], keepsTextAfterOutline: true });
    const grp = f.group(text);
    f.layers[0].adopt(grp);
    f.doc.selection = [grp, text]; // 그룹 + 그 안의 글상자
    const ai = loadWith(f);
    const opts = { sheetWMm: 200, sheetHMm: 200, quantity: 1, method };
    if (method === 'shape') {
      const data = JSON.parse(ai.nestTextPrepare(opts));
      assert.strictEqual(data.pieces.length, 2, '글자 2개만 준비');
      ai.nestTextApply(JSON.parse(JSON.stringify(nestShape.nest(data.pieces, { sheetW: 200 * MM, sheetH: 200 * MM, margin: 5 * MM, gap: 3 * MM, res: MM, allowRotate: true }))));
    } else {
      ai.nestText(opts);
    }
    const layer = f.layers.find(l => l.name === '네스팅');
    const parts = layer.items.filter(it => !it.guides);
    assert.strictEqual(parts.length, 2, '글자 2개 = 1세트');
    assert.ok(parts.every(p => p.typename !== 'TextFrame'), '남은 글상자 없음');
    assert.ok(!f.layers.some(l => l.name === '네스팅 작업중'), '작업 레이어는 지운다');
    assert.ok(parts.every(p => !p.note), '표시용 메모는 지운다');
  });
}

test('세트 수량 2 면 두 세트', () => {
  const f = fakeIllustrator();
  const text = new f.Item('TextFrame', { b: [0, 100, 90, 0], glyphs: [f.rectPath(0, 100, 40, 0), f.rectPath(50, 100, 90, 0)] });
  f.layers[0].adopt(text);
  f.doc.selection = [text];
  const ai = loadWith(f);
  const data = JSON.parse(ai.nestTextPrepare({ quantity: 2, method: 'shape' }));
  assert.strictEqual(data.pieces.length, 4);
});

test('용지 폭 네스팅: 최대 길이를 넘으면 두 번째 장은 오른쪽 옆에 위를 맞춰 놓는다', () => {
  const f = fakeIllustrator();
  const a = f.rectPath(0, 300, 400 * MM, 300 - 400 * MM);  // 400 x 400mm
  f.layers[0].adopt(a);
  f.doc.selection = [a];
  const ai = loadWith(f);
  const msg = ai.nestRoll({ widthMm: 500, maxLengthMm: 500, quantity: 2, gapMm: 5, marginMm: 10 });
  assert.match(msg, /2장으로 나눔/);
  const parts = f.layers.find(l => l.name === '네스팅').items.map(it => it.geometricBounds).sort((p, q) => p[0] - q[0]);
  assert.strictEqual(parts.length, 2);
  const near = (x, y, m) => assert.ok(Math.abs(x - y) < 1e-6, m || `${x} != ${y}`);
  near(parts[0][0], 10 * MM);
  near(parts[1][0], (500 + 30 + 10) * MM, '옆 장: 용지 폭 + 30mm 오른쪽');
  near(parts[0][1], 300 - 10 * MM);
  near(parts[1][1], 300 - 10 * MM, '위를 맞춤');
});
