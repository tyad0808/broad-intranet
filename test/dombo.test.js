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

// 100mm x 50mm 작업물 (왼쪽 아래가 원점)
const art = [0, 50 * MM, 100 * MM, 0];

test('기본 설정은 4점 L자, 마크 바깥 모서리가 작업물에서 5mm 떨어진다', () => {
  const r = core.domboComputeMarks(art, {});
  assert.deepStrictEqual(Array.from(r.marks, m => m.corner), ['leftTop', 'rightTop', 'rightBottom', 'leftBottom']);
  nearPts([[r.extent[0], r.extent[1]], [r.extent[2], r.extent[3]]], [[-5 * MM, 55 * MM], [105 * MM, -5 * MM]]);
  r.marks.forEach(m => assert.strictEqual(m.points.length, 6));

  // 왼쪽 위 L자: 꼭짓점에서 오른쪽·아래로 10mm, 두께 0.5mm
  nearPts(r.marks[0].points, [
    [-5, 55], [5, 55], [5, 54.5], [-4.5, 54.5], [-4.5, 45], [-5, 45],
  ].map(([x, y]) => [x * MM, y * MM]));

  // 오른쪽 아래 L자: 꼭짓점에서 왼쪽·위로
  nearPts(r.marks[2].points, [
    [105, -5], [95, -5], [95, -4.5], [104.5, -4.5], [104.5, 5], [105, 5],
  ].map(([x, y]) => [x * MM, y * MM]));
});

test('3점이면 오른쪽 위를 뺀다', () => {
  const r = core.domboComputeMarks(art, { count: 3 });
  assert.deepStrictEqual(Array.from(r.marks, m => m.corner), ['leftTop', 'rightBottom', 'leftBottom']);
});

test('사각형 마크는 바깥 모서리에서 안쪽으로 꽉 찬 정사각형이다', () => {
  const r = core.domboComputeMarks(art, { shape: 'square', sizeMm: 5, offsetMm: 0 });
  nearPts(r.marks[3].points, [[0, 0], [5, 0], [5, 5], [0, 5]].map(([x, y]) => [x * MM, y * MM]));
});

test('패널에서 온 글자 숫자도 받아들이고, 대지는 마크 바깥 여백만큼 넓힌다', () => {
  const r = core.domboComputeMarks(art, { count: '3', sizeMm: '8', offsetMm: '2', marginMm: '3' });
  assert.strictEqual(r.marks.length, 3);
  nearPts([[r.paper[0], r.paper[1]], [r.paper[2], r.paper[3]]], [[-5 * MM, 55 * MM], [105 * MM, -5 * MM]]);
});

test('잘못된 설정과 너무 작은 작업물은 거절한다', () => {
  assert.throws(() => core.domboComputeMarks(art, { sizeMm: 0 }), /마크 크기/);
  assert.throws(() => core.domboComputeMarks(art, { thickMm: 10 }), /선 두께/);
  assert.throws(() => core.domboComputeMarks(art, { count: 5 }), /개수/);
  assert.throws(() => core.domboComputeMarks(art, { shape: 'circle' }), /모양/);
  assert.throws(() => core.domboComputeMarks(art, { sizeMm: NaN }), /마크 크기/);
  assert.throws(() => core.domboComputeMarks([0, 5 * MM, 5 * MM, 0], { offsetMm: 0 }), /너무 작습니다/);
});
