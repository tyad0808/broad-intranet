// 관리자 › 판매처 연결: 스마트스토어·쿠팡 API 키 넣기(연결 시험 후 저장) · 수집 켜기/끄기 · '실제로 보내기' 스위치
// 이 주소들은 app.js 에서 requireAdmin 을 거친 뒤에만 들어온다.
// 키는 암호화해서 저장하고(channelRegistry.js), 화면에는 끝 4자리만. 켤 때는 관리자 비밀번호를 다시 확인한다.
const express = require('express');

function channelRoutes(registry, { godo = null } = {}) {
  const router = express.Router();
  router.use((req, res, next) => { res.locals.navSection = 'admin'; next(); });
  const flash = (req, type, message) => { req.session.flash = { type, message }; };
  const back = '/admin/channels';
  const known = ch => registry && Object.hasOwn(registry.CHANNELS, ch);
  // 같은 판매처를 연달아 누르는 것 막기 (판매처 서버가 막을 수 있어서)
  const busy = new Set();
  const once = async (key, res, fn) => {
    if (busy.has(key)) return res.redirect(back);
    busy.add(key);
    try { return await fn(); } finally { busy.delete(key); }
  };

  router.get('/channels', (req, res) => {
    if (!registry) return res.status(404).render('error', { title: '판매처 연결', message: '이 서버에서는 판매처 연결을 쓸 수 없습니다.' });
    res.render('admin/channels', {
      title: '판매처 연결',
      tab: 'channels',
      channels: registry.view(),
      history: registry.history(),
      ready: registry.ready,
      keyProblem: registry.keyProblem,
      godo,
    });
  });

  router.post('/channels/:ch/save', (req, res, next) => {
    if (!known(req.params.ch)) return res.redirect(back);
    return once(`save${req.params.ch}`, res, async () => {
      const out = await registry.save(req.params.ch, req.body, req.user.id);
      flash(req, out.error ? 'error' : 'ok', out.error || `${registry.CHANNELS[req.params.ch].label} 키를 저장했어요. 몇 분 안에 주문과 문의가 들어와요.`);
      res.redirect(back);
    }).catch(next);
  });

  router.post('/channels/:ch/test', (req, res, next) => {
    if (!known(req.params.ch)) return res.redirect(back);
    return once(`test${req.params.ch}`, res, async () => {
      const out = await registry.test(req.params.ch, req.user.id);
      flash(req, out.error ? 'error' : 'ok', out.error || '연결 시험 성공: 판매처가 키를 받아 줬어요.');
      res.redirect(back);
    }).catch(next);
  });

  router.post('/channels/:ch/enable', (req, res) => {
    if (!known(req.params.ch)) return res.redirect(back);
    const on = req.body.on === '1';
    const out = registry.setEnabled(req.params.ch, on, req.user.id);
    flash(req, out.error ? 'error' : 'ok', out.error || (on ? '수집을 다시 켰어요.' : '수집을 껐어요. 실제로 보내기도 함께 꺼졌어요.'));
    res.redirect(back);
  });

  router.post('/channels/:ch/delete', (req, res) => {
    if (!known(req.params.ch)) return res.redirect(back);
    const out = registry.remove(req.params.ch, req.user.id);
    flash(req, out.error ? 'error' : 'ok', out.error || (out.backToEnv
      ? '키를 지웠어요. 서버를 다시 켜면 서버 설정(.env) 키로 돌아가요. 이미 가져온 주문·문의는 그대로 남아요.'
      : '키를 지웠어요. 이미 가져온 주문·문의는 그대로 남아요.'));
    res.redirect(back);
  });

  // 서버 설정(.env) 키를 관리자 화면으로 옮기기 (관리자 비밀번호 다시 확인, 연결 시험)
  router.post('/channels/:ch/adopt', (req, res, next) => {
    if (!known(req.params.ch)) return res.redirect(back);
    return once(`adopt${req.params.ch}`, res, async () => {
      const out = await registry.adopt(req.params.ch, req.body.password, req.user);
      flash(req, out.error ? 'error' : 'ok', out.error || `${registry.CHANNELS[req.params.ch].label}를 관리자 화면으로 옮겼어요. 지금 동작은 그대로이고, 이제 여기서 관리해요.`);
      res.redirect(back);
    }).catch(next);
  });

  // '실제로 보내기' 켜기 (관리자 비밀번호 다시 확인) / 끄기 (바로)
  router.post('/channels/:ch/switch', (req, res) => {
    if (!known(req.params.ch)) return res.redirect(back);
    const kind = req.body.kind === 'answer' ? 'answer' : 'write';
    const ch = req.params.ch;
    const label = `${registry.CHANNELS[ch].label} ${registry.CHANNELS[ch].switches[kind]}`;
    const out = req.body.on === '1'
      ? registry.switchOn(ch, kind, req.body.password, req.user)
      : registry.switchOff(ch, kind, req.user.id);
    flash(req, out.error ? 'error' : 'ok', out.error || (req.body.on === '1' ? `${label}: 이제 실제로 보내요.` : `${label}: 연습 모드로 바꿨어요.`));
    res.redirect(back);
  });

  return router;
}

module.exports = { channelRoutes };
