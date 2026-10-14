// 모양대로 네스팅 (래스터 방식). 아크릴 텍스트 패널에서 돌린다 (일러스트레이터 스크립트보다 훨씬 빠름).
// 글자 모양을 작은 칸(정밀도 mm)으로 바꿔, 다른 글자의 빈 곳·구멍 안까지 끼워 넣는다.
// 좌표: 입력 윤곽선은 일러스트레이터 문서 좌표 (pt, 위로 갈수록 y 증가).
//       결과 x, y 는 원판 왼쪽 위에서 오른쪽·아래로 잰 거리 (pt) = 돌린 글자의 범위 왼쪽 위 자리.
(function (root) {
  'use strict';

  // 반시계 방향으로 돌리기 (일러스트레이터 rotate 와 같은 방향)
  function rotatePoint(p, angle) {
    switch (angle) {
      case 90: return [-p[1], p[0]];
      case 180: return [-p[0], -p[1]];
      case 270: return [p[1], -p[0]];
      default: return [p[0], p[1]];
    }
  }

  function boundsOf(polys) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of polys) for (const p of poly) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    return { minX, minY, maxX, maxY };
  }

  // 윤곽선(짝홀 규칙: 구멍은 비움)을 칸으로. 모자라지 않게 테두리가 지나는 칸도 모두 채운다.
  function rasterize(polys, res) {
    const b = boundsOf(polys);
    const w = Math.max(1, Math.ceil((b.maxX - b.minX) / res - 1e-9));
    const h = Math.max(1, Math.ceil((b.maxY - b.minY) / res - 1e-9));
    const grid = new Uint8Array(w * h);
    const col = x => Math.min(w - 1, Math.max(0, Math.floor((x - b.minX) / res)));
    const row = y => Math.min(h - 1, Math.max(0, Math.floor((b.maxY - y) / res)));
    // 칸 가운데를 지나는 가로줄로 안쪽 채우기
    for (let r = 0; r < h; r++) {
      const yc = b.maxY - (r + 0.5) * res, xs = [];
      for (const poly of polys) {
        for (let i = 0, n = poly.length; i < n; i++) {
          const p = poly[i], q = poly[(i + 1) % n];
          if ((p[1] > yc) !== (q[1] > yc)) xs.push(p[0] + (yc - p[1]) * (q[0] - p[0]) / (q[1] - p[1]));
        }
      }
      xs.sort((a, c) => a - c);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const c0 = Math.max(0, Math.ceil((xs[i] - b.minX) / res - 0.5));
        const c1 = Math.min(w - 1, Math.floor((xs[i + 1] - b.minX) / res - 0.5));
        for (let c = c0; c <= c1; c++) grid[r * w + c] = 1;
      }
    }
    // 테두리가 지나는 칸
    const step = res / 4;
    for (const poly of polys) {
      for (let i = 0, n = poly.length; i < n; i++) {
        const p = poly[i], q = poly[(i + 1) % n];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]), k = Math.max(1, Math.ceil(len / step));
        for (let s = 0; s <= k; s++) {
          const t = s / k;
          grid[row(p[1] + (q[1] - p[1]) * t) * w + col(p[0] + (q[0] - p[0]) * t)] = 1;
        }
      }
    }
    return { w, h, grid, minX: b.minX, maxY: b.maxY };
  }

  // 반지름 g 칸만큼 둘레를 불린다 (간격용). 결과는 사방으로 g 칸 커진다.
  function dilate(ras, g) {
    if (g <= 0) return { w: ras.w, h: ras.h, grid: ras.grid };
    const W = ras.w + 2 * g, H = ras.h + 2 * g, out = new Uint8Array(W * H), src = ras.grid;
    const disk = [];
    for (let dy = -g; dy <= g; dy++) for (let dx = -g; dx <= g; dx++) if (dx * dx + dy * dy <= g * g + g) disk.push([dx, dy]);
    for (let r = 0; r < ras.h; r++) {
      for (let c = 0; c < ras.w; c++) {
        if (!src[r * ras.w + c]) continue;
        const edge = c === 0 || r === 0 || c === ras.w - 1 || r === ras.h - 1 ||
          !src[r * ras.w + c - 1] || !src[r * ras.w + c + 1] || !src[(r - 1) * ras.w + c] || !src[(r + 1) * ras.w + c];
        if (!edge) { out[(r + g) * W + c + g] = 1; continue; }
        for (const d of disk) out[(r + g + d[1]) * W + c + g + d[0]] = 1;
      }
    }
    return { w: W, h: H, grid: out };
  }

  // 줄마다 채워진 구간 [시작, 끝, 시작, 끝 ...]
  function intervals(r) {
    const rows = [];
    for (let y = 0; y < r.h; y++) {
      const list = [];
      let start = -1;
      for (let x = 0; x <= r.w; x++) {
        const on = x < r.w && r.grid[y * r.w + x];
        if (on && start < 0) start = x;
        if (!on && start >= 0) { list.push(start, x - 1); start = -1; }
      }
      rows.push(list);
    }
    return rows;
  }

  function filledCount(grid) { let n = 0; for (let i = 0; i < grid.length; i++) n += grid[i]; return n; }

  // 원판 한 장: 칸마다 차 있는지 + 오른쪽으로 이어진 빈 칸 수(빠른 겹침 검사용)
  function newSheet(W, H, m) {
    const s = { W, H, m, occ: new Uint8Array(W * H), run: new Int32Array(W * H), topFree: 0,
      freeCells: (W - 2 * m) * (H - 2 * m), misses: 0, hint: 0 };
    for (let y = 0; y < H; y++) updateRun(s, y);
    return s;
  }
  function updateRun(s, y) {
    const o = y * s.W;
    let n = 0;
    for (let x = s.W - 1; x >= 0; x--) { n = s.occ[o + x] ? 0 : n + 1; s.run[o + x] = n; }
  }

  // (X, Y) 에 놓을 수 있으면 -1, 아니면 다음에 시도할 X
  function test(s, shape, X, Y) {
    const g = shape.g, rows = shape.dil, n = rows.length;
    // 지난번에 막힌 줄부터 본다 (옆 자리도 대개 같은 줄에서 막힘)
    const h0 = shape.hint < n ? shape.hint : 0;
    for (let k = 0; k < n; k++) {
      const r = k === 0 ? h0 : (k <= h0 ? k - 1 : k);
      const yy = Y - g + r;
      if (yy < 0 || yy >= s.H) continue;
      const list = rows[r], o = yy * s.W;
      for (let i = 0; i < list.length; i += 2) {
        let a = X - g + list[i], b = X - g + list[i + 1];
        if (a < 0) a = 0;
        if (b >= s.W) b = s.W - 1;
        if (a > b) continue;
        const free = s.run[o + a];
        if (free < b - a + 1) {
          const blocked = a + free; // 처음 막힌 칸
          shape.hint = r;
          return Math.max(X + 1, blocked + g - list[i] + 1);
        }
      }
    }
    return -1;
  }

  function place(s, shape, X, Y) {
    for (let r = 0; r < shape.raw.length; r++) {
      const list = shape.raw[r], o = (Y + r) * s.W;
      for (let i = 0; i < list.length; i += 2) for (let x = X + list[i]; x <= X + list[i + 1]; x++) s.occ[o + x] = 1;
      for (let i = 0; i < list.length; i += 2) s.freeCells -= list[i + 1] - list[i] + 1;
      updateRun(s, Y + r);
    }
    // 여백 안쪽이 꽉 찬 줄은 다음부터 건너뛴다
    while (s.topFree < s.H && rowFull(s, s.topFree)) s.topFree++;
  }
  function rowFull(s, y) {
    if (y < s.m) return true;
    for (let x = s.m; x < s.W - s.m; x++) if (!s.occ[y * s.W + x]) return false;
    return true;
  }

  // 가장 위(그다음 왼쪽) 자리. 없으면 null
  function findSpot(s, shape, m) {
    const maxX = s.W - m - shape.w, maxY = s.H - m - shape.h;
    for (let Y = Math.max(m, s.topFree); Y <= maxY; Y++) {
      let X = m;
      while (X <= maxX) {
        const next = test(s, shape, X, Y);
        if (next < 0) return { X, Y };
        X = next;
      }
    }
    return null;
  }

  // pieces: [{ id, polys: [[[x, y], ...], ...] }] (pt)
  // o: { sheetW, sheetH, margin, gap, res, allowRotate } (pt)
  // 결과: { placements: [{ id, bin, x, y, angle }], bins, usedHeights: [pt], area: 실제 모양 넓이 합(pt²) }
  const CLOSE_AFTER = 30;

  function nest(pieces, o) {
    const job = start(pieces, o);
    while (!job.step()) { /* 계속 */ }
    return job.result();
  }

  // 화면이 멈추지 않게 조금씩 나눠 돌린다. onProgress(끝낸 개수, 전체)
  function nestAsync(pieces, o, onProgress) {
    return new Promise((resolve, reject) => {
      let job;
      try { job = start(pieces, o); } catch (e) { reject(e); return; }
      (function tick() {
        try {
          const until = Date.now() + 60;
          let done = false;
          while (!done && Date.now() < until) done = job.step();
          if (onProgress) onProgress(job.done(), job.total);
          if (done) resolve(job.result()); else setTimeout(tick, 0);
        } catch (e) { reject(e); }
      })();
    });
  }

  // 준비(칸 바꾸기) 후 한 조각씩 놓는 작업
  function start(pieces, o) {
    const res = o.res;
    const W = Math.floor(o.sheetW / res), H = Math.floor(o.sheetH / res);
    const m = Math.ceil(o.margin / res - 1e-9), g = Math.ceil(o.gap / res - 1e-9);
    if (W - 2 * m <= 0 || H - 2 * m <= 0) throw new Error('여백이 원판보다 큽니다.');
    if (W * H > 40e6) throw new Error('원판이 정밀도에 비해 너무 큽니다. 정밀도 값을 키우세요.');
    const angles = o.allowRotate ? [0, 90, 180, 270] : [0];

    const items = pieces.map((p, idx) => {
      const shapes = angles.map(angle => {
        const polys = p.polys.map(poly => poly.map(pt => rotatePoint(pt, angle)));
        const ras = rasterize(polys, res);
        return { angle, w: ras.w, h: ras.h, raw: intervals(ras), dil: intervals(dilate(ras, g)), g, cells: filledCount(ras.grid), hint: 0 };
      });
      return { id: p.id, idx, shapes, cells: shapes[0].cells, area: polyArea(p.polys) };
    });
    const tooBig = items.filter(it => !it.shapes.some(sh => sh.w <= W - 2 * m && sh.h <= H - 2 * m)).map(it => it.id);
    if (tooBig.length) {
      const e = new Error('원판보다 큰 조각이 ' + tooBig.length + '개 있습니다.');
      e.tooBig = tooBig;
      throw e;
    }
    // 큰 것부터 (같으면 처음 순서)
    const order = items.slice().sort((a, b) => b.cells - a.cells || a.idx - b.idx);

    const sheets = [], placements = [];
    let next = 0;
    function stepOne(it) {
      let best = null;
      for (let k = 0; k < sheets.length && !best; k++) {
        const sh = sheets[k];
        // 남은 칸이 모자라거나, 연달아 여러 번 못 넣은 원판은 건너뛴다
        if (sh.misses >= CLOSE_AFTER || sh.freeCells < it.cells) continue;
        best = bestIn(sh, it, k);
        if (best) sh.misses = 0; else sh.misses++;
      }
      if (!best) {
        sheets.push(newSheet(W, H, m));
        best = bestIn(sheets[sheets.length - 1], it, sheets.length - 1);
      }
      place(sheets[best.bin], best.shape, best.X, best.Y);
      placements.push({ id: it.id, bin: best.bin, x: best.X * res, y: best.Y * res, angle: best.shape.angle, h: best.shape.h * res });
    }

    function bestIn(sheet, it, bin) {
      let best = null;
      for (const sh of it.shapes) {
        const spot = findSpot(sheet, sh, m);
        if (!spot) continue;
        const score = [spot.Y + sh.h, spot.X];
        if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
          best = { bin, shape: sh, X: spot.X, Y: spot.Y, score };
        }
      }
      return best;
    }

    function result() {
      const usedHeights = sheets.map(() => 0);
      placements.forEach(p => { usedHeights[p.bin] = Math.max(usedHeights[p.bin], p.y + p.h + m * res); });
      return {
        placements: placements.map(p => ({ id: p.id, bin: p.bin, x: p.x, y: p.y, angle: p.angle })),
        bins: sheets.length,
        usedHeights,
        area: items.reduce((s, it) => s + it.area, 0),
      };
    }

    return {
      total: order.length,
      done: () => next,
      step() { if (next < order.length) stepOne(order[next++]); return next >= order.length; },
      result,
    };
  }

  // 짝홀 규칙 넓이 (구멍은 뺀다) — 바깥/구멍 판정 없이 겹 수로 근사: 바깥 넓이 - 구멍 넓이
  function polyArea(polys) {
    const areas = polys.map(poly => {
      let s = 0;
      for (let i = 0, n = poly.length; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
      return Math.abs(s / 2);
    });
    let total = 0;
    polys.forEach((poly, i) => {
      let depth = 0;
      polys.forEach((other, j) => { if (j !== i && areas[j] > areas[i] && inside(poly[0], other)) depth++; });
      total += depth % 2 ? -areas[i] : areas[i];
    });
    return total;
  }
  function inside(pt, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }

  const api = { nest, nestAsync, rasterize, dilate, rotatePoint, polyArea };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NestShape = api;
})(this);
