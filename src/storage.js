// 서버 저장 공간: 디스크 남은 용량, DB 크기, 백업 크기 (관리자 → 저장 공간, 80% 넘으면 관리자 알림)
const fs = require('fs');
const path = require('path');
const { DB_PATH } = require('./db');

const ALERT_PERCENT = 80;
// 사무실 NAS 백업: NAS 가 백업을 가져갈 때마다 서버가 시각을 적는 파일 (deploy/nas-backup-setup.sh 가 만든다)
const NAS_PULL_FILE = process.env.NAS_PULL_FILE || '/var/lib/broad-intranet-nas/last_pull';
const NAS_STALE_DAYS = 3;

// NAS 백업 상태: { configured: 설정했는지, last: 마지막으로 가져간 시각(ISO), days: 며칠 전, stale: 3일 넘게 안 가져감 }
function nasInfo({ file = NAS_PULL_FILE, now = new Date() } = {}) {
  const home = path.dirname(file);
  if (!fs.existsSync(home)) return { configured: false, last: null, days: null, stale: false };
  let last = null;
  try { last = fs.readFileSync(file, 'utf8').trim() || null; } catch { last = null; }
  const t = last ? Date.parse(last) : NaN;
  const days = Number.isFinite(t) ? Math.floor((now.getTime() - t) / 86400000) : null;
  // 설정하고 아직 한 번도 안 가져갔으면: 설정한 지 3일이 지나야 경고 (설정 직후엔 경고하지 않음)
  let since = days;
  if (since === null) { try { since = Math.floor((now.getTime() - fs.statSync(home).mtimeMs) / 86400000); } catch { since = 0; } }
  return { configured: true, last: Number.isFinite(t) ? new Date(t).toISOString() : null, days, stale: since > NAS_STALE_DAYS };
}

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
  return { disk, db, backups, alert: Boolean(disk && disk.percent >= ALERT_PERCENT), ALERT_PERCENT, nas: nasInfo(), NAS_STALE_DAYS };
}

// 사람이 읽기 쉬운 크기: 1.2GB, 340MB, 12KB
function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${units[i]}`;
}

module.exports = { storageInfo, nasInfo, humanSize, ALERT_PERCENT, NAS_STALE_DAYS };
