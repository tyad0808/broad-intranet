// 판매처 연결: 스마트스토어·쿠팡 API 키를 관리자 화면에서 넣고(DB 에 암호화), '실제로 보내기' 를 켜고 끈다
//
// - 서버 .env 에 키가 있는 판매처는 "서버 설정" — 화면에서는 상태만 보이고 바꿀 수 없다 (예전 방식 그대로)
// - .env 에 키가 없는 판매처만 화면에서 넣을 수 있다. 넣으면 서버를 다시 켜지 않고 바로:
//     주문 수집(collectors) · 발주확인·발송처리(actions.setWriter) · 문의 받기·답변(inbox) 에 반영
// - '실제로 보내기' 스위치: 처음엔 꺼짐(연습 모드). 마지막 연결 시험이 성공해야 켤 수 있고, 켤 때는 관리자 비밀번호를 다시 확인한다
// - 비밀 키는 화면·기록에 다시 내보내지 않는다 (끝 4자리만)
const { createNaverClient } = require('./channels/naverClient');
const { createCoupangClient } = require('./channels/coupangClient');
const { createSmartstoreSource, createSmartstoreWriter } = require('./channels/smartstore');
const { createCoupangSource, createCoupangWriter } = require('./channels/coupang');
const { createNaverQnaSource, createNaverQnaSender, SOURCE: QNA_SOURCE, LABEL: QNA_LABEL } = require('./inbox/naverQna');
const { createCoupangInquirySource, createCoupangInquirySender, SOURCE: CQ_SOURCE, LABEL: CQ_LABEL } = require('./inbox/coupangInquiry');

const { verifyPassword } = require('./auth');

const TEST_LIMIT_MS = 30_000;
const kstIso = date => new Date(date.getTime() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00');
const kstDate = date => new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// 판매처마다: 넣는 칸(secret = 암호화), .env 로 이미 연결됐는지, 스위치 이름, 실제 연결 만들기
const CHANNELS = {
  smartstore: {
    label: '스마트스토어',
    api: '네이버 커머스 API',
    fields: [
      { key: 'clientId', label: '애플리케이션 ID', secret: false, required: true },
      { key: 'clientSecret', label: '애플리케이션 시크릿', secret: true, required: true },
    ],
    envReady: env => env.ORDER_SOURCE === 'naver' && Boolean(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET),
    envOn: { write: env => env.NAVER_WRITE === 'on', answer: env => env.NAVER_ANSWER === 'on' && env.NAVER_QNA !== 'off' },
    switches: { write: '발주확인 · 발송처리', answer: '상품 문의 답변' },
    qna: { source: QNA_SOURCE, label: QNA_LABEL, off: env => env.NAVER_QNA === 'off' },
  },
  coupang: {
    label: '쿠팡',
    api: '쿠팡 WING OPEN API',
    fields: [
      { key: 'vendorId', label: '업체코드 (Vendor ID)', secret: false, required: true },
      { key: 'accessKey', label: 'Access Key', secret: true, required: true },
      { key: 'secretKey', label: 'Secret Key', secret: true, required: true },
      { key: 'wingId', label: 'WING 로그인 아이디', secret: false, required: false, note: '문의 답변에 "누가 답했는지" 로만 써요 · 비밀번호 아님' },
    ],
    envReady: env => ['COUPANG_VENDOR_ID', 'COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY'].every(k => env[k]) && env.COUPANG !== 'off',
    envOn: { write: env => env.COUPANG_WRITE === 'on', answer: env => env.COUPANG_ANSWER === 'on' && env.COUPANG_QNA !== 'off' },
    switches: { write: '상품준비중 · 송장', answer: '문의 답변' },
    qna: { source: CQ_SOURCE, label: CQ_LABEL, off: env => env.COUPANG_QNA === 'off' },
  },
};

// 실제 연결 만들기 (테스트에서는 가짜로 바꿔 끼운다)
const defaultFactories = {
  smartstore: {
    client: (k, write) => createNaverClient({ clientId: k.clientId, clientSecret: k.clientSecret, allowWrite: write }),
    source: k => createSmartstoreSource({ clientId: k.clientId, clientSecret: k.clientSecret }),
    writer: k => createSmartstoreWriter({ clientId: k.clientId, clientSecret: k.clientSecret }),
    qnaSource: k => createNaverQnaSource({ client: createNaverClient({ clientId: k.clientId, clientSecret: k.clientSecret }) }),
    qnaSender: k => createNaverQnaSender({ client: createNaverClient({ clientId: k.clientId, clientSecret: k.clientSecret, allowWrite: true }) }),
    // 연결 시험: 최근 1시간 사이 바뀐 주문 목록을 한 번 물어본다 (조회만)
    test: async client => {
      const to = new Date();
      await client.request('GET', '/v1/pay-order/seller/product-orders/last-changed-statuses', {
        query: { lastChangedFrom: kstIso(new Date(to.getTime() - 3600 * 1000)), lastChangedTo: kstIso(to) },
      });
    },
  },
  coupang: {
    client: (k, write) => createCoupangClient({ vendorId: k.vendorId, accessKey: k.accessKey, secretKey: k.secretKey, allowWrite: write }),
    source: k => createCoupangSource({ vendorId: k.vendorId, accessKey: k.accessKey, secretKey: k.secretKey }),
    writer: k => createCoupangWriter({ vendorId: k.vendorId, accessKey: k.accessKey, secretKey: k.secretKey }),
    qnaSource: k => createCoupangInquirySource({ client: createCoupangClient({ vendorId: k.vendorId, accessKey: k.accessKey, secretKey: k.secretKey }) }),
    qnaSender: k => createCoupangInquirySender({ client: createCoupangClient({ vendorId: k.vendorId, accessKey: k.accessKey, secretKey: k.secretKey, allowWrite: true }), wingId: k.wingId || '' }),
    // 연결 시험: 오늘 들어온 결제완료 발주서를 1건만 물어본다 (조회만)
    test: async (client, k) => {
      const today = kstDate(new Date());
      await client.request('GET', `/v2/providers/openapi/apis/api/v4/vendors/${k.vendorId}/ordersheets`, {
        query: { createdAtFrom: today, createdAtTo: today, status: 'ACCEPT', maxPerPage: 1 },
      });
    },
  },
};

// 판매처가 돌려준 오류를 쉬운 말로
function testError(channel, e) {
  const text = `${e && e.message} ${e && e.status}`;
  if (/401|403|unauthor|forbidden|invalid.*(key|signature|client)|인증/i.test(text)) {
    return `${CHANNELS[channel].label}가 키를 거절했어요. 키를 다시 확인해 주세요. 판매처에 이 서버 주소(IP)를 등록해야 하는 경우도 있어요.`;
  }
  if (/시간 초과|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(text)) return `${CHANNELS[channel].label}가 응답하지 않아요. 잠시 뒤 다시 시험해 주세요.`;
  return `연결하지 못했어요: ${String((e && e.message) || e).slice(0, 200)}`;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('시간 초과')), ms); })]).finally(() => clearTimeout(timer));
}

