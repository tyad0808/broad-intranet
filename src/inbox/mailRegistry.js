// 메일 계정 모음: 서버 .env 의 계정 + 관리자 화면에서 넣은 계정(DB, 앱 비밀번호는 암호화)
//
// 관리자 화면에서 추가·바꾸기·끄기·지우기를 하면 apply() 로 바로 반영한다 (서버를 다시 켤 필요 없음):
//   메일함 받기(수집기 출처 목록) · 답장 보내기(senders) · 첨부 열기(files) · 화면 이름(sourceLabels)
// 출처 이름: .env 는 gmail, gmail2 … gmail5 / 관리자 화면은 gmail101 처럼 100 + 번호 (겹치지 않게, 한 번 정하면 그대로)
const { PROVIDERS, isMailSource, mailAccountsFromEnv, createMailSource, createMailSender, createMailFiles, defaultConnect, withTimeout } = require('./mail');

const SOURCE_BASE = 100;
const LOGIN_LIMIT_MS = 30_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 로그인 실패 이유를 알아듣기 쉽게
function loginError(e) {
  const text = `${e && e.message} ${e && e.responseText}`;
  if ((e && e.authenticationFailed) || /AUTHENTICATIONFAILED|Invalid credentials|Login failed|authentication failed|LOGIN failed|Username and Password not accepted/i.test(text)) {
    return '메일 서버가 로그인을 거절했어요. 메일 주소와 앱 비밀번호를 확인해 주세요. (일반 로그인 비밀번호가 아니라 앱 비밀번호여야 해요)';
  }
  if (/시간 초과|timeout|ETIMEDOUT/i.test(text)) return '메일 서버가 응답하지 않아요. 잠시 뒤 다시 시험해 주세요.';
  if (/IMAP.*(disabled|not enabled)|enable IMAP/i.test(text)) return '메일 설정에서 IMAP 사용이 꺼져 있어요. 켜고 다시 시험해 주세요.';
  return `연결하지 못했어요: ${String((e && e.message) || e).slice(0, 200)}`;
}

