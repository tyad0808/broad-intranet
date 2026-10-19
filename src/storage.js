// 서버 저장 공간: 디스크 남은 용량, DB 크기, 백업 크기 (관리자 → 저장 공간, 80% 넘으면 관리자 알림)
const fs = require('fs');
const path = require('path');
const { DB_PATH } = require('./db');

const ALERT_PERCENT = 80;

const sizeOf = file => {
  try { return fs.statSync(file).size; } catch { return 0; }
};

function backupDirOf(dbPath) {
  return process.env.BACKUP_DIR || path.join(path.dirname(dbPath), '..', 'backups');
}

function storageInfo({ dbPath = DB_PATH, backupDir = backupDirOf(dbPath), statfs = fs.statfsSync } = {}) {
  let disk = null;
  try {
    const s = statfs(path.dirname(dbPath));
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = total - s.bfree * s.bsize;
    disk = { total, used, free, percent: total ? Math.round((used / total) * 100) : 0 };
  } catch {
    disk = null;
  }
  // DB 는 본 파일 + 아직 합쳐지지 않은 변경분(-wal)
  const db = sizeOf(dbPath) + sizeOf(`${dbPath}-wal`);
  let backups = { count: 0, size: 0, latest: null };
  try {
    const files = fs.readdirSync(backupDir).filter(n => /^intranet-.*\.db(\.gz)?$/.test(n)).sort();
    backups = {
      count: files.length,
      size: files.reduce((sum, n) => sum + sizeOf(path.join(backupDir, n)), 0),
      latest: files.length ? files[files.length - 1] : null,
    };
  } catch {
    // 백업 폴더가 아직 없음
  }
  return { disk, db, backups, alert: Boolean(disk && disk.percent >= ALERT_PERCENT), ALERT_PERCENT };
}

// 사람이 읽기 쉬운 크기: 1.2GB, 340MB, 12KB
function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${units[i]}`;
}

module.exports = { storageInfo, humanSize, ALERT_PERCENT };
