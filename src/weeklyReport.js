// 주간 매출 보고 메일: 관리자가 정한 요일·시각(기본 금요일 18시)에 관리자가 적은 주소로
//   이번 주(월요일 0시 ~ 보내는 시각) vs 지난주 같은 구간: 매출 · 객단가 · 발송된 택배 수 + 채널별 매출
//   월요일에 보내면 이번 주 구간이 너무 짧아서 지난주 월~일 전체 vs 그 전 주
//   제목은 관리자가 정한다 ({회사명} {기간} {매출} {변화}). 암호화를 켜면 본문에 숫자 없이 비밀번호 PDF 를 붙인다
//   보내는 메일: 이미 연결된 회사 메일 계정(SMTP). 한 주에 한 번만 (보낸 날은 settings 에 기억, 실패하면 3번까지 다시)
const nodemailer = require('nodemailer');
const { getSetting, setSetting } = require('./collector');
const { totals, byChannel } = require('./stats');
const { utcSql } = require('./retention');
const { channelInfoWith } = require('./channels/labels');
const { buildReportPdf } = require('./reportPdf');

const DEFAULT_DAY = 5; // 금요일 (0=일요일)
const DEFAULT_HOUR = 18;
const DEFAULT_SUBJECT = '[{회사명}] 이번 주 매출 {매출} ({변화})';
const SAFE_SUBJECT = '[{회사명}] 주간 매출 보고 ({기간})'; // 암호화할 때 기본 제목 (금액 없음)
const MIN_PASSWORD = 6;
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MAX_TRIES = 3;
const MAX_RECIPIENTS = 10;
const KST = 9 * 3600000;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// 받는 주소: 쉼표·줄바꿈·띄어쓰기로 나눠 적은 것 → 목록 (틀린 주소가 있으면 error)
function parseRecipients(text) {
  const list = [...new Set(String(text || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean))];
  const bad = list.filter(a => !EMAIL.test(a));
  if (bad.length) return { error: `메일 주소를 확인해 주세요: ${bad.join(', ')}` };
  if (list.length > MAX_RECIPIENTS) return { error: `받는 사람은 ${MAX_RECIPIENTS}명까지 넣을 수 있습니다.` };
  return { list };
}

const settingsOf = db => {
  let recipients = [];
  try { recipients = JSON.parse(getSetting(db, 'weekly_report_to') || '[]'); } catch { recipients = []; }
  let last = null;
  try { last = JSON.parse(getSetting(db, 'weekly_report_last') || 'null'); } catch { last = null; }
  const day = Number(getSetting(db, 'weekly_report_day'));
  const hour = Number(getSetting(db, 'weekly_report_hour'));
  return {
    enabled: getSetting(db, 'weekly_report_on') === '1', recipients, last,
    day: Number.isInteger(day) && day >= 0 && day <= 6 && getSetting(db, 'weekly_report_day') !== null ? day : DEFAULT_DAY,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 && getSetting(db, 'weekly_report_hour') !== null ? hour : DEFAULT_HOUR,
    subject: getSetting(db, 'weekly_report_subject') || '',
    encrypt: getSetting(db, 'weekly_report_encrypt') === '1',
    hasPassword: Boolean(getSetting(db, 'weekly_report_pw')),
  };
};

// 제목: {회사명} {기간} {매출} {변화}. 암호화할 때는 금액이 제목에 드러나지 않게 {매출} {변화} 를 뺀다
function fillSubject(template, values, { encrypt = false } = {}) {
  let t = template || (encrypt ? SAFE_SUBJECT : DEFAULT_SUBJECT);
  if (encrypt) t = t.replace(/\{(매출|변화)\}/g, '');
  return t.replace(/\{(회사명|기간|매출|변화)\}/g, (all, k) => values[k] ?? '')
    .replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s{2,}/g, ' ').trim() || '주간 매출 보고';
}

// 이번 주 월요일 0시(한국) ~ until, 지난주 같은 구간 (UTC Date). until 이 월요일 0시면 지난주 월~일 전체
// weekKey: 이 보고를 보낸 날 (한국 날짜) — 한 주에 한 번만 보내는 표시
function weekRange(until) {
  const k = new Date(until.getTime() + KST);
  const mondayKst = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - ((k.getUTCDay() + 6) % 7));
  const week = 7 * 86400000;
  let start = new Date(mondayKst - KST);
  if (start.getTime() >= until.getTime()) start = new Date(start.getTime() - week);
  return { start, end: until, prevStart: new Date(start.getTime() - week), prevEnd: new Date(until.getTime() - week), weekKey: k.toISOString().slice(0, 10) };
}

