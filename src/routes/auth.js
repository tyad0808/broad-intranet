// 회원가입, 로그인, 로그아웃, 승인 대기 화면
const express = require('express');
const { hashPassword, validatePassword, attemptLogin } = require('../auth');

const LOGIN_MESSAGES = {
  blocked: '계정이 정지되었거나 사용할 수 없어 로그아웃되었습니다.',
  signedup: '가입 신청이 완료되었습니다. 관리자 승인 후 사용할 수 있습니다.',
  loggedout: '로그아웃되었습니다.',
};

function authRoutes(db) {
  const router = express.Router();

  const activeJobs = () =>
    db.prepare('SELECT id, name FROM jobs WHERE active = 1 ORDER BY sort_order').all();

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    res.render('login', { title: '로그인', error: null, notice: LOGIN_MESSAGES[req.query.m] || null, email: '' });
  });

  router.post('/login', (req, res, next) => {
    const { email, password } = req.body;
    const result = attemptLogin(db, email, password);
    if (!result.ok) {
      return res.status(401).render('login', { title: '로그인', error: result.message, notice: null, email: email || '' });
    }
    // 로그인 직후 세션 ID 를 새로 발급한다 (로그인 전 세션 ID 를 훔쳐 둔 공격을 막음)
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.userId = result.user.id;
      res.redirect(result.user.status === 'pending' ? '/pending' : '/');
    });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login?m=loggedout'));
  });

  router.get('/signup', (req, res) => {
    if (req.user) return res.redirect('/');
    res.render('signup', { title: '회원가입', error: null, form: {}, jobs: activeJobs() });
  });

  router.post('/signup', (req, res) => {
    const form = {
      email: String(req.body.email || '').trim(),
      name: String(req.body.name || '').trim(),
      job_id: Number(req.body.job_id) || null,
    };
    const password = req.body.password;
    const fail = message =>
      res.status(400).render('signup', { title: '회원가입', error: message, form, jobs: activeJobs() });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return fail('이메일 형식이 올바르지 않습니다.');
    if (!form.name) return fail('이름을 입력하세요.');
    const pwError = validatePassword(password);
    if (pwError) return fail(pwError);
    if (password !== req.body.password_confirm) return fail('비밀번호 확인이 일치하지 않습니다.');
    if (form.job_id && !activeJobs().some(j => j.id === form.job_id)) return fail('직무를 다시 선택하세요.');

    const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(form.email);
    if (exists) return fail('이미 가입된 이메일입니다.');

    // 가입 직후 상태는 항상 '승인 대기'
    db.prepare(
      "INSERT INTO users (email, password_hash, name, job_id, role, status) VALUES (?, ?, ?, ?, 'staff', 'pending')"
    ).run(form.email, hashPassword(password), form.name, form.job_id);

    // 관리자 알림용 기록 (화면에 띄우는 기능은 6단계)
    db.prepare("INSERT INTO notifications (type, message) VALUES ('signup', ?)").run(
      `${form.name}(${form.email}) 님이 가입을 신청했습니다.`
    );

    res.redirect('/login?m=signedup');
  });

  router.get('/pending', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.status !== 'pending') return res.redirect('/');
    res.render('pending', { title: '승인 대기' });
  });

  return router;
}

module.exports = { authRoutes };
