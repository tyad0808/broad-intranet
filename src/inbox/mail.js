// 4차 문의함: 회사 메일(네이버메일·지메일) 받기와 답장
//
// 받기: IMAP 으로 받은편지함(INBOX)을 읽는다. 처음에는 최근 30일, 그 뒤로는 지난번 다음 메일부터.
//       답장했다는 표시(\Answered)가 붙은 메일은 '답변완료' 로 본다 (메일 사이트에서 직접 답장해도 맞춰짐).
// 답장: SMTP 로 보낸다. 같은 대화로 묶이도록 In-Reply-To·References 를 붙이고,
//       원래 메일에 '답장함' 표시를 남긴다. 네이버는 보낸메일함에도 복사해 둔다 (지메일은 자동으로 남음).
// 비밀번호: 메일 계정 비밀번호가 아니라 각 메일에서 발급한 '앱 비밀번호' 를 .env 에만 둔다.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');

// 메일 계정 종류별 서버 주소
const PROVIDERS = {
  naver_mail: { label: '네이버메일', imap: 'imap.naver.com', smtp: 'smtp.naver.com', saveSent: true, env: 'NAVER_MAIL' },
  gmail: { label: '지메일', imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', saveSent: false, env: 'GMAIL' },
};

const FIRST_DAYS = 30;          // 처음 연결할 때 가져올 기간
const MAX_PER_RUN = 200;        // 한 번에 가져올 최대 메일 수 (처음에 메일이 아주 많을 때)
const MAX_SIZE = 8 * 1024 * 1024; // 이보다 큰 메일(큰 첨부)은 본문을 받지 않고 제목만
const MAX_BODY = 20_000;        // 저장할 본문 글자 수

// .env 에 계정이 있는 메일만: NAVER_MAIL_USER / NAVER_MAIL_PASS, GMAIL_USER / GMAIL_PASS
function mailAccountsFromEnv(env = process.env) {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => env[`${p.env}_USER`] && env[`${p.env}_PASS`])
    .map(([source, p]) => ({ source, ...p, user: env[`${p.env}_USER`], pass: env[`${p.env}_PASS`] }));
}

// HTML 메일을 글자로 (mailparser 가 글자 본문을 못 만든 경우의 예비)
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 메일 한 통(원본) → 문의함 한 줄
async function parseMail(source, raw, { uidKey, flags = new Set(), date = null, parse = simpleParser } = {}) {
  const m = await parse(raw);
  const from = (m.from && m.from.value && m.from.value[0]) || {};
  const replyTo = (m.replyTo && m.replyTo.value && m.replyTo.value[0]) || null;
  const text = (m.text && m.text.trim()) || htmlToText(m.html);
  const refs = Array.isArray(m.references) ? m.references : m.references ? [m.references] : [];
  return {
    source,
    external_id: uidKey,
    from_name: from.name || null,
    from_addr: from.address || null,
    reply_to: replyTo && replyTo.address && replyTo.address !== from.address ? replyTo.address : null,
    subject: m.subject || '(제목 없음)',
    body: text.slice(0, MAX_BODY),
    attachments: JSON.stringify((m.attachments || []).filter(a => a.contentDisposition !== 'inline' || a.filename)
      .map(a => ({ name: a.filename || '(이름 없음)', size: a.size || 0 }))),
    message_id: m.messageId || null,
    references_hdr: refs.join(' ') || null,
    received_at: new Date(m.date || date || Date.now()).toISOString(),
    answered: flags.has('\\Answered'),
  };
}