// 발송된 택배 수 (주문번호 단위, 퀵·직접전달 등은 빼고): 인트라넷 발송 시각 또는 채널에서 발송을 처음 본 시각
function parcels(db, start, end) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM orders o
      GROUP BY o.channel, o.channel_order_id
      HAVING MIN(COALESCE(o.shipped_at, o.channel_shipped_at)) >= ? AND MIN(COALESCE(o.shipped_at, o.channel_shipped_at)) < ?
        AND MAX(o.ship_method IS NOT NULL AND o.ship_method != 'DELIVERY') = 0
    )
  `).get(utcSql(start), utcSql(end)).n;
}

function buildReport(db, until = new Date()) {
  const r = weekRange(until);
  const cur = totals(db, utcSql(r.start), utcSql(r.end));
  const prev = totals(db, utcSql(r.prevStart), utcSql(r.prevEnd));
  return {
    ...r,
    rows: [
      { label: '매출', now: cur.sales, before: prev.sales, unit: '원' },
      { label: '객단가', now: cur.aov, before: prev.aov, unit: '원' },
      { label: '발송된 택배', now: parcels(db, r.start, r.end), before: parcels(db, r.prevStart, r.prevEnd), unit: '건' },
      { label: '주문 수', now: cur.orders, before: prev.orders, unit: '건' },
    ],
    channels: byChannel(db, utcSql(r.start), utcSql(r.end)),
    missing: cur.missing,
  };
}

const fmt = (n, unit) => `${Math.round(n || 0).toLocaleString('ko-KR')}${unit}`;
const change = (now, before) => {
  if (!before) return now ? '새로 생김' : '-';
  const p = Math.round(((now - before) / before) * 100);
  return p === 0 ? '변화 없음' : `${p > 0 ? '▲' : '▼'} ${Math.abs(p)}%`;
};
const kstText = d => { const k = new Date(d.getTime() + KST); return `${k.getUTCMonth() + 1}/${k.getUTCDate()}(${'일월화수목금토'[k.getUTCDay()]}) ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 메일 본문 (휴대폰 메일 앱에서도 깨지지 않게 표 + 인라인 스타일)
function renderReport(rep, { brandName = '', siteUrl = '', channelName = ch => ch, subjectTemplate = '' } = {}) {
  const period = `${kstText(rep.start)} ~ ${kstText(rep.end)}`;
  const prevPeriod = `${kstText(rep.prevStart)} ~ ${kstText(rep.prevEnd)}`;
  const subject = fillSubject(subjectTemplate, { 회사명: brandName, 기간: period, 매출: fmt(rep.rows[0].now, '원'), 변화: change(rep.rows[0].now, rep.rows[0].before) });
  const td = 'padding:10px 8px;border-bottom:1px solid #eef0f3;font-size:14px;white-space:nowrap;';
  const rows = rep.rows.map(x => {
    const c = change(x.now, x.before);
    const color = c.startsWith('▲') ? '#08875c' : c.startsWith('▼') ? '#e42939' : '#4e5968';
    return `<tr><td style="${td}color:#4e5968;">${esc(x.label)}</td><td style="${td}text-align:right;font-weight:700;">${fmt(x.now, x.unit)}</td>`
      + `<td style="${td}text-align:right;color:#8b95a1;">${fmt(x.before, x.unit)}</td><td style="${td}text-align:right;font-weight:700;color:${color};">${c}</td></tr>`;
  }).join('');
  const channels = rep.channels.length
    ? rep.channels.map(c => `<tr><td style="${td}">${esc(channelName(c.ch))}</td><td style="${td}text-align:right;">${fmt(c.sales, '원')}</td><td style="${td}text-align:right;color:#8b95a1;">${c.orders}건</td></tr>`).join('')
    : `<tr><td style="${td}color:#8b95a1;">이번 주 주문이 없어요.</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#191f28;">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;">
  <p style="margin:0 0 4px;color:#8b95a1;font-size:13px;">${esc(brandName)} 주간 매출 보고</p>
  <h1 style="margin:0 0 4px;font-size:20px;">이번 주 매출 ${fmt(rep.rows[0].now, '원')}</h1>
  <p style="margin:0 0 16px;color:#4e5968;font-size:13px;">${period} · 지난주 같은 구간(${prevPeriod})과 비교</p>
  <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;" cellpadding="0" cellspacing="0">
    <tr><th style="${td}text-align:left;color:#8b95a1;font-size:12px;">항목</th><th style="${td}text-align:right;color:#8b95a1;font-size:12px;">이번 주</th><th style="${td}text-align:right;color:#8b95a1;font-size:12px;">지난주</th><th style="${td}text-align:right;color:#8b95a1;font-size:12px;">변화</th></tr>
    ${rows}
  </table>
  <h2 style="margin:20px 0 8px;font-size:15px;">채널별 매출</h2>
  <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;" cellpadding="0" cellspacing="0">${channels}</table>
  ${rep.missing ? `<p style="color:#8b95a1;font-size:12px;">금액을 모르는 주문 ${rep.missing}건은 매출에서 빠졌어요.</p>` : ''}
  <p style="color:#8b95a1;font-size:12px;">매출은 결제 금액(할인 뒤·배송비 제외), 취소·반품·입금 전은 빼요. 택배 수는 퀵·직접전달을 뺀 주문번호 단위예요.</p>
  ${siteUrl ? `<p style="margin:20px 0 0;"><a href="${esc(siteUrl)}/stats" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#3182f6;color:#fff;text-decoration:none;font-weight:700;font-size:14px;">통계 화면 열기</a></p>` : ''}
</div></body></html>`;
  const text = [`${brandName} 주간 매출 보고`, period, '', ...rep.rows.map(x => `${x.label}: ${fmt(x.now, x.unit)} (지난주 ${fmt(x.before, x.unit)}, ${change(x.now, x.before)})`),
    '', '채널별 매출', ...rep.channels.map(c => `- ${channelName(c.ch)}: ${fmt(c.sales, '원')} (${c.orders}건)`), siteUrl ? `\n${siteUrl}/stats` : ''].join('\n');
  return { subject, html, text };
}

// 암호화: 본문에는 숫자 없이 안내만, 표는 비밀번호 PDF 로
async function renderEncrypted(rep, { brandName = '', siteUrl = '', channelName = ch => ch, subjectTemplate = '', password }) {
  const period = `${kstText(rep.start)} ~ ${kstText(rep.end)}`;
  const subject = fillSubject(subjectTemplate, { 회사명: brandName, 기간: period }, { encrypt: true });
  const pdf = await buildReportPdf({
    title: `${brandName} 주간 매출 보고`.trim(),
    period: `기간 ${period}`,
    compare: `비교 지난주 같은 구간 (${kstText(rep.prevStart)} ~ ${kstText(rep.prevEnd)})`,
    rows: rep.rows.map(x => ({ label: x.label, nowText: fmt(x.now, x.unit), beforeText: fmt(x.before, x.unit), change: change(x.now, x.before) })),
    channels: rep.channels.map(c => ({ name: channelName(c.ch), salesText: fmt(c.sales, '원'), orders: c.orders })),
    notes: [
      ...(rep.missing ? [`금액을 모르는 주문 ${rep.missing}건은 매출에서 빠졌어요.`] : []),
      '매출은 결제 금액(할인 뒤·배송비 제외), 취소·반품·입금 전은 빼요. 택배 수는 퀵·직접전달을 뺀 주문번호 단위예요.',
    ],
    password,
  });
  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#191f28;">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;">
  <p style="margin:0 0 4px;color:#8b95a1;font-size:13px;">${esc(brandName)} 주간 매출 보고</p>
  <h1 style="margin:0 0 8px;font-size:20px;">이번 주 보고가 도착했어요</h1>
  <p style="margin:0 0 6px;color:#4e5968;font-size:14px;">${period}</p>
  <p style="margin:0 0 16px;color:#4e5968;font-size:14px;">첨부한 PDF 를 열면 <strong>비밀번호</strong>를 물어요. 관리자 화면에서 정한 비밀번호를 넣어 주세요.</p>
  ${siteUrl ? `<p style="margin:20px 0 0;"><a href="${esc(siteUrl)}/stats" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#3182f6;color:#fff;text-decoration:none;font-weight:700;font-size:14px;">통계 화면 열기 (로그인)</a></p>` : ''}
</div></body></html>`;
  const text = `${brandName} 주간 매출 보고\n${period}\n\n첨부한 PDF 를 열면 비밀번호를 물어요.${siteUrl ? `\n${siteUrl}/stats` : ''}`;
  const k = new Date(rep.end.getTime() + KST).toISOString().slice(0, 10);
  return { subject, html, text, attachments: [{ filename: `주간매출보고_${k}.pdf`, content: pdf, contentType: 'application/pdf' }] };
}

// account: 회사 메일 계정 { user, pass, smtp } (없으면 보낼 수 없음)
function createWeeklyReporter({ db, account, transport = null, brandName = () => '', siteUrl = process.env.PUBLIC_URL || 'https://intranet.broadstore.co.kr', now = () => new Date() }) {
  const channelInfo = channelInfoWith(db);
  const mailer = transport || (account ? nodemailer.createTransport({
    host: account.smtp, port: 465, secure: true, auth: { user: account.user, pass: account.pass }, socketTimeout: 60_000,
  }) : null);

  // until: 이번 주 구간의 끝 (기본은 지금, 정기 발송은 금요일 18:00)
  async function send({ test = false, until = now() } = {}) {
    const s = settingsOf(db);
    if (!mailer) return { ok: false, message: '보낼 메일 계정이 없습니다 (.env 의 네이버메일·지메일 계정).' };
    if (!s.recipients.length) return { ok: false, message: '받는 사람 메일 주소를 먼저 넣어 주세요.' };
    const password = s.encrypt ? getSetting(db, 'weekly_report_pw') : null;
    if (s.encrypt && !password) return { ok: false, message: '암호화가 켜져 있는데 비밀번호가 없어요. 비밀번호를 먼저 정해 주세요.' };
    const rep = buildReport(db, until);
    const opts = { brandName: brandName(), siteUrl, channelName: ch => channelInfo(ch).name, subjectTemplate: s.subject };
    try {
      const mail = s.encrypt ? await renderEncrypted(rep, { ...opts, password }) : renderReport(rep, opts);
      await mailer.sendMail({
        from: { name: brandName() || '주간 보고', address: account.user }, to: s.recipients,
        subject: `${test ? '[테스트] ' : ''}${mail.subject}`, html: mail.html, text: mail.text, attachments: mail.attachments || [],
      });
      const result = { at: now().toISOString(), ok: true, test, weekKey: rep.weekKey, message: `${s.recipients.length}명에게 보냈습니다.${s.encrypt ? ' (비밀번호 PDF)' : ''}` };
      setSetting(db, 'weekly_report_last', JSON.stringify(result));
      return result;
    } catch (e) {
      const result = { at: now().toISOString(), ok: false, test, weekKey: rep.weekKey, message: `보내지 못했습니다 — ${e.message}` };
      setSetting(db, 'weekly_report_last', JSON.stringify(result));
      return result;
    }
  }

  // 몇 분마다 불린다: 정한 요일·시각이 지났고, 켜져 있고, 그날 아직 안 보냈으면 보낸다 (실패하면 3번까지)
  async function tick() {
    const s = settingsOf(db);
    if (!s.enabled || !s.recipients.length) return null;
    const k = new Date(now().getTime() + KST);
    if (k.getUTCDay() !== s.day || k.getUTCHours() < s.hour) return null;
    // 구간 끝은 정한 시각 정각 (18:05 에 보내도 18:00 까지). 월요일이면 0시 (지난주 월~일 전체)
    const sendAt = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), s.day === 1 ? 0 : s.hour) - KST);
    const weekKey = k.toISOString().slice(0, 10);
    if (getSetting(db, 'weekly_report_sent') === weekKey) return null;
    const tries = Number(getSetting(db, `weekly_report_tries_${weekKey}`)) || 0;
    if (tries >= MAX_TRIES) return null;
    setSetting(db, `weekly_report_tries_${weekKey}`, tries + 1);
    const result = await send({ until: sendAt });
    if (result.ok) setSetting(db, 'weekly_report_sent', weekKey);
    return result;
  }

  return { send, tick, ready: Boolean(mailer), sender: account ? account.user : null };
}

module.exports = {
  createWeeklyReporter, buildReport, renderReport, renderEncrypted, parseRecipients, settingsOf, weekRange, parcels, fillSubject,
  DAYS, DEFAULT_SUBJECT, SAFE_SUBJECT, MIN_PASSWORD,
};
