// CS 매크로 v1 (엑셀 45개) 가져오기와 매크로 카테고리
//
// 가져오기 규칙 (사용자 요청):
//   - 기존에 저장된 문구는 절대 지우거나 덮어쓰지 않는다. 새 줄로 더하기만 한다
//   - 기존 문구와 겹쳐 보이는 것(이름이 같거나 내용이 거의 같은 것)은 미리보기에 따로 보여 주고,
//     관리자가 '그래도 추가' 를 고른 것만 더한다 (기본은 건너뜀)
//   - 이미 가져온 매크로(같은 번호)는 다시 넣지 않는다 → 버튼을 여러 번 눌러도 두 번 들어가지 않음
const fs = require('fs');
const path = require('path');
const { transaction } = require('./db');

// 매크로를 고를 때 보이는 순서. 카테고리가 없는 예전 문구는 맨 뒤 '기타'
const CATEGORIES = ['첫 응대', '주문 안내', '파일', '디자인·시안', '주문·제작', '배송', '클레임', '사후관리'];
const OTHER = '기타';
const V1_ORIGIN = 'cs-v1';
const V1_FILE = path.join(__dirname, 'data', 'cs-macros-v1.json');

function loadV1(file = V1_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

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

// 미리보기: [{ macro, status: 'new' | 'overlap' | 'imported', matches: [{ id, title, reason }] }]
function previewImport(db, data = loadV1()) {
  const existing = db.prepare('SELECT id, title, body, origin, macro_no FROM reply_templates').all();
  return data.macros.map(macro => {
    if (existing.some(e => e.origin === V1_ORIGIN && e.macro_no === macro.no)) return { macro, status: 'imported', matches: [] };
    const matches = existing.filter(e => e.origin !== V1_ORIGIN).map(e => {
      if (squash(e.title) === squash(macro.title)) return { id: e.id, title: e.title, reason: '이름이 같아요' };
      const sim = similarity(e.body, macro.body);
      if (sim >= SIMILAR) return { id: e.id, title: e.title, reason: `내용이 ${Math.round(sim * 100)}% 비슷해요` };
      return null;
    }).filter(Boolean);
    return { macro, status: matches.length ? 'overlap' : 'new', matches };
  });
}

// 가져오기: 새것은 모두, 겹치는 것은 force 에 번호가 있을 때만. 기존 문구는 건드리지 않는다. 더한 개수
function importMacros(db, { force = [], userId = null, data = loadV1() } = {}) {
  const forced = new Set(force.map(Number));
  const rows = previewImport(db, data).filter(p => p.status === 'new' || (p.status === 'overlap' && forced.has(p.macro.no)));
  const insert = db.prepare(`
    INSERT INTO reply_templates (title, body, scope, category, macro_no, usage_hint, mail_subject, origin, updated_by)
    VALUES (?, ?, 'all', ?, ?, ?, ?, ?, ?)
  `);
  transaction(db, () => {
    for (const { macro: m } of rows) {
      insert.run(m.title, m.body, CATEGORIES.includes(m.category) ? m.category : null, m.no, m.hint || null, m.mailSubject || null, V1_ORIGIN, userId);
    }
  });
  return rows.length;
}

// 카테고리별로 묶기 (정해진 순서, 기타는 맨 뒤). 빈 카테고리는 뺀다
function groupByCategory(list) {
  const order = [...CATEGORIES, OTHER];
  const groups = new Map(order.map(c => [c, []]));
  for (const t of list) groups.get(CATEGORIES.includes(t.category) ? t.category : OTHER).push(t);
  return order.map(name => ({ name, items: groups.get(name) })).filter(g => g.items.length);
}

module.exports = { CATEGORIES, OTHER, V1_ORIGIN, loadV1, similarity, previewImport, importMacros, groupByCategory };
