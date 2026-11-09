// 관리자 › 메일 계정: 네이버메일·지메일을 앱 비밀번호로 연결 (추가·비밀번호 바꾸기·연결 시험·끄기·지우기)
// 이 주소들은 app.js 에서 requireAdmin 을 거친 뒤에만 들어온다.
// 앱 비밀번호는 저장할 때 암호화하고(secretBox.js), 화면·기록에는 다시 내보내지 않는다.
const express = require('express');
const { loginError } = require('../inbox/mailRegistry');

function mailAccountRoutes(registry) {
  const router = express.Router();
  router.use((req, res, next) => { res.locals.navSection = 'admin'; next(); }); // 왼쪽 메뉴 '관리자' 칸 표시
  const flash = (req, type, message) => { req.session.flash = { type, message }; };
  // 같은 계정에 연결 시험을 연달아 누르는 것 막기 (메일 서버가 막을 수 있어서)
  const busy = new Set();
  const once = async (key, res, fn) => {
    if (busy.has(key)) return res.redirect('/admin/mail');
    busy.add(key);
    try { return await fn(); } finally { busy.delete(key); }
  };

  router.get('/mail', (req, res) => {
    if (!registry) return res.status(404).render('error', { title: '메일 계정', message: '이 서버에서는 메일 계정을 쓸 수 없습니다.' });
    res.render('admin/mail', {
      title: '메일 계정',
      tab: 'mail',
      accounts: registry.list(),
      history: registry.history(),
      ready: registry.ready,
      keyProblem: registry.keyProblem,
      live: registry.live,
      friendly: text => (text ? loginError({ message: text }) : ''),
    });
  });

  router.post('/mail/add', (req, res, next) => once('add', res, async () => {
    const out = await registry.add({ kind: String(req.body.kind || ''), address: req.body.address, pass: req.body.pass }, req.user.id);
    flash(req, out.error ? 'error' : 'ok', out.error || `${String(req.body.address).trim()} 를 연결했어요. 몇 분 안에 메일함으로 들어와요.`);
    res.redirect('/admin/mail');
  }).catch(next));

  router.post('/mail/:id/password', (req, res, next) => once(`pw${req.params.id}`, res, async () => {
    const out = await registry.changePassword(req.params.id, req.body.pass, req.user.id);
    flash(req, out.error ? 'error' : 'ok', out.error || '새 앱 비밀번호로 바꿨어요.');
    res.redirect('/admin/mail');
  }).catch(next));

  router.post('/mail/:id/test', (req, res, next) => once(`test${req.params.id}`, res, async () => {
    const out = await registry.test(req.params.id, req.user.id);
    flash(req, out.error ? 'error' : 'ok', out.error || '연결 시험 성공: 로그인됐어요.');
    res.redirect('/admin/mail');
  }).catch(next));

  router.post('/mail/:id/enable', (req, res) => {
    const on = req.body.on === '1';
    const out = registry.setEnabled(req.params.id, on, req.user.id);
    flash(req, out.error ? 'error' : 'ok', out.error || (on ? '다시 켰어요. 다음 받기부터 메일이 들어와요.' : '껐어요. 새 메일을 받지 않고, 답장도 보내지 않아요.'));
    res.redirect('/admin/mail');
  });

  // 서버 설정(.env) 계정 끄기·켜기 (계정 정보는 .env 그대로, 받기·답장만 멈춤)
  router.post('/mail/env/:source/enable', (req, res) => {
    const on = req.body.on === '1';
    const out = registry.setEnvEnabled(String(req.params.source), on, req.user.id);
    flash(req, out.error ? 'error' : 'ok', out.error || (on ? `${out.address} 를 다시 켰어요. 다음 받기부터 메일이 들어와요.` : `${out.address} 를 껐어요. 새 메일을 받지 않고, 이 주소로 답장도 보내지 않아요. 이미 받은 메일은 메일함에 그대로 있어요.`));
    res.redirect('/admin/mail');
  });

  router.post('/mail/:id/delete', (req, res) => {
    const out = registry.remove(req.params.id, req.user.id);
    flash(req, out.error ? 'error' : 'ok', out.error || '지웠어요. 이미 받은 메일은 메일함에 그대로 남아요.');
    res.redirect('/admin/mail');
  });

  return router;
}

module.exports = { mailAccountRoutes };
