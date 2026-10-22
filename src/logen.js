// 로젠 송장 흐름 (로젠 안내 메일의 순서 그대로)
//   ① 관리자 › 로젠 설정: 계약정보·계약운임 조회 → 보내는 분·기본 박스 저장
//   ② 주문 목록 › [로젠 등록]: 주문번호 묶음 하나 = 송장 하나로 registerOrderData
//   ③ 직원이 iLOGEN '주문등록출력(복수건)' 에서 출력 (출력해야 송장번호가 생김)
//   ④ [송장번호 가져오기]: inquirySlipNoMulti → 발송처리 칸에 송장번호를 미리 채움
//   ⑤ 주문 카드 › [배송 조회]: inquiryCargoTrackingMulti (누를 때만)
//
// 로젠 요청: 한 번에 10건 안팎, 차례대로(동시에 여러 개 X), 호출 사이 몇 초씩 쉬기
//   → 모든 로젠 호출은 call() 한 줄로 줄 세워 보내고, 호출 사이에 GAP_MS 를 쉰다
// 테스트 서버(LOGEN_ENV 가 prod 가 아님)는 로젠 문서의 연습용 거래처 코드로 보내고, 고객 정보 대신 연습용 정보를 보낸다
const { createLogenClient, TEST_CODES } = require('./channels/logen');
const { getSetting, setSetting } = require('./collector');
const { claimLevel } = require('./channels/labels');

const BATCH = 10;
const GAP_MS = 3000;
const TRACK_CACHE_MS = 5 * 60 * 1000; // 배송 조회는 5분 안에 다시 누르면 저장해 둔 결과를 보여준다
const SLIP_DAYS = 30; // 송장번호는 등록한 지 30일 안의 주문만 찾는다
// 테스트 서버에 보낼 연습용 받는 분 (로젠 문서 예시)
const PRACTICE_RECEIVER = { name: '테스트고객', addr: '충남 부여군 은산면 내지리 123-1', tel: '01012345678' };

const digits = v => String(v || '').replace(/\D/g, '');
const kstYmd = d => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const clip = (v, n) => String(v || '').slice(0, n);

function readJson(db, key, fallback) {
  try { return JSON.parse(getSetting(db, key) || '') || fallback; } catch { return fallback; }
}

function clientFromEnv() {
  const env = process.env.LOGEN_ENV === 'prod' ? 'prod' : 'dev';
  const secretKey = process.env.LOGEN_SECRET_KEY;
  return createLogenClient({
    env,
    secretKey,
    ...(env === 'dev' ? TEST_CODES : {}),
    allowWrite: process.env.LOGEN_WRITE === 'on',
  });
}

