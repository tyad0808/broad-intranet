// 등신대 외곽선 계산 (standee-shape.js): 외곽선 두께, 발 아래 일자, 좁은 틈·예각 메우기
const test = require('node:test');
const assert = require('node:assert');
const st = require('../tools/illustrator-standee/standee-shape.js');

// 사람 흉내 (칸 1개 = 1mm): 머리 + 몸통 + 다리 둘 (사이 틈 10mm) + 몸에 붙은 팔 (사이 틈 15mm)
function person() {
  const w = 300, h = 600, a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const on = (x - 150) ** 2 + (y - 80) ** 2 < 50 ** 2 ||
      (x > 100 && x < 200 && y > 130 && y < 380) ||
      (x > 105 && x < 145 && y >= 380 && y < 590) ||
      (x > 155 && x < 195 && y >= 380 && y < 580) ||
      (x > 60 && x < 85 && y > 140 && y < 340) || (x >= 85 && x <= 100 && y > 140 && y < 170);
    if (on) a[y * w + x] = 255;
  }
  return { a, w, h };
}
const bbox = pts => {
  const xs = pts.map(p => p.a[0]), ys = pts.map(p => p.a[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
// 점 하나가 윤곽선(꼭짓점 다각형) 안에 있는가
const inside = (pts, x, y) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i].a, [xj, yj] = pts[j].a;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
};

test('외곽선은 사람 둘레로 외곽선 두께만큼, 발 아래도 외곽선만큼 내려와 일자로 자른다', () => {
  const { a, w, h } = person();
  const r = st.outline(a, w, h, { cellMm: 1, outlineMm: 10, roundMm: 10 });
  const b = bbox(r.points);
  assert.ok(Math.abs(b[0] - 51) <= 1.5, `왼쪽 ${b[0]}`);   // 팔 61 - 10
  assert.ok(Math.abs(b[1] - 20) <= 1.5, `위 ${b[1]}`);     // 머리 30 - 10
  assert.ok(Math.abs(b[2] - 210) <= 1.5, `오른쪽 ${b[2]}`); // 몸통 200 + 10
  assert.strictEqual(b[3], 600, '발(590) 아래 외곽선 10mm 에서 일자');
  assert.strictEqual(r.feetY, 590);
  assert.strictEqual(r.cutY, 600);
  const corners = r.points.filter(p => p.corner);
  assert.strictEqual(corners.length, 2, '바닥 양 끝만 각진 모서리');
  corners.forEach(p => assert.strictEqual(p.a[1], 600));
  assert.ok(r.points.length < 200, `점이 너무 많다: ${r.points.length}`);
});

test('예각 정리: 다리 사이·팔 옆의 좁은 틈은 메우고, 0 이면 그대로 둔다', () => {
  const { a, w, h } = person();
  const filled = st.outline(a, w, h, { cellMm: 1, outlineMm: 3, roundMm: 10 }).points;
  assert.ok(inside(filled, 150, 500), '다리 사이 메움');
  assert.ok(inside(filled, 92, 250), '팔과 몸 사이 메움');
  const open = st.outline(a, w, h, { cellMm: 1, outlineMm: 3, roundMm: 0, baseMm: 0, fillLegs: false }).points;
  assert.ok(!inside(open, 150, 500), '예각 정리·바닥 채우기 0 이면 다리 사이가 비어 있다');
});

test('투명한 그림만 있으면 알려준다', () => {
  assert.throws(() => st.outline(new Uint8Array(100), 10, 10, { cellMm: 1, outlineMm: 10 }), /사람/);
});

test('칸 크기(mm)대로 두께를 잰다', () => {
  const w = 100, h = 100, a = new Uint8Array(w * h);
  for (let y = 20; y < 80; y++) for (let x = 20; x < 80; x++) a[y * w + x] = 255;
  const b = bbox(st.outline(a, w, h, { cellMm: 2, outlineMm: 10, roundMm: 0 }).points);
  assert.ok(Math.abs(b[0] - 15) <= 1 && Math.abs(b[1] - 15) <= 1, `${b}`);  // 10mm = 5칸
});

test('바닥 채우기: 장화 사이·앞코 아래 빈 곳은 바닥까지 곧게 메운다 (바닥 일자 선이 끊기지 않게)', () => {
  // 치마(아래로 넓어짐, 단이 y=480) + 장화 둘 (사이 80mm), 오른쪽 장화는 앞코가 바닥보다 30mm 앞으로 튀어나옴
  const w = 400, h = 600, a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const on = (y < 480 && x > 150 - y / 8 && x < 250 + y / 8) ||
      (y >= 430 && y < 590 && x > 80 && x < 150) ||
      (y >= 430 && y < 590 && x > 230 && x < 300) ||
      (y >= 520 && y < 560 && x >= 300 && x < 330);  // 앞코 (아래는 비어 있음)
    if (on) a[y * w + x] = 255;
  }
  const r = st.outline(a, w, h, { cellMm: 1, outlineMm: 10, roundMm: 5 });
  assert.ok(inside(r.points, 190, 560), '장화 사이 메움');
  assert.ok(inside(r.points, 320, 585), '앞코 아래 메움');
  const corners = r.points.filter(p => p.corner);
  assert.strictEqual(corners.length, 2);
  corners.forEach(p => assert.strictEqual(p.a[1], 600));
  const xs = corners.map(p => p.a[0]).sort((p, q) => p - q);
  assert.ok(xs[0] <= 72 && xs[1] >= 338, `바닥 선이 양쪽 끝까지: ${xs}`);
  // 바닥 채우기 0 이면 장화 사이가 빈다
  const open = st.outline(a, w, h, { cellMm: 1, outlineMm: 10, roundMm: 5, baseMm: 0, fillLegs: false });
  assert.ok(!inside(open.points, 190, 560));
});

test('다리 사이 메우기: 바닥부터 다리가 만나는 곳(가랑이)까지 메운다 — 틈이 넓고 높아도, 한쪽 발이 더 내려와도', () => {
  // 몸통(위) + 다리 둘: 사이 틈 60mm, 높이 350mm (바닥 채우기 높이 300mm 보다 높음). 왼발이 10mm 더 내려옴
  const w = 300, h = 700, a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const on = (y < 300 && x > 70 && x < 230) || (y >= 300 && y < 690 && x > 70 && x < 120) || (y >= 300 && y < 680 && x > 180 && x < 230) ||
      (y > 50 && y < 250 && x > 20 && x < 45);  // 몸 옆 팔 (틈 25mm) — 위쪽이라 메우지 않는다
    if (on) a[y * w + x] = 255;
  }
  const r = st.outline(a, w, h, { cellMm: 1, outlineMm: 5, roundMm: 5 });
  assert.ok(inside(r.points, 150, 600), '다리 사이 아래쪽');
  assert.ok(inside(r.points, 150, 320), '가랑이 바로 아래');
  assert.ok(!inside(r.points, 57, 150), '팔과 몸 사이는 그대로');
  const off = st.outline(a, w, h, { cellMm: 1, outlineMm: 5, roundMm: 5, fillLegs: false });
  assert.ok(!inside(off.points, 150, 450), '끄면 다리 사이가 빈다');
});
