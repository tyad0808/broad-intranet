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

// NAS·윈도우·맥이 만드는 시스템 파일, 올리는 중인 임시 파일은 건너뛴다
const IGNORE_EXACT = new Set(['thumbs.db', 'desktop.ini', '.ds_store', '@eadir', '#recycle', '#snapshot', '.recycle', '$recycle.bin']);
function isIgnored(name) {
  const n = name.toLowerCase();
  return IGNORE_EXACT.has(n) || n.startsWith('~$') || n.startsWith('._') || n.startsWith('.~') ||
    n.startsWith('.sync') || n.endsWith('.tmp') || n.endsWith('.part') || n.endsWith('.crdownload') ||
    n.endsWith('.partial') || n.endsWith('.download');
}

// 폴더 안의 파일들 (하위 폴더 포함): Map<'하위/이름', { size, mtimeMs }>
async function scan(root, maxDepth = 12) {
  const out = new Map();
  async function walk(dir, rel, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (depth === 0) throw e; // 맨 위 폴더를 못 읽으면 연결 문제
      return;                   // 하위 폴더 하나를 못 읽으면 건너뛴다
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
        } catch { /* 그사이 지워진 파일 */ }
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

class Syncer {
  /**
   * @param {object} o
   * @param {string} o.source      NAS 폴더 (예: \\\\NAS\\출력\\실사)
   * @param {string} o.dest        받을 폴더 (출력 컴퓨터)
   * @param {string} o.statePath   기록 파일 경로
   * @param {number} [o.stableTicks=2]   몇 번 연달아 같아야 다 올라간 것으로 볼지
   * @param {boolean} [o.skipExisting=true] 처음 켤 때 이미 NAS 에 있던 파일은 받지 않기
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
    return this;
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
      if (!st.isDirectory()) throw new Error('폴더가 아닙니다');
      files = await scan(this.source);
    } catch (e) {
      return { status: 'offline', received: [], errors: [], message: e.code || e.message };
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
    for (const [rel, info] of files) {
      const k = known[rel];
      if (k && k.size === info.size && k.mtimeMs === info.mtimeMs) continue;
      const p = this.waiting.get(rel);
      if (!p || p.size !== info.size || p.mtimeMs !== info.mtimeMs) {
        this.waiting.set(rel, { size: info.size, mtimeMs: info.mtimeMs, ticks: 1 });
        if (this.stableTicks > 1) continue;
      } else if (++p.ticks < this.stableTicks) {
        continue;
      }
      try {
        const localPath = await this.copy(rel, info);
        known[rel] = info;
        const entry = {
          id: this.state.nextId++, rel, name: path.posix.basename(rel), folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
          size: info.size, mtimeMs: info.mtimeMs, receivedAt: this.now(), kind: k ? 'updated' : 'new', seen: false, localPath,
          done: false, doneAt: null, openedAt: null,
        };
        // 같은 파일의 옛 버전이 출력 전이면 '새 버전으로 바뀜' (옛 버전을 잘못 출력하지 않게)
        for (const old of this.state.history) if (old.rel === rel && isPending(old)) old.replaced = true;
        this.state.history.unshift(entry);
        received.push(entry);
      } catch (e) {
        errors.push({ rel, message: e.code || e.message });
      }
      this.waiting.delete(rel);
    }
    // 그사이 NAS 에서 사라진 것은 기다리지 않는다 (받은 파일은 지우지 않음)
    for (const rel of this.waiting.keys()) if (!files.has(rel)) this.waiting.delete(rel);
    for (const rel of Object.keys(known)) if (!files.has(rel)) delete known[rel];

    if (this.state.history.length > this.historyLimit) this.state.history.length = this.historyLimit;
    if (received.length) await this.save();
    return { status: 'ok', received, errors };
  }

  async copy(rel, info) {
    const src = toPath(this.source, rel);
    let dst = toPath(this.dest, rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    const part = dst + '.part';
    await fsp.copyFile(src, part);
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

  // 출력 완료 체크 (done=false 면 풀기). 체크하면 알림도 본 것으로
  async markDone(id, done = true) {
    const h = this.state.history.find(x => x.id === id);
    if (!h) return false;
    h.done = !!done;
    h.doneAt = done ? this.now() : null;
    if (done) h.seen = true;
    await this.save();
    return true;
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

module.exports = { Syncer, scan, isIgnored };
