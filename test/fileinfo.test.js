// 출력 파일 크기 정보 읽기 (PDF·AI·EPS 는 mm, 이미지는 픽셀·dpi·mm)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readInfo, formatInfo } = require('../tools/file-sync/src/core/fileinfo.js');

const FIX = path.join(__dirname, 'fixtures', 'file-sync');
const info = async name => formatInfo(await readInfo(path.join(FIX, name)));

test('진짜 파일들 (reportlab PDF, PIL·ImageMagick 이미지, EPS)', async () => {
  assert.strictEqual(await info('banner-3000x900.pdf'), '3000×900mm');
  assert.strictEqual(await info('card-90x50-2p.pdf'), '90×50mm · 2쪽');
  assert.strictEqual(await info('logo.eps'), '100×50mm');
  assert.strictEqual(await info('photo-150dpi.jpg'), '600×300px · 150dpi · 102×51mm');
  assert.strictEqual(await info('photo-72dpi.png'), '600×300px · 72dpi · 212×106mm');
  assert.strictEqual(await info('photo-300dpi.tif'), '600×300px · 300dpi · 51×25mm');
  assert.strictEqual(await info('cm-units.tif'), '400×200px · 102dpi · 100×50mm', 'cm 단위 해상도도 dpi 로');
  assert.strictEqual(await info('poster-200dpi.psd'), '160×80px · 200dpi · 20×10mm');
});

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileinfo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return (name, data) => { const f = path.join(dir, name); fs.writeFileSync(f, data); return f; };
}
const pdf = body => Buffer.from('%PDF-1.7\n' + body + '\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');

test('PDF: 재단 크기(TrimBox)가 있으면 그것, 아주 큰 현수막의 UserUnit 반영', async t => {
  const put = tmp(t);
  const trim = put('trim.pdf', pdf('3 0 obj << /Type /Page /MediaBox [0 0 300 300] /TrimBox [9 9 291 291] /Resources << /Font << >> >> >> endobj'));
  const r = await readInfo(trim);
  assert.strictEqual(formatInfo(r), '99×99mm');
  assert.strictEqual(r.trim, true);
  // 일러스트레이터는 5m 넘는 대지를 UserUnit 으로 저장한다: 2267.7 pt × 10 = 8000mm
  const big = put('big.pdf', pdf('3 0 obj << /Type /Page /UserUnit 10 /MediaBox [0 0 2267.72 850.39] >> endobj'));
  assert.strictEqual(formatInfo(await readInfo(big)), '8000×3000mm');
});

test('PDF: 압축된 객체 묶음 안의 페이지, 큰 파일 뒤쪽의 페이지', async t => {
  const put = tmp(t);
  const inner = zlib.deflateSync(Buffer.from('3 0 << /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] >>', 'latin1'));
  const objstm = Buffer.concat([
    Buffer.from('%PDF-1.7\n5 0 obj << /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ' + inner.length + ' >>\nstream\n', 'latin1'),
    inner, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]);
  assert.strictEqual(formatInfo(await readInfo(put('objstm.pdf', objstm))), '210×297mm', 'A4');

  // 40MB 짜리: 앞쪽은 이미지 데이터, 페이지 정보는 맨 뒤
  const filler = Buffer.alloc(40 * 1024 * 1024, 0x41);
  const tail = Buffer.from('\n4 0 obj << /Type /Page /MediaBox [0 0 1417.32 708.66] >> endobj\n%%EOF\n', 'latin1');
  assert.strictEqual(formatInfo(await readInfo(put('tail.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), filler, tail])))), '500×250mm');
});

test('모르는 파일·깨진 파일은 표시 없이 넘어간다', async t => {
  const put = tmp(t);
  assert.strictEqual(await readInfo(put('note.txt', '그냥 글')), null);
  assert.strictEqual(await readInfo(put('broken.pdf', '%PDF-1.4 깨짐')), null);
  assert.strictEqual(await readInfo(path.join(FIX, '없는파일.pdf')), null);
  assert.strictEqual(formatInfo(null), '');
});
