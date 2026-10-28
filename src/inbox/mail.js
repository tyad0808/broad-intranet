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
const SOURCE_BATCH = 20;        // 본문을 한 번에 몇 통씩 받을지 (메모리를 너무 많이 쓰지 않게)
const FETCH_LIMIT_MS = 4 * 60 * 1000; // 한 계정 받기가 이보다 오래 걸리면 끊는다 (멈춘 연결이 다음 받기를 막지 않게)

// 메일의 첨부파일 목록 (IMAP 의 메일 구조에서 찾는다: 파일은 받지 않고 이름·크기·위치만)
//   part: 메일 안의 위치 번호 → 나중에 그 부분만 내려받을 때 쓴다
function attachmentParts(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    for (const child of node.childNodes) attachmentParts(child, out);
    return out;
  }
  const name = (node.dispositionParameters && node.dispositionParameters.filename) || (node.parameters && node.parameters.name);
  if (node.disposition === 'attachment' || name) {
    out.push({ part: node.part || '1', name: name || '(이름 없음)', size: node.size || 0, type: String(node.type || 'application/octet-stream').toLowerCase() });
  }
  return out;
}

// 미리보기로 화면에 바로 보여줘도 되는 그림 (SVG 는 스크립트가 들어갈 수 있어 제외)
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function previewType(file) {
  const type = String(file.type || '').toLowerCase();
  if (PREVIEW_TYPES.has(type)) return type;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return EXT_TYPES[ext] || null;
}

// 정해진 시간 안에 끝나지 않으면 오류
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// .env 에 계정이 있는 메일만: NAVER_MAIL_USER / NAVER_MAIL_PASS, GMAIL_USER / GMAIL_PASS
// 같은 종류를 여러 개: 두 번째부터 NAVER_MAIL2_USER / NAVER_MAIL2_PASS … (최대 5개씩)
//   출처 이름: naver_mail, naver_mail2 … / 화면에는 메일 주소로 보여준다
const MAX_PER_PROVIDER = 5;
function mailAccountsFromEnv(env = process.env) {
  const out = [];
  for (const [kind, p] of Object.entries(PROVIDERS)) {
    for (let n = 1; n <= MAX_PER_PROVIDER; n++) {
      const suffix = n === 1 ? '' : String(n);
      const user = env[`${p.env}${suffix}_USER`];
      const pass = env[`${p.env}${suffix}_PASS`];
      if (!user || !pass) continue;
      out.push({ ...p, source: `${kind}${suffix}`, kind, kindLabel: p.label, label: user.trim(), user: user.trim(), pass });
    }
  }
  return out;
}

// 메일 출처인지 (naver_mail, naver_mail2, gmail …)
const isMailSource = source => /^(naver_mail|gmail)\d*$/.test(String(source || ''));

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
  // 어느 메일에 대한 답장인지 (References + In-Reply-To): 같은 대화를 찾아 담당자를 이어받을 때 쓴다
  const refs = [...new Set([...(Array.isArray(m.references) ? m.references : m.references ? [m.references] : []), ...(m.inReplyTo ? [m.inReplyTo] : [])])];
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

