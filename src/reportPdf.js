// 주간 매출 보고 PDF (비밀번호로 잠금): 메일 본문에는 숫자를 넣지 않고 이 PDF 를 붙인다
//   잠금: AES-256 (PDF 1.7 확장 3). 여는 비밀번호 = 관리자가 정한 비밀번호, 고치기용 비밀번호는 매번 무작위
//   글꼴: Pretendard (assets/fonts, SIL OFL)
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const C = { text: '#191f28', sub: '#4e5968', muted: '#8b95a1', line: '#e5e8eb', up: '#08875c', down: '#e42939', head: '#f9fafb' };

// rows: [{ label, now, before, unit }], channels: [{ name, sales, orders }]
function buildReportPdf({ title, period, compare, rows, channels, notes = [], password }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margin: 48,
      info: { Title: title, Author: '' },
      ...(password ? {
        userPassword: password,
        ownerPassword: crypto.randomBytes(18).toString('hex'),
        permissions: { printing: 'highResolution', copying: true },
        pdfVersion: '1.7ext3',
      } : {}),
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('R', path.join(FONT_DIR, 'Pretendard-Regular.otf'));
    doc.registerFont('B', path.join(FONT_DIR, 'Pretendard-Bold.otf'));

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font('B').fontSize(20).fillColor(C.text).text(title, left, 48);
    doc.moveDown(0.3).font('R').fontSize(10.5).fillColor(C.sub).text(period).text(compare);
    doc.moveDown(1.2);

    // 표: 열 너비 비율과 정렬
    const table = (header, body, cols) => {
      const rowH = 30;
      let y = doc.y;
      const xs = [];
      cols.reduce((x, c) => { xs.push(x); return x + c.w * width; }, left);
      doc.rect(left, y, width, rowH).fill(C.head);
      header.forEach((h, i) => doc.font('B').fontSize(9.5).fillColor(C.muted)
        .text(h, xs[i] + 8, y + 10, { width: cols[i].w * width - 16, align: cols[i].align || 'left' }));
      y += rowH;
      body.forEach(cells => {
        cells.forEach((cell, i) => doc.font(cell.bold ? 'B' : 'R').fontSize(11).fillColor(cell.color || C.text)
          .text(cell.text, xs[i] + 8, y + 9, { width: cols[i].w * width - 16, align: cols[i].align || 'left', lineBreak: false }));
        doc.moveTo(left, y + rowH).lineTo(left + width, y + rowH).lineWidth(0.6).strokeColor(C.line).stroke();
        y += rowH;
      });
      doc.y = y + 18;
      doc.x = left;
    };

    table(['항목', '이번 주', '지난주', '변화'], rows.map(r => [
      { text: r.label, color: C.sub },
      { text: r.nowText, bold: true },
      { text: r.beforeText, color: C.muted },
      { text: r.change, bold: true, color: r.change.startsWith('▲') ? C.up : r.change.startsWith('▼') ? C.down : C.sub },
    ]), [{ w: 0.28 }, { w: 0.28, align: 'right' }, { w: 0.26, align: 'right' }, { w: 0.18, align: 'right' }]);

    doc.font('B').fontSize(13).fillColor(C.text).text('채널별 매출', left, doc.y);
    doc.moveDown(0.5);
    table(['채널', '매출', '주문'], channels.length
      ? channels.map(c => [{ text: c.name }, { text: c.salesText, bold: true }, { text: `${c.orders}건`, color: C.muted }])
      : [[{ text: '이번 주 주문이 없어요.', color: C.muted }, { text: '' }, { text: '' }]],
    [{ w: 0.5 }, { w: 0.3, align: 'right' }, { w: 0.2, align: 'right' }]);

    doc.font('R').fontSize(9).fillColor(C.muted);
    notes.forEach(n => doc.text(n, left, doc.y, { width }));
    doc.end();
  });
}

module.exports = { buildReportPdf };
