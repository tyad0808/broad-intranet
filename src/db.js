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

// 알림 종류: 새 주문, 미지정 주문 많음, 가입 신청, 고객 시안 확정, 고객 수정 요청
const NOTIFICATION_TYPES = ["'new_order'", "'unassigned_over'", "'signup'", "'proof_approved'", "'proof_revise'"].join(', ');

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

    -- 주문 수집 기록 (언제 몇 건을 가져왔는지, 실패했다면 왜인지)
    CREATE TABLE IF NOT EXISTS collect_runs (
      id          INTEGER PRIMARY KEY,
      channel     TEXT    NOT NULL,
      started_at  TEXT    NOT NULL,
      finished_at TEXT,
      range_from  TEXT,
      range_to    TEXT,
      ok          INTEGER,
      fetched     INTEGER NOT NULL DEFAULT 0,
      created     INTEGER NOT NULL DEFAULT 0,
      updated     INTEGER NOT NULL DEFAULT 0,
      error       TEXT
    );

    -- 알림 기록
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY,
      type       TEXT    NOT NULL CHECK (type IN (${NOTIFICATION_TYPES})),
      message    TEXT    NOT NULL,
      order_id   INTEGER REFERENCES orders(id),
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 시안 1건 = 고객에게 보내는 링크 1개. 수정할 때마다 같은 링크에 새 판(version)이 쌓인다.
    -- 주문 카드와 연결하지 않아도 된다 (매장·전화 손님).
    CREATE TABLE IF NOT EXISTS proofs (
      id             INTEGER PRIMARY KEY,
      token          TEXT    NOT NULL UNIQUE,   -- 고객 링크 주소 (추측할 수 없는 무작위 문자열)
      order_id       INTEGER REFERENCES orders(id),
      title          TEXT    NOT NULL,
      customer_name  TEXT,
      customer_phone TEXT,
      note           TEXT,                      -- 고객에게 보여줄 안내 (규격, 소재, 수량 등)
      status         TEXT    NOT NULL DEFAULT 'waiting'
                     CHECK (status IN ('waiting', 'approved', 'revise', 'closed')),
      created_by     INTEGER REFERENCES users(id),
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at     TEXT    NOT NULL,          -- 이 시각이 지나면 고객 링크가 열리지 않는다
      decided_at     TEXT,                      -- 고객이 확정한 시각
      decided_name   TEXT                       -- 확정한 사람 이름 (고객이 입력)
    );
    CREATE INDEX IF NOT EXISTS idx_proofs_status ON proofs(status);
    CREATE INDEX IF NOT EXISTS idx_proofs_order  ON proofs(order_id);

    -- 시안 이미지 (1차, 2차, …)
    CREATE TABLE IF NOT EXISTS proof_versions (
      id            INTEGER PRIMARY KEY,
      proof_id      INTEGER NOT NULL REFERENCES proofs(id),
      version_no    INTEGER NOT NULL,
      file_name     TEXT    NOT NULL,           -- data/proofs 안의 저장 이름
      mime          TEXT    NOT NULL,
      original_name TEXT,
      message       TEXT,                       -- 고객에게 보여줄 한마디 (예: 전화번호 크게 수정했습니다)
      uploaded_by   INTEGER REFERENCES users(id),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (proof_id, version_no)
    );

    -- 고객 응답: 확정 또는 수정 요청. pins 는 이미지 위에 찍은 표시 [{x, y, note}] (x, y 는 0~1 비율)
    CREATE TABLE IF NOT EXISTS proof_responses (
      id         INTEGER PRIMARY KEY,
      proof_id   INTEGER NOT NULL REFERENCES proofs(id),
      version_id INTEGER NOT NULL REFERENCES proof_versions(id),
      action     TEXT    NOT NULL CHECK (action IN ('approve', 'revise')),
      name       TEXT,
      comment    TEXT,
      pins       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 보낸 문자 기록 (알리고). 개발 중 가짜 발송도 여기에 남는다
    CREATE TABLE IF NOT EXISTS sms_log (
      id         INTEGER PRIMARY KEY,
      receiver   TEXT    NOT NULL,
      message    TEXT    NOT NULL,
      driver     TEXT    NOT NULL,
      ok         INTEGER NOT NULL,
      result     TEXT,
      proof_id   INTEGER REFERENCES proofs(id),
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  upgradeNotificationTypes(db);
}

// 예전 DB 의 알림 종류 제한(CHECK)에 시안 알림이 없으면 표를 새로 만들어 옮긴다 (SQLite 는 CHECK 를 바로 고칠 수 없음)
function upgradeNotificationTypes(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get();
  if (!row || row.sql.includes("'proof_revise'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE notifications_new (
          id         INTEGER PRIMARY KEY,
          type       TEXT    NOT NULL CHECK (type IN (${NOTIFICATION_TYPES})),
          message    TEXT    NOT NULL,
          order_id   INTEGER REFERENCES orders(id),
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO notifications_new (id, type, message, order_id, created_at)
          SELECT id, type, message, order_id, created_at FROM notifications;
        DROP TABLE notifications;
        ALTER TABLE notifications_new RENAME TO notifications;
      `);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
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

    // 새 주문이 들어갈 단계, 채널에서 발주확인되면 옮겨 갈 단계 (이름을 바꿔도 번호로 기억)
    const stageId = name => {
      const row = db.prepare('SELECT id FROM work_stages WHERE name = ?').get(name);
      return row ? String(row.id) : null;
    };
    const newStage = stageId('발주');
    const confirmedStage = stageId('발주확인');
    if (newStage) insertSetting.run('stage_new', newStage);
    if (confirmedStage) insertSetting.run('stage_confirmed', confirmedStage);
    // 시안: 보내면 '컨펌', 고객이 확정하면 '제작', 수정 요청하면 '디자인작업' 으로 주문 카드를 옮긴다
    [['stage_proof_sent', '컨펌'], ['stage_proof_approved', '제작'], ['stage_proof_revise', '디자인작업']]
      .forEach(([key, name]) => {
        const id = stageId(name);
        if (id) insertSetting.run(key, id);
      });

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
