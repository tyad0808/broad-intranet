// DB 백업: data/intranet.db 를 backups/ 폴더에 날짜별로 압축해 복사하고(.db.gz), 오래된 백업은 지운다
// 실행: npm run backup   (운영 서버에서는 매일 새벽 자동 실행)
//
// 파일을 그냥 복사하면 쓰는 도중의 내용이 섞일 수 있어서, SQLite 의 VACUUM INTO 로
// "그 순간의 완전한 사본"을 만든다. 서버가 켜져 있어도 안전하다.
// 그 사본을 gzip 으로 압축해 둔다 (글자 데이터라 1/4~1/5 크기). 되살릴 때는 gunzip 으로 푼다.
// 시안 그림(data/proofs)도 backups/proofs/ 에 똑같이 맞춰 둔다 → 사무실 NAS 가 backups 폴더 하나만 가져가면 된다 (deploy/nas-backup-setup.sh)
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('../src/db');

const BACKUP_NAME = /^intranet-\d{4}-\d{2}-\d{2}-\d{4}\.db(\.gz)?$/;

// 시안 그림 폴더를 백업 폴더 안 proofs/ 에 똑같이: 새 파일은 하드링크(디스크를 더 쓰지 않음, 안 되면 복사), 원본에서 지워진 파일은 지운다
//   (지워진 주문·개인정보를 지운 주문의 시안은 백업에서도 사라져야 한다)
function mirrorProofs(src, dest) {
  if (!fs.existsSync(src)) return null;
  fs.mkdirSync(dest, { recursive: true });
  const want = new Set(fs.readdirSync(src).filter(n => !n.startsWith('.') && fs.statSync(path.join(src, n)).isFile()));
  let added = 0;
  let removed = 0;
  for (const name of want) {
    const to = path.join(dest, name);
    if (fs.existsSync(to)) continue;
    try { fs.linkSync(path.join(src, name), to); } catch { fs.copyFileSync(path.join(src, name), to); }
    added += 1;
  }
  for (const name of fs.readdirSync(dest)) {
    if (want.has(name)) continue;
    fs.rmSync(path.join(dest, name), { force: true, recursive: true });
    removed += 1;
  }
  return { count: want.size, added, removed };
}

async function backup({
  dbPath = DB_PATH,
  dir = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), '..', 'backups'),
  keepDays = Number(process.env.BACKUP_KEEP_DAYS) || 14,
  proofDir = process.env.PROOF_DIR || path.join(path.dirname(dbPath), 'proofs'),
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
  const proofs = mirrorProofs(proofDir, path.join(dir, 'proofs'));
  return { target, removed, proofs };
}

if (require.main === module) {
  backup().then(({ target, removed, proofs }) => {
    console.log(`백업 완료: ${target} (${Math.round(fs.statSync(target).size / 1024)}KB)`);
    if (removed.length) console.log(`오래된 백업 ${removed.length}개 삭제`);
    if (proofs) console.log(`시안 그림 ${proofs.count}개 (새로 ${proofs.added} · 지움 ${proofs.removed})`);
  }).catch(err => {
    console.error(`백업 실패: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { backup, mirrorProofs, BACKUP_NAME };