function createChannelRegistry({
  db, box, env = process.env,
  collectors = [], makeCollector = source => ({ source, run: async () => ({ ok: true }) }),
  actions = null, inbox = null,
  factories = defaultFactories,
  // 켤 때 다시 넣은 비밀번호가 지금 로그인한 관리자의 비밀번호인지
  verifyAdminPassword = (user, password) => {
    const r = user && db.prepare("SELECT password_hash FROM users WHERE id = ? AND role = 'admin' AND status = 'active'").get(user.id);
    return Boolean(r && password && verifyPassword(String(password), r.password_hash));
  },
}) {
  const rowOf = ch => db.prepare('SELECT * FROM channel_keys WHERE channel = ?').get(ch) || null;
  const log = (ch, userId, action) => db.prepare('INSERT INTO channel_log (channel, user_id, action) VALUES (?, ?, ?)').run(ch, userId || null, action);
  const parse = text => { try { return JSON.parse(text || '{}') || {}; } catch { return {}; } };
  const envManaged = ch => CHANNELS[ch].envReady(env);
  // 저장된 키 전부 (비밀 키는 풀어서). 못 풀면 null
  function keysOf(row) {
    if (!row) return null;
    const pub = parse(row.public_json);
    const opened = row.secret_sealed ? box.open(row.secret_sealed) : null;
    if (!opened) return null; // 저장된 키가 없거나 열쇠가 바뀌어 못 품
    const secret = parse(opened);
    return { ...pub.values, ...secret };
  }

  // 이 화면이 끼워 넣은 것들 (판매처마다). 뺄 때는 이것만 뺀다 — 개발용 가짜 주문 수집기 등은 그대로
  const added = new Map();
  const drop = (list, item) => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1); };

  // 판매처 하나를 지금 상태대로 끼우기 (.env 판매처는 건드리지 않는다)
  function applyChannel(ch) {
    if (envManaged(ch)) return;
    const def = CHANNELS[ch];
    const f = factories[ch];
    // 지난번에 끼운 수집기·문의 받기·답변·처리를 먼저 뺀다
    const before = added.get(ch);
    if (before) {
      drop(collectors, before.collector);
      if (inbox && before.qna) drop(inbox.collectorSources, before.qna);
      if (inbox && before.sender) delete inbox.senders[def.qna.source];
      if (actions && before.writer) actions.setWriter(ch, null);
      added.delete(ch);
    }
    const row = rowOf(ch);
    const keys = row && row.enabled ? keysOf(row) : null;
    if (!keys) return;
    // 화면에서 넣은 키가 있으면 같은 판매처의 다른 수집기(개발용 가짜 주문)는 뺀다
    for (let i = collectors.length - 1; i >= 0; i--) if (collectors[i].source.channel === ch) collectors.splice(i, 1);
    const now = { collector: makeCollector(f.source(keys)) };
    collectors.push(now.collector);
    added.set(ch, now);
    if (actions && row.write_on) { now.writer = true; actions.setWriter(ch, f.writer(keys)); }
    if (inbox && !def.qna.off(env)) {
      inbox.sourceLabels[def.qna.source] = def.qna.label;
      now.qna = f.qnaSource(keys);
      inbox.collectorSources.push(now.qna);
      if (row.answer_on) { now.sender = true; inbox.senders[def.qna.source] = f.qnaSender(keys); }
    }
  }
  const apply = () => Object.keys(CHANNELS).forEach(applyChannel);

  async function tryKeys(ch, keys) {
    const f = factories[ch];
    try {
      await withTimeout(f.test(f.client(keys, false), keys), TEST_LIMIT_MS);
      return null;
    } catch (e) {
      return testError(ch, e);
    }
  }

  // 화면에 넘길 값: 비밀 키는 끝 4자리만
  function view() {
    return Object.entries(CHANNELS).map(([ch, def]) => {
      const row = rowOf(ch);
      const pub = parse(row && row.public_json);
      const fromEnv = envManaged(ch);
      const keysOk = Boolean(row && keysOf(row));
      return {
        channel: ch, label: def.label, api: def.api, fields: def.fields, switches: def.switches, fromEnv,
        saved: Boolean(row && row.secret_sealed), locked: Boolean(row && row.secret_sealed && !keysOk),
        values: pub.values || {}, tails: pub.tails || {},
        enabled: row ? Boolean(row.enabled) : false,
        testOkAt: row ? row.test_ok_at : null,
        updatedAt: row ? row.updated_at : null,
        on: {
          write: fromEnv ? def.envOn.write(env) : Boolean(row && row.write_on),
          answer: fromEnv ? def.envOn.answer(env) : Boolean(row && row.answer_on),
        },
        qnaOff: def.qna.off(env),
      };
    });
  }

  return {
    CHANNELS,
    apply,
    view,
    get ready() { return box.ready; },
    keyProblem: box.keyProblem,
    history(limit = 20) {
      return db.prepare('SELECT l.*, u.name AS user_name FROM channel_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?').all(limit);
    },
    // 키 저장: 비밀 키 칸을 비우면 저장된 값 그대로 (바꾸고 싶은 칸만 넣으면 됨). 연결 시험이 되어야 저장
    async save(ch, input, userId) {
      const def = CHANNELS[ch];
      if (!def) return { error: '판매처를 찾을 수 없어요.' };
      if (envManaged(ch)) return { error: '서버 설정(.env)으로 연결된 판매처라 여기서는 바꿀 수 없어요.' };
      if (!box.ready) return { error: box.keyProblem || '서버 .env 에 SETTINGS_KEY 가 없어 키를 저장할 수 없어요.' };
      const row = rowOf(ch);
      const old = keysOf(row) || {};
      const keys = {};
      for (const fl of def.fields) {
        const raw = String((input && input[fl.key]) ?? '').trim();
        const value = raw || (fl.secret ? old[fl.key] || '' : '');
        if (value.length > 300 || /\s/.test(value)) return { error: `${fl.label}을(를) 확인해 주세요.` };
        if (fl.required && !value) return { error: `${fl.label}을(를) 넣어 주세요.` };
        keys[fl.key] = value;
      }
      const error = await tryKeys(ch, keys);
      if (error) return { error };
      const values = Object.fromEntries(def.fields.filter(fl => !fl.secret).map(fl => [fl.key, keys[fl.key]]));
      const tails = Object.fromEntries(def.fields.filter(fl => fl.secret).map(fl => [fl.key, keys[fl.key].slice(-4)]));
      const secret = Object.fromEntries(def.fields.filter(fl => fl.secret).map(fl => [fl.key, keys[fl.key]]));
      db.prepare(`
        INSERT INTO channel_keys (channel, public_json, secret_sealed, enabled, test_ok_at, updated_by, updated_at)
        VALUES (?, ?, ?, 1, datetime('now'), ?, datetime('now'))
        ON CONFLICT(channel) DO UPDATE SET public_json = excluded.public_json, secret_sealed = excluded.secret_sealed, enabled = 1,
          test_ok_at = excluded.test_ok_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run(ch, JSON.stringify({ values, tails }), box.seal(JSON.stringify(secret)), userId || null);
      log(ch, userId, row ? '키 바꿈' : '키 저장');
      applyChannel(ch);
      return { ok: true };
    },
    async test(ch, userId) {
      if (!CHANNELS[ch] || envManaged(ch)) return { error: '여기서 시험할 수 없는 판매처예요.' };
      const keys = keysOf(rowOf(ch));
      if (!keys) return { error: '저장된 키가 없거나 풀 수 없어요 (서버 열쇠가 바뀌었으면 키를 다시 넣어 주세요).' };
      const error = await tryKeys(ch, keys);
      if (!error) db.prepare("UPDATE channel_keys SET test_ok_at = datetime('now') WHERE channel = ?").run(ch);
      log(ch, userId, error ? '연결 시험 실패' : '연결 시험 성공');
      return error ? { error } : { ok: true };
    },
    setEnabled(ch, on, userId) {
      const row = rowOf(ch);
      if (!row || envManaged(ch)) return { error: '판매처를 찾을 수 없어요.' };
      // 끄면 실제로 보내기도 함께 끈다 (다시 켤 때 다시 확인)
      db.prepare(`UPDATE channel_keys SET enabled = ?, ${on ? '' : 'write_on = 0, answer_on = 0,'} updated_at = datetime('now') WHERE channel = ?`).run(on ? 1 : 0, ch);
      log(ch, userId, on ? '수집 켬' : '수집 끔');
      applyChannel(ch);
      return { ok: true };
    },
    // '실제로 보내기' 켜기: 연결 시험 성공 + 관리자 비밀번호 다시 확인. 끄기는 바로
    switchOn(ch, kind, password, user) {
      const def = CHANNELS[ch];
      if (!def || !def.switches[kind] || envManaged(ch)) return { error: '여기서 바꿀 수 없는 스위치예요.' };
      const row = rowOf(ch);
      if (!row || !row.enabled || !keysOf(row)) return { error: '먼저 키를 넣고 연결해 주세요.' };
      if (!row.test_ok_at) return { error: '연결 시험에 성공해야 켤 수 있어요.' };
      if (kind === 'answer' && def.qna.off(env)) return { error: '서버 설정에서 문의 받기가 꺼져 있어요.' };
      if (kind === 'answer' && ch === 'coupang' && !keysOf(row).wingId) return { error: '쿠팡 문의 답변은 WING 로그인 아이디를 넣어야 켤 수 있어요.' };
      if (!verifyAdminPassword(user, password)) return { error: '관리자 비밀번호가 맞지 않아요.' };
      db.prepare(`UPDATE channel_keys SET ${kind}_on = 1, updated_at = datetime('now') WHERE channel = ?`).run(ch);
      log(ch, user && user.id, `실제로 켬: ${def.switches[kind]}`);
      applyChannel(ch);
      return { ok: true };
    },
    switchOff(ch, kind, userId) {
      const def = CHANNELS[ch];
      if (!def || !def.switches[kind] || envManaged(ch)) return { error: '여기서 바꿀 수 없는 스위치예요.' };
      db.prepare(`UPDATE channel_keys SET ${kind}_on = 0, updated_at = datetime('now') WHERE channel = ?`).run(ch);
      log(ch, userId, `연습 모드로: ${def.switches[kind]}`);
      applyChannel(ch);
      return { ok: true };
    },
    // 지우기: 키를 지우고 수집·처리도 뺀다 (이미 가져온 주문·문의는 그대로)
    remove(ch, userId) {
      if (!rowOf(ch) || envManaged(ch)) return { error: '판매처를 찾을 수 없어요.' };
      db.prepare('DELETE FROM channel_keys WHERE channel = ?').run(ch);
      log(ch, userId, '키 지움');
      applyChannel(ch);
      return { ok: true };
    },
  };
}

module.exports = { createChannelRegistry, CHANNELS, testError };
