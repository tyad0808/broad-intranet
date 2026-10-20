// 파일 받기 엔진: NAS 폴더를 주기적으로 살펴 새 파일·바뀐 파일을 출력 컴퓨터 폴더로 복사한다.
// 전기(Electron) 없이 Node 만으로 돈다 (테스트: test/file-sync.test.js).
//
// - 다 올라간 파일만 복사: 크기·수정 시각이 연달아 stableTicks 번 같아야 복사한다 (올리는 중인 큰 파일 대비)
// - 반쯤 복사된 파일이 보이지 않게: '이름.part' 로 복사한 뒤 이름을 바꾼다
// - NAS 원본은 건드리지 않는다 (읽기만)
// - 받은 기록은 state 파일(JSON)에 남아 껐다 켜도 이어진다
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { readInfo } = require('./fileinfo');

// 출력 완료한 NAS 원본을 옮겨 두는 폴더 (NAS 폴더 바로 아래). 받기에서는 건너뛴다
const DONE_DIR = '_출력완료';

// 급한 파일: 이름이나 폴더에 [급] (급) 긴급, 또는 앞·뒤가 띄어진 '급' (급_현수막, 현수막_급.pdf)
// '고급명함' 처럼 낱말 속의 '급' 은 아니다
function isUrgent(rel) {
  return rel.split('/').some(seg => {
    const base = seg.replace(/\.[^.]+$/, '');
    return /\[급\]|\(급\)|긴급|urgent/i.test(seg) || /(^|[\s_\-.])급($|[\s_\-.])/.test(base);
  });
}

// NAS·윈도우·맥이 만드는 시스템 파일, 올리는 중인 임시 파일은 건너뛴다
const IGNORE_EXACT = new Set(['thumbs.db', 'desktop.ini', '.ds_store', '@eadir', '#recycle', '#snapshot', '.recycle', '$recycle.bin', DONE_DIR]);
function isIgnored(name) {
  const n = name.toLowerCase();
  return IGNORE_EXACT.has(n) || n.startsWith('~$') || n.startsWith('._') || n.startsWith('.~') ||
    n.startsWith('.sync') || n.endsWith('.tmp') || n.endsWith('.part') || n.endsWith('.crdownload') ||
    n.endsWith('.partial') || n.endsWith('.download');
}

// 받지 않을 확장자 (설정): 'psd, .zip mp4' → Set{'psd','zip','mp4'}
function parseExts(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  return new Set(list.map(x => String(x).trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean));
}
const extOf = rel => { const m = /\.([^./]+)$/.exec(rel); return m ? m[1].toLowerCase() : ''; };

// NAS 에 못 닿은 까닭을 사람 말로 (윈도우 네트워크 오류는 Node 에서 UNKNOWN 으로 오는 경우가 많다)
function offlineReason(e) {
  const c = e && e.code;
  if (c === 'ENOENT') return '폴더를 찾을 수 없음';
  if (c === 'EACCES' || c === 'EPERM') return '권한 없음 (NAS 로그인 확인)';
  if (c === 'ENOTDIR') return '폴더가 아닙니다';
  return '네트워크 응답 없음' + (c ? ' (' + c + ')' : '');
}

// 폴더 안의 파일들 (하위 폴더 포함): Map<'하위/이름', { size, mtimeMs }>
// out.unsure: 이번에 못 읽은 하위 폴더('폴더/')·파일 — 없어진 게 아니라 잠깐 못 읽은 것이라 기록을 지우면 안 된다
async function scan(root, maxDepth = 12) {
  const out = new Map();
  out.unsure = [];
  async function walk(dir, rel, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (depth === 0) throw e; // 맨 위 폴더를 못 읽으면 연결 문제
      if (e.code !== 'ENOENT') out.unsure.push(rel + '/'); // 하위 폴더 하나를 못 읽으면 이번엔 건너뛴다
      return;
    }
    for (const e of entries) {
      if (isIgnored(e.name)) continue;
      const full = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(full, r, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(full);
          out.set(r, { size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
        } catch (err) {
          if (err.code !== 'ENOENT') out.unsure.push(r); // ENOENT 는 그사이 지워진 파일
        }
      }
    }
  }
  await walk(root, '', 0);
  return out;
}

const toPath = (root, rel) => path.join(root, ...rel.split('/'));
const isPending = h => !h.done && !h.replaced;

// 같은 이름 파일을 바꿀 수 없을 때(출력 프로그램이 열고 있는 등) 쓸 다른 이름: '이름 (2).확장자'
async function freeName(file) {
  const dir = path.dirname(file), ext = path.extname(file), base = path.basename(file, ext);
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(dir, `${base} (${i})${ext}`);
    try { await fsp.access(cand); } catch { return cand; }
  }
  throw new Error('같은 이름 파일이 너무 많습니다: ' + file);
}

