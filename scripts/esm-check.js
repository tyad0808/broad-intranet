// G마켓·옥션(ESM) 연결 확인: 사이트마다 상태별 주문 수와 주문번호, 최근 7일 취소 건수를 보여준다
//   조회만 한다 (주문은 아무것도 바꾸지 않음). 키·아이디 값과 고객 정보는 출력하지 않는다.
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run esm-check
// (ESM 은 등록한 서버 IP 에서만 받는다 — 인트라넷 서버에서 실행)
require('dotenv').config({ quiet: true });
const { createEsmClient, SITES } = require('../src/channels/esmClient');

const STATUSES = { 1: '신규주문', 2: '발송대기중', 3: '배송중', 4: '배송완료' };
const kst = d => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

(async () => {
  const client = createEsmClient();
  const has = k => (process.env[k] ? '있음' : '없음');
  console.log(`마스터 ID ${has('ESM_MASTER_ID')} · 시크릿키 ${has('ESM_SECRET_KEY')} · G마켓 ID ${has('ESM_GMARKET_ID')} · 옥션 ID ${has('ESM_AUCTION_ID')}`);
  if (!client.sites.length) return console.log('G마켓·옥션 판매자 ID 가 .env 에 없습니다.');
  const now = new Date();
  const from = kst(new Date(now.getTime() - 7 * 24 * 3600 * 1000));
  const to = kst(new Date(now.getTime() + 24 * 3600 * 1000));
  console.log(`조회 기간(결제일) ${from} ~ ${kst(now)} · 기간 조회는 5초에 1번이라 조금 걸립니다`);
  let ok = 0;
  let fail = 0; // eslint-disable-line prefer-const
  for (const site of client.sites) {
    console.log(`\n▶ ${site.name}`);
    for (const [status, label] of Object.entries(STATUSES)) {
      try {
        const body = await client.request('POST', '/shipping/v1/Order/RequestOrders', {
          siteType: SITES[site.key].code, orderStatus: Number(status), requestDateType: 2,
          requestDateFrom: from, requestDateTo: to, pageIndex: 1, pageSize: 100,
        });
        const data = (body && (body.Data || body.data)) || {};
        const rows = data.RequestOrders || [];
        const nos = rows.slice(0, 5).map(o => `${o.OrderNo}(${String(o.PayDate || '').slice(5, 16)})`);
        console.log(`  ${label.padEnd(5)} ${String(data.TotalCount ?? rows.length).padStart(3)}건 ${nos.join(', ')}${rows.length > 5 ? ' …' : ''}`);
        ok++;
      } catch (e) {
        console.log(`  ${label.padEnd(5)} 실패: ${e.message}`);
        fail++;
      }
    }
    try {
      const body = await client.request('POST', '/claim/v1/sa/Cancels', {
        SiteType: SITES[site.key].code, CancelStatus: 0, Type: 2, StartDate: kst(new Date(now.getTime() - 6 * 24 * 3600 * 1000)), EndDate: kst(now),
      });
      const rows = Array.isArray(body && (body.Data || body.data)) ? (body.Data || body.data) : [];
      console.log(`  취소(최근 7일 신청) ${rows.length}건`);
      ok++;
    } catch (e) {
      console.log(`  취소 조회 실패: ${e.message}`);
      fail++;
    }
  }
  console.log(fail ? `\n일부 실패 ${fail}건 — 401 이면 키·마스터 ID·판매자 ID 또는 서버 IP 등록을 확인하세요.` : `\n기본 조회 정상 (${ok}번 조회 성공)`);

  // ── 실제 수집과 똑같이 한 번 (DB 에는 아무것도 쓰지 않음) ──
  const { createEsmSource } = require('../src/channels/esm');
  const { DB_PATH } = require('../src/db');
  let startDate = /^\d{4}-\d{2}-\d{2}$/.test(process.env.ESM_START_DATE || '') ? process.env.ESM_START_DATE : null;
  let lastRun = null;
  try {
    const db = new (require('node:sqlite').DatabaseSync)(DB_PATH, { readOnly: true });
    startDate = startDate || (db.prepare("SELECT value FROM settings WHERE key = 'esm_start_date'").get() || {}).value || null;
    lastRun = db.prepare("SELECT started_at, ok, error FROM collect_runs WHERE channel = 'esm' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    db.close();
  } catch (e) {
    console.log(`(인트라넷 DB 를 읽지 못함: ${e.message})`);
  }
  if (lastRun) console.log(`\n인트라넷의 마지막 자동 수집: ${lastRun.started_at} · ${lastRun.ok ? '성공' : `실패 — ${lastRun.error}`}`);
  console.log(`\n▶ 실제 수집과 같은 과정으로 한 번 (가져오는 주문: ${startDate || '날짜 제한 없음'} 결제분부터, 1분쯤)`);
  const source = createEsmSource({ client, startDate });
  try {
    const rows = await source.fetchChanges();
    console.log(`  주문 읽기 성공: 가져올 주문 ${rows.length}건 ${rows.slice(0, 5).map(r => `${r.channel_item_id}(${r.channel_status_label})`).join(', ')}${rows.length > 5 ? ' …' : ''}`);
  } catch (e) {
    console.log(`  주문 읽기 실패: ${e.message}`);
    fail++;
  }
  try {
    const claims = await source.fetchClaims();
    console.log(`  취소·반품·교환 읽기 성공: ${claims.length}건`);
  } catch (e) {
    console.log(`  취소·반품·교환 읽기 실패: ${e.message}`);
    fail++;
  }
  console.log(fail ? '\n실패한 줄의 문장을 캡처해서 보내 주세요.' : '\n연결 정상 — 실제 수집도 같은 결과로 됩니다.');
})();
