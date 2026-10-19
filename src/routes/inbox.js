// 4차 문의함: 메일·쇼핑몰 문의를 한 목록에서 보고, 담당자를 정하고, 인트라넷에서 바로 답변한다
//
// 답변 보내기는 출처마다 따로 켠다 (메일: .env 의 MAIL_SEND=on). 꺼져 있으면 연습 모드 — 보내지 않고 기록만 남긴다.
const express = require('express');
const { transaction } = require('../db');

const TABS = { open: '미답변', mine: '내 담당', done: '답변완료', all: '전체' };
const STATUS_LABELS = { open: '미답변', answered: '답변완료', closed: '처리 완료' };
const MAX_REPLY = 10_000;

function inboxRoutes(db, { collector = null, senders = {}, sourceLabels = {}, notifier }) {
  const router = express.Router();
  const busy = new Set(); // 같은 문의에 답변을 두 번 연달아 보내는 것 방지

  const labelOf = source => sourceLabels[source] || source;
  const findInquiry = id => db.prepare(`
    SELECT q.*, u.name AS assignee_name, h.name AS handled_name FROM inquiries q
    LEFT JOIN users u ON u.id = q.assignee_id LEFT JOIN users h ON h.id = q.handled_by
    WHERE q.id = ?
  `).get(Number(id));
  const staff = () => db.prepare("SELECT id, name FROM users WHERE status = 'active' ORDER BY name").all();
  const modeOf = source => (senders[source] ? 'live' : 'practice');
  const bump = id => db.prepare("UPDATE inquiries SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(id);
  const back = req => safeBack(req.body.back || req.query.back);
  const selfUrl = (id, b) => `/inbox/${Number(id)}${b !== '/inbox' ? `?back=${encodeURIComponent(b)}` : ''}`;
  const flashTo = (req, res, url, type, message) => {
    req.session.flash = { type, message };
    res.redirect(url);
  };

  // ───────── 목록 ─────────
  router.get('/inbox', (req, res) => {
    const tab = TABS[req.query.tab] ? req.query.tab : 'open';
    const src = String(req.query.src || '');
    const q = String(req.query.q || '').trim().slice(0, 50);

    const base = [];
    const params = [];
    if (q) {
      base.push('(q.subject LIKE ? OR q.body LIKE ? OR q.from_name LIKE ? OR q.from_addr LIKE ?)');
      params.push(...Array(4).fill(`%${q}%`));
    }
    const tabWhere = {
      open: ["q.status = 'open'"],
      mine: ["q.status = 'open'", 'q.assignee_id = ?'],
      done: ["q.status IN ('answered', 'closed')"],
      all: [],
    };
    const tabParams = { mine: [req.user.id] };
    const whereSql = list => (list.length ? 'WHERE ' + list.join(' AND ') : '');

    // 탭 건수 (출처 칩 조건 포함), 출처 칩 건수 (탭 조건 포함)
    const srcWhere = src ? ['q.source = ?'] : [];
    const srcParams = src ? [src] : [];
    const tabCounts = {};
    for (const key of Object.keys(TABS)) {
      tabCounts[key] = db.prepare(`SELECT COUNT(*) AS n FROM inquiries q ${whereSql([...base, ...srcWhere, ...tabWhere[key]])}`)
        .get(...params, ...srcParams, ...(tabParams[key] || [])).n;
    }
    const sourceCounts = Object.fromEntries(db.prepare(`
      SELECT q.source, COUNT(*) AS n FROM inquiries q ${whereSql([...base, ...tabWhere[tab]])} GROUP BY q.source
    `).all(...params, ...(tabParams[tab] || [])).map(r => [r.source, r.n]));
    const sources = [...new Set([...Object.keys(sourceLabels), ...Object.keys(sourceCounts)])];

    const rows = db.prepare(`
      SELECT q.id, q.source, q.from_name, q.from_addr, q.subject, substr(q.body, 1, 160) AS preview, q.received_at,
        q.status, q.assignee_id, q.attachments, u.name AS assignee_name
      FROM inquiries q LEFT JOIN users u ON u.id = q.assignee_id
      ${whereSql([...base, ...srcWhere, ...tabWhere[tab]])}
      ORDER BY q.received_at DESC, q.id DESC LIMIT 300
    `).all(...params, ...srcParams, ...(tabParams[tab] || []));

    let lastRun = null;
    try { lastRun = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'inbox_last_run'").get() || {}).value || 'null'); } catch { lastRun = null; }

    res.render('inbox/list', {
      title: '문의함',
      navSection: 'inbox',
      rows, tab, TABS, tabCounts, src, sources, sourceCounts, q, labelOf, STATUS_LABELS,
      staff: staff(),
      canCollect: Boolean(collector),
      noSources: Object.keys(sourceLabels).length === 0,
      lastRun,
      currentUrl: req.originalUrl,
      modes: Object.fromEntries(Object.keys(sourceLabels).map(s => [s, modeOf(s)])),
    });
  });

  // 지금 받기
  router.post('/inbox/collect', async (req, res, next) => {
    try {
      const b = back(req);
      if (!collector) return flashTo(req, res, b, 'error', '연결된 메일이 없습니다. .env 에 메일 계정을 넣어 주세요.');
      const r = await collector.run();
      const parts = [`새 문의 ${r.created}건`];
      if (r.answered) parts.push(`메일 사이트에서 답장한 ${r.answered}건은 답변완료로`);
      if (r.ok) return flashTo(req, res, b, 'ok', `받기 완료: ${parts.join(', ')}.`);
      flashTo(req, res, b, 'error', `일부를 받지 못했습니다 — ${r.errors.join(' / ')} (${parts.join(', ')})`);
    } catch (e) {
      next(e);
    }
  });

  // 여러 건 '처리 완료' (광고·알림 메일처럼 답변이 필요 없는 것)
  router.post('/inbox/bulk/close', (req, res) => {
    const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean).slice(0, 300);
    const b = back(req);
    if (!ids.length) return flashTo(req, res, b, 'error', '처리할 문의를 체크해 주세요.');
    const marks = ids.map(() => '?').join(',');
    const n = db.prepare(`
      UPDATE inquiries SET status = 'closed', handled_by = ?, handled_at = datetime('now'), version = version + 1, updated_at = datetime('now')
      WHERE id IN (${marks}) AND status = 'open'
    `).run(req.user.id, ...ids).changes;
    notifier.inboxChanged(ids, req.user.id);
    flashTo(req, res, b, 'ok', `${n}건을 처리 완료로 바꿨습니다.`);
  });

  // ───────── 문의 하나 ─────────
  router.get('/inbox/:id', (req, res) => {
    const inquiry = findInquiry(req.params.id);
    if (!inquiry) return res.status(404).render('error', { title: '없는 문의', message: '문의를 찾을 수 없습니다.' });
    let attachments = [];
    try { attachments = JSON.parse(inquiry.attachments || '[]'); } catch { attachments = []; }
    const replies = db.prepare(`
      SELECT r.*, u.name AS user_name FROM inquiry_replies r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.inquiry_id = ? ORDER BY r.id
    `).all(inquiry.id);
    res.render('inbox/detail', {
      title: inquiry.subject || '문의',
      navSection: 'inbox',
      inquiry, attachments, replies, staff: staff(),
      label: labelOf(inquiry.source),
      mode: modeOf(inquiry.source),
      STATUS_LABELS,
      back: safeBack(req.query.back),
    });
  });

  // 답변 보내기
  router.post('/inbox/:id/reply', async (req, res, next) => {
    const b = back(req);
    const inquiry = findInquiry(req.params.id);
    if (!inquiry) return flashTo(req, res, b, 'error', '문의를 찾을 수 없습니다.');
    const url = selfUrl(inquiry.id, b);
    const body = String(req.body.body || '').replace(/\r\n/g, '\n').trim();
    if (!body) return flashTo(req, res, url, 'error', '답변 내용을 적어 주세요.');
    if (body.length > MAX_REPLY) return flashTo(req, res, url, 'error', `답변은 ${MAX_REPLY.toLocaleString()}자까지 쓸 수 있습니다.`);
    if (Number(req.body.version) !== inquiry.version) {
      return flashTo(req, res, url, 'error', '그사이 다른 직원이 이 문의를 바꿨습니다. 바뀐 내용을 확인하고 다시 보내 주세요.');
    }
    if (busy.has(inquiry.id)) return flashTo(req, res, url, 'error', '이미 보내는 중입니다. 잠시 후 새로고침해 보세요.');
    busy.add(inquiry.id);
    try {
      const sender = senders[inquiry.source];
      const out = sender
        ? await sender.reply(inquiry, body)
        : { result: 'practice', message: `연습 모드라 ${labelOf(inquiry.source)}로 보내지 않았습니다.` };
      transaction(db, () => {
        db.prepare('INSERT INTO inquiry_replies (inquiry_id, user_id, body, mode, result, message) VALUES (?, ?, ?, ?, ?, ?)')
          .run(inquiry.id, req.user.id, body, sender ? 'live' : 'practice', out.result, out.message);
        if (out.result === 'ok') {
          db.prepare("UPDATE inquiries SET status = 'answered', handled_by = ?, handled_at = datetime('now') WHERE id = ?")
            .run(req.user.id, inquiry.id);
        }
        bump(inquiry.id);
      });
      notifier.inboxChanged([inquiry.id], req.user.id);
      const type = out.result === 'ok' ? 'ok' : out.result === 'practice' ? 'warn' : 'error';
      flashTo(req, res, url, type, out.message);
    } catch (e) {
      next(e);
    } finally {
      busy.delete(inquiry.id);
    }
  });

  // 담당자 지정
  router.post('/inbox/:id/assign', (req, res) => {
    const b = back(req);
    const inquiry = findInquiry(req.params.id);
    if (!inquiry) return flashTo(req, res, b, 'error', '문의를 찾을 수 없습니다.');
    const assignee = req.body.assignee_id ? Number(req.body.assignee_id) : null;
    if (assignee && !staff().some(s => s.id === assignee)) return flashTo(req, res, b, 'error', '지정할 수 없는 직원입니다.');
    db.prepare('UPDATE inquiries SET assignee_id = ? WHERE id = ?').run(assignee, inquiry.id);
    bump(inquiry.id);
    notifier.inboxChanged([inquiry.id], req.user.id);
    if (assignee && assignee !== req.user.id) {
      notifier.notify('new_inquiry', {
        title: '문의 담당 지정', body: `${req.user.name} 님이 '${inquiry.subject}' 문의를 맡겼습니다.`, url: `/inbox/${inquiry.id}`,
      }, userId => userId === assignee);
    }
    res.redirect(req.body.from === 'detail' ? selfUrl(inquiry.id, b) : b);
  });

  // 처리 완료 (답변 필요 없음) / 다시 열기
  for (const [action, to, from, message] of [
    ['close', 'closed', 'open', '처리 완료로 바꿨습니다.'],
    ['reopen', 'open', null, '다시 미답변으로 돌렸습니다.'],
  ]) {
    router.post(`/inbox/:id/${action}`, (req, res) => {
      const b = back(req);
      const inquiry = findInquiry(req.params.id);
      if (!inquiry) return flashTo(req, res, b, 'error', '문의를 찾을 수 없습니다.');
      if (from && inquiry.status !== from) return flashTo(req, res, selfUrl(inquiry.id, b), 'error', '미답변 문의만 처리 완료로 바꿀 수 있습니다.');
      db.prepare(`UPDATE inquiries SET status = ?, handled_by = ?, handled_at = ${to === 'open' ? 'NULL' : "datetime('now')"} WHERE id = ?`)
        .run(to, to === 'open' ? null : req.user.id, inquiry.id);
      bump(inquiry.id);
      notifier.inboxChanged([inquiry.id], req.user.id);
      flashTo(req, res, selfUrl(inquiry.id, b), 'ok', message);
    });
  }

  return router;
}

// 돌아갈 주소는 문의함 목록만 허용
function safeBack(value) {
  const v = String(value || '');
  return /^\/inbox(\?[^\s]*)?$/.test(v) ? v : '/inbox';
}

module.exports = { inboxRoutes, TABS };
