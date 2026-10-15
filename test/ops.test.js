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

test('백업 파일은 원본과 같은 내용으로 열리고, 14일 지난 백업은 지워진다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intranet-backup-'));
  const dbPath = path.join(dir, 'data', 'intranet.db');
  const backups = path.join(dir, 'backups');
  const db = openDb(dbPath);
  addUser(db, { email: 'keep@broad.test', name: '보존' });

  // 20일 전 백업 하나를 미리 만들어 둔다
  fs.mkdirSync(backups, { recursive: true });
  const old = path.join(backups, 'intranet-2026-09-01-0300.db');
  fs.writeFileSync(old, 'old');
  const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  fs.utimesSync(old, twentyDaysAgo, twentyDaysAgo);

  const { target, removed } = backup({ dbPath, dir: backups, now: new Date('2026-10-14T18:00:00Z') });
  db.close();

  assert.strictEqual(path.basename(target), 'intranet-2026-10-15-0300.db', '파일 이름은 한국 시간');
  const copy = new DatabaseSync(target, { readOnly: true });
  assert.strictEqual(copy.prepare("SELECT name FROM users WHERE email = 'keep@broad.test'").get().name, '보존');
  copy.close();
  assert.deepStrictEqual(removed, ['intranet-2026-09-01-0300.db']);
  assert.ok(!fs.existsSync(old));
});
