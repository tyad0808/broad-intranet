// 모양대로 네스팅 (래스터): 빈 곳·구멍에 끼워 넣기, 겹치지 않기, 간격·여백 지키기
const test = require('node:test');
const assert = require('node:assert');
const shape = require('../tools/illustrator-nesting/nest-shape.js');

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

// 결과대로 실제 윤곽선을 옮겨 놓는다 (원판 왼쪽 위 = (0,0), y 는 위로)
function placed(pieces, r, sheetH, gapBetweenSheets = 0) {
  const byId = new Map(pieces.map(p => [p.id, p]));
  return r.placements.map(pl => {
    const polys = byId.get(pl.id).polys.map(poly => poly.map(pt => shape.rotatePoint(pt, pl.angle)));
    let minX = Infinity, maxY = -Infinity;
    polys.forEach(poly => poly.forEach(([x, y]) => { minX = Math.min(minX, x); maxY = Math.max(maxY, y); }));
    const oy = -pl.bin * (sheetH + gapBetweenSheets);
    return { id: pl.id, bin: pl.bin, polys: polys.map(poly => poly.map(([x, y]) => [x - minX + pl.x, y - maxY - pl.y + oy])) };
  });
}

function insideAny(pt, polys) {
  let c = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
  }
  return c;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
// 윤곽선 위 점을 촘촘히
function samples(polys, step = 0.5) {
  const out = [];
  polys.forEach(poly => poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
    for (let k = 0; k < n; k++) out.push([p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n]);
  }));
  return out;
}
function minDist(A, B) {
  let d = Infinity;
  for (const p of samples(A.polys)) {
    if (insideAny(p, B.polys)) return -1; // 겹침
    for (const poly of B.polys) for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return d;
}

function checkLayout(pieces, o, r) {
  assert.strictEqual(r.placements.length, pieces.length, '모두 배치');
  const P = placed(pieces, r, o.sheetH);
  P.forEach(p => samples(p.polys).forEach(([x, y]) => {
    const top = -p.bin * o.sheetH;
    assert.ok(x >= o.margin - 1e-6 && x <= o.sheetW - o.margin + 1e-6, `가로 여백 ${x}`);
    assert.ok(top - y >= o.margin - 1e-6 && top - y <= o.sheetH - o.margin + 1e-6, `세로 여백 ${top - y}`);
  }));
  for (let i = 0; i < P.length; i++) {
    for (let j = i + 1; j < P.length; j++) {
      if (P[i].bin !== P[j].bin) continue;
      const d = Math.min(minDist(P[i], P[j]), minDist(P[j], P[i]));
      assert.ok(d >= o.gap - 0.01, `조각 ${P[i].id} 과 ${P[j].id} 사이 ${d.toFixed(2)} < 간격 ${o.gap}`);
    }
  }
}

test('칸 바꾸기: 구멍은 비우고 테두리가 지나는 칸은 채운다', () => {
  const r = shape.rasterize([rect(0, 0, 10, 10), rect(3, 3, 4, 4)], 1);
  assert.strictEqual(r.w, 10);
  assert.strictEqual(r.h, 10);
  const at = (c, rr) => r.grid[rr * r.w + c];
  assert.strictEqual(at(0, 0), 1);
  assert.strictEqual(at(5, 5), 0, '구멍 가운데는 빈칸');
  assert.strictEqual(at(3, 5), 1, '구멍 테두리 칸은 채움');
});

test("'ㅁ' 구멍 안에 작은 조각을 넣어 원판 한 장으로 끝낸다", () => {
  // 바깥 100 x 100 테두리(두께 10), 작은 20 x 20 네 개. 원판 110 x 110 → 사각형 방식이면 2장
  const pieces = [{ id: 0, polys: [rect(0, 0, 100, 100), rect(10, 10, 80, 80)] }];
  for (let i = 1; i <= 4; i++) pieces.push({ id: i, polys: [rect(0, 0, 20, 20)] });
  const o = { sheetW: 110, sheetH: 110, margin: 5, gap: 3, res: 1, allowRotate: true };
  const r = shape.nest(pieces, o);
  assert.strictEqual(r.bins, 1);
  checkLayout(pieces, o, r);
});

test("'ㄱ' 두 개를 엇갈려 맞물리게 넣는다", () => {
  // 'ㄱ' 모양 (가로 획 100 x 20 + 세로 획 20 x 80): 범위는 100 x 100 이지만 넓이는 3600
  const giyeok = [[0, 100], [100, 100], [100, 0], [80, 0], [80, 80], [0, 80]];
  const pieces = [{ id: 0, polys: [giyeok] }, { id: 1, polys: [giyeok] }];
  // 원판 125 x 125: 범위(100 x 100)대로면 한 장에 하나뿐. 모서리 안쪽으로 겹쳐 넣으면 한 장
  const o = { sheetW: 125, sheetH: 125, margin: 0, gap: 2, res: 1, allowRotate: true };
  const r = shape.nest(pieces, o);
  assert.strictEqual(r.bins, 1);
  checkLayout(pieces, o, r);
});

test('회전을 막으면 돌리지 않고, 원판보다 큰 조각은 알려 준다', () => {
  const pieces = [{ id: 0, polys: [rect(0, 0, 50, 10)] }, { id: 1, polys: [rect(0, 0, 30, 30)] }];
  const o = { sheetW: 100, sheetH: 100, margin: 2, gap: 2, res: 1, allowRotate: false };
  const r = shape.nest(pieces, o);
  r.placements.forEach(p => assert.strictEqual(p.angle, 0));
  checkLayout(pieces, o, r);
  assert.throws(() => shape.nest([{ id: 7, polys: [rect(0, 0, 200, 10)] }], o), e => {
    assert.match(e.message, /원판보다 큰 조각이 1개/);
    assert.deepStrictEqual(e.tooBig, [7]);
    return true;
  });
});

test('여러 장으로 나누고, 넓이는 구멍을 뺀다', () => {
  const pieces = Array.from({ length: 9 }, (_, i) => ({ id: i, polys: [rect(0, 0, 40, 40)] }));
  const o = { sheetW: 100, sheetH: 100, margin: 0, gap: 5, res: 1, allowRotate: true };
  const r = shape.nest(pieces, o);
  assert.strictEqual(r.bins, 3, '40+5+40 → 한 장에 4개');
  checkLayout(pieces, o, r);
  assert.ok(Math.abs(shape.polyArea([rect(0, 0, 10, 10), rect(2, 2, 6, 6)]) - 64) < 1e-9);
});

test('곡선이 많은 글자 모양도 겹치지 않는다 (무작위 별 모양)', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const star = () => {
    const n = 5 + Math.floor(rnd() * 4), R = 10 + rnd() * 25, pts = [];
    for (let i = 0; i < n * 2; i++) {
      const a = Math.PI * i / n, rr = i % 2 ? R * (0.3 + rnd() * 0.3) : R;
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
    return pts;
  };
  const pieces = Array.from({ length: 25 }, (_, i) => ({ id: i, polys: [star()] }));
  const o = { sheetW: 200, sheetH: 150, margin: 3, gap: 2, res: 1, allowRotate: true };
  const r = shape.nest(pieces, o);
  checkLayout(pieces, o, r);
});

test('나눠 돌려도 한 번에 돌린 것과 결과가 같다', async () => {
  const pieces = Array.from({ length: 12 }, (_, i) => ({ id: i, polys: [rect(0, 0, 10 + i * 3, 15)] }));
  const o = { sheetW: 120, sheetH: 80, margin: 2, gap: 2, res: 1, allowRotate: true };
  const seen = [];
  const a = await shape.nestAsync(pieces, o, (n, total) => seen.push([n, total]));
  assert.deepStrictEqual(a, shape.nest(pieces, o));
  assert.deepStrictEqual(seen[seen.length - 1], [12, 12]);
  await assert.rejects(shape.nestAsync(pieces, { ...o, margin: 100 }), /여백/);
});
