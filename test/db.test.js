// 실행: npm test
// 실제 DB 파일 대신 메모리 DB(':memory:')로 검사하므로 데이터가 남지 않는다.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');

test('기본 작업 단계 6개가 순서대로 들어간다', () => {
  const db = openDb(':memory:');
  const names = db.prepare('SELECT name FROM work_stages ORDER BY sort_order').all().map(r => r.name);
  assert.deepStrictEqual(names, ['발주', '발주확인', '디자인작업', '컨펌', '제작', '발송']);
});

test('기본 직무 중 디자이너만 담당 디자이너 대상이다', () => {
  const db = openDb(':memory:');
  const designers = db.prepare('SELECT name FROM jobs WHERE is_designer = 1').all().map(r => r.name);
  assert.deepStrictEqual(designers, ['디자이너']);
});

test('미지정 알림 기준 건수 기본값은 5다', () => {
  const db = openDb(':memory:');
  const row = db.prepare("SELECT value FROM settings WHERE key = 'unassigned_threshold'").get();
  assert.strictEqual(row.value, '5');
});

test('새 직원은 기본 상태가 승인 대기다', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (email, password_hash, name) VALUES ('a@b.com', 'x', '홍길동')").run();
  const user = db.prepare("SELECT role, status FROM users WHERE email = 'a@b.com'").get();
  assert.deepStrictEqual({ ...user }, { role: 'staff', status: 'pending' });
});

test('같은 상품주문번호는 두 번 저장되지 않는다', () => {
  const db = openDb(':memory:');
  const insert = db.prepare(
    "INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name) VALUES ('smartstore', 'O1', 'P1', '명함')"
  );
  insert.run();
  assert.throws(() => insert.run(), /UNIQUE/);
});

test('관리자가 단계를 바꾼 뒤 다시 열어도 기본값으로 덮어쓰지 않는다', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'intranet-')), 'test.db');

  const db1 = openDb(file);
  db1.prepare("UPDATE work_stages SET name = '시안' WHERE name = '디자인작업'").run();
  db1.close();

  const db2 = openDb(file);
  const names = db2.prepare('SELECT name FROM work_stages ORDER BY sort_order').all().map(r => r.name);
  assert.ok(names.includes('시안'));
  assert.ok(!names.includes('디자인작업'));
  db2.close();
});
