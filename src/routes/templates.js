// 자주 쓰는 답장 문구: 직원 누구나 만들고 고치고 지운다. 답장 칸 위 [문구 넣기] 로 넣는다
//   문구 안의 {고객명} {상품명} {주문번호} {회사명} 은 넣을 때 그 문의의 값으로 바뀐다 (모르는 값은 그대로 남겨 직접 고치게)
const express = require('express');

const SCOPES = { all: '메일·쇼핑몰 문의 모두', mail: '메일만', shop: '쇼핑몰 문의만' };
const VARIABLES = ['고객명', '상품명', '주문번호', '회사명'];
const MAX_TITLE = 40;
const MAX_BODY = 5000;

// 문구 안의 {이름} 을 값으로 (값이 없으면 그대로)
function fillTemplate(body, values) {
  return String(body || '').replace(/\{(고객명|상품명|주문번호|회사명)\}/g, (all, key) => (values[key] ? String(values[key]) : all));
}

// 답장 칸에서 쓸 문구 목록: 이 문의 종류(메일·쇼핑몰)에 맞는 것만, 많이 쓴 순
function templatesFor(db, kind, values) {
  return db.prepare(`
    SELECT id, title, body FROM reply_templates WHERE scope IN ('all', ?) ORDER BY use_count DESC, title
  `).all(kind).map(t => ({ id: t.id, title: t.title, body: fillTemplate(t.body, values) }));
}

function templateRoutes(db) {
  const router = express.Router();
  const flash = (req, type, message) => { req.session.flash = { type, message }; };
  const parse = body => {
    const title = String(body.title || '').trim().slice(0, MAX_TITLE);
    const text = String(body.body || '').replace(/\r\n/g, '\n').trim();
    const scope = SCOPES[body.scope] ? body.scope : 'all';
    if (!title) return { error: '문구 이름을 적어 주세요.' };
    if (!text) return { error: '문구 내용을 적어 주세요.' };
    if (text.length > MAX_BODY) return { error: `문구는 ${MAX_BODY}자까지 쓸 수 있습니다.` };
    return { title, text, scope };
  };

  router.get('/templates', (req, res) => {
    const templates = db.prepare(`
      SELECT t.*, u.name AS updated_name FROM reply_templates t LEFT JOIN users u ON u.id = t.updated_by
      ORDER BY t.use_count DESC, t.title
    `).all();
    res.render('templates', { title: '답장 문구', navSection: 'templates', templates, SCOPES, VARIABLES, edit: Number(req.query.edit) || null });
  });

  router.post('/templates', (req, res) => {
    const t = parse(req.body);
    if (t.error) { flash(req, 'error', t.error); return res.redirect('/templates'); }
    db.prepare('INSERT INTO reply_templates (title, body, scope, updated_by) VALUES (?, ?, ?, ?)').run(t.title, t.text, t.scope, req.user.id);
    flash(req, 'ok', `문구를 만들었습니다: ${t.title}`);
    res.redirect('/templates');
  });

  router.post('/templates/:id', (req, res) => {
    const t = parse(req.body);
    if (t.error) { flash(req, 'error', t.error); return res.redirect(`/templates?edit=${Number(req.params.id)}`); }
    db.prepare("UPDATE reply_templates SET title = ?, body = ?, scope = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
      .run(t.title, t.text, t.scope, req.user.id, Number(req.params.id));
    flash(req, 'ok', `문구를 고쳤습니다: ${t.title}`);
    res.redirect('/templates');
  });

  router.post('/templates/:id/delete', (req, res) => {
    db.prepare('DELETE FROM reply_templates WHERE id = ?').run(Number(req.params.id));
    flash(req, 'ok', '문구를 지웠습니다.');
    res.redirect('/templates');
  });

  // 답장 칸에 넣을 때마다 1 올린다 (많이 쓰는 문구가 위로)
  router.post('/templates/:id/used', (req, res) => {
    db.prepare('UPDATE reply_templates SET use_count = use_count + 1 WHERE id = ?').run(Number(req.params.id));
    res.status(204).end();
  });

  return router;
}

module.exports = { templateRoutes, templatesFor, fillTemplate, SCOPES, VARIABLES };
