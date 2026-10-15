// 회사 일정 달력 (PC 주문 목록 오른쪽 칸)
//
// - 승인된 직원 누구나 일정을 넣을 수 있다
// - 고치기·지우기는 넣은 사람과 관리자만
// - 달을 넘길 때는 /calendar?month=YYYY-MM 으로 달력 칸만 새로 받아 바꿔 끼운다 (목록은 그대로)
const express = require('express');

const COLORS = { blue: '파랑', green: '초록', orange: '주황', red: '빨강', purple: '보라' };
const MAX_DAYS = 62; // 여러 날 일정은 최대 두 달

// 오늘 날짜 (한국 시간) YYYY-MM-DD
function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const toDate = s => new Date(`${s}T00:00:00Z`);
const toStr = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => toStr(new Date(toDate(s).getTime() + n * 86400000));

// 한 달 달력에 필요한 것: 주(週)별 날짜 칸, 칸마다 그날 일정, 앞뒤 달
function buildMonth(db, monthParam, user) {
  const today = kstToday();
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthParam || '')) ? monthParam : today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = toDate(first).getUTCDay(); // 일요일 시작
  const gridStart = addDays(first, -offset);
  const weeksCount = Math.ceil((offset + daysInMonth) / 7);
  const gridEnd = addDays(gridStart, weeksCount * 7 - 1);

  const events = db.prepare(`
    SELECT e.*, u.name AS creator_name FROM events e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.start_date <= ? AND COALESCE(e.end_date, e.start_date) >= ?
    ORDER BY e.start_date, e.time IS NOT NULL, e.time, e.id
  `).all(gridEnd, gridStart).map(e => ({
    ...e,
    canEdit: Boolean(user) && (user.role === 'admin' || e.created_by === user.id),
  }));

  const weeks = [];
  for (let w = 0; w < weeksCount; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(gridStart, w * 7 + d);
      days.push({
        date,
        day: Number(date.slice(8)),
        inMonth: date.slice(0, 7) === month,
        isToday: date === today,
        weekday: d,
        events: events.filter(e => e.start_date <= date && (e.end_date || e.start_date) >= date),
      });
    }
    weeks.push(days);
  }

  const shift = n => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  };
  // 이번 달 일정 목록 (달력 아래 '이달의 일정')
  const monthEvents = events.filter(e => (e.end_date || e.start_date) >= first && e.start_date <= `${month}-${String(daysInMonth).padStart(2, '0')}`);
  return { month, label: `${y}년 ${m}월`, weeks, prev: shift(-1), next: shift(1), today, monthEvents, COLORS };
}

function calendarRoutes(db, notifier) {
  const router = express.Router();

  // 달력 칸만 (달 넘기기·실시간 새로고침용)
  router.get('/calendar', (req, res) => {
    res.render('partials/calendar', { cal: buildMonth(db, req.query.month, req.user) });
  });

  router.post('/calendar/events', (req, res) => {
    const input = parseEvent(req.body);
    const back = backTo(req.body.back, input.start_date);
    if (input.error) return fail(req, res, back, input.error);
    db.prepare(`
      INSERT INTO events (title, start_date, end_date, time, memo, color, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.title, input.start_date, input.end_date, input.time, input.memo, input.color, req.user.id);
    notifier.calendarChanged(req.user.id);
    req.session.flash = { type: 'ok', message: `일정을 추가했습니다: ${input.title}` };
    res.redirect(back);
  });

  router.post('/calendar/events/:id', (req, res) => {
    const event = editable(req);
    const input = parseEvent(req.body);
    const back = backTo(req.body.back, input.start_date || (event && event.start_date));
    if (!event) return fail(req, res, back, '고칠 수 없는 일정입니다 (넣은 사람과 관리자만 고칠 수 있음).');
    if (input.error) return fail(req, res, back, input.error);
    db.prepare(`
      UPDATE events SET title = ?, start_date = ?, end_date = ?, time = ?, memo = ?, color = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(input.title, input.start_date, input.end_date, input.time, input.memo, input.color, event.id);
    notifier.calendarChanged(req.user.id);
    req.session.flash = { type: 'ok', message: `일정을 고쳤습니다: ${input.title}` };
    res.redirect(back);
  });

  router.post('/calendar/events/:id/delete', (req, res) => {
    const event = editable(req);
    const back = backTo(req.body.back, event && event.start_date);
    if (!event) return fail(req, res, back, '지울 수 없는 일정입니다 (넣은 사람과 관리자만 지울 수 있음).');
    db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
    notifier.calendarChanged(req.user.id);
    req.session.flash = { type: 'ok', message: `일정을 지웠습니다: ${event.title}` };
    res.redirect(back);
  });

  // 넣은 사람이거나 관리자일 때만 일정을 돌려준다
  function editable(req) {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(req.params.id));
    if (!event) return null;
    return req.user.role === 'admin' || event.created_by === req.user.id ? event : null;
  }

  return router;
}

function parseEvent(body) {
  const title = String(body.title || '').trim().slice(0, 100);
  if (!title) return { error: '일정 제목을 적어 주세요.' };
  const start = String(body.start_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(toDate(start).getTime())) return { error: '날짜를 골라 주세요.' };
  let end = String(body.end_date || '').trim();
  if (end && (!/^\d{4}-\d{2}-\d{2}$/.test(end) || Number.isNaN(toDate(end).getTime()))) return { error: '끝나는 날짜 형식이 올바르지 않습니다.' };
  if (end && end < start) return { error: '끝나는 날짜가 시작 날짜보다 앞입니다.' };
  if (end && end > addDays(start, MAX_DAYS)) return { error: `여러 날 일정은 ${MAX_DAYS}일까지만 넣을 수 있습니다.` };
  if (end === start) end = '';
  const time = String(body.time || '').trim();
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: '시간 형식이 올바르지 않습니다.' };
  return {
    title,
    start_date: start,
    end_date: end || null,
    time: time || null,
    memo: String(body.memo || '').trim().slice(0, 1000) || null,
    color: COLORS[body.color] ? body.color : 'blue',
  };
}

// 저장 뒤 돌아갈 주소: 우리 목록 주소 + 일정이 있는 달 (cal=YYYY-MM)
function backTo(value, date) {
  const v = String(value || '');
  const base = /^\/(\?[^\s]*)?$/.test(v) ? v : '/';
  const params = new URLSearchParams(base.includes('?') ? base.slice(base.indexOf('?') + 1) : '');
  if (date && /^\d{4}-\d{2}/.test(date)) params.set('cal', date.slice(0, 7));
  const q = params.toString();
  return q ? `/?${q}` : '/';
}

function fail(req, res, back, message) {
  req.session.flash = { type: 'error', message };
  res.redirect(back);
}

module.exports = { calendarRoutes, buildMonth, COLORS };
