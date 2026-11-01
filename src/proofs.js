// 시안확정서·작업지시서
//
// 디자이너가 주문 카드에서 확정 시안(그림)을 올리고, 수정 횟수·소재·실제 사이즈·배송방법을 적는다.
// 그걸로 A4 한 장짜리 출력실용 작업지시서(그리고 다음 단계에서 고객용 시안확정서)를 만든다.
//
// 시안 그림은 DB 가 아니라 서버 폴더(data/proofs)에 파일로 둔다 → DB 와 매일 백업이 커지지 않게.
// 주문이 지워지거나, 끝난 지 3개월이 지나 개인정보를 지운 주문의 시안은 함께 지운다 (sweep).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DB_PATH } = require('./db');
const { imageType } = require('./brand');
const { getSetting } = require('./collector');

const MAX_IMAGE = 20 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const FILE_RE = /^[0-9a-f]{24}\.(png|jpg|webp)$/;
// 배송방법 고르는 칸 (출력실이 보는 글자 그대로 저장)
const SHIP_CHOICES = ['택배', '퀵서비스', '방문수령', '화물', '직접전달'];
// 담당 디자이너 옆에 적는 회사 연락처 (관리자 화면에서 바꾸는 칸은 고객용을 만들 때 함께)
const DEFAULT_PHONE = '031-822-7815';

// ───────── 옵션 글자 다루기 ─────────

