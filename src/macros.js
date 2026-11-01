// 매크로(답장 문구) 엑셀 올리기·받기와 카테고리
//
// 엑셀이 원본: 관리자가 [엑셀 받기] → 엑셀에서 고치기 → [엑셀 올리기] → 미리보기에서 확인 → 반영
//   - 줄마다 '번호' 로 인트라넷 매크로와 짝을 맞춘다 (번호가 같으면 같은 매크로)
//   - 새 번호 = 새로 추가, 같은 번호인데 글이 다름 = 고침 (둘 다 기본 체크). 체크한 것만 반영
//   - 엑셀에 없는 번호는 지우지 않는다 (지우기는 화면의 [지우기] 로만 — 엑셀을 잘못 올려 한꺼번에 사라지지 않게)
//   - 엑셀 이전부터 쓰던 '번호 없는 예전 문구' 는 절대 바꾸지 않는다. 새 매크로가 예전 문구와 겹쳐 보이면 기본으로 건너뜀
//   - 사용 횟수·마지막 사용일은 고쳐도 그대로 남는다
const { transaction } = require('./db');
const { readXlsx, writeXlsx } = require('./xlsx');
const { getSetting, setSetting } = require('./collector');

// 화면에서 지운 매크로 번호 (엑셀을 다시 올려도 기본으로 다시 넣지 않게 기억해 둔다)
function deletedNos(db) {
  const saved = getSetting(db, 'macro_deleted_nos');
  if (saved === null || saved === undefined) {
    // 처음 한 번: 이 기능 전에 지운 것 = CS 매크로 v1 로 가져온 번호(1~마지막) 중 빈 번호
    const nos = db.prepare("SELECT macro_no FROM reply_templates WHERE origin = 'cs-v1' AND macro_no IS NOT NULL").all().map(r => r.macro_no);
    const max = nos.length ? Math.max(...nos) : 0;
    const gaps = Array.from({ length: max }, (_, i) => i + 1).filter(n => !nos.includes(n));
    setSetting(db, 'macro_deleted_nos', JSON.stringify(gaps));
    return new Set(gaps);
  }
  try { return new Set((JSON.parse(saved) || []).map(Number)); } catch { return new Set(); }
}
function rememberDeleted(db, no) {
  if (!Number.isInteger(no)) return;
  const set = deletedNos(db);
  set.add(no);
  setSetting(db, 'macro_deleted_nos', JSON.stringify([...set].sort((a, b) => a - b)));
}

// 매크로를 고를 때 보이는 순서. 엑셀에 새 카테고리를 적으면 이 뒤에 붙고, 카테고리가 없는 예전 문구는 맨 뒤 '기타'
const CATEGORIES = ['첫 응대', '주문 안내', '파일', '디자인·시안', '주문·제작', '배송', '클레임', '사후관리'];
const OTHER = '기타';
const ORIGIN = 'excel';
const MAX = { title: 40, category: 20, hint: 60, subject: 100, body: 5000, rows: 500 };
const MAX_FILE = 5 * 1024 * 1024;

// 비교용: 띄어쓰기·문장부호·이모티콘을 빼고 소문자로
const squash = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// 두 글이 얼마나 비슷한지 (0~1): 글자 두 개씩 묶음이 얼마나 겹치는지
function similarity(a, b) {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = s => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1);
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let both = 0;
  for (const [g, n] of gx) both += Math.min(n, gy.get(g) || 0);
  return (2 * both) / (Math.max(1, x.length - 1) + Math.max(1, y.length - 1));
}
const SIMILAR = 0.8;

// 카테고리별로 묶기: 정해진 순서 → 엑셀에서 새로 생긴 카테고리(처음 나온 순) → 기타. 빈 카테고리는 뺀다
function groupByCategory(list) {
  const order = [...CATEGORIES];
  for (const t of list) if (t.category && !order.includes(t.category)) order.push(t.category);
  order.push(OTHER);
  const groups = new Map(order.map(c => [c, []]));
  for (const t of list) groups.get(t.category && groups.has(t.category) ? t.category : OTHER).push(t);
  return order.map(name => ({ name, items: groups.get(name) })).filter(g => g.items.length);
}

// ───────── 엑셀 → 매크로 목록 ─────────
const clean = v => String(v ?? '').replace(/\r\n?/g, '\n').trim();
const oneLine = v => clean(v).replace(/\s+/g, ' ');

// 머리줄의 칸 이름으로 어느 칸이 무엇인지 찾는다 (칸 순서가 바뀌어도 된다)
const HEADERS = {
  no: h => h === '번호',
  category: h => h.startsWith('카테고리'),
  title: h => h === '제목' || h.startsWith('제목'),
  hint: h => h.startsWith('언제'),
  body: h => h.startsWith('답변') || h.startsWith('내용'),
  subject: h => h.startsWith('메일제목'),
  origin: h => h.startsWith('출처'),
};

