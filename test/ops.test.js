// 운영 준비: 수집 끄기, 운영 서버 가짜 주문 차단, 백업
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { createOrderSource } = require('../src/channels');
const { backup } = require('../scripts/backup');
const { addUser } = require('./helpers');

test('ORDER_SOURCE=off 이면 수집하지 않는다', () => {
  assert.strictEqual(createOrderSource('off'), null);
});

test('운영 서버에서는 가짜 주문을 쓸 수 없다', () => {
  assert.throws(() => createOrderSource('mock', { production: true }), /가짜 주문/);
  assert.ok(createOrderSource('mock', { production: false }));
});

test('알 수 없는 ORDER_SOURCE 값은 거부한다', () => {
  assert.throws(() => createOrderSource('navr'), /올바르지 않습니다/);
});

test('백업 파일은 압축되어 있고, 풀면 원본과 같은 내용으로 열리며, 14일 지난 백업은 지워진다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intranet-backup-'));
  const dbPath = path.join(dir, 'data', 'intranet.db');
  const backups = path.join(dir, 'backups');
  const db = openDb(dbPath);
  addUser(db, { email: 'keep@broad.test', name: '보존' });

  // 20일 전 백업 하나를 미리 만들어 둔다
  fs.mkdirSync(backups, { recursive: true });
  const old = path.join(backups, 'intranet-2026-09-01-0300.db');
  fs.writeFileSync(old, 'old');
  const now = new Date('2026-10-14T18:00:00Z');
  const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 3600 * 1000);
  fs.utimesSync(old, twentyDaysAgo, twentyDaysAgo);

  const { target, removed } = await backup({ dbPath, dir: backups, now });
  db.close();

  assert.strictEqual(path.basename(target), 'intranet-2026-10-15-0300.db.gz', '파일 이름은 한국 시간');
  assert.deepStrictEqual(fs.readdirSync(backups), ['intranet-2026-10-15-0300.db.gz'], '압축 전 사본은 남지 않음');
  const unzipped = path.join(dir, 'restored.db');
  fs.writeFileSync(unzipped, require('zlib').gunzipSync(fs.readFileSync(target)));
  assert.ok(fs.statSync(target).size < fs.statSync(unzipped).size / 2, '압축되어 작다');
  const copy = new DatabaseSync(unzipped, { readOnly: true });
  assert.strictEqual(copy.prepare("SELECT name FROM users WHERE email = 'keep@broad.test'").get().name, '보존');
  copy.close();
  assert.deepStrictEqual(removed, ['intranet-2026-09-01-0300.db']);
  assert.ok(!fs.existsSync(old));
});

test('백업 때 시안 그림도 backups/proofs 에 똑같이 맞춘다 (하드링크, 원본에서 지운 것은 백업에서도 지움)', async () => {
  const { mirrorProofs } = require('../scripts/backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intranet-proofs-'));
  const src = path.join(dir, 'proofs');
  const dest = path.join(dir, 'backups', 'proofs');
  assert.strictEqual(mirrorProofs(src, dest), null, '시안 폴더가 없으면 아무것도 안 함');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'a.png'), 'A');
  fs.writeFileSync(path.join(src, 'b.jpg'), 'B');
  assert.deepStrictEqual(mirrorProofs(src, dest), { count: 2, added: 2, removed: 0 });
  assert.strictEqual(fs.statSync(path.join(src, 'a.png')).ino, fs.statSync(path.join(dest, 'a.png')).ino, '하드링크라 디스크를 더 안 씀');
  fs.unlinkSync(path.join(src, 'a.png'));
  fs.writeFileSync(path.join(src, 'c.webp'), 'C');
  assert.deepStrictEqual(mirrorProofs(src, dest), { count: 2, added: 1, removed: 1 });
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['b.jpg', 'c.webp']);
});

test('NAS 백업 상태: 설정 전 / 아직 안 가져감 / 가져감 / 3일 넘게 멈춤, 멈추면 관리자 알림은 하루 한 번', () => {
  const { nasInfo } = require('../src/storage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-'));
  const file = path.join(dir, 'home', 'last_pull');
  const now = new Date('2026-11-10T00:00:00Z');
  assert.deepStrictEqual(nasInfo({ file, now }), { configured: false, last: null, days: null, stale: false });
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '');
  assert.strictEqual(nasInfo({ file, now: new Date() }).stale, false, '방금 설정했으면 경고 안 함');
  fs.writeFileSync(file, '2026-11-09T19:30:00Z\n');
  assert.deepStrictEqual(nasInfo({ file, now }), { configured: true, last: '2026-11-09T19:30:00.000Z', days: 0, stale: false });
  fs.writeFileSync(file, '2026-11-05T19:30:00Z');
  const stale = nasInfo({ file, now });
  assert.deepStrictEqual([stale.days, stale.stale], [4, true]);

  const { createNotifier } = require('../src/notifier');
  const db = openDb(':memory:');
  addUser(db, { email: 'boss@broad.test', name: '사장', role: 'admin' });
  const notifier = createNotifier({ db });
  assert.strictEqual(notifier.checkNas(stale, '2026-11-10'), true);
  assert.strictEqual(notifier.checkNas(stale, '2026-11-10'), false, '같은 날은 한 번만');
  assert.strictEqual(notifier.checkNas({ ...stale, stale: false }, '2026-11-11'), false);
  assert.strictEqual(notifier.checkNas({ configured: false }, '2026-11-11'), false);
});
