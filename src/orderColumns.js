// 주문 목록 칸 순서·보이기 (관리자 › 주문 목록 칸 에서 정한다, 모든 직원에게 같게)
//   넓은 화면(1100px 이상)의 표 모양에서 칸 순서와 너비를 정하고, 숨긴 칸은 휴대폰에서도 숨긴다
//   저장: settings.order_columns = [{ key, show }] (JSON). 모르는 칸은 버리고, 새로 생긴 칸은 뒤에 붙인다
const { getSetting, setSetting } = require('./collector');

// wide: 1300px 이상 · mid: 1100~1299px 의 칸 너비
const COLUMNS = {
  main: { label: '주문', wide: 'minmax(0, 1.6fr)', mid: 'minmax(0, 1.4fr)', fixed: true },
  memo: { label: '메모', wide: 'minmax(170px, 0.7fr)', mid: 'minmax(170px, 0.7fr)' }, // 1500px 이상에서만 따로 칸
  status: { label: '상태', wide: '140px', mid: '132px' },
  ship: { label: '배송 · 금액', wide: '104px', mid: '100px' },
  due: { label: '납기 · 발송', wide: '132px', mid: '124px' },
  design: { label: '디자인', wide: '168px', mid: '164px', pick: true },
  assign: { label: '담당', wide: '112px', mid: '104px', pick: true },
};
const DEFAULT_ORDER = ['main', 'memo', 'status', 'ship', 'due', 'design', 'assign'];
const KEY = 'order_columns';

// 저장된 값 → [{ key, label, show, fixed, pick }] (모든 칸, 순서대로)
function loadColumns(db) {
  let saved = [];
  try { saved = JSON.parse(getSetting(db, KEY) || '[]'); } catch { saved = []; }
  if (!Array.isArray(saved)) saved = [];
  const seen = new Set();
  const list = [];
  for (const c of saved) {
    if (!c || !COLUMNS[c.key] || seen.has(c.key)) continue;
    seen.add(c.key);
    list.push({ key: c.key, show: COLUMNS[c.key].fixed ? true : c.show !== false });
  }
  for (const key of DEFAULT_ORDER) if (!seen.has(key)) list.push({ key, show: true });
  return list.map(c => ({ ...c, label: COLUMNS[c.key].label, fixed: Boolean(COLUMNS[c.key].fixed), pick: Boolean(COLUMNS[c.key].pick) }));
}

function saveColumns(db, list) {
  setSetting(db, KEY, JSON.stringify(list.map(c => ({ key: c.key, show: c.show }))));
}

// 칸 하나를 위·아래로 한 칸 옮기기
function moveColumn(db, key, dir) {
  const list = loadColumns(db);
  const i = list.findIndex(c => c.key === key);
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j], list[i]];
  saveColumns(db, list);
  return true;
}

function showColumn(db, key, show) {
  const list = loadColumns(db);
  const col = list.find(c => c.key === key);
  if (!col || col.fixed) return false;
  col.show = Boolean(show);
  saveColumns(db, list);
  return true;
}

// 주문 목록 화면에 넣는 <style> 내용 (값은 위의 정해진 글자로만 만든다, 직원이 쓴 글자는 들어가지 않음)
//   1500px 이상: 메모도 따로 한 칸 (--oc-wide, --oc-<칸> = 몇 번째 칸)
//   1100~1499px: 메모는 주문 칸 아래 한 줄로 (메모를 뺀 칸 줄 --ocn-wide·--ocn-mid, --ocn-<칸>)
function columnsCss(list) {
  const shown = list.filter(c => c.show);
  const noMemo = shown.filter(c => c.key !== 'memo');
  const widths = (cols, size) => `24px ${cols.map(c => COLUMNS[c.key][size]).join(' ')}`;
  const vars = [
    `--oc-wide: ${widths(shown, 'wide')};`,
    `--ocn-wide: ${widths(noMemo, 'wide')};`,
    `--ocn-mid: ${widths(noMemo, 'mid')};`,
    ...shown.map((c, i) => `--oc-${c.key}: ${i + 2};`),
    ...noMemo.map((c, i) => `--ocn-${c.key}: ${i + 2};`),
  ];
  const hidden = list.filter(c => !c.show).map(c => `.order-list:not(.inbox-list) .c-${c.key} { display: none !important; }`);
  return [`:root { ${vars.join(' ')} }`, ...hidden].join('\n');
}

module.exports = { COLUMNS, DEFAULT_ORDER, loadColumns, saveColumns, moveColumn, showColumn, columnsCss };
