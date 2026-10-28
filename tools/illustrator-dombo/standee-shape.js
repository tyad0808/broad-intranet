// 등신대 외곽선 계산 (래스터 방식). 브로애드 도구 패널에서 돌린다 (일러스트레이터 스크립트보다 훨씬 빠름).
// 입력: 누끼 PNG 의 알파(투명도)를 줄인 칸 그림 (w x h, 0~255).
// 순서: 사람 모양 → 외곽선만큼 넓히기 → 예각(좁은 틈·뾰족한 안쪽 모서리) 메우기 → 발 아래 일자로 자르기 → 구멍 메우기 → 윤곽선 → 부드럽게
// 결과 좌표는 칸 단위 (왼쪽 위가 0, 오른쪽·아래로 증가). 입력 그림의 (0,0) 이 결과의 (0,0).
(function (root) {
  'use strict';

  const INF = 1e20;

  // 1차원 거리 제곱 변환 (Felzenszwalb). f: 0 이면 대상, INF 면 대상 아님
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }

  // 칸마다 '켜진 칸(on[i]=1)' 까지 거리의 제곱
  function distSq(on, W, H) {
    const n = Math.max(W, H);
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    const out = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) out[i] = on[i] ? 0 : INF;
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) f[y] = out[y * W + x];
      edt1d(f, H, d, v, z);
      for (let y = 0; y < H; y++) out[y * W + x] = d[y];
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) f[x] = out[y * W + x];
      edt1d(f, W, d, v, z);
      for (let x = 0; x < W; x++) out[y * W + x] = d[x];
    }
    return out;
  }

  // 바깥에서 닿지 않는 빈 칸(구멍)을 채운다
  function fillHoles(g, W, H) {
    const seen = new Uint8Array(W * H), stack = [];
    for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
    for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
    while (stack.length) {
      const i = stack.pop();
      if (seen[i] || g[i]) continue;
      seen[i] = 1;
      const x = i % W, y = (i - x) / W;
      if (x > 0) stack.push(i - 1);
      if (x < W - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - W);
      if (y < H - 1) stack.push(i + W);
    }
    for (let i = 0; i < W * H; i++) if (!g[i] && !seen[i]) g[i] = 1;
  }

  // 가장 큰 덩어리(상하좌우로 이어진 칸)만 남긴다
  function keepLargest(g, W, H) {
    const label = new Int32Array(W * H);
    let best = 0, bestSize = 0, next = 0;
    for (let s = 0; s < W * H; s++) {
      if (!g[s] || label[s]) continue;
      next++;
      let size = 0;
      const stack = [s];
      label[s] = next;
      while (stack.length) {
        const i = stack.pop();
        size++;
        const x = i % W, y = (i - x) / W;
        const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
        for (const j of nb) if (j >= 0 && g[j] && !label[j]) { label[j] = next; stack.push(j); }
      }
      if (size > bestSize) { bestSize = size; best = next; }
    }
    for (let i = 0; i < W * H; i++) g[i] = label[i] === best ? 1 : 0;
    return bestSize;
  }

  // 켜진 칸 덩어리의 테두리를 칸 모서리 점으로 따라간다 (가장 긴 고리 = 바깥 테두리)
  // 칸마다 꺼진 이웃 쪽 변을, 칸이 진행 방향 오른쪽(y 아래로 증가 기준)에 오게 잇는다
  function traceOuter(g, W, H) {
    const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H && g[y * W + x]) ? 1 : 0;
    const key = (x, y) => y * (W + 1) + x;
    const edges = new Map();  // 시작 꼭짓점 → [끝 꼭짓점 x, y, 방향] 목록
    const add = (x0, y0, x1, y1, d) => {
      const k = key(x0, y0);
      if (!edges.has(k)) edges.set(k, []);
      edges.get(k).push([x0, y0, x1, y1, d]);
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!g[y * W + x]) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y, 0);          // 위 변: 오른쪽으로
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1, 1);  // 오른쪽 변: 아래로
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1, 2);  // 아래 변: 왼쪽으로
      if (!at(x - 1, y)) add(x, y + 1, x, y, 3);          // 왼쪽 변: 위로
    }
    let best = [];
    while (edges.size) {
      const firstKey = edges.keys().next().value;
      let e = edges.get(firstKey).pop();
      if (!edges.get(firstKey).length) edges.delete(firstKey);
      const loop = [];
      const sk = key(e[0], e[1]);
      for (;;) {
        loop.push([e[0], e[1]]);
        const k = key(e[2], e[3]);
        if (k === sk && !edges.has(k)) break;
        const list = edges.get(k);
        if (!list) break;
        // 갈림길(대각선으로 닿은 칸)이면 오른쪽으로 꺾는 변을 고른다
        let pick = 0;
        if (list.length > 1) {
          const want = (e[4] + 1) % 4;
          for (let q = 0; q < list.length; q++) if (list[q][4] === want) pick = q;
        }
        e = list.splice(pick, 1)[0];
        if (!list.length) edges.delete(k);
      }
      if (loop.length > best.length) best = loop;
    }
    return best;
  }

  // 같은 방향으로 이어진 점은 뺀다 (계단 모서리만 남김)
  function dropCollinear(pts) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
    }
    return out;
  }

  // 계단을 부드럽게: 이웃 점과 평균 (고정 점은 그대로)
  function smooth(pts, fixed, rounds) {
    let cur = pts.map(p => [p[0], p[1]]);
    const n = cur.length;
    for (let r = 0; r < rounds; r++) {
      const nx = cur.map(p => [p[0], p[1]]);
      for (let i = 0; i < n; i++) {
        if (fixed[i]) continue;
        const a = cur[(i + n - 1) % n], b = cur[i], c = cur[(i + 1) % n];
        nx[i] = [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4];
      }
      cur = nx;
    }
    return cur;
  }

  // 더글라스-포이커: 닫힌 점 목록을 tol 안에서 줄인다. keep 인 점은 꼭 남긴다
  function simplifyClosed(pts, tol, keep) {
    const n = pts.length;
    if (n < 4) return pts.map((p, i) => i);
    const mark = new Uint8Array(n);
    // 고정 점이 없으면 서로 먼 두 점에서 나눈다
    let anchors = [];
    for (let i = 0; i < n; i++) if (keep[i]) anchors.push(i);
    if (anchors.length < 2) {
      let far = 0, fd = -1;
      for (let i = 1; i < n; i++) {
        const dx = pts[i][0] - pts[0][0], dy = pts[i][1] - pts[0][1];
        if (dx * dx + dy * dy > fd) { fd = dx * dx + dy * dy; far = i; }
      }
      anchors = anchors.length === 1 ? [anchors[0], (anchors[0] + Math.floor(n / 2)) % n].sort((a, b) => a - b) : [0, far];
    }
    anchors.forEach(i => { mark[i] = 1; });
    const segDist = (p, a, b) => {
      const vx = b[0] - a[0], vy = b[1] - a[1], L = vx * vx + vy * vy;
      let t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      const dx = a[0] + t * vx - p[0], dy = a[1] + t * vy - p[1];
      return Math.sqrt(dx * dx + dy * dy);
    };
    const stack = [];
    for (let k = 0; k < anchors.length; k++) stack.push([anchors[k], anchors[(k + 1) % anchors.length]]);
    while (stack.length) {
      const [s, e] = stack.pop();
      const len = (e - s + n) % n || n;
      let best = -1, bd = tol;
      for (let j = 1; j < len; j++) {
        const i = (s + j) % n, dd = segDist(pts[i], pts[s], pts[e]);
        if (dd > bd) { bd = dd; best = i; }
      }
      if (best >= 0) { mark[best] = 1; stack.push([s, best], [best, e]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (mark[i]) out.push(i);
    return out;
  }

  // 점마다 곡선 손잡이 (Catmull-Rom). corner 인 점은 손잡이 없음
  function handles(pts, corner) {
    const n = pts.length, out = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (corner[i]) { out.push({ a: p, l: p, r: p, corner: true }); continue; }
      const a = pts[(i + n - 1) % n], c = pts[(i + 1) % n];
      let tx = (c[0] - a[0]) / 6, ty = (c[1] - a[1]) / 6;
      // 손잡이가 옆 점까지의 거리 절반을 넘지 않게
      const la = Math.hypot(p[0] - a[0], p[1] - a[1]), lc = Math.hypot(c[0] - p[0], c[1] - p[1]), lt = Math.hypot(tx, ty) || 1;
      const kl = Math.min(1, la / 2 / lt), kr = Math.min(1, lc / 2 / lt);
      out.push({ a: p, l: [p[0] - tx * kl, p[1] - ty * kl], r: [p[0] + tx * kr, p[1] + ty * kr], corner: false });
    }
    return out;
  }

  // alpha: 0~255 (w*h), opts: { cellMm: 칸 하나의 실제 크기(mm), outlineMm, roundMm, flatBottom }
  // 결과: { points: [{ a:[x,y], l, r, corner }], feetY, cells } (칸 단위, 입력 그림 기준)
  function outline(alpha, w, h, opts) {
    const c = opts.cellMm, o = opts.outlineMm / c, r = Math.max(0, opts.roundMm || 0) / c;
    const P = Math.ceil(o + r) + 3, W = w + 2 * P, H = h + 2 * P;
    const person = new Uint8Array(W * H);
    let feet = -1, count = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] >= 128) { person[(y + P) * W + x + P] = 1; feet = y; count++; }
    }
    if (!count) throw new Error('그림에 사람(불투명한 부분)이 없습니다. 배경이 투명한 PNG 인지 확인하세요.');
    // 넓히기 (외곽선 + 둥글게) → 줄이기 (둥글게): 좁은 틈·예각이 메워지고, 바깥 모서리는 외곽선만큼 둥글어진다
    const d1 = distSq(person, W, H), grown = new Uint8Array(W * H), R1 = (o + r) * (o + r);
    for (let i = 0; i < W * H; i++) grown[i] = d1[i] <= R1 ? 1 : 0;
    let shape = grown;
    if (r > 0) {
      const outside = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) outside[i] = grown[i] ? 0 : 1;
      const d2 = distSq(outside, W, H), R2 = r * r;
      shape = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) shape[i] = d2[i] > R2 ? 1 : 0;
      // 사람 모양은 꼭 남긴다 (줄이다가 깎이지 않게)
      for (let i = 0; i < W * H; i++) if (person[i]) shape[i] = 1;
    }
    // 발 아래를 일자로: 사람의 맨 아래 줄 바로 밑에서 자른다
    const cut = feet + 1 + P;
    if (opts.flatBottom !== false) for (let y = cut; y < H; y++) for (let x = 0; x < W; x++) shape[y * W + x] = 0;
    fillHoles(shape, W, H);
    keepLargest(shape, W, H);

    let pts = dropCollinear(traceOuter(shape, W, H));
    const onCut = p => opts.flatBottom !== false && p[1] === cut;
    // 일자 바닥의 양 끝은 각진 모서리로 고정
    let fixed = pts.map(onCut);
    pts = smooth(pts, fixed, 3);
    const keep = fixed.slice();
    const idx = simplifyClosed(pts, 0.35, keep);
    let out = idx.map(i => pts[i]);
    const corner = idx.map(i => fixed[i] && (!fixed[(i + 1) % pts.length] || !fixed[(i + pts.length - 1) % pts.length]));
    // 바닥 가운데 점(양 끝이 아닌)은 빼고 양 끝만 남긴다
    const keepIdx = [];
    for (let k = 0; k < out.length; k++) if (!(fixed[idx[k]] && !corner[k])) keepIdx.push(k);
    out = keepIdx.map(k => out[k]);
    const corner2 = keepIdx.map(k => corner[k]);
    const points = handles(out, corner2).map(p => ({
      a: [p.a[0] - P, p.a[1] - P], l: [p.l[0] - P, p.l[1] - P], r: [p.r[0] - P, p.r[1] - P], corner: p.corner,
    }));
    return { points, feetY: feet + 1, cells: count };
  }

  const api = { outline, distSq, fillHoles, keepLargest, traceOuter, simplifyClosed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.standeeShape = api;
})(typeof window !== 'undefined' ? window : this);