// 1.6.0 까지: NAS 하위 폴더를 잠깐 못 읽으면 그 안의 파일을 다시 받아 같은 파일이 목록에 두 번 들어갔다.
// 같은 이름·크기·수정 시각인 기록은 먼저 받은 하나만 남기고, 출력 완료·확인 표시는 합친다. 고친 게 있으면 true
function dedupeHistory(history) {
  const first = new Map(), drop = new Set();
  for (let i = history.length - 1; i >= 0; i--) { // 뒤가 먼저 받은 것
    const h = history[i], key = h.rel + '\0' + h.size + '\0' + h.mtimeMs, keep = first.get(key);
    if (!keep) { first.set(key, h); continue; }
    if (h.done && !keep.done) { keep.done = true; keep.doneAt = h.doneAt; keep.nasDone = keep.nasDone || h.nasDone; }
    keep.seen = keep.seen || h.seen;
    keep.openedAt = keep.openedAt || h.openedAt;
    if (!fs.existsSync(keep.localPath) && h.localPath) keep.localPath = h.localPath;
    drop.add(h);
  }
  if (!drop.size) return false;
  const kept = history.filter(h => !drop.has(h));
  // '새 버전으로 바뀜' 다시 계산: 출력 전이고, 같은 이름의 더 나중 기록이 있을 때만
  const newest = new Map();
  for (const h of kept) {
    if (newest.has(h.rel)) h.replaced = !h.done;
    else { newest.set(h.rel, h); h.replaced = false; }
  }
  history.length = 0;
  history.push(...kept);
  return true;
}

class Syncer {
  /**
   * @param {object} o
   * @param {string} o.source      NAS 폴더 (예: \\\\NAS\\출력\\실사)
   * @param {string} o.dest        받을 폴더 (출력 컴퓨터)
   * @param {string} o.statePath   기록 파일 경로
   * @param {number} [o.stableTicks=2]   몇 번 연달아 같아야 다 올라간 것으로 볼지
   * @param {boolean} [o.skipExisting=true] 처음 켤 때 이미 NAS 에 있던 파일은 받지 않기
   * @param {string|string[]} [o.skipExt] 받지 않을 확장자 (예: 'psd, zip')
   * @param {number} [o.historyLimit=1000]
   * @param {() => number} [o.now]
   */
  constructor(o) {
    this.source = o.source;
    this.dest = o.dest;
    this.statePath = o.statePath;
    this.stableTicks = o.stableTicks || 2;
    this.skipExisting = o.skipExisting !== false;
    this.historyLimit = o.historyLimit || 1000;
    this.skipExt = parseExts(o.skipExt);
    this.scan = o.scan || scan; // 시험용으로 바꿔 끼울 수 있게
    this.onProgress = o.onProgress || null; // 받는 중 진행 상황
    this.progress = null;
    this.now = o.now || Date.now;
    this.waiting = new Map(); // 올라가는 중인지 지켜보는 파일
    this.state = null;
  }

  async load() {
    try {
      this.state = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
      // 다른 NAS 폴더를 보던 기록이면 처음부터 (받을 목록만 새로, 받은 기록은 둔다)
      if (this.state.source !== this.source) {
        this.state.source = this.source;
        this.state.known = null;
      }
    } catch {
      this.state = { version: 1, source: this.source, known: null, history: [], nextId: 1 };
    }
    if (dedupeHistory(this.state.history)) await this.save();
    return this;
  }

  // 이미 받은 것과 똑같은 파일(같은 이름·크기·수정 시각)이고 받은 파일도 그대로 있으면 다시 받지 않는다
  // (_출력완료 로 옮겼던 것을 다시 올린 건 다시 출력하려는 것이라 받는다)
  alreadyHave(rel, info) {
    return this.state.history.some(h => h.rel === rel && !h.nasDone && h.size === info.size && h.mtimeMs === info.mtimeMs &&
      fs.existsSync(h.localPath) && fs.statSync(h.localPath).size === info.size);
  }

