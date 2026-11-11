// 휴가(월차·연차) 일수 계산 (사용자 요청 2026-11)
//   - 입사 1년 미만: 한 달을 채울 때마다 1개 (입사일의 다음 달 같은 날, 최대 11개)
//   - 입사 1년 이상: 입사일(1년·2년·…)마다 14개
//   - 반차(오전·오후)는 0.5개, 종일은 평일(월~금) 수만큼
//   - 남은 일수 = 생긴 일수 + 직접 조정 − 승인된 휴가. 해가 바뀌어도 저절로 없어지지 않는다 (필요하면 관리자가 조정)
const MONTHLY_MAX = 11;
const YEARLY_DAYS = 14;
const KINDS = { full: '종일', am: '오전 반차', pm: '오후 반차' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const toDate = s => new Date(`${s}T00:00:00Z`);
const toStr = d => d.toISOString().slice(0, 10);

// 몇 달 뒤 같은 날 (그 달에 그날이 없으면 그 달 마지막 날: 1/31 + 1달 = 2/28)
function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const total = (m - 1) + n;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return toStr(new Date(Date.UTC(year, month, Math.min(d, last))));
}

const isDate = s => DATE_RE.test(String(s || '')) && toStr(toDate(s)) === s;

// 입사일부터 오늘까지 생긴 휴가 [{ date, days, label }] 와 다음에 생길 것
function grantsOf(hireDate, today = kstToday()) {
  if (!isDate(hireDate) || hireDate > today) return { grants: [], next: isDate(hireDate) ? { date: addMonths(hireDate, 1), days: 1, label: '입사 1개월' } : null };
  const grants = [];
  let next = null;
  for (let k = 1; k <= MONTHLY_MAX; k += 1) {
    const date = addMonths(hireDate, k);
    const g = { date, days: 1, label: `입사 ${k}개월` };
    if (date <= today) grants.push(g);
    else { next = next || g; break; }
  }
  for (let n = 1; n <= 60; n += 1) {
    const date = addMonths(hireDate, 12 * n);
    const g = { date, days: YEARLY_DAYS, label: `입사 ${n}년` };
    if (date <= today) grants.push(g);
    else { next = next || g; break; }
  }
  return { grants, next };
}

// 근속: '1년 3개월' 처럼
function serviceText(hireDate, today = kstToday()) {
  if (!isDate(hireDate) || hireDate > today) return '';
  let months = 0;
  while (addMonths(hireDate, months + 1) <= today) months += 1;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y}년` : '', m ? `${m}개월` : '', !y && !m ? '1개월 미만' : ''].filter(Boolean).join(' ');
}

// 쓰는 일수: 반차 0.5, 종일은 시작~끝 사이 평일 수
function daysOf(kind, start, end) {
  if (kind === 'am' || kind === 'pm') return 0.5;
  let n = 0;
  for (let d = toDate(start); toStr(d) <= end; d = new Date(d.getTime() + 86400000)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n += 1;
  }
  return n;
}

// 신청 값 확인 → { start, end, kind, days, reason } 또는 { error }
function readRequest(body) {
  const kind = KINDS[body.kind] ? body.kind : 'full';
  const start = String(body.start_date || '');
  let end = String(body.end_date || '') || start;
  if (!isDate(start)) return { error: '휴가 날짜를 골라 주세요.' };
  if (kind !== 'full') end = start; // 반차는 하루만
  if (!isDate(end) || end < start) return { error: '끝나는 날이 시작하는 날보다 앞이에요.' };
  if ((toDate(end) - toDate(start)) / 86400000 > 31) return { error: '한 번에 한 달(31일)까지만 신청할 수 있어요. 나눠서 신청해 주세요.' };
  const days = daysOf(kind, start, end);
  if (!days) return { error: '고른 날이 모두 주말이에요. 평일을 골라 주세요.' };
  const reason = String(body.reason || '').trim().slice(0, 200);
  return { start, end, kind, days, reason };
}

// 직원 한 명의 휴가 현황
function summaryOf(db, user, today = kstToday()) {
  const { grants, next } = grantsOf(user.hire_date, today);
  const granted = grants.reduce((s, g) => s + g.days, 0);
  const adjusted = db.prepare('SELECT COALESCE(SUM(days), 0) AS n FROM leave_adjust WHERE user_id = ?').get(user.id).n;
  const used = db.prepare("SELECT COALESCE(SUM(days), 0) AS n FROM leave_requests WHERE user_id = ? AND status = 'approved'").get(user.id).n;
  const pending = db.prepare("SELECT COALESCE(SUM(days), 0) AS n FROM leave_requests WHERE user_id = ? AND status = 'pending'").get(user.id).n;
  return { hireDate: user.hire_date || '', service: serviceText(user.hire_date, today), grants, next, granted, adjusted, used, pending, left: granted + adjusted - used };
}

// 일수 보기: 1 / 0.5 / 1.5
const fmtDays = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

module.exports = { KINDS, MONTHLY_MAX, YEARLY_DAYS, addMonths, grantsOf, serviceText, daysOf, readRequest, summaryOf, fmtDays, isDate, kstToday };
