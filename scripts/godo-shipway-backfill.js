// 자사몰 예전 주문의 배송 방법 채우기 (한 번만 쓰는 명령)
//   자사몰 API 가 배송 방법(deliveryMethod)을 보내기 전에 받은 주문은 배송 방법 칸이 비어 있다.
//   진행 중인 주문은 수집할 때 다시 읽어 채워지지만, 끝난 주문(구매확정·취소 등)은 다시 읽지 않아 비어 있는 채로 남는다.
//   → 배송 방법이 빈 자사몰 주문만 골라 자사몰 API 에서 한 건씩 읽고(읽기만), 배송 방법 칸 하나만 채운다.
//   이미 값이 있는 주문은 덮어쓰지 않는다 — 여러 번 실행해도 안전하다. 다른 칸(상태·금액·주소 등)은 건드리지 않는다.
//
// 실행 (미리보기, 몇 건인지 세기만): sudo -u intranet npm run godo-shipway-backfill
// 실제로 채우기 (먼저 DB 백업):      sudo -u intranet npm run godo-shipway-backfill -- --apply
require('dotenv').config({ quiet: true });

const { openDb, transaction } = require('../src/db');
const { createGodoClient, normalize } = require('../src/channels/godo');
const { SHIP_WAYS } = require('../src/channels/shipping');

// 자사몰 주문 한 건(API 응답)의 배송 방법 코드 — 수집할 때와 똑같은 방법(normalize)으로 읽는다
const shipWayOf = order => (normalize(order).find(r => r.delivery_method) || {}).delivery_method || null;

async function fillGodoShipWay(db, { client = createGodoClient(), apply = false, onProgress = () => {} } = {}) {
  const orderNos = db.prepare(
    "SELECT DISTINCT channel_order_id FROM orders WHERE channel = 'godo' AND delivery_method IS NULL ORDER BY channel_order_id"
  ).all().map(r => r.channel_order_id);
  const update = db.prepare(
    "UPDATE orders SET delivery_method = ? WHERE channel = 'godo' AND channel_order_id = ? AND delivery_method IS NULL"
  );
  const out = { orders: orderNos.length, found: {}, unknown: 0, failed: [], filled: 0, filledRows: 0 };
  const fills = [];
  for (const [i, orderNo] of orderNos.entries()) {
    let code = null;
    try {
      // 한 건 조회 응답은 { item: 주문 } 처럼 감싸서 올 수도 있다 (수집의 verifyOpen 과 같은 방법으로 꺼냄)
      const body = await client.request('GET', `/orders/${orderNo}`);
      code = shipWayOf((body && (body.item || body.order)) || body);
      if (!code) out.unknown += 1; // 자사몰도 모르는 방법 → 비워 둠
    } catch (e) {
      out.failed.push({ orderNo, message: e.message }); // 자사몰에서 지워진 주문 등 → 건너뜀
    }
    if (code) {
      out.found[code] = (out.found[code] || 0) + 1;
      fills.push([code, orderNo]);
    }
    onProgress(i + 1, orderNos.length);
  }
  if (apply && fills.length) {
    transaction(db, () => {
      for (const [code, orderNo] of fills) {
        const changes = Number(update.run(code, orderNo).changes);
        out.filledRows += changes;
        if (changes) out.filled += 1;
      }
    });
  }
  return out;
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  (async () => {
    if (!process.env.GODO_API_KEY) {
      console.log('.env 에 GODO_API_KEY 가 없습니다 (자사몰 주문 수집 키).');
      process.exitCode = 1;
      return;
    }
    if (apply) {
      const { backup } = require('./backup');
      const { target } = await backup();
      console.log(`먼저 DB 백업을 만들었습니다: ${target}`);
    }
    const db = openDb();
    console.log(apply ? '자사몰 예전 주문의 배송 방법을 채웁니다.' : '미리보기: 배송 방법이 빈 자사몰 주문을 셉니다 (아무것도 바꾸지 않음).');
    try {
      const out = await fillGodoShipWay(db, {
        apply,
        onProgress: (done, total) => { if (done % 20 === 0) process.stdout.write(`  … ${done}/${total}건 읽음\n`); },
      });
      console.log(`배송 방법이 빈 자사몰 주문: ${out.orders}건`);
      for (const [code, n] of Object.entries(out.found)) console.log(`  ${(SHIP_WAYS[code] || {}).text || code}: ${n}건`);
      if (out.unknown) console.log(`  자사몰도 배송 방법을 모름 (비워 둠): ${out.unknown}건`);
      if (out.failed.length) {
        console.log(`  읽지 못함 (건너뜀): ${out.failed.length}건`);
        for (const f of out.failed.slice(0, 5)) console.log(`    - ${f.orderNo}: ${f.message}`);
      }
      if (apply) console.log(`✓ 주문 ${out.filled}건 (상품 줄 ${out.filledRows}개) 의 배송 방법을 채웠습니다`);
      else if (Object.keys(out.found).length) console.log('\n실제로 채우려면: sudo -u intranet npm run godo-shipway-backfill -- --apply');
    } catch (e) {
      console.log(`✗ 실패: ${e.message}`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  })();
}

module.exports = { fillGodoShipWay };
