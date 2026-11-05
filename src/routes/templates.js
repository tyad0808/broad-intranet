// 자주 쓰는 답장 문구: 직원 누구나 만들고 고치고 지운다. 답장 칸 위 [문구 넣기] 로 넣는다
//   문구 안의 {고객명} {상품명} {주문번호} {회사명} 은 넣을 때 그 문의의 값으로 바뀐다 (모르는 값은 그대로 남겨 직접 고치게)
const express = require('express');
const { isManager } = require('../auth');
const { CATEGORIES, OTHER, groupByCategory, parseMacroWorkbook, previewUpload, applyUpload, exportWorkbook, rememberDeleted } = require('../macros');

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
    const category = categories().includes(body.category) ? body.category : null;
    const hint = String(body.usage_hint || '').replace(/\s+/g, ' ').trim().slice(0, MAX_HINT) || null;
    const subject = String(body.mail_subject || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SUBJECT) || null;
    if (!title) return { error: '문구 이름을 적어 주세요.' };
    if (!text) return { error: '문구 내용을 적어 주세요.' };
    if (text.length > MAX_BODY) return { error: `문구는 ${MAX_BODY}자까지 쓸 수 있습니다.` };
    return { title, text, scope, category, hint, subject };
  };
  // 관리자 화면 탭은 관리자만, 엑셀 올리기·받기·사용 횟수 순은 관리자·부관리자
  const isAdmin = req => req.user && req.user.role === 'admin';
  const canManage = req => isManager(req.user);
  // 고를 수 있는 카테고리: 정해진 8개 + 엑셀로 새로 생긴 것
  const categories = () => [...new Set([...CATEGORIES,
    ...db.prepare("SELECT DISTINCT category FROM reply_templates WHERE category IS NOT NULL AND category != '' ORDER BY category").all().map(r => r.category)])];
  const adminOnly = (req, res) => {
    if (canManage(req)) return false;
    res.status(403).render('error', { title: '권한 없음', message: '관리자·부관리자만 쓸 수 있습니다.' });
    return true;
  };

  router.get('/templates', (req, res) => {
    const templates = db.prepare(`
      SELECT t.*, u.name AS updated_name FROM reply_templates t LEFT JOIN users u ON u.id = t.updated_by
      ORDER BY ${LIST_ORDER.replace(/(macro_no|use_count|title)/g, 't.$1')}
    `).all();
    // 관리자: '사용 횟수 순' 으로 보기 (1~2달 뒤 점검용)
    const byUsage = canManage(req) && req.query.sort === 'usage'
      ? [...templates].sort((a, b) => b.use_count - a.use_count || String(b.last_used_at || '').localeCompare(String(a.last_used_at || '')) || (a.macro_no ?? 1e9) - (b.macro_no ?? 1e9))
      : null;
    res.render('templates', { title: '답장 문구', navSection: isAdmin(req) ? 'admin' : 'templates', templates, groups: groupByCategory(templates), SCOPES, VARIABLES,
      CATEGORIES: categories(), OTHER, edit: Number(req.query.edit) || null, isAdmin: isAdmin(req), canManage: canManage(req), byUsage });
  });

  router.post('/templates', (req, res) => {
    const t = parse(req.body);
    if (t.error) { flash(req, 'error', t.error); return res.redirect('/templates'); }
    db.prepare('INSERT INTO reply_templates (title, body, scope, category, usage_hint, mail_subject, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.title, t.text, t.scope, t.category, t.hint, t.subject, req.user.id);
    flash(req, 'ok', `문구를 만들었습니다: ${t.title}`);
    res.redirect('/templates');
  });

  // ───────── 엑셀 받기 · 올리기 (관리자) ─────────
  // 받기: 지금 매크로 전부 (올리기와 같은 모양 + 사용 횟수·마지막 사용일)
  router.get('/templates/export.xlsx', (req, res) => {
    if (adminOnly(req, res)) return;
    const day = res.app.locals.kst(new Date().toISOString()).slice(0, 10);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="macros-${day}.xlsx"; filename*=UTF-8''${encodeURIComponent(`브로애드_CS매크로_${day}.xlsx`)}`,
      'Cache-Control': 'no-store',
    });
    res.send(exportWorkbook(db, res.app.locals.kst));
  });
  // 올리기 ①: 엑셀을 읽어 로그인 정보(세션)에 잠깐 들고 있다가 미리보기로 (아직 아무것도 바꾸지 않음)
  router.post('/templates/upload', (req, res) => {
    if (adminOnly(req, res)) return;
    const file = (req.files || [])[0];
    const r = req.uploadError ? { error: '엑셀 파일이 너무 커요.' } : parseMacroWorkbook(file && file.content);
    if (r.error) { flash(req, 'error', r.error); return res.redirect('/templates'); }
    req.session.macroUpload = { macros: r.macros, problems: r.problems, sheet: r.sheet, name: file.name };
    res.redirect('/templates/upload');
  });
  router.get('/templates/upload', (req, res) => {
    if (adminOnly(req, res)) return;
    const up = req.session.macroUpload;
    if (!up) { flash(req, 'error', '올린 엑셀이 없어요. 다시 올려 주세요.'); return res.redirect('/templates'); }
    res.render('templates-upload', { title: '엑셀 올리기 미리보기', navSection: isAdmin(req) ? 'admin' : 'templates', isAdmin: isAdmin(req), up, preview: previewUpload(db, up.macros) });
  });
  // 올리기 ②: 체크한 것만 반영 (새로 추가 · 고침). 엑셀에 없는 매크로·예전 문구는 그대로
  router.post('/templates/upload/apply', (req, res) => {
    if (adminOnly(req, res)) return;
    const up = req.session.macroUpload;
    if (!up) { flash(req, 'error', '올린 엑셀이 없어요. 다시 올려 주세요.'); return res.redirect('/templates'); }
    const pick = k => [].concat(req.body[k] || []).map(Number).filter(Number.isInteger);
    const r = applyUpload(db, up.macros, { add: pick('add'), update: pick('update'), userId: req.user.id });
    delete req.session.macroUpload;
    flash(req, 'ok', r.added || r.updated ? `엑셀을 반영했습니다: 새로 추가 ${r.added}개 · 고침 ${r.updated}개` : '바뀐 매크로가 없습니다.');
    res.redirect('/templates');
  });
  router.post('/templates/upload/cancel', (req, res) => {
    delete req.session.macroUpload;
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
    const row = db.prepare('SELECT macro_no FROM reply_templates WHERE id = ?').get(Number(req.params.id));
    db.prepare('DELETE FROM reply_templates WHERE id = ?').run(Number(req.params.id));
    if (row && row.macro_no !== null) rememberDeleted(db, row.macro_no); // 엑셀을 다시 올려도 기본으로 다시 넣지 않게
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
