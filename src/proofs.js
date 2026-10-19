// 시안 컨펌: 시안 올리기 → 고객에게 링크 문자 → 고객 확정 / 수정 요청 → 주문 카드 단계 이동 + 알림
// 화면(라우트)과 분리해 두어 테스트에서 바로 부를 수 있다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { transaction } = require('./db');
const { normalizePhone } = require('./sms');

const MAX_UPLOAD_MB = 30;
const EXPIRE_DAYS = 30;

const STATUS_LABELS = {
  waiting: '확인 대기',
  revise: '수정 요청',
  approved: '확정',
  closed: '종료',
};

// 올릴 수 있는 이미지: 파일 앞부분(매직 넘버)으로 판단한다. 확장자는 믿지 않는다
function detectImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' };
  }
  return null;
}

const clean = (value, max) => {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : null;
};

// 이미지 위에 찍은 표시: [{x, y, note}] 만 받고 나머지는 버린다
function parsePins(raw) {
  let list;
  try {
    list = JSON.parse(String(raw || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map(p => ({
    x: Math.min(1, Math.max(0, Number(p && p.x) || 0)),
    y: Math.min(1, Math.max(0, Number(p && p.y) || 0)),
    note: clean(p && p.note, 200) || '',
  }));
}

function createProofService({ db, sms, dir, env = process.env, now = () => new Date() }) {
  fs.mkdirSync(dir, { recursive: true });
  const expireDays = Math.max(1, Number(env.PROOF_EXPIRE_DAYS) || EXPIRE_DAYS);

  const sqlTime = d => d.toISOString().replace('T', ' ').slice(0, 19);
  const expiresAt = () => sqlTime(new Date(now().getTime() + expireDays * 86400000));
  const setting = key => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? Number(row.value) : null;
  };

  const getProof = id => db.prepare(`
    SELECT p.*, u.name AS created_by_name, o.channel_order_id, o.product_name, o.stage_id AS order_stage_id
    FROM proofs p LEFT JOIN users u ON u.id = p.created_by LEFT JOIN orders o ON o.id = p.order_id
    WHERE p.id = ?`).get(Number(id));
  const getByToken = token => db.prepare('SELECT * FROM proofs WHERE token = ?').get(String(token));
  const versions = proofId => db.prepare(`
    SELECT v.*, u.name AS uploaded_by_name FROM proof_versions v LEFT JOIN users u ON u.id = v.uploaded_by
    WHERE v.proof_id = ? ORDER BY v.version_no`).all(proofId);
  const latestVersion = proofId =>
    db.prepare('SELECT * FROM proof_versions WHERE proof_id = ? ORDER BY version_no DESC LIMIT 1').get(proofId);
  const getVersion = (proofId, no) =>
    db.prepare('SELECT * FROM proof_versions WHERE proof_id = ? AND version_no = ?').get(proofId, Number(no));
  const responses = proofId => db.prepare(`
    SELECT r.*, v.version_no FROM proof_responses r JOIN proof_versions v ON v.id = r.version_id
    WHERE r.proof_id = ? ORDER BY r.id`).all(proofId).map(r => ({ ...r, pins: parsePins(r.pins) }));

  const isExpired = proof => new Date(proof.expires_at.replace(' ', 'T') + 'Z') < now();

  // 주문 카드가 연결돼 있으면 설정된 단계로 옮긴다 (숨긴 단계로는 옮기지 않음)
  function moveOrder(proof, settingKey) {
    if (!proof.order_id) return;
    const stageId = setting(settingKey);
    if (!stageId) return;
    const stage = db.prepare('SELECT id FROM work_stages WHERE id = ? AND active = 1').get(stageId);
    if (!stage) return;
    db.prepare("UPDATE orders SET stage_id = ?, updated_at = datetime('now') WHERE id = ?").run(stage.id, proof.order_id);
  }

  function saveFile(file) {
    const kind = detectImage(file && file.buffer);
    if (!kind) throw new UserError('JPG, PNG, WEBP 이미지만 올릴 수 있습니다. 일러스트에서 [내보내기 → JPG] 로 저장해 주세요.');
    const fileName = crypto.randomBytes(16).toString('hex') + kind.ext;
    fs.writeFileSync(path.join(dir, fileName), file.buffer);
    return { fileName, mime: kind.mime };
  }

  const filePath = version => path.join(dir, path.basename(version.file_name));

  function customerMessage(proof, versionNo, link) {
    const who = proof.customer_name ? `${proof.customer_name}님, ` : '';
    const what = versionNo > 1
      ? `'${proof.title}' 수정 시안(${versionNo}차)이 올라왔습니다.`
      : `'${proof.title}' 시안이 준비되었습니다.`;
    return `[브로애드] ${who}${what} 확인 후 확정 또는 수정 요청 부탁드립니다.\n${link}`;
  }

  async function sendLink(proof, versionNo, baseUrl) {
    if (!proof.customer_phone) return { ok: false, result: '고객 전화번호가 없어 문자를 보내지 않았습니다.' };
    return sms.sendSms(proof.customer_phone, customerMessage(proof, versionNo, linkFor(proof, baseUrl)), { proofId: proof.id });
  }

  const linkFor = (proof, baseUrl) => `${String(env.PUBLIC_BASE_URL || baseUrl).replace(/\/+$/, '')}/p/${proof.token}`;

  // 새 시안 만들기 (1차 이미지 포함)
  async function create({ user, fields, file, baseUrl, sendSms = true }) {
    const title = clean(fields.title, 100);
    if (!title) throw new UserError('시안 이름을 입력하세요. (예: ○○식당 현수막 5000x900)');
    const orderId = Number(fields.order_id) || null;
    const order = orderId ? db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) : null;
    if (orderId && !order) throw new UserError('연결할 주문을 찾을 수 없습니다.');
    // 비워 두면 주문의 받는 사람 정보를 쓴다
    const customerName = clean(fields.customer_name, 50) || (order && (order.receiver_name || order.buyer_name)) || null;
    const phoneRaw = clean(fields.customer_phone, 30) || (order && order.receiver_phone) || null;
    if (phoneRaw && !normalizePhone(phoneRaw)) throw new UserError('고객 전화번호 형식이 올바르지 않습니다.');
    const saved = saveFile(file);

    const proofId = transaction(db, () => {
      const token = crypto.randomBytes(12).toString('base64url');
      const id = Number(db.prepare(`
        INSERT INTO proofs (token, order_id, title, customer_name, customer_phone, note, created_by, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        token, orderId, title, customerName, phoneRaw, clean(fields.note, 1000), user.id, expiresAt()
      ).lastInsertRowid);
      db.prepare(`INSERT INTO proof_versions (proof_id, version_no, file_name, mime, original_name, message, uploaded_by)
        VALUES (?, 1, ?, ?, ?, ?, ?)`).run(id, saved.fileName, saved.mime, clean(file.originalname, 200), clean(fields.message, 500), user.id);
      moveOrder({ order_id: orderId }, 'stage_proof_sent');
      return id;
    });
    const proof = getProof(proofId);
    const smsResult = sendSms ? await sendLink(proof, 1, baseUrl) : null;
    return { proof, smsResult };
  }

  // 수정 시안 올리기: 같은 링크에 다음 판이 쌓이고, 다시 '확인 대기' 가 된다
  async function addVersion({ proof, user, fields, file, baseUrl, sendSms = true }) {
    const saved = saveFile(file);
    const versionNo = transaction(db, () => {
      const no = (latestVersion(proof.id) || { version_no: 0 }).version_no + 1;
      db.prepare(`INSERT INTO proof_versions (proof_id, version_no, file_name, mime, original_name, message, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(proof.id, no, saved.fileName, saved.mime, clean(file.originalname, 200), clean(fields.message, 500), user.id);
      db.prepare(`UPDATE proofs SET status = 'waiting', decided_at = NULL, decided_name = NULL,
        expires_at = ?, updated_at = datetime('now') WHERE id = ?`).run(expiresAt(), proof.id);
      moveOrder(proof, 'stage_proof_sent');
      return no;
    });
    const fresh = getProof(proof.id);
    const smsResult = sendSms ? await sendLink(fresh, versionNo, baseUrl) : null;
    return { proof: fresh, versionNo, smsResult };
  }

  // 고객이 지금 응답할 수 있는 상태인지. 아니면 이유 문구를 돌려준다
  function closedReason(proof) {
    if (proof.status === 'closed') return '종료된 시안입니다. 브로애드로 문의해 주세요.';
    if (isExpired(proof)) return '링크 사용 기간이 지났습니다. 브로애드로 문의해 주세요.';
    return null;
  }

  async function notifyStaff(proof, type, text) {
    db.prepare('INSERT INTO notifications (type, message, order_id) VALUES (?, ?, ?)').run(type, text, proof.order_id || null);
    await Promise.all(sms.notifyPhones.map(phone => sms.sendSms(phone, text, { proofId: proof.id })));
  }

  // 고객 응답 (확정 / 수정 요청). versionNo 는 고객 화면에 떠 있던 판 번호
  async function respond({ proof, action, versionNo, name, comment, pins, agreed }) {
    const reason = closedReason(proof);
    if (reason) throw new UserError(reason);
    const latest = latestVersion(proof.id);
    if (!latest || latest.version_no !== Number(versionNo)) {
      throw new UserError('새 시안이 올라왔습니다. 화면을 새로고침해서 최신 시안을 확인해 주세요.');
    }
    if (proof.status !== 'waiting') {
      throw new UserError(proof.status === 'approved' ? '이미 확정된 시안입니다.' : '이미 수정 요청을 보냈습니다. 수정 시안이 올라오면 문자로 알려드립니다.');
    }
    const who = clean(name, 50);
    const text = clean(comment, 2000);
    const pinList = action === 'revise' ? parsePins(pins) : [];

    if (action === 'approve') {
      if (!who) throw new UserError('확정하시는 분 성함을 입력해 주세요.');
      if (!agreed) throw new UserError('문구·전화번호·규격 확인에 체크해 주세요.');
    } else if (action === 'revise') {
      if (!text && !pinList.some(p => p.note)) throw new UserError('수정할 내용을 적어 주세요.');
    } else {
      throw new UserError('알 수 없는 요청입니다.');
    }

    // 동시에 두 번 눌러도 한 번만 처리되게, 상태가 '확인 대기' 일 때만 바꾼다
    const changed = transaction(db, () => {
      const result = action === 'approve'
        ? db.prepare(`UPDATE proofs SET status = 'approved', decided_at = datetime('now'), decided_name = ?,
            updated_at = datetime('now') WHERE id = ? AND status = 'waiting'`).run(who, proof.id)
        : db.prepare(`UPDATE proofs SET status = 'revise', updated_at = datetime('now')
            WHERE id = ? AND status = 'waiting'`).run(proof.id);
      if (result.changes === 0) return false;
      db.prepare('INSERT INTO proof_responses (proof_id, version_id, action, name, comment, pins) VALUES (?, ?, ?, ?, ?, ?)')
        .run(proof.id, latest.id, action, who, text, pinList.length ? JSON.stringify(pinList) : null);
      moveOrder(proof, action === 'approve' ? 'stage_proof_approved' : 'stage_proof_revise');
      return true;
    });
    if (!changed) throw new UserError('이미 처리된 시안입니다. 화면을 새로고침해 주세요.');

    const ver = latest.version_no > 1 ? ` (${latest.version_no}차)` : '';
    if (action === 'approve') {
      await notifyStaff(proof, 'proof_approved', `[시안확정] ${proof.title}${ver} - ${who}님 확정`);
    } else {
      const summary = text || pinList.map(p => p.note).filter(Boolean).join(' / ');
      const short = summary.length > 40 ? summary.slice(0, 40) + '…' : summary;
      await notifyStaff(proof, 'proof_revise', `[수정요청] ${proof.title}${ver} - ${short}`);
    }
    return getProof(proof.id);
  }

  function close(proof) {
    db.prepare("UPDATE proofs SET status = 'closed', updated_at = datetime('now') WHERE id = ?").run(proof.id);
  }

  function list(status) {
    const where = STATUS_LABELS[status] ? 'WHERE p.status = ?' : '';
    const rows = db.prepare(`
      SELECT p.*, u.name AS created_by_name, o.channel_order_id,
        (SELECT MAX(version_no) FROM proof_versions v WHERE v.proof_id = p.id) AS version_count
      FROM proofs p LEFT JOIN users u ON u.id = p.created_by LEFT JOIN orders o ON o.id = p.order_id
      ${where} ORDER BY CASE p.status WHEN 'revise' THEN 0 WHEN 'waiting' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
        p.updated_at DESC LIMIT 300`);
    return where ? rows.all(status) : rows.all();
  }

  const counts = () => Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM proofs GROUP BY status').all().map(r => [r.status, r.n])
  );

  return {
    create, addVersion, respond, close, list, counts, sendLink, linkFor, closedReason, isExpired,
    getProof, getByToken, versions, latestVersion, getVersion, responses, filePath,
  };
}

// 사용자에게 그대로 보여줘도 되는 오류 (입력 실수 등)
class UserError extends Error {}

module.exports = { createProofService, UserError, STATUS_LABELS, MAX_UPLOAD_MB, detectImage, parsePins };