// 옵션 항목 이름 정리: 앞 번호(①④), ★, '(미선택시 …)' 같은 안내 괄호를 지운다
//   '④ 디자인 작업 의뢰' → '디자인 작업 의뢰', '★볼터치 무료옵션★' → '볼터치 무료옵션'
//   '모양재단(미선택경우 사각재단)' → '모양재단', '문구 변경 및 파일접수 (필수입력)' → '문구 변경 및 파일접수'
function cleanLabel(label) {
  return String(label || '')
    .replace(/[①-⑳❶-❿]/g, '')
    .replace(/[★☆]/g, '')
    .replace(/\s*\([^()]*(미선택|미신청|필수)[^()]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// '항목: 값' → { label, value }. 쌍점이 없으면 항목 이름 없이 값만
function splitLabel(part) {
  const text = String(part || '').trim();
  const i = text.indexOf(': ');
  if (i < 0) return { label: '', value: text };
  return { label: text.slice(0, i).trim(), value: text.slice(i + 2).trim() };
}

// 본상품 옵션 한 줄 → 조각들. 스마트스토어는 ' / ' 로 잇는다
const optionParts = text => String(text || '').split(' / ').map(splitLabel).filter(p => p.value);

// '선택안함' 같은 값은 보여 주지 않는다
const isNone = value => /^(선택\s*안\s*함|선택\s*안\s*하기|미선택|없음|해당\s*없음)$/.test(String(value || '').replace(/[()]/g, '').trim());

// 추가옵션 줄: [{ value, label, qty }]. 추가상품은 상품 이름 = 고른 값, 옵션 = '항목: 값'
function addonLines(items) {
  return items.filter(i => i.item_type === 'addon').map(i => {
    const { label, value } = i.option_text ? splitLabel(i.option_text) : { label: '', value: '' };
    return { value: value || i.product_name, label: cleanLabel(label), qty: Number(i.quantity) || 1 };
  }).filter(a => a.value && !isNone(a.value));
}

// 소재·두께 짐작 (디자이너 입력 칸에 미리 채우는 값): 옵션에 '소재' 항목이 있으면 그 값, 없으면 상품 이름에서 찾는다
const MATERIAL_RE = /(포맥스|폼보드|우드락|아크릴|PVC\s?캘지|캘지|페트|현수막|타포린|시트지|합판|아트지|스노우지|모조지|투명\s?PET)\s*(\d+(?:\.\d+)?\s?(?:T|t|mm)\b)?/;
function guessMaterial(item) {
  if (!item) return '';
  const part = optionParts(item.option_text).find(p => /소재|재질/.test(p.label) && !isNone(p.value));
  if (part) return part.value;
  const m = MATERIAL_RE.exec(`${item.product_name || ''} ${item.option_text || ''}`);
  if (!m) return '';
  return m[2] ? `${m[1]} ${m[2].replace(/\s/g, '').replace(/t$/, 'T')}` : m[1];
}

// 실제 사이즈 짐작: 옵션·상품 이름에 단위(cm·mm)가 붙은 정확한 크기가 있을 때만 (예: 90x120(cm), 420x594mm)
//   '81~100cm' 같은 가격 구간은 실제 크기가 아니라 건너뛴다. 결과는 cm, 긴 쪽 먼저
const SIZE_RE = /(^|[^\d~.])(\d+(?:\.\d+)?)\s*[x×X*]\s*(\d+(?:\.\d+)?)\s*\(?\s*(cm|mm)/i;
function guessSize(item) {
  if (!item) return { long: '', short: '' };
  for (const text of [item.option_text, item.product_name]) {
    const m = SIZE_RE.exec(String(text || ''));
    if (!m) continue;
    const k = m[4].toLowerCase() === 'mm' ? 0.1 : 1;
    const [a, b] = [Number(m[2]) * k, Number(m[3]) * k].map(n => String(Math.round(n * 10) / 10));
    return Number(a) >= Number(b) ? { long: a, short: b } : { long: b, short: a };
  }
  return { long: '', short: '' };
}

// 고객 요청: 배송 메시지 + 옵션 중 '요청' 이 들어간 항목 (예: '추가 요청사항: 내용은 톡톡')
function customerRequests(items) {
  const lines = [];
  const memo = items.map(i => i.ship_memo).find(Boolean);
  if (memo) lines.push(memo);
  for (const i of items) {
    for (const p of optionParts(i.option_text)) {
      if (/요청/.test(p.label) && !isNone(p.value) && !/^[.\-x×]$/i.test(p.value)) lines.push(`${cleanLabel(p.label)}: ${p.value}`);
    }
  }
  return [...new Set(lines)];
}

// 납기 D-day: 납기(직원이 정한 날)가 없으면 채널 발송기한 날짜. 오늘·내일이면 hot (빨강)
const kstDate = ms => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
function dueView(order, items, now = new Date()) {
  let date = order.due_date || null;
  let from = '납기';
  if (!date) {
    const due = items.filter(i => i.channel_status === 'PAYED' && i.ship_due).map(i => i.ship_due).sort()[0];
    if (due && Number.isFinite(Date.parse(due))) { date = kstDate(Date.parse(due)); from = '발송기한'; }
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  const diff = Math.round((d.getTime() - Date.parse(`${kstDate(now.getTime())}T00:00:00Z`)) / 86400000);
  const dday = diff === 0 ? 'D-day' : diff > 0 ? `D-${diff}` : `D+${-diff} 지남`;
  return { date, from, text: `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${WEEK[d.getUTCDay()]})`, dday, hot: diff <= 1 };
}

// 사이즈 숫자 칸: 비우거나, 0보다 큰 숫자(소수점 한 자리까지)만
function cleanSize(value) {
  const text = String(value || '').trim().replace(',', '.');
  if (!text) return { value: null };
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text) || Number(text) <= 0) return { error: '사이즈는 cm 숫자로 적어 주세요. (예: 160, 59.4)' };
  return { value: String(Number(text)) };
}

// ───────── 저장소 ─────────

function proofDirOf() {
  return process.env.PROOF_DIR || path.join(path.dirname(DB_PATH), 'proofs');
}

function createProofs({ db, dir = proofDirOf() }) {
  const getStmt = db.prepare('SELECT * FROM proof_sheets WHERE channel = ? AND channel_order_id = ?');
  const fileOf = name => (FILE_RE.test(String(name || '')) ? path.join(dir, name) : null);
  const removeFile = name => {
    const file = fileOf(name);
    if (file) fs.rm(file, { force: true }, () => {});
  };

  return {
    dir,
    get: order => getStmt.get(order.channel, order.channel_order_id) || null,

    // 저장: fields = { revision, material, size_long, size_short, ship_method }, image = Buffer (없으면 그림은 그대로)
    // 새 시안을 올렸는데 수정 횟수 칸을 그대로 두었으면 +1 (처음 올리면 0)
    save(order, fields, image, userId) {
      const old = getStmt.get(order.channel, order.channel_order_id);
      let type = null;
      if (image && image.length) {
        if (image.length > MAX_IMAGE) return { error: `시안 그림은 ${MAX_IMAGE / 1024 / 1024}MB 이하로 올려 주세요.` };
        type = imageType(image);
        if (!type) return { error: 'PNG·JPG·WEBP 그림만 올릴 수 있습니다. (PDF·AI 파일은 JPG 로 내보내 주세요)' };
      }
      const long = cleanSize(fields.size_long);
      const short = cleanSize(fields.size_short);
      if (long.error || short.error) return { error: long.error || short.error };
      let sizes = [long.value, short.value];
      if (sizes[0] && sizes[1] && Number(sizes[1]) > Number(sizes[0])) sizes = [sizes[1], sizes[0]]; // 긴 쪽 먼저
      const given = String(fields.revision ?? '').trim();
      if (given && !/^\d{1,3}$/.test(given)) return { error: '수정 횟수는 0 이상의 숫자로 적어 주세요.' };
      let revision = given ? Number(given) : old ? old.revision : 0;
      if (type && old && old.image_file && revision === old.revision) revision += 1;
      const ship = SHIP_CHOICES.includes(fields.ship_method) ? fields.ship_method : null;
      const material = String(fields.material || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;

      let file = old ? old.image_file : null;
      if (type) {
        fs.mkdirSync(dir, { recursive: true });
        file = `${crypto.randomBytes(12).toString('hex')}.${EXT[type]}`;
        fs.writeFileSync(path.join(dir, file), image);
      }
      db.prepare(`
        INSERT INTO proof_sheets (channel, channel_order_id, image_file, image_type, revision, material, size_long, size_short, ship_method, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT (channel, channel_order_id) DO UPDATE SET image_file = excluded.image_file, image_type = excluded.image_type,
          revision = excluded.revision, material = excluded.material, size_long = excluded.size_long, size_short = excluded.size_short,
          ship_method = excluded.ship_method, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run(order.channel, order.channel_order_id, file, type || (old && old.image_type) || null, revision, material, sizes[0], sizes[1], ship, userId || null);
      if (type && old && old.image_file && old.image_file !== file) removeFile(old.image_file); // 예전 시안 파일은 지운다
      return { ok: true, revision, uploaded: Boolean(type) };
    },

    // 그림 파일 읽기 (없으면 null)
    image(row) {
      const file = row && fileOf(row.image_file);
      if (!file) return null;
      try { return { type: row.image_type, data: fs.readFileSync(file) }; } catch { return null; }
    },

    // 주문이 지워졌거나 개인정보를 지운(끝난 지 3개월) 주문의 시안을 지운다. 지운 개수
    sweep() {
      const rows = db.prepare(`
        SELECT p.channel, p.channel_order_id, p.image_file FROM proof_sheets p
        WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.channel = p.channel AND o.channel_order_id = p.channel_order_id)
           OR EXISTS (SELECT 1 FROM orders o WHERE o.channel = p.channel AND o.channel_order_id = p.channel_order_id AND o.pii_cleared_at IS NOT NULL)
      `).all();
      const del = db.prepare('DELETE FROM proof_sheets WHERE channel = ? AND channel_order_id = ?');
      for (const r of rows) {
        del.run(r.channel, r.channel_order_id);
        removeFile(r.image_file);
      }
      return rows.length;
    },
  };
}

// 작업지시서에 그릴 값을 한곳에서 만든다 (화면은 그리기만)
function sheetView(db, { order, items, proof, channelName, sourceName, now = new Date() }) {
  const mains = items.filter(i => i.item_type !== 'addon');
  const main = mains[0] || items[0];
  const memoLines = customerRequests(items);
  return {
    buyer: order.buyer_name || '',
    receiver: order.receiver_name && order.receiver_name !== order.buyer_name ? order.receiver_name : '',
    channelName: sourceName ? `${channelName} · ${sourceName}` : channelName,
    orderNo: order.source_order_no || order.channel_order_id,
    designer: order.assignee_name || '',
    phone: getSetting(db, 'proof_phone') || DEFAULT_PHONE,
    revision: proof ? proof.revision : 0,
    products: mains.map(i => ({ name: i.product_name, option: i.option_text || '', qty: Number(i.quantity) || 1 })),
    productName: main ? main.product_name : '',
    material: proof && proof.material ? proof.material : '',
    size: proof && proof.size_long && proof.size_short ? `${proof.size_long} × ${proof.size_short} cm` : '',
    qty: mains.reduce((n, i) => n + (Number(i.quantity) || 0), 0),
    addons: addonLines(items),
    requests: memoLines,
    due: dueView(order, items, now),
    ship: proof && proof.ship_method ? proof.ship_method : '',
    hasImage: Boolean(proof && proof.image_file),
  };
}

module.exports = {
  createProofs, sheetView, proofDirOf,
  cleanLabel, splitLabel, optionParts, addonLines, guessMaterial, guessSize, customerRequests, dueView, cleanSize, isNone,
  SHIP_CHOICES, DEFAULT_PHONE, MAX_IMAGE,
};
