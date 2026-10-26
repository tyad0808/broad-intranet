// 로젠택배 API 점검: 인증키·IP 등록이 됐는지와 응답 모양을 확인한다 (키 값은 출력하지 않음)
//   1) 테스트 서버(개발계): 우리 거래처코드로 계약 조회 → 운임 조회 → 가짜 주문 1건 등록 → 송장번호 조회
//   2) 실제 서버(운영계): 우리 거래처코드로 계약·운임 '조회만' (주문은 보내지 않음)
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run logen-check
require('dotenv').config({ quiet: true });
const { createLogenClient } = require('../src/channels/logen');
const { openDb } = require('../src/db');

const keysOf = obj => Object.keys(obj || {}).join(', ') || '없음';
const first = body => (body && Array.isArray(body.data) ? body.data[0] : null);
const kstDate = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');

async function step(title, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`  ✗ ${title} 실패: ${e.message}`);
    if (e.body && typeof e.body === 'object') console.log('    응답 항목:', keysOf(e.body));
    return false;
  }
  return true;
}

async function contract(client, label) {
  let fareTy = null;
  const ok = await step(`${label} 계약정보 조회`, async () => {
    const body = await client.request('contractTotalInfo');
    const c = first(body);
    console.log(`  응답: ${body.sttsCd} (${body.sttsMsg || ''}) · 항목: ${keysOf(c)}`);
    if (!c || c.resultCd === 'FALSE') throw new Error((c && c.resultMsg) || '계약 정보가 없습니다');
    console.log(`  ✓ 영업소 ${c.pickSalesNm} · 지점 ${c.pickBranNm} · 운임 ${c.fareTyNm}(${c.fareTy}) · 사용 ${c.useYn}`);
    fareTy = c.fareTy;
  });
  if (!ok || !fareTy) return null;
  let box = null;
  await step(`${label} 계약 운임 조회`, async () => {
    const body = await client.request('contPickFares', [{ fareTy }]);
    const c = first(body);
    const boxes = (c && (c.data1 || c.data)) || [];
    console.log(`  응답: ${body.sttsCd} · 박스 종류 ${boxes.length}개`);
    for (const b of boxes.slice(0, 15)) console.log(`    - ${b.boxTyNm}(${b.boxTyCd}) ${Number(b.dlvFare).toLocaleString()}원`);
    box = boxes[0] || null;
  });
  return { fareTy, box };
}

(async () => {
  console.log(`인증키(LOGEN_SECRET_KEY) ${process.env.LOGEN_SECRET_KEY ? '있음' : '없음 ✗'} · 거래처코드(LOGEN_CUST_CD) ${process.env.LOGEN_CUST_CD ? '있음' : '없음 ✗'} · 연동업체코드(LOGEN_USER_ID) ${process.env.LOGEN_USER_ID ? '있음' : '없음 (거래처코드로 대신)'}`);

  console.log(`\n▶ 1) 테스트 서버 (우리 거래처코드 ${process.env.LOGEN_CUST_CD || '없음 ✗'})`);
  // 테스트 서버도 우리 거래처코드(.env 의 LOGEN_CUST_CD)로 보낸다 — 로젠이 전송 내역에서 우리 코드를 확인한다
  const dev = createLogenClient({ env: 'dev' });
  const got = await contract(dev, '테스트');
  // 보내는 분: 인트라넷 관리자 › 로젠 설정에 저장한 값 (실제 주소여야 로젠이 주소를 읽는다)
  let sender = null;
  try { sender = JSON.parse((openDb().prepare("SELECT value FROM settings WHERE key = 'logen_sender'").get() || {}).value || 'null'); } catch { sender = null; }
  if (got && !(sender && sender.name && sender.addr && sender.tel)) {
    console.log('  ✗ 보내는 분 정보가 없습니다. 인트라넷 관리자 › 로젠 설정 ② 에서 이름·주소·전화번호를 저장한 뒤 다시 실행하세요.');
  } else if (got) {
    console.log(`  보내는 분: ${sender.name} · 주소 ${sender.addr.length}자 · 전화 ${sender.tel.length}자리`);
  }
  if (got && sender && sender.name && sender.addr && sender.tel) {
    const { fareTy, box } = got;
    const fixTakeNo = `BROADTEST${Date.now()}`;
    const registered = await step('테스트 주문 등록', async () => {
      const body = await dev.request('registerOrderData', [{
        takeDt: kstDate(), slipNo: '', fixTakeNo,
        sndCustNm: sender.name, sndCustAddr: sender.addr, sndTelNo: sender.tel,
        rcvCustNm: '테스트고객', rcvCustAddr: '충남 부여군 은산면 내지리 123-1', rcvTelNo: '01012345678', rcvCellNo: '01012345678',
        fareTy, ...(box ? { boxTyCd: box.boxTyCd } : {}), qty: 1, dlvFare: box ? Number(box.dlvFare) : 3000, goodsNm: '테스트 상품', sndMsg: '문 앞',
      }]);
      const c = first(body);
      console.log(`  응답: ${body.sttsCd} (${body.sttsMsg || ''}) · 항목: ${keysOf(c)}`);
      if (!c || c.resultCd === 'FALSE') throw new Error((c && c.resultMsg) || '등록되지 않았습니다');
      console.log('  ✓ 테스트 주문 등록됨');
    });
    if (registered) {
      await step('송장번호 조회', async () => {
        const body = await dev.request('inquirySlipNoMulti', [{ fixTakeNo }]);
        const c = first(body);
        console.log(`  응답: ${body.sttsCd} (${body.sttsMsg || ''}) · 항목: ${keysOf(c)}`);
        const slips = (c && c.data1) || [];
        console.log(`  ✓ 조회됨 — 송장번호 ${slips.filter(s => s.slipNo).length}개 (아직 출력 전이면 0개가 정상)${c && c.resultMsg ? ` · ${c.resultMsg}` : ''}`);
      });
    }
  }

  console.log('\n▶ 2) 실제 서버 (우리 거래처코드, 조회만)');
  await contract(createLogenClient({ env: 'prod' }), '실제');
  console.log('\n위 결과를 그대로 보여 주세요. (고객 정보·키는 출력되지 않습니다)');
})();
