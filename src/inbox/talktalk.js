// 5차 채팅: 네이버 톡톡 (톡톡 파트너센터 '챗봇 API')
//
// 받기: 고객이 톡톡을 보내면 네이버가 인트라넷 비밀 주소(POST /hooks/talktalk/<TALKTALK_WEBHOOK_TOKEN>)로 바로 알려 준다.
//       네이버 서버 IP 에서 온 것만 받는다. 대화방 하나 = 문의함 한 줄, 주고받은 말은 chat_messages 에.
// 파트너센터와 같이 쓰기: 챗봇 API 를 연결하면 대화 주도권이 기본으로 챗봇(인트라넷)에 있다.
//       고객 말이 오면 주도권을 바로 파트너센터로 넘겨서(passThread) 직원은 지금처럼 파트너센터에서 답한다.
//       파트너센터에서 보낸 답은 echo 로 와서 대화에 함께 쌓이고, 문의는 '답변완료' 가 된다.
// 보내기 API 키(TALKTALK_SEND_KEY)는 .env 에만 둔다. 인트라넷에서 직접 답장하는 기능은 2단계.
const crypto = require('crypto');

const SOURCE = 'talktalk';
const LABEL = '톡톡';
const SEND_URL = 'https://gw.talk.naver.com/chatbot/v1/event';
// 사진 보내기: 네이버가 우리 주소에서 사진을 한 번 가져가 imageId 를 준다 → 그 imageId 로 보낸다
const UPLOAD_URL = 'https://gw.talk.naver.com/chatbot/v1/imageUpload';
const MAX_IMAGE = 20 * 1024 * 1024; // 네이버 한도: 한 장 20MB
const PARTNER_CENTER_URL = 'https://partner.talk.naver.com/';
// 네이버 톡톡 서버 IP (챗봇 API 안내의 ACL 대역)
const NAVER_RANGES = ['211.249.40.0/27', '211.249.68.0/27', '220.230.168.0/27', '103.6.173.0/27'];
// 사진은 이 주소에서 온 것만 화면에 띄운다 (서버가 대신 가져와 보여 줌)
const IMAGE_HOSTS = /(^|\.)(naver\.com|naver\.net|pstatic\.net)$/i;