// 메일 번호(uid) 목록 → 문의함 줄들
//   빠르게: 메일마다 따로 묻지 않고 한 번에 묻는다 (① 제목·크기·구조 전부, ② 본문은 20통씩 묶어서)
async function fetchItems(client, account, uids, uidValidity, { parse = simpleParser, now = () => new Date() } = {}) {
  const metas = [];
  if (uids.length) {
    for await (const m of client.fetch(uids.join(','), { uid: true, flags: true, size: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true })) {
      metas.push(m);
    }
  }
  metas.sort((a, b) => a.uid - b.uid);
  const small = metas.filter(m => !(m.size > MAX_SIZE)).map(m => m.uid);
  const sources = new Map();
  for (let i = 0; i < small.length; i += SOURCE_BATCH) {
    for await (const m of client.fetch(small.slice(i, i + SOURCE_BATCH).join(','), { uid: true, source: true }, { uid: true })) {
      sources.set(m.uid, m.source);
    }
  }

  const items = [];
  for (const meta of metas) {
    const uid = meta.uid;
    const uidKey = `${uidValidity}:${uid}`;
    const flags = new Set(meta.flags || []);
    if (meta.size > MAX_SIZE) {
      const env = meta.envelope || {};
      const from = (env.from && env.from[0]) || {};
      items.push({
        source: account.source, external_id: uidKey, from_name: from.name || null, from_addr: from.address || null,
        reply_to: null, subject: env.subject || '(제목 없음)',
        body: `(메일이 커서(${Math.round(meta.size / 1024 / 1024)}MB) 본문을 가져오지 않았습니다. ${account.label}에서 확인하세요.)`,
        attachments: JSON.stringify(attachmentParts(meta.bodyStructure)), message_id: env.messageId || null, references_hdr: null,
        received_at: new Date(meta.internalDate || now()).toISOString(), answered: flags.has('\\Answered'),
      });
      continue;
    }
    const raw = sources.get(uid);
    if (!raw) continue;
    const item = await parseMail(account.source, raw, { uidKey, flags, date: meta.internalDate, parse });
    // 첨부 목록은 메일 구조에서 (나중에 그 부분만 내려받을 수 있게 위치 번호까지)
    if (meta.bodyStructure) item.attachments = JSON.stringify(attachmentParts(meta.bodyStructure));
    items.push(item);
  }
  return items;
}

