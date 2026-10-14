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

test('각 변을 간격 이하로 똑같이 나누고, 왼쪽 위부터 시계 방향으로 놓는다', () => {
  // 중심 사각형 116mm x 66mm, 간격 50mm → 가로 3칸(38.67mm), 세로 2칸(33mm)
  const r = core.domboComputeMarks(art, { spacingMm: 50 });
  const w = 116 / 3;
  nearPts(r.centers, mmPts([
    [-8, 58], [-8 + w, 58], [-8 + 2 * w, 58], [108, 58],
    [108, 25],
    [108, -8], [-8 + 2 * w, -8], [-8 + w, -8], [-8, -8],
    [-8, 25],
  ]));
  near(r.spacingX, w * MM);
  near(r.spacingY, 33 * MM);
});

test('길이가 간격으로 딱 나눠지면 칸을 더 만들지 않는다', () => {
  // 중심 사각형 116mm x 66mm → 간격 58mm 이면 가로 2칸
  const r = core.domboComputeMarks(art, { spacingMm: 58 });
  near(r.spacingX, 58 * MM);
  assert.strictEqual(r.centers.length, 2 * 3 + 2 * 1);
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
