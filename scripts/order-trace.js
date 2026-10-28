// 주문 한 건의 기록 보기 (읽기만 함 — 아무것도 바꾸거나 보내지 않는다)
// 언제 누가 발주확인·발송처리를 보냈는지, 로젠 등록·송장번호, 채널에서 본 상태를 한 번에 보여 준다
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run order-trace -- 주문번호(또는 상품주문번호·로젠 송장번호·주문자 이름)
require('dotenv').config({ quiet: true });
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const key = String(process.argv[2] || '').trim();
if (!key) {
  console.log('찾을 주문번호(또는 상품주문번호·로젠 송장번호·주문자 이름)를 뒤에 적어 주세요.\n예: npm run order-trace -- 45457477951');
  process.exit(0);
}
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'intranet.db'), { readOnly: true });
const kst = v => {
  if (!v) return '-';
  const s = String(v);
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
};

// 주문 묶음 찾기: 주문번호 · 상품주문번호 · 로젠 송장번호(로젠 기록·발송 송장) · 주문자 이름
const groups = db.prepare(`
  SELECT DISTINCT channel, channel_order_id FROM orders
  WHERE channel_order_id = ?1 OR channel_item_id = ?1 OR tracking_no = ?1 OR buyer_name = ?1 OR receiver_name = ?1
  UNION
  SELECT channel, channel_order_id FROM logen_shipments WHERE slip_no = ?1 OR take_no = ?1
  LIMIT 10
`).all(key);
if (!groups.length) {
  console.log(`'${key}' 로 찾은 주문이 없습니다.`);
  process.exit(0);
}

console.log(`로젠 자동 발송처리(관리자 › 로젠): ${(db.prepare("SELECT value FROM settings WHERE key = 'logen_auto_dispatch'").get() || {}).value === '1' ? '켜짐' : '꺼짐'}`);
console.log(`네이버로 실제 보내기(NAVER_WRITE): ${process.env.NAVER_WRITE === 'on' ? 'on' : '꺼짐(연습 모드)'} · 로젠 서버: ${process.env.LOGEN_ENV === 'prod' ? '실제' : '테스트'}`);

for (const g of groups) {
  console.log(`\n━━━━ ${g.channel} 주문 ${g.channel_order_id} ━━━━`);
  for (const o of db.prepare('SELECT * FROM orders WHERE channel = ? AND channel_order_id = ? ORDER BY id').all(g.channel, g.channel_order_id)) {
    console.log(`· 상품주문 ${o.channel_item_id} | ${o.product_name.slice(0, 30)}`);
    console.log(`  채널 상태 ${o.channel_status} (발주확인 ${o.channel_confirmed ? '됨' : '전'}) | 결제 ${kst(o.paid_at)}`);
    console.log(`  인트라넷 발송: ${o.shipped_at ? `${kst(o.shipped_at)} ${o.ship_company || ''} ${o.tracking_no || ''}` : '없음'}`);
    console.log(`  채널에서 '배송중' 을 처음 본 때(판매자센터 등 바깥에서 발송): ${kst(o.channel_shipped_at)}`);
  }
  const actions = db.prepare(`
    SELECT a.*, u.name AS user_name FROM order_actions a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.channel = ? AND a.channel_order_id = ? ORDER BY a.id
  `).all(g.channel, g.channel_order_id);
  console.log(`[인트라넷 처리 기록] ${actions.length ? '' : '없음'}`);
  for (const a of actions) {
    console.log(`  ${kst(a.created_at)} | ${a.action} | ${a.mode === 'live' ? '실제로 보냄' : a.mode} | 결과 ${a.result} | ${a.user_name || (a.user_id ? `직원#${a.user_id}` : '자동(사람 아님)')}`);
    if (a.detail) console.log(`     내용 ${a.detail}`);
    if (a.message) console.log(`     메시지 ${a.message.slice(0, 200)}`);
  }
  const ships = db.prepare(`
    SELECT s.*, u.name AS user_name FROM logen_shipments s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.channel = ? AND s.channel_order_id = ? ORDER BY s.id
  `).all(g.channel, g.channel_order_id);
  console.log(`[로젠 기록] ${ships.length ? '' : '없음'}`);
  for (const s of ships) {
    console.log(`  등록 ${kst(s.created_at)} (${s.user_name || '-'}) | 서버 ${s.env} | 로젠 주문번호 ${s.take_no} | 상태 ${s.status} | 송장 ${s.slip_no || '없음'}${s.slip_at ? ` (받은 때 ${kst(s.slip_at)})` : ''}`);
    let track = [];
    try { track = JSON.parse(s.track_json || '[]'); } catch { track = []; }
    if (track.length) console.log(`  배송 조회(${kst(s.track_at)}): ${track.map(t => `${t.at || ''} ${t.stat || t.statNm || ''}`.trim()).join(' → ')}`);
  }
}
