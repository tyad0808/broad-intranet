// 주간 매출 보고 메일: 매주 금요일 오후 6시에 관리자가 적은 주소로
//   이번 주(월요일 0시 ~ 금요일 18시) vs 지난주 같은 구간: 매출 · 객단가 · 발송된 택배 수 + 채널별 매출
//   보내는 메일: 이미 연결된 회사 메일 계정(SMTP). 한 주에 한 번만 (보낸 주는 settings 에 기억, 실패하면 3번까지 다시)
const nodemailer = require('nodemailer');
const { getSetting, setSetting } = require('./collector');
const { totals, byChannel } = require('./stats');
const { utcSql } = require('./retention');
const { channelInfoWith } = require('./channels/labels');

const SEND_WEEKDAY = 5; // 금요일
const SEND_HOUR = 18;
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
  return { enabled: getSetting(db, 'weekly_report_on') === '1', recipients, last };
};

// 이번 주 월요일 0시(한국) ~ until, 지난주 같은 구간 (UTC Date)
function weekRange(until) {
  const k = new Date(until.getTime() + KST);
  const mondayKst = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - ((k.getUTCDay() + 6) % 7));
  const start = new Date(mondayKst - KST);
  const week = 7 * 86400000;
  return { start, end: until, prevStart: new Date(start.getTime() - week), prevEnd: new Date(until.getTime() - week), weekKey: new Date(mondayKst).toISOString().slice(0, 10) };
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
function renderReport(rep, { brandName = '', siteUrl = '', channelName = ch => ch } = {}) {
  const period = `${kstText(rep.start)} ~ ${kstText(rep.end)}`;
  const prevPeriod = `${kstText(rep.prevStart)} ~ ${kstText(rep.prevEnd)}`;
  const subject = `[${brandName || '주간 보고'}] 이번 주 매출 ${fmt(rep.rows[0].now, '원')} (${change(rep.rows[0].now, rep.rows[0].before)})`;
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
    const rep = buildReport(db, until);
    const mail = renderReport(rep, { brandName: brandName(), siteUrl, channelName: ch => channelInfo(ch).name });
    try {
      await mailer.sendMail({ from: { name: brandName() || '주간 보고', address: account.user }, to: s.recipients, subject: `${test ? '[테스트] ' : ''}${mail.subject}`, html: mail.html, text: mail.text });
      const result = { at: now().toISOString(), ok: true, test, weekKey: rep.weekKey, message: `${s.recipients.length}명에게 보냈습니다.` };
      setSetting(db, 'weekly_report_last', JSON.stringify(result));
      return result;
    } catch (e) {
      const result = { at: now().toISOString(), ok: false, test, weekKey: rep.weekKey, message: `보내지 못했습니다 — ${e.message}` };
      setSetting(db, 'weekly_report_last', JSON.stringify(result));
      return result;
    }
  }

  // 몇 분마다 불린다: 금요일 18시가 지났고, 켜져 있고, 이번 주에 아직 안 보냈으면 보낸다 (실패하면 3번까지)
  async function tick() {
    const s = settingsOf(db);
    if (!s.enabled || !s.recipients.length) return null;
    const k = new Date(now().getTime() + KST);
    if (k.getUTCDay() !== SEND_WEEKDAY || k.getUTCHours() < SEND_HOUR) return null;
    // 보내는 시각은 정확히 금요일 18:00 기준으로 계산 (18:05 에 보내도 같은 구간)
    const sendAt = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), SEND_HOUR) - KST);
    const { weekKey } = weekRange(sendAt);
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

module.exports = { createWeeklyReporter, buildReport, renderReport, parseRecipients, settingsOf, weekRange, parcels };