// 반환: { macros: [{ no, category, title, hint, body, subject, origin, row }], problems: ['3번째 줄: …'], sheet }
function parseMacroWorkbook(buf) {
  if (!buf || !buf.length) return { error: '엑셀 파일을 골라 주세요.' };
  if (buf.length > MAX_FILE) return { error: `엑셀 파일은 ${MAX_FILE / 1024 / 1024}MB 까지 올릴 수 있어요.` };
  let sheets;
  try { sheets = readXlsx(buf); } catch (e) { return { error: e.message }; }
  // '제목' 과 '답변' 칸이 있는 첫 시트 (보통 'CS 매크로 v1')
  for (const sheet of sheets) {
    const headerAt = sheet.rows.slice(0, 10).findIndex(r => r.some(c => HEADERS.title(squash(c))) && r.some(c => HEADERS.body(squash(c))));
    if (headerAt < 0) continue;
    const head = sheet.rows[headerAt].map(c => squash(c));
    const col = {};
    for (const [key, test] of Object.entries(HEADERS)) col[key] = head.findIndex(h => h && test(h));
    if (col.no < 0) return { error: `'${sheet.name}' 시트에 '번호' 칸이 없어요. 매크로마다 번호가 있어야 짝을 맞출 수 있어요.` };
    const macros = [];
    const problems = [];
    const seen = new Set();
    sheet.rows.slice(headerAt + 1).forEach((r, i) => {
      const rowNo = headerAt + 2 + i;
      const get = k => (col[k] >= 0 ? r[col[k]] : '');
      const m = { no: Number(clean(get('no'))), category: oneLine(get('category')), title: oneLine(get('title')), hint: oneLine(get('hint')),
        body: clean(get('body')), subject: oneLine(get('subject')), origin: oneLine(get('origin')), row: rowNo };
      if (!m.title && !m.body && !clean(get('no'))) return; // 빈 줄
      const bad = msg => problems.push(`${rowNo}번째 줄${m.title ? ` (${m.title})` : ''}: ${msg}`);
      if (!Number.isInteger(m.no) || m.no < 1) return bad('번호가 없거나 숫자가 아니라 건너뛰어요.');
      if (seen.has(m.no)) return bad(`번호 ${m.no} 가 위에 또 있어서 건너뛰어요.`);
      if (!m.title) return bad('제목이 비어 있어 건너뛰어요.');
      if (!m.body) return bad('답변이 비어 있어 건너뛰어요.');
      if (m.title.length > MAX.title) return bad(`제목이 ${MAX.title}자를 넘어요.`);
      if (m.body.length > MAX.body) return bad(`답변이 ${MAX.body}자를 넘어요.`);
      if (m.category.length > MAX.category) return bad(`카테고리 이름이 ${MAX.category}자를 넘어요.`);
      if (m.hint.length > MAX.hint) return bad(`'언제 쓰나' 가 ${MAX.hint}자를 넘어요.`);
      if (m.subject.length > MAX.subject) return bad(`메일 제목이 ${MAX.subject}자를 넘어요.`);
      if (macros.length >= MAX.rows) return bad(`매크로는 한 번에 ${MAX.rows}개까지 올릴 수 있어요.`);
      if (m.category === OTHER) m.category = '';
      seen.add(m.no);
      macros.push(m);
    });
    if (!macros.length && !problems.length) return { error: `'${sheet.name}' 시트에 매크로가 없어요.` };
    return { macros, problems, sheet: sheet.name };
  }
  return { error: "'번호 · 제목 · 답변' 칸이 있는 시트를 찾지 못했어요. [엑셀 받기] 로 받은 파일 모양 그대로 올려 주세요." };
}

// ───────── 미리보기 · 반영 ─────────
const FIELDS = [['title', 'title', '제목'], ['category', 'category', '카테고리'], ['hint', 'usage_hint', '언제 쓰나'], ['subject', 'mail_subject', '메일 제목'], ['body', 'body', '답변']];

// 반환: { add: [{ macro, overlaps, deleted }], change: [{ macro, current, fields: ['제목', …] }], same: n, missing: [{ macro_no, title }] }
function previewUpload(db, macros) {
  const all = db.prepare('SELECT id, title, body, category, usage_hint, mail_subject, macro_no, use_count FROM reply_templates').all();
  const numbered = new Map(all.filter(t => t.macro_no !== null).map(t => [t.macro_no, t]));
  const old = all.filter(t => t.macro_no === null);
  const gone = deletedNos(db);
  const add = [];
  const change = [];
  let same = 0;
  for (const m of macros) {
    const cur = numbered.get(m.no);
    if (!cur) {
      const overlaps = old.map(e => {
        if (squash(e.title) === squash(m.title)) return { title: e.title, reason: '이름이 같아요' };
        const sim = similarity(e.body, m.body);
        return sim >= SIMILAR ? { title: e.title, reason: `내용이 ${Math.round(sim * 100)}% 비슷해요` } : null;
      }).filter(Boolean);
      add.push({ macro: m, overlaps, deleted: gone.has(m.no) });
      continue;
    }
    const fields = FIELDS.filter(([k, col]) => clean(cur[col] || '') !== clean(m[k] || '')).map(f => f[2]);
    if (fields.length) change.push({ macro: m, current: cur, fields });
    else same += 1;
  }
  const inFile = new Set(macros.map(m => m.no));
  const missing = [...numbered.values()].filter(t => !inFile.has(t.macro_no)).sort((a, b) => a.macro_no - b.macro_no)
    .map(t => ({ macro_no: t.macro_no, title: t.title }));
  return { add, change, same, missing };
}

