// 주문 현황판 화면
//   /              현황판 (전체 · 내 작업 · 완료, 검색, 요약 칸 필터)
//   /orders/new    전화·매장·카톡 주문 직접 등록
//   /orders/:id    주문 상세: 단계 이동, 담당자·납기·메모, 완료 처리, 변경 기록
const express = require('express');
const { UserError, CHANNEL_LABELS, MANUAL_CHANNELS } = require('../orders');

function orderRoutes(service) {
  const router = express.Router();
  const flash = (req, type, message) => {
    req.session.flash = { type, message };
  };

  const findOrder = (req, res) => {
    const order = service.get(req.params.id);
    if (!order) {
      res.status(404).render('error', { title: '없는 주문', message: '주문을 찾을 수 없습니다.' });
      return null;
    }
    return order;
  };

  // 입력 오류는 안내 문구로, 나머지는 서버 오류로
  const handle = fn => (req, res, next) => {
    try {
      fn(req, res);
    } catch (err) {
      if (!(err instanceof UserError)) return next(err);
      flash(req, 'error', err.message);
      res.redirect(req.get('referer') || '/');
    }
  };

  router.get('/', (req, res) => {
    const view = ['mine', 'done'].includes(req.query.view) ? req.query.view : 'all';
    const q = String(req.query.q || '').trim().slice(0, 100);
    const filter = service.FILTERS[req.query.f] ? req.query.f : null;
    const common = { title: '주문 현황', view, q, filter, myCount: service.myCount(req.user.id) };
    if (q) return res.render('orders/board', { ...common, results: service.search(q) });
    if (view === 'done') return res.render('orders/board', { ...common, results: service.done() });
    const board = service.board({ userId: view === 'mine' ? req.user.id : null, filter });
    res.render('orders/board', { ...common, board });
  });

  router.get('/orders/new', (req, res) => {
    res.render('orders/new', {
      title: '주문 등록',
      channels: MANUAL_CHANNELS.map(key => ({ key, label: CHANNEL_LABELS[key] })),
      assignees: service.assignees(),
    });
  });

  router.post('/orders', handle((req, res) => {
    const id = service.create({ user: req.user, fields: req.body });
    flash(req, 'notice', '주문을 등록했습니다.');
    res.redirect(`/orders/${id}`);
  }));

  router.get('/orders/:id', (req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    const stages = service.stages();
    const at = stages.findIndex(s => s.id === order.stage_id);
    res.render('orders/show', {
      title: order.product_name,
      order,
      stages,
      // 다음 단계 버튼. 단계가 없거나 숨긴 단계면 첫 단계로
      next: at === -1 ? stages[0] : stages[at + 1] || null,
      assignees: service.assignees(),
      events: service.events(order.id),
    });
  });

  router.post('/orders/:id', handle((req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    const n = service.update({ user: req.user, order, fields: req.body });
    flash(req, 'notice', n ? '저장했습니다.' : '바뀐 내용이 없습니다.');
    res.redirect(`/orders/${order.id}`);
  }));

  router.post('/orders/:id/stage', handle((req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    service.moveStage({ user: req.user, order, stageId: req.body.stage_id });
    res.redirect(req.body.back === 'board' ? '/' : `/orders/${order.id}`);
  }));

  router.post('/orders/:id/done', handle((req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    service.complete({ user: req.user, order });
    flash(req, 'notice', '완료 처리했습니다. 현황판에서 빠지고 [완료] 탭에서 볼 수 있습니다.');
    res.redirect(`/orders/${order.id}`);
  }));

  router.post('/orders/:id/reopen', handle((req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    service.reopen({ user: req.user, order });
    flash(req, 'notice', '다시 열었습니다. 현황판에 다시 나타납니다.');
    res.redirect(`/orders/${order.id}`);
  }));

  return router;
}

module.exports = { orderRoutes };
