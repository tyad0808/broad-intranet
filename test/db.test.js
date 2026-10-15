// 실행: npm test
// 실제 DB 파일 대신 메모리 DB(':memory:')로 검사하므로 데이터가 남지 않는다.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');

test('기본 주문 단계 3개(자동)와 디자인 단계 3개가 따로 들어간다', () => {
  const db = openDb(':memory:');
  const names = t => db.prepare(`SELECT name FROM ${t} ORDER BY sort_order`).all().map(r => r.name);
  assert.deepStrictEqual(names('work_stages'), ['발주', '발주확인', '발송']);
  assert.deepStrictEqual(names('design_stages'), ['디자인 작업 전', '디자인 작업 중', '컨펌 후 파일전송']);
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
  db1.prepare("UPDATE design_stages SET name = '시안' WHERE name = '디자인 작업 전'").run();
  db1.close();

  const db2 = openDb(file);
  const names = db2.prepare('SELECT name FROM design_stages ORDER BY sort_order').all().map(r => r.name);
  assert.ok(names.includes('시안'));
  assert.ok(!names.includes('디자인 작업 전'));
  db2.close();
});

test('예전 DB: 주문 단계 사이에 있던 디자인 단계를 따로 옮기고, 그 단계의 주문은 디자인 단계를 기억한다', () => {
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'split-')), 'old.db');
  // 예전 모양: 주문 단계 6개 (디자인 단계가 섞여 있음), 관리자가 이름 하나를 바꿔 둠
  const db0 = openDb(file);
  db0.exec(`
    DELETE FROM design_stages;
    DELETE FROM settings WHERE key IN ('design_split_v1', 'stage_names_v2');
    DELETE FROM work_stages WHERE name = '발송';
    INSERT INTO work_stages (name, sort_order) VALUES ('디자인작업', 30), ('컨펌', 40), ('샘플 제작', 50), ('발송', 60);
  `);
  const sid = name => db0.prepare('SELECT id FROM work_stages WHERE name = ?').get(name).id;
  const add = (item, stage, confirmed) => db0.prepare(
    "INSERT INTO orders (channel, channel_order_id, channel_item_id, product_name, stage_id, channel_confirmed) VALUES ('smartstore', ?, ?, 'x', ?, ?)"
  ).run(`O${item}`, item, sid(stage), confirmed);
  add('P1', '컨펌', 1);
  add('P2', '디자인작업', 0);
  add('P3', '발송', 1);
  db0.close();

  const db = openDb(file);
  const names = t => db.prepare(`SELECT name FROM ${t} ORDER BY sort_order`).all().map(r => r.name);
  assert.deepStrictEqual(names('work_stages'), ['발주', '발주확인', '발송']);
  assert.deepStrictEqual(names('design_stages'), ['디자인작업 전', '작업 중', '샘플 제작'], '관리자가 바꾼 이름은 그대로');
  const row = item => db.prepare(`
    SELECT s.name AS stage, d.name AS design FROM orders o
    JOIN work_stages s ON s.id = o.stage_id LEFT JOIN design_stages d ON d.id = o.design_stage_id WHERE o.channel_item_id = ?
  `).get(item);
  assert.deepStrictEqual({ ...row('P1') }, { stage: '발주확인', design: '작업 중' });
  assert.deepStrictEqual({ ...row('P2') }, { stage: '발주', design: '디자인작업 전' });
  assert.deepStrictEqual({ ...row('P3') }, { stage: '발송', design: null });
  db.close();
});