// 체크한 번호만 반영: add/update = 번호 목록. 반환 { added, updated }
function applyUpload(db, macros, { add = [], update = [], userId = null } = {}) {
  const preview = previewUpload(db, macros);
  const addSet = new Set(add.map(Number));
  const updSet = new Set(update.map(Number));
  const toAdd = preview.add.filter(a => addSet.has(a.macro.no));
  const toUpd = preview.change.filter(c => updSet.has(c.macro.no));
  transaction(db, () => {
    const ins = db.prepare(`INSERT INTO reply_templates (title, body, scope, category, macro_no, usage_hint, mail_subject, origin, updated_by)
      VALUES (?, ?, 'all', ?, ?, ?, ?, ?, ?)`);
    for (const { macro: m } of toAdd) ins.run(m.title, m.body, m.category || null, m.no, m.hint || null, m.subject || null, ORIGIN, userId);
    // 지웠던 번호를 다시 넣었으면 '지운 번호' 기억에서 뺀다
    if (toAdd.some(a => a.deleted)) {
      const set = deletedNos(db);
      toAdd.forEach(a => set.delete(a.macro.no));
      setSetting(db, 'macro_deleted_nos', JSON.stringify([...set].sort((a, b) => a - b)));
    }
    // 고치기: 글만 바꾼다 (사용 횟수·마지막 사용일·쓰는 곳은 그대로)
    const upd = db.prepare(`UPDATE reply_templates SET title = ?, body = ?, category = ?, usage_hint = ?, mail_subject = ?, updated_by = ?,
      updated_at = datetime('now') WHERE id = ?`);
    for (const { macro: m, current } of toUpd) upd.run(m.title, m.body, m.category || null, m.hint || null, m.subject || null, userId, current.id);
  });
  return { added: toAdd.length, updated: toUpd.length };
}

// ───────── 인트라넷 → 엑셀 ─────────
// 올리기와 같은 모양 + 사용 횟수·마지막 사용일 (올릴 때는 이 두 칸은 읽지 않는다)
function exportWorkbook(db, kst) {
  const list = db.prepare(`SELECT * FROM reply_templates ORDER BY macro_no IS NULL, macro_no, use_count DESC, title`).all();
  const head = ['번호', '카테고리', '제목', '언제 쓰나', '답변 (메신저·메일 공용)', '메일 제목', '출처', '사용 횟수', '마지막 사용일'];
  const rows = [head, ...list.map(t => [
    t.macro_no ?? '', t.category || (t.macro_no ? '' : OTHER), t.title, t.usage_hint || '', t.body, t.mail_subject || '',
    t.macro_no ? (t.origin === ORIGIN || t.origin === 'cs-v1' ? '엑셀' : '') : '예전 문구 (번호 없음)', t.use_count, t.last_used_at ? kst(t.last_used_at) : '',
  ])];
  const guide = [
    ['올리는 방법'],
    ['· 이 파일을 고쳐서 인트라넷 [엑셀 올리기] 로 올리면, 미리보기에서 확인한 뒤 반영돼요.'],
    ['· 줄마다 "번호" 로 짝을 맞춰요. 번호가 같으면 같은 매크로예요. 새 매크로는 안 쓰는 새 번호로 맨 아래에 더하세요.'],
    ['· 엑셀에서 줄을 지워도 인트라넷 매크로는 지워지지 않아요. 지우기는 인트라넷 화면의 [지우기] 로 해 주세요.'],
    ['· "사용 횟수", "마지막 사용일" 칸은 인트라넷이 세는 값이라 올릴 때는 읽지 않아요.'],
    ['· 번호가 없는 줄(예전 문구)은 올려도 바뀌지 않아요. 엑셀로 관리하려면 새 번호를 적어 새 매크로로 올리세요.'],
    ['· 카테고리는 아래 이름 중 하나를 쓰면 그 순서로 보여요. 새 이름을 쓰면 새 카테고리가 생겨요. 비우면 "기타".'],
    [CATEGORIES.join(' / ')],
  ];
  return writeXlsx([
    { name: 'CS 매크로', header: true, widths: [6, 12, 24, 26, 70, 36, 14, 10, 18], rows },
    { name: '올리는 방법', widths: [110], rows: guide },
  ]);
}

module.exports = { CATEGORIES, OTHER, ORIGIN, MAX_FILE, rememberDeleted, deletedNos, similarity, groupByCategory, parseMacroWorkbook, previewUpload, applyUpload, exportWorkbook };