// client: 로젠 연결 (테스트에서는 가짜), gapMs: 호출 사이 쉬는 시간
function createLogen({ db, client = clientFromEnv(), gapMs = GAP_MS, now = () => new Date() } = {}) {
  const env = client.env;

  // ── 줄 세워 보내기: 앞 호출이 끝나고 gapMs 가 지나야 다음 호출 ──
  let chain = Promise.resolve();
  let lastAt = 0;
  function call(name, rows) {
    const run = chain.then(async () => {
      const wait = lastAt + gapMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      try {
        return await client.request(name, rows);
      } finally {
        lastAt = Date.now();
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  // ── 설정 ──
  const sender = () => readJson(db, 'logen_sender', { name: '', addr: '', tel: '' });
  const contract = () => readJson(db, 'logen_contract', null);
  const boxCd = () => getSetting(db, 'logen_box') || '';
  function settings() {
    const c = contract();
    const box = c && c.env === env ? (c.boxes || []).find(b => b.cd === boxCd()) || null : null;
    const s = sender();
    const missing = [];
    if (!c || c.env !== env) missing.push('계약 정보 불러오기');
    if (!s.name || !s.addr || !s.tel) missing.push('보내는 분');
    if (!box) missing.push('기본 박스');
    return { env, sender: s, contract: c && c.env === env ? c : null, box, ready: missing.length === 0, missing };
  }

  // 계약정보 → 계약운임 (관리자 › 로젠 설정의 [계약 정보 불러오기])
  async function loadContract() {
    const body = await call('contractTotalInfo', [{}]);
    const c = body && Array.isArray(body.data) ? body.data[0] : null;
    if (!c || c.resultCd === 'FALSE') throw new Error((c && c.resultMsg) || (body && body.sttsMsg) || '계약 정보가 없습니다');
    const fares = await call('contPickFares', [{ fareTy: c.fareTy }]);
    const f = fares && Array.isArray(fares.data) ? fares.data[0] : null;
    const boxes = ((f && (f.data1 || f.data)) || []).map(b => ({ cd: b.boxTyCd, nm: b.boxTyNm, fare: Number(b.dlvFare) || 0 }));
    const saved = {
      env, at: now().toISOString(), salesNm: c.pickSalesNm, branNm: c.pickBranNm, fareTy: c.fareTy, fareTyNm: c.fareTyNm, useYn: c.useYn, boxes,
    };
    setSetting(db, 'logen_contract', JSON.stringify(saved));
    // 박스가 하나뿐이거나 고른 박스가 없어졌으면 첫 박스로
    if (boxes.length && !boxes.some(b => b.cd === boxCd())) setSetting(db, 'logen_box', boxes[0].cd);
    return saved;
  }

  function saveSettings({ name, addr, tel, box }) {
    name = clip(String(name || '').trim(), 50);
    addr = clip(String(addr || '').trim(), 300);
    tel = digits(tel);
    if (!name || !addr) return { error: '보내는 분 이름과 주소를 넣어 주세요.' };
    if (tel.length < 9 || tel.length > 12) return { error: '보내는 분 전화번호를 확인해 주세요 (숫자 9~12자리).' };
    const c = contract();
    if (box && !(c && (c.boxes || []).some(b => b.cd === box))) return { error: '박스 종류를 다시 골라 주세요.' };
    setSetting(db, 'logen_sender', JSON.stringify({ name, addr, tel }));
    if (box) setSetting(db, 'logen_box', box);
    return { ok: true };
  }

  // ── 등록 상태 ──
  const latestStmt = db.prepare(`
    SELECT * FROM logen_shipments WHERE channel = ? AND channel_order_id = ? AND env = ? ORDER BY id DESC LIMIT 1
  `);
  const shipmentOf = (channel, orderId) => latestStmt.get(channel, orderId, env) || null;
  const waitingStmt = db.prepare(`
    SELECT s.* FROM logen_shipments s
    WHERE s.env = ? AND s.status = 'registered' AND s.slip_no IS NULL AND s.created_at >= datetime('now', ?)
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.channel = s.channel AND o.channel_order_id = s.channel_order_id AND o.shipped_at IS NOT NULL)
    ORDER BY s.id
  `);
  const waiting = () => waitingStmt.all(env, `-${SLIP_DAYS} days`);

  // 로젠에 등록할 수 있는 주문 묶음: 결제완료(입금완료) 상품이 있고, 취소·반품 요청 중이 아니고, 아직 발송·등록 전
  function canRegister(items) {
    if (!items.some(i => i.channel_status === 'PAYED')) return false;
    if (items.some(i => claimLevel(i.claim_status) === 'open' || i.shipped_at)) return false;
    const s = shipmentOf(items[0].channel, items[0].channel_order_id);
    return !(s && s.status === 'registered');
  }

  // 같은 주문번호를 다시 등록할 때(iLOGEN 에서 지운 뒤)는 뒤에 -2, -3 을 붙인다
  function nextTakeNo(channel, orderId) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM logen_shipments WHERE channel = ? AND channel_order_id = ? AND env = ?').get(channel, orderId, env).n;
    return n ? `${orderId}-${n + 1}` : String(orderId);
  }

  function orderRow(items, takeNo, s) {
    const main = items[0];
    const practice = env !== 'prod';
    const phone = practice ? PRACTICE_RECEIVER.tel : digits(main.receiver_phone);
    const qty = items.reduce((sum, i) => sum + (Number(i.quantity) || 1), 0);
    return {
      takeDt: kstYmd(now()),
      slipNo: '',
      fixTakeNo: takeNo,
      sndCustNm: s.sender.name,
      sndCustAddr: s.sender.addr,
      sndTelNo: s.sender.tel,
      rcvCustNm: practice ? PRACTICE_RECEIVER.name : clip(main.receiver_name, 50),
      rcvCustAddr: practice ? PRACTICE_RECEIVER.addr : clip(main.receiver_address, 300),
      rcvTelNo: phone,
      rcvCellNo: phone.startsWith('01') ? phone : '',
      fareTy: s.contract.fareTy,
      boxTyCd: s.box.cd,
      qty: 1,
      dlvFare: s.box.fare,
      goodsNm: clip(`${main.product_name}${items.length > 1 ? ` 외 ${items.length - 1}건` : ''}`, 200),
      goodsOpt: clip(main.option_text, 200),
      inQty: Math.min(qty, 999),
    };
  }

  // groups: [items, ...] (같은 주문번호의 상품 목록). 결과: { done, failed: [{name, message}], skipped: [{name, reason}], error }
  let busy = false;
  async function register(groups, userId) {
    const s = settings();
    if (!s.ready) return { error: `관리자 › 로젠 설정에서 먼저 정해 주세요: ${s.missing.join(', ')}` };
    if (busy) return { error: '다른 직원이 지금 로젠에 등록하고 있어요. 잠시 뒤에 다시 눌러 주세요.' };
    busy = true;
    try {
      const skipped = [];
      const todo = [];
      const seen = new Set();
      for (const items of groups) {
        const main = items[0];
        // 같은 주문번호를 두 번 골라도 한 번만 보낸다
        const key = `${main.channel}:${main.channel_order_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!canRegister(items)) { skipped.push({ name: main.product_name, reason: '이미 등록·발송했거나 결제완료가 아님' }); continue; }
        if (env === 'prod' && (!main.receiver_name || !main.receiver_address || digits(main.receiver_phone).length < 9)) {
          skipped.push({ name: main.product_name, reason: '받는 분 이름·주소·전화번호가 없음' });
          continue;
        }
        todo.push({ items, takeNo: nextTakeNo(main.channel, main.channel_order_id) });
      }
      let done = 0;
      const failed = [];
      const insert = db.prepare('INSERT OR IGNORE INTO logen_shipments (channel, channel_order_id, env, take_no, user_id) VALUES (?, ?, ?, ?, ?)');
      for (const part of chunk(todo, BATCH)) {
        let body;
        try {
          body = await call('registerOrderData', part.map(t => orderRow(t.items, t.takeNo, s)));
        } catch (e) {
          part.forEach(t => failed.push({ name: t.items[0].product_name, message: e.message }));
          if (e.notSent) break; // 스위치가 꺼져 있으면 나머지도 보내지 않는다
          continue;
        }
        const results = new Map(((body && body.data) || []).map(r => [String(r.fixTakeNo), r]));
        for (const t of part) {
          const r = results.get(t.takeNo);
          if (r && r.resultCd === 'TRUE') {
            insert.run(t.items[0].channel, t.items[0].channel_order_id, env, t.takeNo, userId || null);
            done += 1;
          } else {
            failed.push({ name: t.items[0].product_name, message: (r && r.resultMsg) || (body && body.sttsMsg) || '로젠 응답에 결과가 없습니다' });
          }
        }
      }
      return { done, failed, skipped };
    } finally {
      busy = false;
    }
  }

  // 출력한 송장번호 가져오기. only: [[channel, orderId]] 를 주면 그 주문만
  async function fetchSlips(only = null) {
    let rows = waiting();
    if (only) {
      const keys = new Set(only.map(([c, o]) => `${c}:${o}`));
      rows = rows.filter(r => keys.has(`${r.channel}:${r.channel_order_id}`));
    }
    rows = rows.slice(0, 50); // 한 번에 최대 50건 (10건씩 5번)
    let found = 0;
    let deleted = 0;
    const setSlip = db.prepare("UPDATE logen_shipments SET slip_no = ?, slip_at = datetime('now') WHERE id = ?");
    const setDeleted = db.prepare("UPDATE logen_shipments SET status = 'deleted' WHERE id = ?");
    for (const part of chunk(rows, BATCH)) {
      const body = await call('inquirySlipNoMulti', part.map(r => ({ fixTakeNo: r.take_no })));
      const byTake = new Map(((body && body.data) || []).map(d => [String(d.fixTakeNo), d]));
      for (const r of part) {
        const d = byTake.get(r.take_no);
        const slips = (d && d.data1) || [];
        const live = slips.filter(x => x.slipNo && x.delYn !== 'Y');
        if (live.length) {
          setSlip.run(digits(live[0].slipNo), r.id);
          found += 1;
        } else if (slips.length && slips.every(x => x.delYn === 'Y')) {
          setDeleted.run(r.id);
          deleted += 1;
        }
      }
    }
    return { checked: rows.length, found, deleted, waiting: rows.length - found - deleted };
  }

  // 배송 조회 (송장번호 하나). 5분 안에 다시 누르면 저장해 둔 결과
  async function track(slipNo, { channel, orderId } = {}) {
    slipNo = digits(slipNo);
    if (slipNo.length < 10 || slipNo.length > 12) throw new Error('로젠 송장번호가 아닙니다.');
    const cached = db.prepare('SELECT track_json, track_at FROM logen_shipments WHERE slip_no = ? AND env = ? ORDER BY id DESC LIMIT 1').get(slipNo, env);
    if (cached && cached.track_at && now() - new Date(`${cached.track_at.replace(' ', 'T')}Z`) < TRACK_CACHE_MS) {
      return { events: JSON.parse(cached.track_json || '[]'), at: cached.track_at, cached: true };
    }
    const body = await call('inquiryCargoTrackingMulti', [{ slipNo }]);
    const d = body && Array.isArray(body.data) ? body.data[0] : null;
    if (d && d.resultCd === 'FALSE' && !(d.data1 || []).length) throw new Error(d.resultMsg || '배송 정보가 아직 없습니다.');
    const events = ((d && d.data1) || []).map(e => ({
      at: e.scanDt ? `${e.scanDt.slice(0, 4)}-${e.scanDt.slice(4, 6)}-${e.scanDt.slice(6, 8)} ${String(e.scanTm || '').slice(0, 2)}:${String(e.scanTm || '').slice(2, 4)}` : '',
      stat: e.statNm || '', place: e.branNm || e.salesNm || '', who: e.acptorTyNm || '',
    }));
    // 우리 주문에 붙은 송장이면 결과를 저장 (없으면: 직접 입력한 로젠 송장 → 그 주문에 조회 기록용 줄을 만든다)
    const row = db.prepare('SELECT id FROM logen_shipments WHERE slip_no = ? AND env = ? ORDER BY id DESC LIMIT 1').get(slipNo, env);
    if (row) db.prepare("UPDATE logen_shipments SET track_json = ?, track_at = datetime('now') WHERE id = ?").run(JSON.stringify(events), row.id);
    else if (channel && orderId) {
      db.prepare(`INSERT OR IGNORE INTO logen_shipments (channel, channel_order_id, env, take_no, status, slip_no, slip_at, track_json, track_at)
        VALUES (?, ?, ?, ?, 'manual', ?, datetime('now'), ?, datetime('now'))`).run(channel, orderId, env, `manual:${slipNo}`, slipNo, JSON.stringify(events));
    }
    return { events, at: null, cached: false };
  }

  // 화면용: 마지막 조회 결과
  function lastTrack(slipNo) {
    const r = db.prepare('SELECT track_json, track_at FROM logen_shipments WHERE slip_no = ? AND env = ? AND track_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(digits(slipNo), env);
    return r ? { events: JSON.parse(r.track_json || '[]'), at: r.track_at } : null;
  }

  return {
    env, hasKey: client.hasKey !== false, call, settings, loadContract, saveSettings, shipmentOf, waiting, canRegister, register, fetchSlips, track, lastTrack,
    writeOn: env !== 'prod' || client.allowWrite === true,
  };
}

module.exports = { createLogen, BATCH, GAP_MS };
