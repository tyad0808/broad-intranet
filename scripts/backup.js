// DB 백업: data/intranet.db 를 backups/ 폴더에 날짜별로 복사하고, 오래된 백업은 지운다
// 실행: npm run backup   (운영 서버에서는 매일 새벽 자동 실행)
//
// 파일을 그냥 복사하면 쓰는 도중의 내용이 섞일 수 있어서, SQLite 의 VACUUM INTO 로
// "그 순간의 완전한 사본"을 만든다. 서버가 켜져 있어도 안전하다.
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('../src/db');

function backup({
  dbPath = DB_PATH,
  dir = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), '..', 'backups'),
  keepDays = Number(process.env.BACKUP_KEEP_DAYS) || 14,
  now = new Date(),
} = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`DB 파일이 없습니다: ${dbPath}`);
  fs.mkdirSync(dir, { recursive: true });

  // 파일 이름에 한국 시간 날짜·시각을 넣는다: intranet-2026-10-15-0300.db
  const kst = new Date(now.getTime() + 9 * 3600 * 1000).toISOString();
  const stamp = `${kst.slice(0, 10)}-${kst.slice(11, 13)}${kst.slice(14, 16)}`;
  const target = path.join(dir, `intranet-${stamp}.db`);
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  // keepDays 보다 오래된 백업 정리
  const limit = now.getTime() - keepDays * 24 * 3600 * 1000;
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^intranet-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(name)) continue;
    const file = path.join(dir, name);
    if (fs.statSync(file).mtimeMs < limit) {
      fs.unlinkSync(file);
      removed.push(name);
    }
  }
  return { target, removed };
}

if (require.main === module) {
  try {
    const { target, removed } = backup();
    console.log(`백업 완료: ${target}`);
    if (removed.length) console.log(`오래된 백업 ${removed.length}개 삭제`);
  } catch (err) {
    console.error(`백업 실패: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { backup };
