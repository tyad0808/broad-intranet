// 자주 쓰는 답장 문구: 직원 누구나 만들고 고치고 지운다. 답장 칸 위 [문구 넣기] 로 넣는다
//   문구 안의 {고객명} {상품명} {주문번호} {회사명} 은 넣을 때 그 문의의 값으로 바뀐다 (모르는 값은 그대로 남겨 직접 고치게)
const express = require('express');
const { CATEGORIES, OTHER, groupByCategory, previewImport, importMacros, loadV1 } = require('../macros');

const SCOPES = { all: '메일·쇼핑몰 문의 모두', mail: '메일만', shop: '쇼핑몰 문의만' };
const VARIABLES = ['고객명', '상품명', '주문번호', '회사명'];
const MAX_TITLE = 40;
const MAX_BODY = 5000;
const MAX_HINT = 60;
const MAX_SUBJECT = 100;

// 문구 안의 {이름} 을 값으로 (값이 없으면 그대로)
function fillTemplate(body, values) {
  return String(body || '').replace(/\{(고객명|상품명|주문번호|회사명)\}/g, (all, key) => (values[key] ? String(values[key]) : all));
}

// 목록 순서: 엑셀 번호 순 (카테고리 안에서 업무 흐름 순서), 번호 없는 예전 문구는 많이 쓴 순
const LIST_ORDER = 'macro_no IS NULL, macro_no, use_count DESC, title';

// 답장 칸에서 쓸 문구 목록: 이 문의 종류(메일·쇼핑몰)에 맞는 것만, 카테고리별로 묶어서
function templatesFor(db, kind, values) {
  const list = db.prepare(`
    SELECT id, title, body, category, usage_hint, mail_subject FROM reply_templates WHERE scope IN ('all', ?) ORDER BY ${LIST_ORDER}
  `).all(kind).map(t => ({ id: t.id, title: t.title, body: fillTemplate(t.body, values), category: t.category, hint: t.usage_hint || '', subject: t.mail_subject || '' }));
  return groupByCategory(list);
}

function templateRoutes(db) {
  const router = express.Router();
  const flash = (req, type, message) => { req.session.flash = { type, message }; };
  const parse = body => {
    const title = String(body.title || '').trim().slice(0, MAX_TITLE);
    const text = String(body.body || '').replace(/\r\n/g, '\n').trim();
    const scope = SCOPES[body.scope] ? body.scope : 'all';
    const category = CATEGORIES.includes(body.category) ? body.category : null;
    const hint = String(body.usage_hint || '').replace(/\s+/g, ' ').trim().slice(0, MAX_HINT) || null;
    const subject = String(body.mail_subject || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SUBJECT) || null;
    if (!title) return { error: '문구 이름을 적어 주세요.' };
    if (!text) return { error: '문구 내용을 적어 주세요.' };
    if (text.length > MAX_BODY) return { error: `문구는 ${MAX_BODY}자까지 쓸 수 있습니다.` };
    return { title, text, scope, category, hint, subject };
  };
  const isAdmin = req => req.user && req.user.role === 'admin';

  router.get('/templates', (req, res) => {
    const templates = db.prepare(`
      SELECT t.*, u.name AS updated_name FROM reply_templates t LEFT JOIN users u ON u.id = t.updated_by
      ORDER BY ${LIST_ORDER.replace(/(macro_no|use_count|title)/g, 't.$1')}
    `).all();
    // 관리자에게만: CS 매크로 v1 중 아직 안 가져온 개수 (가져오기 버튼)
    const preview = isAdmin(req) ? previewImport(db) : [];
    const v1Left = { fresh: preview.filter(p => p.status === 'new').length, overlap: preview.filter(p => p.status === 'overlap').length };
    res.render('templates', { title: '답장 문구', navSection: 'templates', templates, groups: groupByCategory(templates), SCOPES, VARIABLES,
      CATEGORIES, OTHER, edit: Number(req.query.edit) || null, isAdmin: isAdmin(req), v1Left });
  });

  router.post('/templates', (req, res) => {
    const t = parse(req.body);
    if (t.error) { flash(req, 'error', t.error); return res.redirect('/templates'); }
    db.prepare('INSERT INTO reply_templates (title, body, scope, category, usage_hint, mail_subject, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.title, t.text, t.scope, t.category, t.hint, t.subject, req.user.id);
    flash(req, 'ok', `문구를 만들었습니다: ${t.title}`);
    res.redirect('/templates');
  });

  // CS 매크로 v1 가져오기 (관리자): ① 미리보기 — 새것 / 기존과 겹쳐 보이는 것 / 이미 가져온 것
  router.get('/templates/import', (req, res) => {
    if (!isAdmin(req)) return res.status(403).render('error', { title: '권한 없음', message: '관리자만 가져올 수 있습니다.' });
    const rows = previewImport(db);
    res.render('templates-import', { title: 'CS 매크로 가져오기', navSection: 'templates', rows, version: loadV1().version, CATEGORIES });
  });
  // ② 가져오기 — 새것은 모두, 겹치는 것은 체크한 것만. 기존 문구는 그대로
  router.post('/templates/import', (req, res) => {
    if (!isAdmin(req)) return res.status(403).render('error', { title: '권한 없음', message: '관리자만 가져올 수 있습니다.' });
    const force = [].concat(req.body.force || []).map(Number).filter(Number.isInteger);
    const n = importMacros(db, { force, userId: req.user.id });
    flash(req, 'ok', n ? `CS 매크로 ${n}개를 더했습니다. 기존 문구는 그대로예요.` : '더할 매크로가 없습니다.');
    res.redirect('/templates');
  });

  router.post('/templates/:id', (req, res) => {
    const t = parse(req.body);
    if (t.error) { flash(req, 'error', t.error); return res.redirect(`/templates?edit=${Number(req.params.id)}`); }
    db.prepare(`UPDATE reply_templates SET title = ?, body = ?, scope = ?, category = ?, usage_hint = ?, mail_subject = ?, updated_by = ?,
      updated_at = datetime('now') WHERE id = ?`)
      .run(t.title, t.text, t.scope, t.category, t.hint, t.subject, req.user.id, Number(req.params.id));
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
    db.prepare("UPDATE reply_templates SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?").run(Number(req.params.id));
    res.status(204).end();
  });

  return router;
}

module.exports = { templateRoutes, templatesFor, fillTemplate, SCOPES, VARIABLES };
