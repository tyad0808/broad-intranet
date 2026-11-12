// 휴가 (월차·연차)
//   /leave        직원 모두: 휴가 신청·취소, 내 남은 휴가 보기
//   /admin/leave  관리자·부관리자: 승인·반려, 직원별 입사일·남은 휴가, 일수 직접 조정 (관리자 › 직원·회사 › 휴가 관리)
//                 부관리자도 들어와야 해서 다른 관리자 화면(관리자만)보다 먼저 연결한다 (app.js)
//   승인하면 회사 일정(달력)에 '이름 휴가' · '이름 오전 반차' 를 저절로 올리고, 승인을 취소하면 지운다
const express = require('express');
const { isManager } = require('../auth');
const { KINDS, readRequest, summaryOf, fmtDays, isDate, kstToday, yearlyModeOf } = require('../leave');

const STATUS = { pending: '승인 대기', approved: '승인', rejected: '반려', canceled: '취소' };
const flash = (req, type, message) => { req.session.flash = { type, message }; };

function leaveRoutes(db, notifier) {
  const router = express.Router();
  const staffList = () => db.prepare(`
    SELECT u.id, u.name, u.nickname, u.hire_date, j.name AS job_name FROM users u LEFT JOIN jobs j ON j.id = u.job_id
    WHERE u.status = 'active' AND u.deleted_at IS NULL ORDER BY u.name
  `).all();
  const findRequest = id => db.prepare(`
    SELECT r.*, u.name AS user_name FROM leave_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?
  `).get(Number(id));
  const requestRows = (where, params) => db.prepare(`
    SELECT r.*, u.name AS user_name, d.name AS decider FROM leave_requests r
    JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.decided_by
    WHERE ${where} ORDER BY r.start_date DESC, r.id DESC LIMIT 100
  `).all(...params);

  // 알림: 신청은 관리자·부관리자에게, 결과는 신청한 직원에게 (화면 오른쪽 아래 + 윈도우 알림)
  const isManagerId = id => {
    const u = db.prepare("SELECT role, sub_admin FROM users WHERE id = ? AND status = 'active'").get(id);
    return Boolean(u) && (u.role === 'admin' || Boolean(u.sub_admin));
  };
  const send = (payload, canReceive) => { if (notifier && notifier.notify) notifier.notify('leave', payload, canReceive); };

  const dateText = r => (r.start_date === r.end_date ? r.start_date : `${r.start_date} ~ ${r.end_date}`);
  const eventTitle = r => `${r.user_name} ${r.kind === 'full' ? '휴가' : KINDS[r.kind]}`;

  router.get('/leave', (req, res) => {
    const today = kstToday();
    const me = summaryOf(db, { ...req.user, hire_date: (db.prepare('SELECT hire_date FROM users WHERE id = ?').get(req.user.id) || {}).hire_date }, today);
    const mine = requestRows('r.user_id = ?', [req.user.id]);
    const waitingCount = isManager(req.user) ? db.prepare("SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending'").get().n : 0;
    res.render('leave', { title: '휴가', navSection: 'leave', me, mine, KINDS, STATUS, fmtDays, today, manager: isManager(req.user), waitingCount, dateText, yearlyMode: yearlyModeOf(db) });
  });

  // 관리 화면 (관리자·부관리자)
  router.get('/admin/leave', (req, res, next) => (isManager(req.user) ? next() : res.status(403).render('error', { title: '권한 없음', message: '관리자·부관리자만 볼 수 있는 화면입니다.' })), (req, res) => {
    const today = kstToday();
    const staff = staffList().map(u => ({ ...u, sum: summaryOf(db, u, today) }));
    res.render('admin/leave', {
      title: '휴가 관리', tab: 'leave', navSection: req.user.role === 'admin' ? 'admin' : 'leave',
      KINDS, STATUS, fmtDays, today, dateText, staff, yearlyMode: yearlyModeOf(db),
      waiting: requestRows("r.status = 'pending'", []).reverse(), // 먼저 신청한 것부터
      recent: requestRows("r.status != 'pending' AND r.start_date >= ?", [`${today.slice(0, 4)}-01-01`]),
      adjusts: db.prepare(`
        SELECT a.*, u.name AS user_name, c.name AS creator FROM leave_adjust a JOIN users u ON u.id = a.user_id
        LEFT JOIN users c ON c.id = a.created_by ORDER BY a.id DESC LIMIT 30
      `).all(),
    });
  });

  // 신청
  router.post('/leave', (req, res) => {
    const f = readRequest(req.body);
    if (f.error) { flash(req, 'error', f.error); return res.redirect('/leave'); }
    const overlap = db.prepare(`
      SELECT 1 FROM leave_requests WHERE user_id = ? AND status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?
    `).get(req.user.id, f.end, f.start);
    if (overlap) { flash(req, 'error', '그 날짜에 이미 신청한 휴가가 있어요. 신청 내역을 확인해 주세요.'); return res.redirect('/leave'); }
    // 남은 휴가 안에서만 (승인 대기 중인 것도 빼고 센다) — 사용자 요청 2026-11
    const me = summaryOf(db, { id: req.user.id, hire_date: (db.prepare('SELECT hire_date FROM users WHERE id = ?').get(req.user.id) || {}).hire_date });
    const canUse = me.left - me.pending;
    if (f.days > canUse) {
      flash(req, 'error', `남은 휴가가 ${fmtDays(Math.max(0, canUse))}일이라 ${fmtDays(f.days)}일은 신청할 수 없어요.${me.pending ? ` (승인 대기 ${fmtDays(me.pending)}일 포함)` : ''} 관리자에게 문의해 주세요.`);
      return res.redirect('/leave');
    }
    db.prepare('INSERT INTO leave_requests (user_id, start_date, end_date, kind, days, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, f.start, f.end, f.kind, f.days, f.reason || null);
    const when = f.start === f.end ? f.start : `${f.start} ~ ${f.end}`;
    send({ title: '휴가 신청', body: `${req.user.name} · ${when} ${KINDS[f.kind]} (${fmtDays(f.days)}일)`, url: '/admin/leave' }, isManagerId);
    flash(req, 'ok', `휴가를 신청했어요 (${fmtDays(f.days)}일). 관리자가 승인하면 알려 드려요.`);
    res.redirect('/leave');
  });

  // 취소: 본인은 승인 대기 중인 것만, 관리자·부관리자는 승인된 것도 (달력 일정도 지운다)
  router.post('/leave/:id/cancel', (req, res) => {
    const r = findRequest(req.params.id);
    const manager = isManager(req.user);
    const mineWaiting = r && r.user_id === req.user.id && r.status === 'pending';
    const managerCan = r && manager && (r.status === 'pending' || r.status === 'approved');
    if (!mineWaiting && !managerCan) { flash(req, 'error', '취소할 수 없는 신청이에요. 승인된 휴가는 관리자에게 취소를 부탁해 주세요.'); return res.redirect('/leave'); }
    if (r.event_id) db.prepare('DELETE FROM events WHERE id = ?').run(r.event_id);
    db.prepare("UPDATE leave_requests SET status = 'canceled', event_id = NULL, decided_by = COALESCE(decided_by, ?), decided_at = datetime('now') WHERE id = ?").run(req.user.id, r.id);
    if (r.event_id && notifier && notifier.calendarChanged) notifier.calendarChanged(req.user.id);
    if (r.user_id !== req.user.id) send({ title: '휴가가 취소됐어요', body: `${dateText(r)} ${KINDS[r.kind]} · ${req.user.name}`, url: '/leave' }, id => id === r.user_id);
    flash(req, 'ok', '휴가 신청을 취소했어요.');
    res.redirect(r.user_id === req.user.id ? '/leave' : '/admin/leave');
  });

  // ── 아래는 관리자·부관리자만 ──
  const managerOnly = (req, res, next) => (isManager(req.user) ? next() : res.status(403).render('error', { title: '권한 없음', message: '관리자·부관리자만 할 수 있어요.' }));

  router.post('/leave/:id/approve', managerOnly, (req, res) => {
    const r = findRequest(req.params.id);
    if (!r || r.status !== 'pending') { flash(req, 'error', '이미 처리된 신청이에요.'); return res.redirect('/admin/leave'); }
    const ev = db.prepare("INSERT INTO events (title, start_date, end_date, time, memo, color, created_by) VALUES (?, ?, ?, NULL, NULL, 'green', ?)")
      .run(eventTitle(r), r.start_date, r.end_date === r.start_date ? null : r.end_date, req.user.id);
    db.prepare("UPDATE leave_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decide_note = ?, event_id = ? WHERE id = ?")
      .run(req.user.id, String(req.body.note || '').trim().slice(0, 200) || null, Number(ev.lastInsertRowid), r.id);
    if (notifier && notifier.calendarChanged) notifier.calendarChanged(req.user.id);
    send({ title: '휴가가 승인됐어요', body: `${dateText(r)} ${KINDS[r.kind]} · ${req.user.name}`, url: '/leave' }, id => id === r.user_id);
    flash(req, 'ok', `${r.user_name} 님의 휴가를 승인했어요. 회사 일정에도 올렸어요.`);
    res.redirect('/admin/leave');
  });

  router.post('/leave/:id/reject', managerOnly, (req, res) => {
    const r = findRequest(req.params.id);
    if (!r || r.status !== 'pending') { flash(req, 'error', '이미 처리된 신청이에요.'); return res.redirect('/admin/leave'); }
    const note = String(req.body.note || '').trim().slice(0, 200);
    db.prepare("UPDATE leave_requests SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decide_note = ? WHERE id = ?").run(req.user.id, note || null, r.id);
    send({ title: '휴가가 반려됐어요', body: `${dateText(r)} ${KINDS[r.kind]}${note ? ` · ${note}` : ''}`, url: '/leave' }, id => id === r.user_id);
    flash(req, 'ok', `${r.user_name} 님의 휴가를 반려했어요.`);
    res.redirect('/admin/leave');
  });

  // 입사일 (휴가 일수 계산의 기준)
  router.post('/leave/hire/:userId', managerOnly, (req, res) => {
    const u = db.prepare("SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL").get(Number(req.params.userId));
    const date = String(req.body.hire_date || '');
    if (!u || (date && !isDate(date)) || (date && date > kstToday())) { flash(req, 'error', '입사일을 다시 확인해 주세요 (오늘보다 뒤는 안 돼요).'); return res.redirect('/admin/leave#staff'); }
    db.prepare('UPDATE users SET hire_date = ? WHERE id = ?').run(date || null, u.id);
    flash(req, 'ok', date ? `${u.name} 님 입사일을 ${date}로 저장했어요.` : `${u.name} 님 입사일을 지웠어요.`);
    res.redirect('/admin/leave#staff');
  });

  // 지금 남은 일수 맞추기: 관리자가 적은 일수가 되도록 조정 기록을 남긴다 (앞으로 생기는 휴가는 여기에 더해진다)
  router.post('/leave/left/:userId', managerOnly, (req, res) => {
    const u = db.prepare('SELECT id, name, hire_date FROM users WHERE id = ? AND deleted_at IS NULL').get(Number(req.params.userId));
    const target = Number(req.body.left);
    if (!u || String(req.body.left || '').trim() === '' || !Number.isFinite(target) || target < 0 || target > 200 || Math.round(target * 2) !== target * 2) {
      flash(req, 'error', '남은 일수를 0.5일 단위로 적어 주세요 (예: 5 또는 2.5).');
      return res.redirect('/admin/leave#staff');
    }
    db.prepare('INSERT INTO leave_baseline (user_id, left_days, set_on, created_by) VALUES (?, ?, ?, ?)').run(u.id, target, kstToday(), req.user.id);
    flash(req, 'ok', `${u.name} 님 남은 휴가를 ${fmtDays(target)}일로 맞췄어요. 앞으로 생기는 휴가는 여기에 더해져요.`);
    res.redirect('/admin/leave#staff');
  });

  // 1년 이상 직원 휴가: 법 기준 자동(legal) 또는 관리자가 매년 직접(manual)
  router.post('/leave/yearly', managerOnly, (req, res) => {
    const mode = req.body.mode === 'manual' ? 'manual' : 'legal';
    db.prepare("INSERT INTO settings (key, value) VALUES ('leave_yearly_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(mode);
    flash(req, 'ok', mode === 'legal' ? '1년 이상 직원은 근로기준법 기준으로 입사일마다 저절로 생겨요 (15일부터, 최대 25일).' : '1년 이상 직원은 자동으로 안 더해요. 매년 남은 일수를 직접 넣어 주세요.');
    res.redirect('/admin/leave#rule');
  });

  // 일수 직접 조정 (+/-, 0.5 단위)
  router.post('/leave/adjust', managerOnly, (req, res) => {
    const u = db.prepare("SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL").get(Number(req.body.user_id));
    const days = Number(req.body.days);
    const note = String(req.body.note || '').trim().slice(0, 100);
    if (!u || !Number.isFinite(days) || days === 0 || Math.abs(days) > 60 || Math.round(days * 2) !== days * 2) {
      flash(req, 'error', '직원과 일수(0.5 단위, 예: 2 · -0.5)를 확인해 주세요.');
      return res.redirect('/admin/leave#adjust');
    }
    if (!note) { flash(req, 'error', '조정하는 이유를 적어 주세요 (예: 시작할 때 남은 일수 맞추기).'); return res.redirect('/admin/leave#adjust'); }
    db.prepare('INSERT INTO leave_adjust (user_id, days, note, created_by) VALUES (?, ?, ?, ?)').run(u.id, days, note, req.user.id);
    flash(req, 'ok', `${u.name} 님 휴가를 ${days > 0 ? '+' : ''}${fmtDays(days)}일 조정했어요.`);
    res.redirect('/admin/leave#staff');
  });

  return router;
}

// 왼쪽 메뉴 '휴가' 옆 숫자: 관리자·부관리자에게 승인 대기 건수
function pendingLeaveCount(db, user) {
  return isManager(user) ? db.prepare("SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'pending'").get().n : 0;
}

module.exports = { leaveRoutes, pendingLeaveCount, STATUS };