// 받은편지함 읽기. state: { uidValidity, lastUid } (지난번 어디까지 읽었는지), openIds: 아직 답변 전인 메일 번호들
function createMailSource(account, {
  connect = acc => defaultConnect(acc), parse = simpleParser, now = () => new Date(), limitMs = FETCH_LIMIT_MS,
} = {}) {
  return {
    source: account.source,
    label: account.label,
    fetch(options) {
      // 전체 시간 제한: 넘으면 연결을 끊어서 멈춘 작업도 함께 끝낸다
      let client = null;
      return withTimeout(this.fetchInner(options, c => { client = c; }), limitMs, `시간 초과 (${Math.round(limitMs / 60000)}분 안에 끝나지 않음)`)
        .catch(e => {
          if (client && typeof client.close === 'function') client.close();
          throw e;
        });
    },
    async fetchInner({ state = {}, openIds = [] } = {}, onClient = () => {}) {
      const client = await withTimeout(connect(account), 60_000, '메일 서버 연결 시간 초과 (60초)');
      onClient(client);
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

          const items = await fetchItems(client, account, uids, uidValidity, { parse, now });

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

// 예전 메일 가져오기 (한 번만 쓰는 명령: npm run mail-backfill)
//   지난 days 일 중 아직 인트라넷에 없는 메일만, 100통씩 나눠 받아 onBatch(items) 로 넘긴다 (onBatch 가 없으면 세기만).
//   '어디까지 읽었는지(lastUid)' 는 건드리지 않는다 (평소 받기와 겹치지 않게)
const BACKFILL_BATCH = 100;
async function backfillMail(account, {
  days = 365, has = () => false, onBatch = null, connect = acc => defaultConnect(acc), parse = simpleParser, now = () => new Date(),
} = {}) {
  const client = await withTimeout(connect(account), 60_000, '메일 서버 연결 시간 초과 (60초)');
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      const since = new Date(now().getTime() - days * 24 * 3600 * 1000);
      const all = ((await client.search({ since }, { uid: true })) || []).sort((a, b) => a - b);
      const todo = all.filter(u => !has(`${uidValidity}:${u}`));
      let done = 0;
      // onBatch 가 없으면 세기만 한다 (미리보기)
      for (let i = 0; onBatch && i < todo.length; i += BACKFILL_BATCH) {
        const items = await fetchItems(client, account, todo.slice(i, i + BACKFILL_BATCH), uidValidity, { parse, now });
        done += await onBatch(items) || 0;
      }
      return { found: all.length, todo: todo.length, added: done };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

function defaultConnect(account) {
  const client = new ImapFlow({
    host: account.imap, port: 993, secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  return client.connect().then(() => client);
}

// 답장 보내기
//   보내기 전에 막힌 경우(로그인 실패·연결 안 됨·받는 주소 거절) → 실패 (아무것도 안 나감)
//   보내는 도중 끊긴 경우 → 확인 필요 (나갔는지 알 수 없음)
const NOT_SENT_CODES = new Set(['EAUTH', 'ECONNECTION', 'EDNS', 'ESOCKET', 'EENVELOPE', 'ETLS']);

function createMailSender(account, {
  // pool: 한 번 연결한 메일 서버 연결을 잠시 다시 쓴다 (답장마다 새로 로그인하지 않아 빠름)
  transport = nodemailer.createTransport({
    host: account.smtp, port: 465, secure: true, auth: { user: account.user, pass: account.pass },
    pool: true, maxConnections: 1, socketTimeout: 60_000,
  }),
  connect = acc => defaultConnect(acc),
  fromName = process.env.MAIL_FROM_NAME || '브로애드',
} = {}) {
  return {
    // files: [{ name, type, content(Buffer) }] — 보내는 동안만 들고 있다가 버린다 (서버에 저장하지 않음)
    async reply(inquiry, body, files = []) {
      const to = inquiry.reply_to || inquiry.from_addr;
      if (!to) return { result: 'fail', message: '받는 사람 주소가 없는 메일입니다.' };
      const subject = /^re:/i.test(inquiry.subject || '') ? inquiry.subject : `Re: ${inquiry.subject || ''}`;
      const refs = [inquiry.references_hdr, inquiry.message_id].filter(Boolean).join(' ') || undefined;
      const raw = await new MailComposer({
        from: { name: fromName, address: account.user },
        to,
        subject,
        text: body,
        attachments: files.map(f => ({ filename: f.name, content: f.content, contentType: f.type || 'application/octet-stream' })),
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
      // 여기부터는 이미 보낸 뒤 — 화면은 바로 돌려주고, '답장함' 표시·보낸메일함 복사는 뒤에서 한다
      // (실패해도 답장 자체는 성공)
      const followUp = markOriginal(account, inquiry, raw, connect).catch(() => {});
      return { result: 'ok', message: `${to} 로 답장을 보냈습니다.`, followUp };
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

// 받은 첨부파일 열기: 누르는 순간 메일함에서 그 부분만 가져와 그대로 넘겨준다 (서버에 남기지 않음)
function createMailFiles(account, { connect = acc => defaultConnect(acc) } = {}) {
  return {
    async open(inquiry, index) {
      const [validity, uid] = String(inquiry.external_id).split(':');
      const client = await withTimeout(connect(account), 60_000, '메일 서버 연결 시간 초과');
      let lock = null;
      const done = async () => {
        if (lock) { lock.release(); lock = null; }
        await client.logout().catch(() => {});
      };
      try {
        lock = await client.getMailboxLock('INBOX');
        if (String(client.mailbox.uidValidity) !== validity) throw Object.assign(new Error('메일함이 바뀌어 이 메일을 찾을 수 없습니다.'), { status: 404 });
        const meta = await client.fetchOne(uid, { uid: true, bodyStructure: true }, { uid: true });
        if (!meta) throw Object.assign(new Error('메일함에서 지워진 메일입니다.'), { status: 404 });
        // 예전 방식으로 저장된 목록은 순서가 다를 수 있어 이름으로 먼저 찾는다
        const parts = attachmentParts(meta.bodyStructure);
        let expected = null;
        try { expected = (JSON.parse(inquiry.attachments || '[]')[Number(index)] || {}).name || null; } catch { expected = null; }
        const file = (expected && parts.find(p => p.name === expected)) || parts[Number(index)];
        if (!file) throw Object.assign(new Error('첨부파일을 찾을 수 없습니다.'), { status: 404 });
        const dl = await client.download(uid, file.part, { uid: true });
        if (!dl || !dl.content) throw Object.assign(new Error('첨부파일을 가져오지 못했습니다.'), { status: 404 });
        return { ...file, stream: dl.content, done };
      } catch (e) {
        await done();
        throw e;
      }
    },
  };
}

module.exports = { PROVIDERS, isMailSource, attachmentParts, previewType, PREVIEW_TYPES, createMailFiles, withTimeout, defaultConnect, mailAccountsFromEnv, createMailSource, createMailSender, backfillMail, parseMail, htmlToText };