// 받은편지함 읽기. state: { uidValidity, lastUid } (지난번 어디까지 읽었는지), openIds: 아직 답변 전인 메일 번호들
function createMailSource(account, { connect = acc => defaultConnect(acc), parse = simpleParser, now = () => new Date() } = {}) {
  return {
    source: account.source,
    label: account.label,
    async fetch({ state = {}, openIds = [] } = {}) {
      const client = await connect(account);
      try {
        const lock = await client.getMailboxLock('INBOX');
        try {
          const uidValidity = String(client.mailbox.uidValidity);
          // 메일함이 새로 만들어졌으면(uidValidity 변경) 처음부터 다시 읽는다
          const fresh = !state.uidValidity || state.uidValidity !== uidValidity;
          let uids;
          if (fresh) {
            const since = new Date(now().getTime() - FIRST_DAYS * 24 * 3600 * 1000);
            uids = (await client.search({ since }, { uid: true })) || [];
          } else {
            uids = ((await client.search({ uid: `${Number(state.lastUid) + 1}:*` }, { uid: true })) || [])
              .filter(u => u > Number(state.lastUid));
          }
          uids = uids.sort((a, b) => a - b).slice(-MAX_PER_RUN);

          const items = [];
          for (const uid of uids) {
            const meta = await client.fetchOne(String(uid), { uid: true, flags: true, size: true, envelope: true, internalDate: true }, { uid: true });
            if (!meta) continue;
            const uidKey = `${uidValidity}:${uid}`;
            const flags = new Set(meta.flags || []);
            if (meta.size > MAX_SIZE) {
              const env = meta.envelope || {};
              const from = (env.from && env.from[0]) || {};
              items.push({
                source: account.source, external_id: uidKey, from_name: from.name || null, from_addr: from.address || null,
                reply_to: null, subject: env.subject || '(제목 없음)',
                body: `(메일이 커서(${Math.round(meta.size / 1024 / 1024)}MB) 본문을 가져오지 않았습니다. ${account.label}에서 확인하세요.)`,
                attachments: '[]', message_id: env.messageId || null, references_hdr: null,
                received_at: new Date(meta.internalDate || now()).toISOString(), answered: flags.has('\\Answered'),
              });
              continue;
            }
            const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
            if (!full || !full.source) continue;
            items.push(await parseMail(account.source, full.source, { uidKey, flags, date: meta.internalDate, parse }));
          }

          // 답변 전인 메일 중 메일 사이트에서 답장한 것 찾기 (\Answered 표시)
          const answeredIds = [];
          const sameBox = openIds.filter(id => id.startsWith(`${uidValidity}:`)).map(id => Number(id.split(':')[1]));
          if (!fresh && sameBox.length) {
            for await (const msg of client.fetch(sameBox.join(','), { uid: true, flags: true }, { uid: true })) {
              if (msg.flags && msg.flags.has('\\Answered')) answeredIds.push(`${uidValidity}:${msg.uid}`);
            }
          }

          const lastUid = Math.max(fresh ? 0 : Number(state.lastUid) || 0, ...uids, 0);
          return { items, answeredIds, state: { uidValidity, lastUid } };
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => {});
      }
    },
  };
}

function defaultConnect(account) {
  const client = new ImapFlow({
    host: account.imap, port: 993, secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
    socketTimeout: 60_000,
  });
  return client.connect().then(() => client);
}

// 답장 보내기
//   보내기 전에 막힌 경우(로그인 실패·연결 안 됨·받는 주소 거절) → 실패 (아무것도 안 나감)
//   보내는 도중 끊긴 경우 → 확인 필요 (나갔는지 알 수 없음)
const NOT_SENT_CODES = new Set(['EAUTH', 'ECONNECTION', 'EDNS', 'ESOCKET', 'EENVELOPE', 'ETLS']);

function createMailSender(account, {
  transport = nodemailer.createTransport({ host: account.smtp, port: 465, secure: true, auth: { user: account.user, pass: account.pass } }),
  connect = acc => defaultConnect(acc),
  fromName = process.env.MAIL_FROM_NAME || '브로애드',
} = {}) {
  return {
    async reply(inquiry, body) {
      const to = inquiry.reply_to || inquiry.from_addr;
      if (!to) return { result: 'fail', message: '받는 사람 주소가 없는 메일입니다.' };
      const subject = /^re:/i.test(inquiry.subject || '') ? inquiry.subject : `Re: ${inquiry.subject || ''}`;
      const refs = [inquiry.references_hdr, inquiry.message_id].filter(Boolean).join(' ') || undefined;
      const raw = await new MailComposer({
        from: { name: fromName, address: account.user },
        to,
        subject,
        text: body,
        inReplyTo: inquiry.message_id || undefined,
        references: refs,
      }).compile().build();
      try {
        const info = await transport.sendMail({ envelope: { from: account.user, to: [to] }, raw });
        if (info.rejected && info.rejected.length) return { result: 'fail', message: `받는 주소가 거절했습니다: ${info.rejected.join(', ')}` };
      } catch (e) {
        if (NOT_SENT_CODES.has(e.code)) return { result: 'fail', message: `보내지 못했습니다 — ${e.message}` };
        return { result: 'unknown', message: `보내는 도중 연결이 끊겼습니다. ${account.label} 보낸메일함에서 나갔는지 확인하세요. (${e.message})` };
      }
      // 여기부터는 이미 보낸 뒤 — 실패해도 답장 자체는 성공으로 둔다
      await markOriginal(account, inquiry, raw, connect).catch(() => {});
      return { result: 'ok', message: `${to} 로 답장을 보냈습니다.` };
    },
  };
}

// 원래 메일에 '답장함' 표시, 네이버는 보낸메일함에 복사
async function markOriginal(account, inquiry, raw, connect) {
  const client = await connect(account);
  try {
    const [validity, uid] = String(inquiry.external_id).split(':');
    const lock = await client.getMailboxLock('INBOX');
    try {
      if (String(client.mailbox.uidValidity) === validity) await client.messageFlagsAdd(uid, ['\\Answered'], { uid: true });
    } finally {
      lock.release();
    }
    if (account.saveSent) {
      const boxes = await client.list();
      const sent = boxes.find(b => b.specialUse === '\\Sent');
      if (sent) await client.append(sent.path, raw, ['\\Seen']);
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

module.exports = { PROVIDERS, mailAccountsFromEnv, createMailSource, createMailSender, parseMail, htmlToText };
