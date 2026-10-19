// DB 백업: data/intranet.db 를 backups/ 폴더에 날짜별로 압축해 복사하고(.db.gz), 오래된 백업은 지운다
// 실행: npm run backup   (운영 서버에서는 매일 새벽 자동 실행)
//
// 파일을 그냥 복사하면 쓰는 도중의 내용이 섞일 수 있어서, SQLite 의 VACUUM INTO 로
// "그 순간의 완전한 사본"을 만든다. 서버가 켜져 있어도 안전하다.
// 그 사본을 gzip 으로 압축해 둔다 (글자 데이터라 1/4~1/5 크기). 되살릴 때는 gunzip 으로 푼다.
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('../src/db');

const BACKUP_NAME = /^intranet-\d{4}-\d{2}-\d{2}-\d{4}\.db(\.gz)?$/;

async function backup({
  dbPath = DB_PATH,
  dir = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), '..', 'backups'),
  keepDays = Number(process.env.BACKUP_KEEP_DAYS) || 14,
  now = new Date(),
} = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`DB 파일이 없습니다: ${dbPath}`);
  fs.mkdirSync(dir, { recursive: true });

  // 파일 이름에 한국 시간 날짜·시각을 넣는다: intranet-2026-10-15-0300.db.gz
  const kst = new Date(now.getTime() + 9 * 3600 * 1000).toISOString();
  const stamp = `${kst.slice(0, 10)}-${kst.slice(11, 13)}${kst.slice(14, 16)}`;
  const target = path.join(dir, `intranet-${stamp}.db.gz`);
  const copy = path.join(dir, `intranet-${stamp}.db.tmp`); // 압축 전 사본 (끝나면 지움)
  for (const f of [target, copy]) if (fs.existsSync(f)) fs.unlinkSync(f);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  try {
    await pipeline(fs.createReadStream(copy), zlib.createGzip({ level: 6 }), fs.createWriteStream(target));
  } finally {
    fs.unlinkSync(copy);
  }

  // keepDays 보다 오래된 백업 정리
  const limit = now.getTime() - keepDays * 24 * 3600 * 1000;
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    if (!BACKUP_NAME.test(name)) continue; // 예전 압축 안 된 백업(.db)도 기간이 지나면 지운다
    const file = path.join(dir, name);
    if (fs.statSync(file).mtimeMs < limit) {
      fs.unlinkSync(file);
      removed.push(name);
    }
  }
  return { target, removed };
}

if (require.main === module) {
  backup().then(({ target, removed }) => {
    console.log(`백업 완료: ${target} (${Math.round(fs.statSync(target).size / 1024)}KB)`);
    if (removed.length) console.log(`오래된 백업 ${removed.length}개 삭제`);
  }).catch(err => {
    console.error(`백업 실패: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { backup, BACKUP_NAME };
