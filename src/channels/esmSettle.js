// G마켓·옥션 정산 금액 (조회만): 판매대금 정산조회에서 '송금일' 기준으로 실제로 들어온 돈을 받아 둔다
//   통계 화면의 'G마켓·옥션 정산 금액 (송금 완료)' 에 쓴다. 판매처에는 아무것도 보내지 않는다
//   환불 건은 ESM 이 반대 부호(-)로 주므로 그대로 더하면 된다
const { createEsmClient } = require('./esmClient');
const { getSetting, setSetting } = require('../collector');

const PATH = '/account/v1/settle/getsettleorder';
const PAGE_SIZE = 100;
const WINDOW_DAYS = 31;      // 한 번에 31일까지만 묻는다 (주문조회와 같은 제한으로 보고 넉넉히 나눈다)
const FIRST_DAYS = 120;      // 처음 한 번: 넉 달 전부터
const DAILY_DAYS = 14;       // 그 뒤로는 최근 2주 (늦게 송금 처리되는 건까지)
const STATUS_KEY = 'esm_settle_status';

const kstDay = d => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayOf = v => { const t = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(t) && !t.startsWith('0001') ? t : null; };
const money = v => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

function createEsmSettleSync({ db, client = createEsmClient(), now = () => new Date() } = {}) {
  const upsert = db.prepare(`
    INSERT INTO esm_settlements (site, contr_no, kind, remit_date, settlement_price, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(site, contr_no, kind) DO UPDATE SET remit_date = excluded.remit_date, settlement_price = excluded.settlement_price, updated_at = excluded.updated_at
  `);

  // 기간 하나(31일 이하)를 페이지를 넘겨 가며 끝까지
  async function fetchWindow(site, from, to) {
    let saved = 0;
    let got = 0; // 받은 줄 수 (ESM 이 한 쪽에 요청보다 적게 줘도 총 건수만큼 다 받을 때까지)
    for (let page = 1; page < 200; page++) {
      const body = await client.request('POST', PATH, { SiteType: site, SrchType: 'D6', SrchStartDate: from, SrchEndDate: to, PageNo: page, PageRowCnt: PAGE_SIZE });
      const rows = Array.isArray(body && body.Data) ? body.Data : [];
      for (const r of rows) {
        if (!r || r.ContrNo === undefined || r.ContrNo === null) continue;
        upsert.run(site, String(r.ContrNo), String(r.Kind ?? '1'), dayOf(r.RemitDate), money(r.SettlementPrice));
        saved += 1;
      }
      got += rows.length;
      const total = Number(body && body.TotalCount) || 0;
      if (!rows.length || got >= total) break;
    }
    return saved;
  }

  return {
    async run() {
      const today = kstDay(now());
      // 한 번도 성공한 적이 없으면 넉 달 전부터 (처음 실패해도 다음에 다시 넉 달)
      let before = null;
      try { before = JSON.parse(getSetting(db, STATUS_KEY) || 'null'); } catch { before = null; }
      const first = !(before && (before.ok || before.lastOk));
      const start = addDays(today, -(first ? FIRST_DAYS : DAILY_DAYS));
      let saved = 0;
      try {
        for (const s of client.sites) {
          for (let from = start; from <= today; from = addDays(from, WINDOW_DAYS)) {
            const to = addDays(from, WINDOW_DAYS - 1) < today ? addDays(from, WINDOW_DAYS - 1) : today;
            saved += await fetchWindow(s.key, from, to);
          }
        }
        setSetting(db, STATUS_KEY, JSON.stringify({ ok: true, at: now().toISOString(), saved }));
        return { ok: true, saved };
      } catch (e) {
        // 실패: 마지막으로 성공한 때(lastOk)는 남겨 둔다
        setSetting(db, STATUS_KEY, JSON.stringify({ ok: false, at: now().toISOString(), error: e.message, lastOk: before && before.ok ? before.at : (before && before.lastOk) || null }));
        return { ok: false, error: e.message };
      }
    },
  };
}

// 통계: 기간(송금일, 한국 날짜) 안에 실제로 들어온 정산 금액
function esmSettlement(db, fromDay, toDay) {
  let status = null;
  try { status = JSON.parse(getSetting(db, STATUS_KEY) || 'null'); } catch { status = null; }
  if (!status) return null; // G마켓·옥션 정산을 한 번도 받아 오지 않은 서버 → 칸을 안 보여 준다
  const rows = db.prepare(`
    SELECT site, COALESCE(SUM(settlement_price), 0) AS amt, COUNT(DISTINCT contr_no) AS n
    FROM esm_settlements WHERE remit_date >= ? AND remit_date <= ? GROUP BY site
  `).all(fromDay, toDay);
  const by = { G: 0, A: 0 };
  let count = 0;
  for (const r of rows) { by[r.site] = r.amt; count += r.n; }
  return { total: by.G + by.A, gmarket: by.G, auction: by.A, count, status };
}

module.exports = { createEsmSettleSync, esmSettlement, STATUS_KEY };
