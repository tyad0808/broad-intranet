// 주문에 상품 옵션·추가옵션이 어떤 모양으로 들어오는지 보기 (읽기만 함 — 고객 이름·연락처·주소는 보여 주지 않는다)
// 시안확정서·작업지시서의 '작업 정보'(소재·사이즈·추가옵션)를 어떻게 나눌지 정하려고 만든 점검 도구
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run option-sample            (최근 60일, 채널마다 최대 40가지)
//       sudo -u intranet npm run option-sample -- 30 smartstore                      (최근 30일, 스마트스토어만)
require('dotenv').config({ quiet: true });
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const days = Math.max(1, Math.min(365, Number(process.argv[2]) || 60));
const only = process.argv[3] || '';
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'intranet.db'), { readOnly: true });
const cut = s => (String(s || '').length > 70 ? `${String(s).slice(0, 70)}…` : String(s || ''));

const channels = db.prepare(`SELECT channel, COUNT(*) AS n FROM orders WHERE datetime(COALESCE(paid_at, created_at)) >= datetime('now', ?) GROUP BY channel`).all(`-${days} days`);
if (!channels.length) {
  console.log(`최근 ${days}일 주문이 없습니다.`);
  process.exit(0);
}
console.log(`최근 ${days}일 주문 줄 수: ${channels.map(c => `${c.channel} ${c.n}`).join(' · ')}\n`);

for (const { channel } of channels) {
  if (only && channel !== only) continue;
  console.log(`━━━━ ${channel} ━━━━`);
  // 같은 모양끼리 묶어 많이 나온 순서로 (본상품·추가상품, 상품 이름, 옵션 글자)
  const rows = db.prepare(`
    SELECT item_type, product_name, option_text, COUNT(*) AS n, SUM(quantity) AS qty, MAX(quantity) AS max_qty
    FROM orders WHERE channel = ? AND datetime(COALESCE(paid_at, created_at)) >= datetime('now', ?)
    GROUP BY item_type, product_name, option_text ORDER BY n DESC LIMIT 40
  `).all(channel, `-${days} days`);
  for (const r of rows) {
    console.log(`[${r.item_type === 'addon' ? '추가' : '본상품'}] ${cut(r.product_name)}  (${r.n}번, 수량 최대 ${r.max_qty})`);
    console.log(`        옵션: ${r.option_text === null ? '(없음)' : JSON.stringify(cut(r.option_text))}`);
  }
  // 옵션 글자를 ' / ' 로 나누고 '항목: 값' 으로 쪼갠 결과 — 어떤 항목 이름이 쓰이는지
  const labels = new Map();
  for (const r of db.prepare(`SELECT option_text FROM orders WHERE channel = ? AND option_text IS NOT NULL AND datetime(COALESCE(paid_at, created_at)) >= datetime('now', ?)`).all(channel, `-${days} days`)) {
    for (const part of String(r.option_text).split(/\s*\/\s*/)) {
      const m = /^([^:]{1,40}):\s*(.*)$/.exec(part);
      const label = m ? m[1].trim() : '(항목 이름 없음)';
      const value = m ? m[2].trim() : part.trim();
      if (!labels.has(label)) labels.set(label, new Map());
      const vals = labels.get(label);
      vals.set(value, (vals.get(value) || 0) + 1);
    }
  }
  if (labels.size) {
    console.log('\n  옵션 항목별 값 (많이 나온 순, 5개까지):');
    for (const [label, vals] of [...labels].sort((a, b) => b[1].size - a[1].size).slice(0, 30)) {
      const top = [...vals].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `${cut(v)}(${n})`).join(', ');
      console.log(`  · ${label}: ${top}`);
    }
  }
  console.log('');
}
