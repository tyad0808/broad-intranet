// 회사 공지 (사용자 요청 2026-11)
//   관리자 › 공지 에서 쓰면, 직원이 인트라넷을 열 때 팝업으로 뜬다.
//   [확인했어요] 를 누르면 그 직원에게는 다시 안 뜬다 (notice_reads). 관리자는 누가 읽었는지 본다.
//   지난 공지는 /notices 에서 누구나 다시 본다.
const express = require('express');

const MAX_TITLE = 60;
const MAX_BODY = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 오늘 날짜 (한국 시간) YYYY-MM-DD
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const flash = (req, type, message) => { req.session.flash = { type, message }; };

// 지금 보여 줄 공지 조건 (기간 안)
const ACTIVE_SQL = 'n.starts_on <= ? AND (n.ends_on IS NULL OR n.ends_on >= ?)';

// 이 직원이 아직 확인 안 한 공지 중 하나 (중요한 것 먼저, 먼저 쓴 것부터) — 팝업용
function popupNotice(db, user) {
  if (!user || user.status !== 'active') return null;
  const today = kstToday();
  return db.prepare(`
    SELECT n.id, n.title, n.body, n.important, n.starts_on FROM notices n
    WHERE ${ACTIVE_SQL} AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?)
    ORDER BY n.important DESC, n.id ASC LIMIT 1
  `).get(today, today, user.id) || null;
}

// 쓴 값 확인: 제목은 꼭, 날짜는 YYYY-MM-DD, 끝나는 날은 시작보다 뒤
function readForm(body) {
  const title = String(body.title || '').trim().slice(0, MAX_TITLE);
  const text = String(body.body || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY);
  const startsOn = DATE_RE.test(String(body.starts_on || '')) ? body.starts_on : kstToday();
  const endsOn = DATE_RE.test(String(body.ends_on || '')) ? body.ends_on : null;
  if (!title) return { error: '공지 제목을 넣어 주세요.' };
  if (endsOn && endsOn < startsOn) return { error: '끝나는 날이 시작하는 날보다 앞이에요.' };
  return { title, text, startsOn, endsOn, important: body.important === '1' ? 1 : 0 };
}

// 돌아갈 주소: 이 사이트 안 주소만
function safeBack(value) {
  const v = String(value || '');
  return /^\/(?!\/)[^\s]*$/.test(v) ? v : '/home';
}

// 직원 모두: 확인 누르기, 지난 공지 보기
function noticeRoutes(db) {
  const router = express.Router();

  router.post('/notices/:id/read', (req, res) => {
    const notice = db.prepare('SELECT id FROM notices WHERE id = ?').get(Number(req.params.id));
    if (notice) db.prepare('INSERT OR IGNORE INTO notice_reads (notice_id, user_id) VALUES (?, ?)').run(notice.id, req.user.id);
    if (req.get('accept') === 'application/json') return res.json({ ok: true });
    res.redirect(safeBack(req.body.back));
  });

  router.get('/notices', (req, res) => {
    const notices = db.prepare(`
      SELECT n.*, u.name AS writer, (SELECT read_at FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?) AS my_read
      FROM notices n LEFT JOIN users u ON u.id = n.created_by
      WHERE n.starts_on <= ? ORDER BY n.starts_on DESC, n.id DESC LIMIT 50
    `).all(req.user.id, kstToday());
    res.render('notices', { title: '공지', navSection: 'home', notices, today: kstToday() });
  });

  return router;
}

// 관리자: 쓰기·고치기·지우기, 누가 읽었는지
function noticeAdminRoutes(db) {
  const router = express.Router();
  const activeStaff = () => db.prepare("SELECT id, name FROM users WHERE status = 'active' AND deleted_at IS NULL ORDER BY name").all();

  router.get('/notices', (req, res) => {
    const staff = activeStaff();
    const notices = db.prepare('SELECT n.*, u.name AS writer FROM notices n LEFT JOIN users u ON u.id = n.created_by ORDER BY n.id DESC LIMIT 50').all();
    const readsOf = db.prepare('SELECT user_id FROM notice_reads WHERE notice_id = ?');
    for (const n of notices) {
      const read = new Set(readsOf.all(n.id).map(r => r.user_id));
      n.readers = staff.filter(s => read.has(s.id));
      n.unread = staff.filter(s => !read.has(s.id));
    }
    res.render('admin/notices', { title: '공지', tab: 'notices', notices, today: kstToday(), MAX_TITLE, MAX_BODY, edit: Number(req.query.edit) || null });
  });

  router.post('/notices', (req, res) => {
    const f = readForm(req.body);
    if (f.error) { flash(req, 'error', f.error); return res.redirect('/admin/notices'); }
    db.prepare('INSERT INTO notices (title, body, important, starts_on, ends_on, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.title, f.text, f.important, f.startsOn, f.endsOn, req.user.id);
    flash(req, 'ok', f.startsOn <= kstToday() ? '공지를 올렸어요. 직원들이 인트라넷을 열면 팝업으로 떠요.' : `공지를 올렸어요. ${f.startsOn}부터 팝업으로 떠요.`);
    res.redirect('/admin/notices');
  });

  // 고치기: 내용만 바뀌고, 이미 확인한 직원에게 다시 띄우려면 '다시 보이기' 를 체크
  router.post('/notices/:id', (req, res) => {
    const n = db.prepare('SELECT id FROM notices WHERE id = ?').get(Number(req.params.id));
    if (!n) { flash(req, 'error', '공지를 찾을 수 없어요.'); return res.redirect('/admin/notices'); }
    const f = readForm(req.body);
    if (f.error) { flash(req, 'error', f.error); return res.redirect(`/admin/notices?edit=${n.id}`); }
    db.prepare("UPDATE notices SET title = ?, body = ?, important = ?, starts_on = ?, ends_on = ?, updated_at = datetime('now') WHERE id = ?")
      .run(f.title, f.text, f.important, f.startsOn, f.endsOn, n.id);
    if (req.body.reshow === '1') db.prepare('DELETE FROM notice_reads WHERE notice_id = ?').run(n.id);
    flash(req, 'ok', req.body.reshow === '1' ? '공지를 고쳤어요. 모든 직원에게 다시 팝업으로 떠요.' : '공지를 고쳤어요.');
    res.redirect('/admin/notices');
  });

  router.post('/notices/:id/delete', (req, res) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM notice_reads WHERE notice_id = ?').run(id);
    db.prepare('DELETE FROM notices WHERE id = ?').run(id);
    flash(req, 'ok', '공지를 지웠어요.');
    res.redirect('/admin/notices');
  });

  return router;
}

module.exports = { noticeRoutes, noticeAdminRoutes, popupNotice, kstToday };