const ipNum = ip => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
function ipAllowed(raw) {
  const ip = String(raw || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true; // 서버 안에서 점검할 때
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  return NAVER_RANGES.some(r => {
    const [base, bits] = r.split('/');
    const mask = 2 ** (32 - Number(bits));
    return Math.floor(ipNum(ip) / mask) === Math.floor(ipNum(base) / mask);
  });
}

// 이벤트 하나 → { kind, text, image_url } (글자·사진·카드형)
function messageOf(ev) {
  if (ev.textContent && ev.textContent.text !== undefined) return { kind: 'text', text: String(ev.textContent.text), image_url: null };
  if (ev.imageContent && ev.imageContent.imageUrl) return { kind: 'image', text: null, image_url: String(ev.imageContent.imageUrl) };
  if (ev.compositeContent && Array.isArray(ev.compositeContent.compositeList)) {
    const text = ev.compositeContent.compositeList.map(c => [c.title, c.description].filter(Boolean).join(' - ')).filter(Boolean).join('\n');
    return { kind: 'card', text: text || '(카드 메시지)', image_url: null };
  }
  return { kind: 'other', text: '(지원하지 않는 메시지)', image_url: null };
}
// 상품 페이지에서 '톡톡문의' 로 들어오면 네이버가 상품 정보를 함께 준다 (options.product)
function productOf(ev) {
  const p = ev && ev.options && ev.options.product;
  if (!p || !p.name) return null;
  const safe = u => (/^https:\/\//.test(String(u || '')) ? String(u).slice(0, 500) : null);
  return { name: String(p.name).slice(0, 200), url: safe(p.url || p.mobileUrl) };
}

// 고객이 대화에 쓴 주문번호 찾기: 숫자 10~20자리 (사이에 - 나 빈칸이 있어도 됨)
//   인트라넷에 그 주문(주문번호 또는 상품주문번호)이 있을 때만 그 주문번호를 돌려준다. 여러 개면 마지막에 쓴 것
function numbersIn(text) {
  return [...String(text || '').matchAll(/\d[\d -]{8,30}\d/g)]
    .map(m => m[0].replace(/\D/g, ''))
    .filter(d => d.length >= 10 && d.length <= 20 && !/^01\d{8,9}$/.test(d)); // 휴대폰 번호는 빼고
}
function orderNoIn(db, text) {
  const find = db.prepare('SELECT channel_order_id FROM orders WHERE channel_order_id = ? OR channel_item_id = ? ORDER BY id LIMIT 1');
  const found = [];
  for (const digits of numbersIn(text)) {
    const row = find.get(digits, digits);
    if (row) found.push(String(row.channel_order_id));
  }
  return found.length ? found[found.length - 1] : null;
}

// 손님이 말한 번호인데 아직 인트라넷에 없는 주문 (주문 수집 전일 수 있다) → meta.saidNo 에 기억해 두고, 들어오면 연결
function rememberSaid(db, inquiryId, text) {
  const nums = numbersIn(text);
  if (!nums.length) return;
  const row = db.prepare('SELECT meta FROM inquiries WHERE id = ?').get(inquiryId);
  let meta = {};
  try { meta = JSON.parse((row && row.meta) || '{}') || {}; } catch { meta = {}; }
  db.prepare('UPDATE inquiries SET meta = ? WHERE id = ?').run(JSON.stringify({ ...meta, saidNo: nums[nums.length - 1] }), inquiryId);
}

// 기억해 둔 번호의 주문이 그사이 들어왔으면 연결한다 (톡톡 목록·대화를 열 때)
function linkSaidOrders(db) {
  const rows = db.prepare("SELECT id, meta FROM inquiries WHERE source = 'talktalk' AND order_no IS NULL AND meta LIKE '%\"saidNo\"%'").all();
  let linked = 0;
  for (const r of rows) {
    let meta = {};
    try { meta = JSON.parse(r.meta || '{}') || {}; } catch { continue; }
    const found = meta.saidNo ? orderNoIn(db, meta.saidNo) : null;
    if (!found) continue;
    delete meta.saidNo;
    db.prepare('UPDATE inquiries SET order_no = ?, meta = ? WHERE id = ?').run(found, JSON.stringify(meta), r.id);
    linked += 1;
  }
  return linked;
}

const previewOf = m => (m.kind === 'image' ? '(사진)' : String(m.text || '').replace(/\s+/g, ' ').trim()).slice(0, 60) || '(내용 없음)';

function createTalktalkClient({ authKey = process.env.TALKTALK_SEND_KEY, fetchFn = fetch } = {}) {
  async function post(json, url = SEND_URL) {
    if (!authKey) throw Object.assign(new Error('TALKTALK_SEND_KEY 가 .env 에 없습니다.'), { notSent: true });
    const res = await fetchFn(url, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json;charset=UTF-8', authorization: authKey },
      body: JSON.stringify(json),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok || !body || body.success !== true) {
      throw Object.assign(new Error(`톡톡 API 오류 (HTTP ${res.status}${body && body.resultCode ? `, 코드 ${body.resultCode}` : ''}${body && body.resultMessage ? `: ${body.resultMessage}` : ''})`), { status: res.status, body });
    }
    return body;
  }
  return {
    // 대화 주도권을 파트너센터로 넘긴다 (메시지를 보내지 않음)
    passThread: (user, partner) => post({ event: 'handover', user, ...(partner ? { partner } : {}), options: { control: 'passThread', targetId: 1 } }),
    // 파트너센터에 있는 대화를 챗봇(인트라넷)으로 잠깐 가져온다 (인트라넷에서 답장할 때)
    takeThread: (user, partner) => post({ event: 'handover', user, ...(partner ? { partner } : {}), options: { control: 'takeThread', metadata: '' } }),
    // 손님에게 말 보내기: content = { textContent: { text } } 또는 { imageContent: { imageId } }
    send: (user, content) => post({ event: 'send', user, ...content }),
    uploadImage: async imageUrl => {
      const body = await post({ imageUrl }, UPLOAD_URL);
      if (!body.imageId) throw new Error('톡톡 사진 올리기 응답에 imageId 가 없습니다.');
      return body.imageId;
    },
  };
}

// 파일 앞부분으로 진짜 사진 종류를 확인 (네이버는 JPG·PNG·GIF 만 받는다)
function imageKind(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  return null;
}

// 네이버가 사진을 가져갈 동안만 잠깐 들고 있는 곳 (메모리, 1분). 주소는 추측할 수 없는 긴 글자
function createTalkImages({ ttlMs = 60_000, now = () => Date.now() } = {}) {
  const map = new Map();
  const sweep = () => { for (const [k, v] of map) if (v.until < now()) map.delete(k); };
  return {
    put(content, type) {
      sweep();
      const token = crypto.randomBytes(24).toString('hex');
      map.set(token, { content, type, until: now() + ttlMs });
      return token;
    },
    get(token) {
      const v = map.get(String(token));
      if (!v || v.until < now()) { map.delete(String(token)); return null; }
      return v;
    },
    remove: token => map.delete(String(token)),
  };
}

// 인트라넷에서 톡톡 답장 보내기 (TALKTALK_ANSWER=on 일 때만 만든다. 아니면 연습 모드)
//   ① 대화를 파트너센터에서 잠깐 가져오고 ② 사진들 → 글 순서로 보내고 ③ 다시 파트너센터로 넘긴다 (파트너센터에서도 계속 답할 수 있게)
//   돌려주는 sent: 실제로 나간 것들 (대화 말풍선으로 남긴다)
function createTalktalkSender({ client = createTalktalkClient(), images, publicUrl = process.env.PUBLIC_URL || 'https://intranet.broadstore.co.kr',
  partnerId = process.env.TALKTALK_PARTNER_ID, log = console } = {}) {
  const base = publicUrl.replace(/\/$/, '');
  return {
    async reply(inquiry, body, files = []) {
      const user = String(inquiry.external_id);
      const sent = [];
      try {
        await client.takeThread(user, partnerId);
      } catch (e) {
        log.warn(`[톡톡] 대화 가져오기 실패 (그대로 보내 봄): ${e.message}`);
      }
      try {
        for (const f of files) {
          const token = images.put(f.content, imageKind(f.content));
          let imageId;
          try {
            imageId = await client.uploadImage(`${base}/talk-img/${token}`);
          } finally {
            images.remove(token);
          }
          await client.send(user, { imageContent: { imageId } });
          sent.push({ kind: 'image', name: f.name });
        }
        if (body) {
          await client.send(user, { textContent: { text: body } });
          sent.push({ kind: 'text', text: body });
        }
      } catch (e) {
        return { result: 'error', sent, message: `톡톡으로 보내지 못했습니다${sent.length ? ` (앞의 ${sent.length}개는 보냄)` : ''}: ${e.message}` };
      } finally {
        await client.passThread(user, partnerId).catch(e => log.warn(`[톡톡] 파트너센터로 다시 넘기기 실패: ${e.message}`));
      }
      return { result: 'ok', sent, message: `톡톡으로 보냈습니다${files.length ? ` (사진 ${files.length}장${body ? ' + 글' : ''})` : ''}.` };
    },
  };
}

function createTalktalkHandler({ db, notifier = null, client = null, partnerId = process.env.TALKTALK_PARTNER_ID, now = () => new Date(), log = console } = {}) {
  const findThread = db.prepare("SELECT id, status FROM inquiries WHERE source = ? AND external_id = ?");
  const insertThread = db.prepare(`INSERT INTO inquiries (source, external_id, from_name, subject, body, attachments, received_at, status)
    VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`);
  const insertMessage = db.prepare('INSERT INTO chat_messages (inquiry_id, direction, kind, text, image_url, sender, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  // 인트라넷에서 보내고 아직 메아리(echo)가 안 온 말 (같은 종류, 글이면 같은 글, 10분 안)
  const findMine = db.prepare(`
    SELECT m.id, m.inquiry_id FROM chat_messages m JOIN inquiries q ON q.id = m.inquiry_id
    WHERE q.source = ? AND q.external_id = ? AND m.direction = 'out' AND m.echoed = 0 AND m.kind = ?
      AND (m.kind = 'image' OR m.text = ?) AND m.created_at >= ?
    ORDER BY m.id LIMIT 1
  `);

  // 고객 쪽 말이 오면 미답변으로, 우리 쪽 말이 나가면 답변완료로
  function record(user, direction, m, sender, product = null) {
    const at = now().toISOString();
    const preview = previewOf(m);
    let thread = findThread.get(SOURCE, user);
    let created = false;
    if (!thread) {
      const info = insertThread.run(SOURCE, user, `톡톡 고객 ${String(user).slice(-4)}`, `[톡톡] ${preview}`, preview, at, direction === 'in' ? 'open' : 'answered');
      thread = { id: Number(info.lastInsertRowid) };
      created = true;
    } else if (direction === 'in') {
      db.prepare(`UPDATE inquiries SET subject = ?, body = ?, received_at = ?, status = 'open', handled_by = NULL, handled_at = NULL,
        version = version + 1, updated_at = datetime('now') WHERE id = ?`).run(`[톡톡] ${preview}`, preview, at, thread.id);
    } else {
      db.prepare(`UPDATE inquiries SET status = CASE WHEN status = 'open' THEN 'answered' ELSE status END, version = version + 1,
        updated_at = datetime('now') WHERE id = ?`).run(thread.id);
    }
    insertMessage.run(thread.id, direction, m.kind, m.text, m.image_url, sender, at);
    if (direction === 'in') {
      // 상품 문의면 상품을 기억해 둔다 (목록의 '상품정보 문의' 태그·상품 줄)
      if (product) {
        const row = db.prepare('SELECT meta FROM inquiries WHERE id = ?').get(thread.id);
        let meta = {};
        try { meta = JSON.parse((row && row.meta) || '{}') || {}; } catch { meta = {}; }
        db.prepare('UPDATE inquiries SET meta = ? WHERE id = ?').run(JSON.stringify({ ...meta, product }), thread.id);
      }
      // 고객이 주문번호를 말하면 그 주문과 연결한다
      const said = m.kind === 'text' || m.kind === 'card' ? m.text : '';
      const orderNo = said ? orderNoIn(db, said) : null;
      if (orderNo) db.prepare('UPDATE inquiries SET order_no = ? WHERE id = ?').run(orderNo, thread.id);
      else if (said) rememberSaid(db, thread.id, said);
    }
    return { id: thread.id, created, preview };
  }

  // 네이버가 보낸 이벤트 하나 처리 (빨리 끝내고 200 을 돌려줘야 해서 주도권 넘기기는 기다리지 않는다)
  return function handle(ev) {
    if (!ev || !ev.user) return { ignored: true };
    const user = String(ev.user);
    if (ev.event === 'send') {
      const r = record(user, 'in', messageOf(ev), 'customer', productOf(ev));
      if (notifier) {
        notifier.inboxChanged();
        notifier.inboxNew('chat', { title: '새 톡톡', body: r.preview, url: `/inbox/${r.id}` });
      }
      // 주도권이 아직 챗봇(인트라넷)에 있으면 파트너센터로 넘긴다 (standby 면 이미 파트너센터에 있음)
      if (client && !(ev.options && ev.options.standby)) {
        client.passThread(user, ev.partner || partnerId).catch(e => log.warn(`[톡톡] 주도권 넘기기 실패: ${e.message}`));
      }
      return { id: r.id };
    }
    if (ev.event === 'echo') {
      // 인트라넷에서 보낸 말이 되돌아온 것이면 이미 대화에 있다 → 확인 표시만 (사진은 네이버 주소를 받아 둔다)
      const m = messageOf(ev);
      const mine = findMine.get(SOURCE, user, m.kind, m.kind === 'image' ? '' : String(m.text || ''), new Date(now().getTime() - 10 * 60 * 1000).toISOString());
      if (mine) {
        db.prepare('UPDATE chat_messages SET echoed = 1, image_url = COALESCE(?, image_url) WHERE id = ?').run(m.image_url, mine.id);
        if (notifier) notifier.inboxChanged();
        return { id: mine.inquiry_id, echoed: true };
      }
      // 파트너센터(또는 챗봇)가 보낸 말
      const r = record(user, 'out', m, 'partner');
      if (notifier) notifier.inboxChanged();
      return { id: r.id };
    }
    // open(대화방 열기)·leave·friend·handover 는 기록만 하지 않고 넘긴다
    return { ignored: true };
  };
}

module.exports = { SOURCE, LABEL, PARTNER_CENTER_URL, IMAGE_HOSTS, MAX_IMAGE, ipAllowed, messageOf, productOf, orderNoIn, linkSaidOrders, imageKind, createTalkImages, createTalktalkSender, createTalktalkClient, createTalktalkHandler };
