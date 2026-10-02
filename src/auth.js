// 비밀번호, 로그인 잠금, 접근 권한 검사
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 8;

// 비밀번호는 원문 대신 bcrypt 해시로만 저장한다. 해시는 되돌려 원문을 알 수 없다.
function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function validatePassword(plain) {
  if (typeof plain !== 'string' || plain.length < MIN_PASSWORD_LENGTH) {
    return `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`;
  }
  return null;
}

// 로그인 시도 결과를 판단한다.
// 반환값: { ok: true, user } 또는 { ok: false, message }
function attemptLogin(db, email, password, now = new Date()) {
  // 이메일이 없을 때와 비밀번호가 틀릴 때 같은 문구를 써서, 어떤 이메일이 가입돼 있는지 알 수 없게 한다
  const WRONG = '이메일 또는 비밀번호가 올바르지 않습니다.';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  if (!user) {
    return { ok: false, message: WRONG };
  }

  if (user.locked_until && new Date(user.locked_until) > now) {
    return { ok: false, message: `로그인에 여러 번 실패해 잠겼습니다. ${LOCK_MINUTES}분 뒤에 다시 시도하세요.` };
  }

  if (!verifyPassword(String(password || ''), user.password_hash)) {
    const failed = user.failed_logins + 1;
    if (failed >= MAX_FAILED_LOGINS) {
      const until = new Date(now.getTime() + LOCK_MINUTES * 60 * 1000).toISOString();
      db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(until, user.id);
      return { ok: false, message: `로그인에 ${MAX_FAILED_LOGINS}번 실패해 ${LOCK_MINUTES}분 동안 잠겼습니다.` };
    }
    db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(failed, user.id);
    return { ok: false, message: WRONG };
  }

  if (user.status === 'suspended' || user.status === 'rejected') {
    return { ok: false, message: '사용할 수 없는 계정입니다. 관리자에게 문의하세요.' };
  }

  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
  return { ok: true, user };
}

// 모든 요청마다 DB 에서 계정을 다시 읽는다.
// 로그인할 때만 확인하면, 정지된 직원이 이미 열어 둔 창으로 계속 쓸 수 있기 때문이다.
function loadUser(db) {
  const stmt = db.prepare(
    'SELECT u.id, u.email, u.name, u.role, u.status, j.name AS job_name ' +
    'FROM users u LEFT JOIN jobs j ON j.id = u.job_id WHERE u.id = ?'
  );
  return (req, res, next) => {
    req.user = null;
    if (req.session.userId) {
      const user = stmt.get(req.session.userId);
      if (user && (user.status === 'active' || user.status === 'pending')) {
        req.user = user;
      } else {
        // 계정이 지워졌거나 정지됨 → 즉시 로그아웃
        return req.session.destroy(() => res.redirect('/login?m=blocked'));
      }
    }
    res.locals.user = req.user;
    next();
  };
}

// 로그인 + 승인된 계정만 통과
function requireActive(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.status === 'pending') return res.redirect('/pending');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.status !== 'active' || req.user.role !== 'admin') {
    return res.status(403).render('error', { title: '권한 없음', message: '관리자만 볼 수 있는 화면입니다.' });
  }
  next();
}

// CSRF 방지: 다른 사이트가 몰래 우리 사이트로 폼을 보내지 못하게, 폼마다 비밀 토큰을 넣고 검사한다
function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (req.method === 'POST') {
    const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
    const expected = req.session.csrfToken;
    const ok = typeof sent === 'string' && sent.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
    if (!ok) {
      return res.status(403).render('error', {
        title: '요청이 만료됨',
        message: '화면이 오래 열려 있었습니다. 새로고침한 뒤 다시 시도하세요.',
      });
    }
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePassword,
  attemptLogin,
  loadUser,
  requireActive,
  requireAdmin,
  csrf,
  MAX_FAILED_LOGINS,
  LOCK_MINUTES,
};
