// 로젠택배 Open API 연결
const test = require('node:test');
const assert = require('node:assert');
const { createLogenClient, isAllowed } = require('../src/channels/logen');

const fake = (status = 200, body = { data: [{ resultCd: 'TRUE' }], sttsCd: 'SUCCESS' }) => {
  const calls = [];
  return { calls, fetchFn: async (url, opts) => { calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return new Response(JSON.stringify(body), { status }); } };
};

test('로젠: 테스트 서버가 기본, 헤더 secretKey, 거래처코드는 자동으로 넣고 연동업체코드가 없으면 거래처코드로', async () => {
  const f = fake();
  const c = createLogenClient({ secretKey: 'k', custCd: '20179999', userId: undefined, env: 'dev', fetchFn: f.fetchFn });
  await c.request('inquirySlipNoMulti', [{ fixTakeNo: 'A1' }]);
  assert.strictEqual(f.calls[0].url, 'https://topenapi.ilogen.com/lrm02b-edi/edi/inquirySlipNoMulti');
  assert.strictEqual(f.calls[0].headers.secretKey, 'k');
  assert.deepStrictEqual(f.calls[0].body, { userId: '20179999', data: [{ custCd: '20179999', fixTakeNo: 'A1' }] });
  await c.request('inquiryCargoTrackingMultiLast', [{ slipNo: '38010101111' }]);
  assert.deepStrictEqual(f.calls[1].body.data, [{ slipNo: '38010101111' }], '화물추적은 송장번호만');
});

test('로젠: 운영계 주문 등록은 LOGEN_WRITE 를 켠 연결만, 허용 목록 밖은 막고, 401 은 키·IP 안내', async () => {
  const f = fake();
  const off = createLogenClient({ secretKey: 'k', custCd: '1', env: 'prod', fetchFn: f.fetchFn });
  await assert.rejects(off.request('registerOrderData', [{}]), /LOGEN_WRITE=on 이 아님/);
  await assert.rejects(off.request('deleteOrder', [{}]), /허용되지 않은/);
  assert.strictEqual(f.calls.length, 0);
  await createLogenClient({ secretKey: 'k', custCd: '1', env: 'prod', fetchFn: f.fetchFn, allowWrite: true }).request('registerOrderData', [{}]);
  assert.strictEqual(f.calls[0].url, 'https://openapi.ilogen.com/lrm02b-edi/edi/registerOrderData');
  assert.ok(isAllowed('contractTotalInfo') && !isAllowed('outSlipPrintPop'));
  const bad = fake(401, { sttsMsg: 'Unauthorized' });
  await assert.rejects(createLogenClient({ secretKey: 'k', custCd: '1', fetchFn: bad.fetchFn }).request('contractTotalInfo'), /IP 가 로젠에 등록되지/);
  await assert.rejects(createLogenClient({ secretKey: '', custCd: '1', fetchFn: bad.fetchFn }).request('contractTotalInfo'), /LOGEN_SECRET_KEY/);
});
