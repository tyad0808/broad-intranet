// 휴가(월차·연차) 일수 계산 (사용자 요청 2026-11)
//   - 입사 1년 미만: 한 달을 채울 때마다 1개 (입사일의 다음 달 같은 날, 최대 11개)
//   - 입사 1년 이상: 근로기준법 기준으로 입사일(만 n년)마다 자동 — 만 1·2년 15일, 만 3년부터 2년마다 +1일, 최대 25일 (기본)
//       관리자 › 휴가 관리 에서 '관리자가 매년 직접 넣기' 로 바꾸면 자동으로 안 더한다 (settings.leave_yearly_mode)
//       그날 근속 1년이 된 직원만. 입사 1년이 되는 날부터 다음 1월 1일 사이에는 새로 생기지 않는다 (필요하면 관리자가 조정)
//   - 반차(오전·오후)는 0.5개, 종일은 평일(월~금) 수만큼
//   - 관리자가 '지금 남은 일수' 를 맞추면 (leave_baseline) 그 일수에서 다시 센다:
//       남은 = 맞춘 일수 + 그 뒤에 생긴 휴가 + 그 뒤 조정 − 그 뒤 승인된 휴가
//     맞춘 적이 없으면 입사일부터 센다. 해가 바뀌어도 남은 휴가가 저절로 없어지지는 않는다
const MONTHLY_MAX = 11;
const YEARLY_MODE = 'legal'; // 기본: 근로기준법 기준 자동. 관리자 화면에서 '매년 직접 넣기'(manual)로 바꿀 수 있다 (사용자 요청 2026-11)
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

// 1년 이상 연차 (근로기준법 60조): 만 n년 되는 날 15일, 만 3년부터 2년마다 1일 더 (최대 25일)
//   만 1·2년 15 · 만 3·4년 16 · 만 5·6년 17 · 만 7·8년 18 … 25
const legalDays = n => Math.min(25, 15 + Math.floor((n - 1) / 2));

// 입사일부터 오늘까지 생긴 휴가 [{ date, days, label }] 와 다음에 생길 것
//   mode: 'legal' 1년 이상도 입사일마다 법 기준으로 자동 · 'manual' 1년 이상은 관리자가 매년 직접 (1년 미만 매월 1일은 둘 다 자동)
function grantsOf(hireDate, today = kstToday(), mode = YEARLY_MODE) {
  if (!isDate(hireDate)) return { grants: [], next: null };
  const grants = [];
  const future = [];
  for (let k = 1; k <= MONTHLY_MAX; k += 1) {
    const date = addMonths(hireDate, k);
    const g = { date, days: 1, label: `입사 ${k}개월` };
    if (date <= today) grants.push(g); else { future.push(g); break; }
  }
  for (let n = 1; mode === 'legal' && n <= 60; n += 1) {
    const g = { date: addMonths(hireDate, 12 * n), days: legalDays(n), label: `만 ${n}년` };
    if (g.date <= today) grants.push(g); else { future.push(g); break; }
  }
  future.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { grants, next: future[0] || null };
}

// 관리자 › 휴가 관리 에서 고른 방식 (settings.leave_yearly_mode)
const yearlyModeOf = db => ((db.prepare("SELECT value FROM settings WHERE key = 'leave_yearly_mode'").get() || {}).value === 'manual' ? 'manual' : 'legal');


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

// 직원 한 명의 휴가 현황 (맞춘 일수가 있으면 그때부터)
function summaryOf(db, user, today = kstToday()) {
  const { grants: all, next } = grantsOf(user.hire_date, today, yearlyModeOf(db));
  const base = db.prepare('SELECT left_days, set_on, created_at FROM leave_baseline WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id) || null;
  const grants = base ? all.filter(g => g.date > base.set_on) : all;
  const since = base ? base.created_at : '0000';
  const granted = grants.reduce((s, g) => s + g.days, 0);
  const adjusted = db.prepare('SELECT COALESCE(SUM(days), 0) AS n FROM leave_adjust WHERE user_id = ? AND created_at >= ?').get(user.id, since).n;
  const used = db.prepare("SELECT COALESCE(SUM(days), 0) AS n FROM leave_requests WHERE user_id = ? AND status = 'approved' AND COALESCE(decided_at, created_at) >= ?").get(user.id, since).n;
  const pending = db.prepare("SELECT COALESCE(SUM(days), 0) AS n FROM leave_requests WHERE user_id = ? AND status = 'pending'").get(user.id).n;
  const start = base ? base.left_days : 0;
  return { hireDate: user.hire_date || '', service: serviceText(user.hire_date, today), grants, next, granted, adjusted, used, pending,
    base: base ? { left: base.left_days, on: base.set_on } : null, left: start + granted + adjusted - used };
}

// 예상 연차수당 (참고용, 사용자 회사 기준: 퇴직금 미포함 연봉 · 주 5일 하루 8시간)
//   월 통상임금 = 연봉 ÷ 12, 1일 통상임금 = 월 통상임금 ÷ 209시간(주 40시간 + 주휴, 한 달) × 8시간
//   연차수당 = 1일 통상임금 × 남은 연차 일수 (남은 일수가 0 이하면 0)
//   연봉에 상여·식대처럼 통상임금이 아닌 돈이 섞여 있으면 실제와 다를 수 있다 → 화면에 '참고용' 이라고 쓴다
const MONTH_HOURS = 209;
const DAY_HOURS = 8;
const dailyWageOf = salary => Math.round((Number(salary) / 12 / MONTH_HOURS) * DAY_HOURS);
const leavePayOf = (salary, leftDays) => (leftDays > 0 ? Math.round(dailyWageOf(salary) * leftDays) : 0);

// 일수 보기: 1 / 0.5 / 1.5
const fmtDays = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

module.exports = { dailyWageOf, leavePayOf, MONTH_HOURS, KINDS, MONTHLY_MAX, YEARLY_MODE, yearlyModeOf, legalDays, addMonths, grantsOf, serviceText, daysOf, readRequest, summaryOf, fmtDays, isDate, kstToday };