function createMailRegistry({
  db, box, inbox, collectorSources = [], live = false,
  envAccounts = mailAccountsFromEnv(),
  connect = acc => defaultConnect(acc),
  makeSource = acc => createMailSource(acc),
  makeSender = acc => createMailSender(acc),
  makeFiles = acc => createMailFiles(acc),
}) {
  const now = () => new Date().toISOString();
  const rowsAll = () => db.prepare('SELECT * FROM mail_accounts ORDER BY id').all();
  const findRow = id => db.prepare('SELECT * FROM mail_accounts WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  const log = (accountId, userId, action, address) =>
    db.prepare('INSERT INTO mail_account_log (account_id, user_id, action, address) VALUES (?, ?, ?, ?)').run(accountId, userId || null, action, address);
  const accountOf = (row, pass) => ({
    ...PROVIDERS[row.kind], source: row.source, kind: row.kind, kindLabel: PROVIDERS[row.kind].label,
    label: row.address, user: row.address, pass,
  });
  // 메일함이 받을 때마다 남기는 계정별 결과 (collector.js 가 inbox_status_<출처> 로 저장)
  const statusOf = source => {
    try { return JSON.parse((db.prepare('SELECT value FROM settings WHERE key = ?').get(`inbox_status_${source}`) || {}).value || 'null'); } catch { return null; }
  };
  const setStatus = (source, status) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`inbox_status_${source}`, JSON.stringify(status));

  // .env 계정 끄기·켜기: 계정 정보(.env)는 그대로 두고 받기·답장만 멈춘다 (settings 의 mail_env_off_<출처> = '1')
  const envOff = source => (db.prepare('SELECT value FROM settings WHERE key = ?').get(`mail_env_off_${source}`) || {}).value === '1';

  // 지금 계정들을 메일함·답장·첨부·이름에 반영 (메일이 아닌 출처는 그대로 둔다)
  function apply() {
    if (!inbox) return;
    for (const map of [inbox.sourceLabels, inbox.senders, inbox.files]) {
      if (!map) continue;
      for (const key of Object.keys(map)) if (isMailSource(key)) delete map[key];
    }
    for (let i = collectorSources.length - 1; i >= 0; i--) if (isMailSource(collectorSources[i].source)) collectorSources.splice(i, 1);
    const use = (acc, { collect }) => {
      inbox.sourceLabels[acc.source] = acc.label;
      if (inbox.files) inbox.files[acc.source] = makeFiles(acc);
      if (!collect) return;
      if (live && inbox.senders) inbox.senders[acc.source] = makeSender(acc);
      collectorSources.push(makeSource(acc));
    };
    for (const acc of envAccounts) use(acc, { collect: !envOff(acc.source) });
    for (const row of rowsAll()) {
      if (!row.source) continue;
      const pass = row.deleted_at ? null : box.open(row.pass_sealed);
      // 지운 계정·열쇠가 바뀌어 비밀번호를 못 푼 계정은 이름만 (받은 메일에 계정 이름이 보이게)
      if (!pass) { inbox.sourceLabels[row.source] = row.address; continue; }
      use(accountOf(row, pass), { collect: Boolean(row.enabled) });
    }
  }

  async function tryLogin(acc) {
    let client = null;
    try {
      client = await withTimeout(connect(acc), LOGIN_LIMIT_MS, '메일 서버 연결 시간 초과');
      return null;
    } catch (e) {
      return loginError(e);
    } finally {
      if (client) await client.logout().catch(() => {});
    }
  }

  const cleanPass = pass => String(pass || '').replace(/\s+/g, ''); // 앱 비밀번호는 띄어 써서 보여 주지만 띄어쓰기는 빼도 된다
  const sameAddress = (kind, address, exceptId = null) =>
    envAccounts.some(a => a.kind === kind && a.user.toLowerCase() === address.toLowerCase())
    || rowsAll().some(r => !r.deleted_at && r.id !== exceptId && r.kind === kind && r.address.toLowerCase() === address.toLowerCase());

  return {
    apply,
    get ready() { return box.ready; },
    keyProblem: box.keyProblem,
    live,
    // 화면용 목록: .env 계정(바꿀 수 없음) + 관리자 화면 계정. 비밀번호는 내보내지 않는다
    list() {
      const env = envAccounts.map(a => ({ id: null, fromEnv: true, kind: a.kind, kindLabel: a.kindLabel, address: a.user, source: a.source, enabled: envOff(a.source) ? 0 : 1, status: statusOf(a.source) }));
      const saved = rowsAll().filter(r => !r.deleted_at).map(r => ({
        id: r.id, fromEnv: false, kind: r.kind, kindLabel: PROVIDERS[r.kind].label, address: r.address, source: r.source,
        enabled: r.enabled, created_at: r.created_at, updated_at: r.updated_at,
        locked: !box.open(r.pass_sealed), // 열쇠가 바뀌어 못 푸는 비밀번호
        status: statusOf(r.source),
      }));
      return [...env, ...saved];
    },
    history(limit = 20) {
      return db.prepare(`SELECT l.*, u.name AS user_name FROM mail_account_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?`).all(limit);
    },
    // 추가: 먼저 실제로 로그인해 보고, 되면 저장
    async add({ kind, address, pass }, userId) {
      if (!box.ready) return { error: box.keyProblem || '서버 .env 에 SETTINGS_KEY 가 없어 비밀번호를 저장할 수 없어요.' };
      if (!PROVIDERS[kind]) return { error: '메일 종류를 골라 주세요.' };
      const addr = String(address || '').trim();
      const pw = cleanPass(pass);
      if (!EMAIL_RE.test(addr) || addr.length > 200) return { error: '메일 주소를 확인해 주세요.' };
      if (!pw || pw.length > 200) return { error: '앱 비밀번호를 넣어 주세요.' };
      if (sameAddress(kind, addr)) return { error: '이미 연결된 메일 주소예요.' };
      const error = await tryLogin({ ...PROVIDERS[kind], kind, user: addr, pass: pw });
      if (error) return { error };
      const id = Number(db.prepare('INSERT INTO mail_accounts (kind, address, pass_sealed, created_by) VALUES (?, ?, ?, ?)')
        .run(kind, addr, box.seal(pw), userId || null).lastInsertRowid);
      const source = `${kind}${SOURCE_BASE + id}`;
      db.prepare('UPDATE mail_accounts SET source = ? WHERE id = ?').run(source, id);
      setStatus(source, { ok: true, at: now(), test: true });
      log(id, userId, '추가', addr);
      apply();
      return { id, source };
    },
    async changePassword(id, pass, userId) {
      if (!box.ready) return { error: box.keyProblem || '서버 .env 에 SETTINGS_KEY 가 없어요.' };
      const row = findRow(id);
      if (!row) return { error: '계정을 찾을 수 없어요.' };
      const pw = cleanPass(pass);
      if (!pw || pw.length > 200) return { error: '새 앱 비밀번호를 넣어 주세요.' };
      const error = await tryLogin(accountOf(row, pw));
      if (error) return { error };
      db.prepare("UPDATE mail_accounts SET pass_sealed = ?, updated_at = datetime('now') WHERE id = ?").run(box.seal(pw), row.id);
      setStatus(row.source, { ok: true, at: now(), test: true });
      log(row.id, userId, '비밀번호 바꿈', row.address);
      apply();
      return { ok: true };
    },
    // 저장된 비밀번호로 다시 로그인해 보기
    async test(id, userId) {
      const row = findRow(id);
      if (!row) return { error: '계정을 찾을 수 없어요.' };
      const pass = box.open(row.pass_sealed);
      if (!pass) return { error: '저장된 비밀번호를 풀 수 없어요 (서버 열쇠가 바뀌었어요). 비밀번호를 다시 넣어 주세요.' };
      const error = await tryLogin(accountOf(row, pass));
      setStatus(row.source, error ? { ok: false, at: now(), error, test: true } : { ok: true, at: now(), test: true });
      log(row.id, userId, error ? '연결 시험 실패' : '연결 시험 성공', row.address);
      return error ? { error } : { ok: true };
    },
    setEnabled(id, on, userId) {
      const row = findRow(id);
      if (!row) return { error: '계정을 찾을 수 없어요.' };
      db.prepare("UPDATE mail_accounts SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(on ? 1 : 0, row.id);
      log(row.id, userId, on ? '켬' : '끔', row.address);
      apply();
      return { ok: true };
    },
    // .env 계정 끄기·켜기 (끄면 새 메일을 받지 않고 그 주소로 답장도 안 보냄. 받은 메일은 메일함에 그대로)
    setEnvEnabled(source, on, userId) {
      const acc = envAccounts.find(a => a.source === source);
      if (!acc) return { error: '계정을 찾을 수 없어요.' };
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`mail_env_off_${source}`, on ? '0' : '1');
      log(null, userId, on ? '켬' : '끔', acc.user);
      apply();
      return { ok: true, address: acc.user };
    },
    // 지우기: 비밀번호는 지우고 이름만 남긴다 (받은 메일은 메일함에 그대로)
    remove(id, userId) {
      const row = findRow(id);
      if (!row) return { error: '계정을 찾을 수 없어요.' };
      db.prepare("UPDATE mail_accounts SET deleted_at = datetime('now'), pass_sealed = NULL, enabled = 0, updated_at = datetime('now') WHERE id = ?").run(row.id);
      log(row.id, userId, '지움', row.address);
      apply();
      return { ok: true };
    },
  };
}

module.exports = { createMailRegistry, loginError, SOURCE_BASE };
