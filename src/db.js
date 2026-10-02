// DB 연결과 테이블 정의
// SQLite 는 DB 전체가 파일 하나(data/intranet.db)라서 백업은 이 파일을 복사하면 된다.
const fs = require('fs');
const path = require('path');
// Node.js 에 기본으로 들어 있는 SQLite (따로 설치·빌드할 필요가 없음)
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'intranet.db');

function openDb(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  // WAL: 읽기와 쓰기가 동시에 일어나도 서로 기다리지 않게 하는 SQLite 설정
  db.exec('PRAGMA journal_mode = WAL');
  // 다른 테이블을 가리키는 칸(FOREIGN KEY)이 엉뚱한 값을 갖지 못하게 검사
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  db.exec(`
    -- 직무: 디자이너, 출력·후가공, CS 등. 관리자가 추가·수정한다.
    CREATE TABLE IF NOT EXISTS jobs (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL UNIQUE,
      is_designer INTEGER NOT NULL DEFAULT 0,  -- 1이면 담당 디자이너 지정 목록에 나온다
      sort_order  INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1
    );

    -- 직원 계정
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY,
      email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash   TEXT    NOT NULL,          -- 비밀번호 원문은 저장하지 않는다
      name            TEXT    NOT NULL,
      role            TEXT    NOT NULL DEFAULT 'staff'
                      CHECK (role IN ('admin', 'staff')),
      status          TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'suspended', 'rejected')),
      job_id          INTEGER REFERENCES jobs(id),
      failed_logins   INTEGER NOT NULL DEFAULT 0,
      locked_until    TEXT,                      -- 로그인 잠금 해제 시각
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      approved_at     TEXT
    );

    -- 작업 상태 단계: 발주 → 발주확인 → … 관리자가 추가·이름변경·순서변경·숨김
    CREATE TABLE IF NOT EXISTS work_stages (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1
    );

    -- 주문 1건 = 카드 1장. 스마트스토어의 "상품주문번호" 하나가 한 줄이다.
    CREATE TABLE IF NOT EXISTS orders (
      id                 INTEGER PRIMARY KEY,
      channel            TEXT    NOT NULL,      -- 'smartstore' (3차에 coupang, esm, godo 추가)
      channel_order_id   TEXT    NOT NULL,      -- 주문번호 (여러 상품을 묶은 번호)
      channel_item_id    TEXT    NOT NULL,      -- 상품주문번호 (상품 하나 단위)
      product_name       TEXT    NOT NULL,
      option_text        TEXT,
      quantity           INTEGER NOT NULL DEFAULT 1,
      buyer_name         TEXT,
      receiver_name      TEXT,
      receiver_phone     TEXT,
      receiver_address   TEXT,
      paid_at            TEXT,
      channel_status     TEXT,                  -- 채널 쪽 주문 상태 (예: PAYED, DELIVERING)
      channel_confirmed  INTEGER NOT NULL DEFAULT 0, -- 채널에서 발주확인이 되었는지 (조회한 값)
      -- 아래는 사내에서 관리하는 칸 (채널에 전달되지 않음)
      stage_id           INTEGER REFERENCES work_stages(id),
      assignee_id        INTEGER REFERENCES users(id),
      due_date           TEXT,
      memo               TEXT,
      nas_path           TEXT,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (channel, channel_item_id)          -- 같은 주문이 두 번 들어오지 않게
    );
    CREATE INDEX IF NOT EXISTS idx_orders_assignee ON orders(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_orders_stage    ON orders(stage_id);
    CREATE INDEX IF NOT EXISTS idx_orders_due      ON orders(due_date);

    -- 설정값 (미지정 알림 기준 건수 등)
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 알림 기록
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY,
      type       TEXT    NOT NULL CHECK (type IN ('new_order', 'unassigned_over', 'signup')),
      message    TEXT    NOT NULL,
      order_id   INTEGER REFERENCES orders(id),
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// 처음 실행할 때만 기본값을 넣는다 (이미 있으면 건드리지 않음)
function seed(db) {
  const insertStage = db.prepare(
    'INSERT OR IGNORE INTO work_stages (name, sort_order) VALUES (?, ?)'
  );
  const insertJob = db.prepare(
    'INSERT OR IGNORE INTO jobs (name, is_designer, sort_order) VALUES (?, ?, ?)'
  );
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );

  transaction(db, () => {
    const hasStages = db.prepare('SELECT COUNT(*) AS n FROM work_stages').get().n > 0;
    if (!hasStages) {
      ['발주', '발주확인', '디자인작업', '컨펌', '제작', '발송'].forEach((name, i) =>
        insertStage.run(name, (i + 1) * 10)
      );
    }

    const hasJobs = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n > 0;
    if (!hasJobs) {
      insertJob.run('디자이너', 1, 10);
      insertJob.run('출력·후가공', 0, 20);
      insertJob.run('CS', 0, 30);
    }

    insertSetting.run('unassigned_threshold', '5');      // 미지정 알림 기준 건수
    insertSetting.run('unassigned_repeat_minutes', '30'); // 해소될 때까지 다시 알리는 간격
  });
}

// 여러 작업을 "전부 성공 또는 전부 취소"로 묶는다. 중간에 오류가 나면 앞의 작업도 되돌린다.
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction, DB_PATH };
