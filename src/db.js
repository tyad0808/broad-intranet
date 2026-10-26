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
  addMissingColumns(db);
  seed(db);
  return db;
}

// 이미 만들어진 DB 파일에 새 칸을 추가한다.
// CREATE TABLE IF NOT EXISTS 는 표가 이미 있으면 아무것도 안 하므로, 나중에 추가된 칸은 여기서 넣는다.
function addColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function addMissingColumns(db) {
  // 5단계: 직원이 주문 카드를 저장할 때마다 1씩 올린다 (동시에 고칠 때 덮어쓰기 방지용)
  addColumn(db, 'orders', 'version', 'INTEGER NOT NULL DEFAULT 0');
  // 본상품(main) / 추가상품(addon). 같은 주문번호 안에서 추가상품은 본상품 아래에 묶어 보여준다
  addColumn(db, 'orders', 'item_type', "TEXT NOT NULL DEFAULT 'main'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_group ON orders(channel, channel_order_id)');
  // 2차: 고객의 취소·반품·교환 요청 (채널에서 조회한 값)
  addColumn(db, 'orders', 'claim_type', 'TEXT');
  addColumn(db, 'orders', 'claim_status', 'TEXT');
  // 2차: 발송 정보 (인트라넷에서 발송처리한 값)
  addColumn(db, 'orders', 'ship_method', 'TEXT');
  addColumn(db, 'orders', 'ship_company', 'TEXT');
  addColumn(db, 'orders', 'tracking_no', 'TEXT');
  addColumn(db, 'orders', 'shipped_at', 'TEXT');
  // 수기 주문(계좌이체 등): 결제 방법·금액·입금자명·주문자 연락처
  addColumn(db, 'orders', 'pay_method', 'TEXT');
  addColumn(db, 'orders', 'amount', 'INTEGER');
  addColumn(db, 'orders', 'depositor', 'TEXT');
  addColumn(db, 'orders', 'buyer_phone', 'TEXT');
  widenOrderActions(db);
  // 디자인 단계 (비어 있으면 첫 번째 디자인 단계로 본다)
  addColumn(db, 'orders', 'design_stage_id', 'INTEGER REFERENCES design_stages(id)');
  // 직원마다 주문 목록의 채널 버튼 순서 (예: ["coupang","smartstore"]). 비어 있으면 기본 순서
  addColumn(db, 'users', 'channel_order', 'TEXT');
  // 직원마다 문의함 큰 탭 순서 (예: ["mail","shop"]). 맨 앞 탭이 처음 열린다
  addColumn(db, 'users', 'inbox_order', 'TEXT');
  // 직원마다 끈 알림 (JSON 목록: 'mail' 메일함, 'inbox' 문의함) — 끄면 왼쪽 메뉴 숫자와 새 메일·문의 알림이 안 보인다
  addColumn(db, 'users', 'notify_off', 'TEXT');
  // 채널이 쓰는 상태 이름 그대로 (예: 자사몰 '고객취소요청'). 공통 상태와 함께 보여줘서 헷갈리지 않게
  addColumn(db, 'orders', 'channel_status_label', 'TEXT');
  // 수기 주문 출처 (계좌·전화 주문, G마켓, 옥션 …)와 그 판매처의 주문번호
  addColumn(db, 'orders', 'source_id', 'INTEGER REFERENCES order_sources(id)');
  addColumn(db, 'orders', 'source_order_no', 'TEXT');
  // 문의 답장에 붙여 보낸 파일 이름·크기 (파일 자체는 저장하지 않음)
  addColumn(db, 'inquiry_replies', 'attachments', 'TEXT');
  // 쇼핑몰 문의: 관련 주문번호(있으면 주문 카드로 바로가기), 답변할 때 필요한 채널별 값(JSON)
  addColumn(db, 'inquiries', 'order_no', 'TEXT');
  addColumn(db, 'inquiries', 'meta', 'TEXT');
  // 메일 삭제: 내용은 지우고 '지웠음' 표시만 남긴다 (예전 메일 가져오기로 다시 들어오지 않게)
  addColumn(db, 'inquiries', 'deleted_at', 'TEXT');
  addColumn(db, 'inquiries', 'deleted_by', 'INTEGER REFERENCES users(id)');
  // 스마트스토어 배송 속성(TODAY = 오늘출발, NORMAL = 일반)과 발송기한(UTC ISO, 상품별 오늘출발 마감 시간이 반영된 값)
  addColumn(db, 'orders', 'delivery_type', 'TEXT');
  addColumn(db, 'orders', 'ship_due', 'TEXT');
  // 채널에서 발송지연 처리한 주문: 사유 코드 (예: CUSTOM_BUILD). 비어 있으면 발송지연 처리 안 함
  addColumn(db, 'orders', 'ship_delayed', 'TEXT');
  // 상품주문 한 줄의 실제 결제 금액 (할인 뒤, 배송비 제외). 채널에서 받아 온다. 수기 주문은 amount(주문 전체 금액)를 쓴다
  addColumn(db, 'orders', 'pay_amount', 'INTEGER');
  // 판매자센터·WING 에서 직접 발송한 주문: 수집 중 '배송중' 으로 바뀐 걸 처음 본 시각 (인트라넷 발송은 shipped_at)
  addColumn(db, 'orders', 'channel_shipped_at', 'TEXT');
  // 수기 주문의 상세주소(동·호수). receiver_address 에는 '기본주소 상세주소' 한 줄로 저장하고, 고칠 때 다시 나누려고 따로 기억한다
  addColumn(db, 'orders', 'receiver_address_detail', 'TEXT');
}

// 처리 기록 표가 수기 주문 기록(등록·입금확인·수정·취소)도 받을 수 있게 넓힌다.
// SQLite 는 CHECK 조건을 바로 고칠 수 없어서, 새 표를 만들어 옮겨 담는다 (기존 기록은 그대로).
function widenOrderActions(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'order_actions'").get();
  if (!row || row.sql.includes("'create'")) return;
  transaction(db, () => {
    db.exec('ALTER TABLE order_actions RENAME TO order_actions_old');
    db.exec('DROP INDEX IF EXISTS idx_order_actions_order');
    migrate(db); // 새 모양의 order_actions 를 만든다 (다른 표는 이미 있어서 그대로)
    db.exec(`
      INSERT INTO order_actions (id, created_at, user_id, action, channel, channel_order_id, item_ids, detail, mode, result, message)
      SELECT id, created_at, user_id, action, channel, channel_order_id, item_ids, detail, mode, result, message FROM order_actions_old;
      DROP TABLE order_actions_old;
    `);
  });
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

    -- 처리 기록: 누가 언제 어떤 주문에 발주확인·발송처리를 눌렀고 결과가 어땠는지 (2차)
    CREATE TABLE IF NOT EXISTS order_actions (
      id               INTEGER PRIMARY KEY,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      user_id          INTEGER REFERENCES users(id),
      action           TEXT    NOT NULL CHECK (action IN ('confirm', 'dispatch', 'create', 'paid', 'edit', 'cancel')),
      channel          TEXT    NOT NULL,
      channel_order_id TEXT    NOT NULL,
      item_ids         TEXT    NOT NULL,          -- 대상 상품주문번호 목록 (JSON)
      detail           TEXT,                      -- 배송 방법·택배사·송장번호 (JSON)
      mode             TEXT    NOT NULL CHECK (mode IN ('live', 'practice', 'local')), -- local: 인트라넷 안에서만 기록 (수기 주문)
      result           TEXT    NOT NULL CHECK (result IN ('ok', 'partial', 'fail', 'practice', 'unknown')),
      message          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_order_actions_order ON order_actions(channel, channel_order_id);

    -- 디자인 단계 (디자이너가 고르는 진행 상태). 주문 단계(발주·발주확인·발송)와 따로 관리한다
    CREATE TABLE IF NOT EXISTS design_stages (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1
    );

    -- 수기 주문 출처 (계좌·전화 주문, G마켓, 옥션 …). 관리자가 이름·순서를 바꾸고 추가한다
    CREATE TABLE IF NOT EXISTS order_sources (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active     INTEGER NOT NULL DEFAULT 1
    );

    -- 4차 문의함: 메일(네이버·지메일)과 쇼핑몰 문의를 한곳에 모은다
    CREATE TABLE IF NOT EXISTS inquiries (
      id             INTEGER PRIMARY KEY,
      source         TEXT    NOT NULL,              -- naver_mail, gmail (4-2부터 smartstore 등)
      external_id    TEXT    NOT NULL,              -- 출처 안에서 유일한 번호 (메일: 받은편지함 번호)
      from_name      TEXT,
      from_addr      TEXT,
      reply_to       TEXT,                          -- 답장 받을 주소 (메일에 따로 적혀 있으면)
      subject        TEXT,
      body           TEXT,                          -- 글자만 (HTML 은 글자로 바꿔 저장)
      attachments    TEXT,                          -- 첨부파일 이름·크기 JSON
      message_id     TEXT,                          -- 메일 답장을 같은 대화로 묶기 위한 값
      references_hdr TEXT,
      received_at    TEXT    NOT NULL,
      status         TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
      assignee_id    INTEGER REFERENCES users(id),
      handled_by     INTEGER REFERENCES users(id),  -- 답변하거나 '처리 완료' 한 직원
      handled_at     TEXT,
      version        INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_inquiries_received ON inquiries(received_at);

    -- 문의 답변 기록 (연습 모드로 보낸 것도 남긴다)
    CREATE TABLE IF NOT EXISTS inquiry_replies (
      id          INTEGER PRIMARY KEY,
      inquiry_id  INTEGER NOT NULL REFERENCES inquiries(id),
      user_id     INTEGER REFERENCES users(id),
      body        TEXT    NOT NULL,
      mode        TEXT    NOT NULL CHECK (mode IN ('live', 'practice')),
      result      TEXT    NOT NULL CHECK (result IN ('ok', 'fail', 'unknown', 'practice')),
      message     TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inquiry_replies ON inquiry_replies(inquiry_id);

    -- 5차 채팅(네이버 톡톡): 대화방 하나 = inquiries 한 줄, 주고받은 말은 여기에 (글자와 네이버 사진 주소만, 사진 파일은 저장하지 않음)
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          INTEGER PRIMARY KEY,
      inquiry_id  INTEGER NOT NULL REFERENCES inquiries(id),
      direction   TEXT    NOT NULL CHECK (direction IN ('in', 'out')),
      kind        TEXT    NOT NULL DEFAULT 'text',
      text        TEXT,
      image_url   TEXT,
      sender      TEXT,
      created_at  TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages ON chat_messages(inquiry_id, id);

    -- 주문 담당자·디자인 단계가 언제 누구에 의해 바뀌었는지 (직원별 처리 현황용)
    CREATE TABLE IF NOT EXISTS order_events (
      id               INTEGER PRIMARY KEY,
      channel          TEXT    NOT NULL,
      channel_order_id TEXT    NOT NULL,
      user_id          INTEGER REFERENCES users(id),
      kind             TEXT    NOT NULL CHECK (kind IN ('assign', 'design')),
      from_value       INTEGER,
      to_value         INTEGER,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_order_events ON order_events(kind, created_at);

    -- 로젠 송장: 우리가 로젠에 등록한 주문 (주문번호 묶음 하나 = 송장 하나, 같은 주문번호 상품은 한 박스로 합포장)
    --   env: dev(테스트 서버) / prod(실제). take_no = 로젠에 보낸 주문번호(fixTakeNo)
    --   status: registered 등록됨 · deleted iLOGEN 에서 지워짐 (다시 등록할 수 있음)
    CREATE TABLE IF NOT EXISTS logen_shipments (
      id               INTEGER PRIMARY KEY,
      channel          TEXT    NOT NULL,
      channel_order_id TEXT    NOT NULL,
      env              TEXT    NOT NULL,
      take_no          TEXT    NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'registered',
      slip_no          TEXT,
      slip_at          TEXT,
      track_json       TEXT,
      track_at         TEXT,
      user_id          INTEGER REFERENCES users(id),
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (env, take_no)
    );
    CREATE INDEX IF NOT EXISTS idx_logen_order ON logen_shipments(channel, channel_order_id);

    -- 자주 쓰는 답장 문구 (직원 누구나 만들고 고친다). scope: all 모두 · mail 메일만 · shop 쇼핑몰 문의만
    CREATE TABLE IF NOT EXISTS reply_templates (
      id          INTEGER PRIMARY KEY,
      title       TEXT    NOT NULL,
      body        TEXT    NOT NULL,
      scope       TEXT    NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'mail', 'shop')),
      use_count   INTEGER NOT NULL DEFAULT 0,
      updated_by  INTEGER REFERENCES users(id),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 회사 일정 (주문 목록 옆 달력). 승인된 직원 누구나 넣고, 넣은 사람과 관리자만 고치거나 지운다
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY,
      title       TEXT    NOT NULL,
      start_date  TEXT    NOT NULL,              -- YYYY-MM-DD (한국 날짜)
      end_date    TEXT,                          -- 여러 날 일정이면 마지막 날, 하루면 비움
      time        TEXT,                          -- HH:MM, 종일이면 비움
      memo        TEXT,
      color       TEXT    NOT NULL DEFAULT 'blue',
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_date);

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

// 수기 주문 출처 처음 목록 (한 번만 넣는다. 관리자가 지우거나 바꾼 뒤에 다시 생기지 않게 표시를 남김)
const ORDER_SOURCE_NAMES = ['계좌·전화 주문', 'G마켓', '옥션', '기타'];

// 주문 단계: 채널 처리(발주확인·발송처리)에 따라 자동으로 움직인다
const ORDER_STAGE_NAMES = ['발주', '발주확인', '발송'];
// 디자인 단계: 디자이너가 직접 고른다 (관리자가 이름·순서를 바꿀 수 있음)
const DESIGN_STAGE_NAMES = ['디자인 작업 전', '디자인 작업 중', '컨펌 후 파일전송'];

// 예전에는 디자인 단계가 주문 단계 사이에 섞여 있었다 (발주 → 발주확인 → 디자인… → 발송).
// 한 번만: 그 단계들을 design_stages 로 옮기고, 그 단계에 있던 주문은 디자인 단계를 그대로 기억한 채
// 주문 단계를 발주확인(채널에서 발주확인됨) 또는 발주로 되돌린다.
function splitDesignStages(db, insertSetting) {
  if (db.prepare("SELECT value FROM settings WHERE key = 'design_split_v1'").get()) return;
  const setting = key => Number((db.prepare('SELECT value FROM settings WHERE key = ?').get(key) || {}).value) || null;
  const stageNew = setting('stage_new');
  const stageConfirmed = setting('stage_confirmed');
  const last = db.prepare('SELECT id FROM work_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1').get();
  const keep = new Set([stageNew, stageConfirmed, last && last.id].filter(Boolean));
  const old = db.prepare('SELECT * FROM work_stages ORDER BY sort_order').all().filter(s => !keep.has(s.id));

  const hasDesign = db.prepare('SELECT COUNT(*) AS n FROM design_stages').get().n > 0;
  const insertDesign = db.prepare('INSERT OR IGNORE INTO design_stages (name, sort_order, active) VALUES (?, ?, ?)');
  const idOf = name => db.prepare('SELECT id FROM design_stages WHERE name = ?').get(name).id;
  if (!hasDesign) {
    const source = old.length ? old.map(s => [s.name, s.active]) : DESIGN_STAGE_NAMES.map(n => [n, 1]);
    source.forEach(([name, active], i) => insertDesign.run(name, (i + 1) * 10, active));
  }
  for (const s of old) {
    const designId = hasDesign ? null : idOf(s.name);
    db.prepare(`
      UPDATE orders SET design_stage_id = COALESCE(?, design_stage_id),
        stage_id = CASE WHEN channel != 'manual' AND channel_confirmed = 1 THEN ? ELSE ? END,
        version = version + 1
      WHERE stage_id = ?
    `).run(designId, stageConfirmed || stageNew, stageNew, s.id);
    db.prepare('DELETE FROM work_stages WHERE id = ?').run(s.id);
  }
  insertSetting.run('design_split_v1', '1');
}

// 한 번만: 판매자센터에서 바로 발송된 주문(묶음이 모두 끝났고 하나라도 발송됨)이 발주확인 등에 남아 있으면 '발송' 단계로
function moveShippedToLastStage(db, insertSetting) {
  if (db.prepare("SELECT value FROM settings WHERE key = 'ship_stage_fix_v1'").get()) return;
  const last = db.prepare('SELECT id FROM work_stages WHERE active = 1 ORDER BY sort_order DESC LIMIT 1').get();
  if (last) {
    const shipped = "'DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED', 'RETURNED'";
    const ended = `${shipped}, 'CANCELED', 'CANCELED_BY_NOPAYMENT'`;
    db.prepare(`
      UPDATE orders SET stage_id = ? WHERE (stage_id IS NULL OR stage_id != ?) AND (channel, channel_order_id) IN (
        SELECT channel, channel_order_id FROM orders GROUP BY channel, channel_order_id
        HAVING MIN(channel_status IN (${ended})) = 1 AND MAX(channel_status IN (${shipped})) = 1
      )
    `).run(last.id, last.id);
  }
  insertSetting.run('ship_stage_fix_v1', '1');
}

// 예전 기본 단계 이름을 새 이름으로 한 번만 바꾼다 (관리자가 이미 다른 이름으로 바꿨으면 건드리지 않음)
function renameDesignStages(db, insertSetting) {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'stage_names_v2'").get();
  if (done) return;
  const pairs = [['디자인작업', '디자인작업 전'], ['컨펌', '작업 중'], ['제작', '컨펌 후 파일전송']];
  for (const [from, to] of pairs) {
    const taken = db.prepare('SELECT 1 FROM work_stages WHERE name = ?').get(to);
    if (!taken) db.prepare('UPDATE work_stages SET name = ? WHERE name = ?').run(to, from);
  }
  insertSetting.run('stage_names_v2', '1');
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
      ORDER_STAGE_NAMES.forEach((name, i) => insertStage.run(name, (i + 1) * 10));
      DESIGN_STAGE_NAMES.forEach((name, i) =>
        db.prepare('INSERT OR IGNORE INTO design_stages (name, sort_order) VALUES (?, ?)').run(name, (i + 1) * 10));
      insertSetting.run('stage_names_v2', '1');
      insertSetting.run('design_split_v1', '1');
    }
    renameDesignStages(db, insertSetting);

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

    splitDesignStages(db, insertSetting);
    moveShippedToLastStage(db, insertSetting);

    if (!db.prepare("SELECT value FROM settings WHERE key = 'order_sources_v1'").get()) {
      const hasSources = db.prepare('SELECT COUNT(*) AS n FROM order_sources').get().n > 0;
      if (!hasSources) {
        ORDER_SOURCE_NAMES.forEach((name, i) =>
          db.prepare('INSERT OR IGNORE INTO order_sources (name, sort_order) VALUES (?, ?)').run(name, (i + 1) * 10));
      }
      insertSetting.run('order_sources_v1', '1');
    }

    insertSetting.run('unassigned_threshold', '5');      // 미지정 알림 기준 건수
    insertSetting.run('unassigned_repeat_minutes', '30'); // 해소될 때까지 다시 알리는 간격
    insertSetting.run('unassigned_recipients', '[]');     // 관리자 말고 미지정 알림을 함께 받을 직원 번호들
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