  async save() {
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true });
    const tmp = this.statePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.state));
    await fsp.rename(tmp, this.statePath);
  }

  get history() { return this.state.history; }
  // 알림을 아직 안 본 것 (새로 온 것)
  get unseen() { return this.state.history.filter(h => !h.seen).length; }
  // 출력 전: 출력 완료 체크를 안 했고, 새 버전으로 바뀌지도 않은 것
  get pending() { return this.state.history.filter(isPending).length; }
  // 출력 전인 채로 ms 넘게 지난 것 (다시 알림용)
  stale(ms) {
    const limit = this.now() - ms;
    return this.state.history.filter(h => isPending(h) && h.receivedAt <= limit);
  }

  // 한 번 살펴보기. 결과: { status: 'ok' | 'offline', received: [기록], errors: [{ rel, message }], baseline? }
  async tick() {
    if (!this.state) await this.load();
    let files;
    try {
      const st = await fsp.stat(this.source);
      if (!st.isDirectory()) throw Object.assign(new Error('폴더가 아닙니다'), { code: 'ENOTDIR' });
      files = await this.scan(this.source);
    } catch (e) {
      return { status: 'offline', received: [], errors: [], message: offlineReason(e) };
    }

    // 처음: 이미 있던 파일은 '받은 것'으로 치고 넘어간다 (옛 파일이 한꺼번에 쏟아지지 않게)
    if (!this.state.known) {
      this.state.known = {};
      if (this.skipExisting) {
        for (const [rel, info] of files) this.state.known[rel] = info;
        await this.save();
        return { status: 'ok', received: [], errors: [], baseline: files.size };
      }
    }

    const known = this.state.known, received = [], errors = [];
    let skipped = false;
    // 1) 이번에 받을 것 고르기 (다 올라간 것만)
    const ready = [];
    for (const [rel, info] of files) {
      const k = known[rel];
      if (k && k.size === info.size && k.mtimeMs === info.mtimeMs) continue;
      // 똑같은 파일을 이미 받아 두었거나(기록이 어긋나도 같은 파일이 또 쏟아지지 않게),
      // 받지 않을 확장자면(나중에 설정에서 빼도 옛 파일이 한꺼번에 쏟아지지 않게) 받은 것으로만 쳐 둔다
      if ((!k && this.alreadyHave(rel, info)) || this.skipExt.has(extOf(rel))) {
        known[rel] = info;
        this.waiting.delete(rel);
        skipped = true;
        continue;
      }
      const p = this.waiting.get(rel);
      if (!p || p.size !== info.size || p.mtimeMs !== info.mtimeMs) {
        this.waiting.set(rel, { size: info.size, mtimeMs: info.mtimeMs, ticks: 1 });
        if (this.stableTicks > 1) continue;
      } else if (++p.ticks < this.stableTicks) {
        continue;
      }
      ready.push({ rel, info, k });
    }

    // 2) 받기. 진행 상황(몇 번째, 몇 MB)을 onProgress 로 알린다
    const batch = { count: ready.length, index: 0, rel: '', fileDone: 0, fileTotal: 0, batchDone: 0,
      batchTotal: ready.reduce((n, r) => n + r.info.size, 0), startedAt: this.now() };
    let before = 0;
    for (const { rel, info, k } of ready) {
      Object.assign(batch, { index: batch.index + 1, rel, fileDone: 0, fileTotal: info.size });
      this.report(batch);
      try {
        const localPath = await this.copy(rel, info, done => {
          batch.fileDone = done;
          batch.batchDone = before + done;
          this.report(batch);
        });
        known[rel] = info;
        const entry = {
          id: this.state.nextId++, rel, name: path.posix.basename(rel), folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
          size: info.size, mtimeMs: info.mtimeMs, receivedAt: this.now(), kind: k ? 'updated' : 'new', seen: false, localPath,
          done: false, doneAt: null, openedAt: null,
          urgent: isUrgent(rel),
          info: await readInfo(localPath), // 3000×900mm / 4724×1417px · 150dpi 같은 크기 정보
        };
        // 같은 파일의 옛 버전이 출력 전이면 '새 버전으로 바뀜' (옛 버전을 잘못 출력하지 않게)
        for (const old of this.state.history) if (old.rel === rel && isPending(old)) old.replaced = true;
        this.state.history.unshift(entry);
        received.push(entry);
      } catch (e) {
        errors.push({ rel, message: e.code || e.message });
      }
      before += info.size;
      batch.batchDone = before;
      this.waiting.delete(rel);
    }
    this.progress = null;
    if (ready.length) this.report(null);
    // 그사이 NAS 에서 사라진 것은 기다리지 않는다 (받은 파일은 지우지 않음)
    for (const rel of this.waiting.keys()) if (!files.has(rel)) this.waiting.delete(rel);
    // 잠깐 못 읽은 폴더·파일은 지우지 않는다 (지우면 다음에 읽힐 때 전부 새 파일로 다시 받게 됨)
    const unsure = files.unsure || [];
    const isUnsure = rel => unsure.some(u => (u.endsWith('/') ? rel.startsWith(u) : rel === u));
    for (const rel of Object.keys(known)) if (!files.has(rel) && !isUnsure(rel)) delete known[rel];

    if (this.state.history.length > this.historyLimit) this.state.history.length = this.historyLimit;
    if (received.length || skipped) await this.save();
    return { status: 'ok', received, errors };
  }

  // 진행 상황 알리기 (null 이면 끝). 받는 중이 아닐 때 기다리는 파일 수는 waitingCount
  report(batch) {
    this.progress = batch ? { ...batch } : null;
    if (this.onProgress) this.onProgress(this.progress);
  }
  // NAS 에 올라가는 중이라 기다리는 파일 수
  get waitingCount() { return this.waiting.size; }

  async copy(rel, info, onBytes) {
    const src = toPath(this.source, rel);
    let dst = toPath(this.dest, rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    const part = dst + '.part';
    // 받은 양을 셀 수 있게 조금씩 읽어 쓴다 (1MB 씩)
    const rs = fs.createReadStream(src, { highWaterMark: 1 << 20 });
    let done = 0;
    rs.on('data', c => { done += c.length; if (onBytes) onBytes(done); });
    try {
      await pipeline(rs, fs.createWriteStream(part));
    } catch (e) {
      await fsp.rm(part, { force: true });
      throw e;
    }
    const st = await fsp.stat(part);
    if (st.size !== info.size) {
      await fsp.rm(part, { force: true });
      throw new Error('복사한 크기가 다릅니다 (올리는 중일 수 있음)');
    }
    try {
      await fsp.rename(part, dst);
    } catch (e) {
      // 같은 이름 파일을 바꿀 수 없으면 (출력 프로그램이 열고 있는 등) 다른 이름으로
      dst = await freeName(dst);
      await fsp.rename(part, dst);
    }
    const t = new Date(info.mtimeMs);
    await fsp.utimes(dst, t, t).catch(() => {});
    return dst;
  }

  // 지금 NAS 에 있는 파일을 모두 다시 받기 (처음에 건너뛴 것까지)
  async importAll() {
    if (!this.state) await this.load();
    this.state.known = {};
    this.waiting.clear();
    await this.save();
  }

  async markSeen(id) {
    let changed = false;
    for (const h of this.state.history) {
      if ((id === 'all' || h.id === id) && !h.seen) { h.seen = true; changed = true; }
    }
    if (changed) await this.save();
    return changed;
  }

  // 출력 완료 체크 (done=false 면 풀기). 체크하면 알림도 본 것으로.
  // moveOnNas 면 NAS 원본을 '_출력완료' 폴더로 옮긴다 (풀면 제자리로). 결과: { ok, warning? }
  async markDone(id, done = true, { moveOnNas = false } = {}) {
    const h = this.state.history.find(x => x.id === id);
    if (!h) return { ok: false };
    h.done = !!done;
    h.doneAt = done ? this.now() : null;
    if (done) h.seen = true;
    let warning;
    try {
      if (done && moveOnNas && !h.nasDone) await this.moveToDone(h);
      if (!done && h.nasDone) await this.moveBack(h);
    } catch (e) {
      warning = 'NAS 원본을 옮기지 못했습니다: ' + (e.code || e.message);
    }
    await this.save();
    return { ok: true, warning };
  }

  async moveToDone(h) {
    const src = toPath(this.source, h.rel);
    const st = await fsp.stat(src).catch(() => null);
    if (!st) throw new Error('NAS 에 원본이 없습니다');
    // 받은 뒤에 NAS 파일이 바뀌었으면 (새 버전) 옮기지 않는다
    if (st.size !== h.size || Math.floor(st.mtimeMs) !== h.mtimeMs) throw new Error('NAS 파일이 받은 뒤에 바뀌었습니다');
    let dst = toPath(this.source, DONE_DIR + '/' + h.rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    if (await fsp.access(dst).then(() => true, () => false)) dst = await freeName(dst);
    await fsp.rename(src, dst);
    h.nasDone = path.relative(this.source, dst).split(path.sep).join('/');
    // 이 파일은 이제 받을 목록에서 빠진다 (다시 올리면 새로 받는다)
    delete this.state.known[h.rel];
  }

  async moveBack(h) {
    const from = toPath(this.source, h.nasDone), to = toPath(this.source, h.rel);
    if (await fsp.access(to).then(() => true, () => false)) throw new Error('제자리에 같은 이름 파일이 다시 올라와 있습니다');
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    const st = await fsp.stat(to);
    // 제자리로 돌린 것을 새 파일로 또 받지 않게
    this.state.known[h.rel] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    h.nasDone = null;
  }

  // 이 앱의 [열기] 로 연 시각
  async markOpened(id) {
    const h = this.state.history.find(x => x.id === id);
    if (!h) return false;
    h.openedAt = this.now();
    h.seen = true;
    await this.save();
    return true;
  }

  async clearHistory() {
    this.state.history = [];
    await this.save();
  }
}

module.exports = { Syncer, scan, isIgnored, isUrgent, parseExts, offlineReason, dedupeHistory, DONE_DIR };
