// 아주 작은 엑셀(.xlsx) 읽기·쓰기 — 매크로 엑셀 올리기/받기용 (따로 프로그램을 설치하지 않으려고 직접 만든다)
//
// .xlsx 는 XML 파일 몇 개를 zip 으로 묶은 것이다.
//   읽기: zip 을 풀어 시트 이름과 칸 글자만 꺼낸다 (서식·수식 계산은 하지 않음. 수식 칸은 엑셀이 저장해 둔 결과 값을 쓴다)
//   쓰기: 글자 칸(inlineStr)만 쓰는 단순한 파일 (머리줄 굵게, 줄바꿈 보이게, 칸 너비)
const zlib = require('zlib');

const MAX_UNZIPPED = 30 * 1024 * 1024; // 압축 폭탄 막기: 풀었을 때 합계 30MB 까지
const MAX_FILES = 200;

// ───────── zip 읽기 ─────────
function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('엑셀 파일이 아니에요.');
  // 끝부분의 '중앙 목록 끝' 표시(EOCD)를 찾는다
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('엑셀 파일이 아니에요. (.xlsx 로 저장해 주세요)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_FILES) throw new Error('엑셀 파일이 너무 복잡해요.');
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('엑셀 파일이 깨졌어요.');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('엑셀 파일이 깨졌어요.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    total += usize;
    if (total > MAX_UNZIPPED) throw new Error('엑셀 파일이 너무 커요.');
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED });
    else continue; // 다른 압축 방식은 건너뜀
    files.set(name, data);
  }
  return files;
}

// ───────── XML 조금 다루기 ─────────
const decode = s => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? decode(m[1]) : null; };
// <t> 들을 이어 붙인 글자 (서식이 섞인 글자는 <r><t>..</t></r> 여러 개)
const texts = xml => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map(m => decode(m[1] || '')).join('');
// 'AB12' → 27 (0부터)
function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref || '');
  if (!letters) return -1;
  return [...letters[0]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

// 반환: [{ name, rows: [[글자, …], …] }]  (빈 칸은 '')
function readXlsx(buf) {
  const files = unzip(buf);
  const text = name => (files.get(name) ? files.get(name).toString('utf8') : null);
  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('엑셀 파일이 아니에요. (.xlsx 로 저장해 주세요)');
  const rels = text('xl/_rels/workbook.xml.rels') || '';
  const target = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) target[attr(m[0], 'Id')] = attr(m[0], 'Target');
  const shared = [];
  const sst = text('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(texts(m[1]));
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const rid = attr(m[0], 'r:id');
    let path = target[rid] || '';
    path = path.startsWith('/') ? path.slice(1) : `xl/${path.replace(/^\.\//, '')}`;
    const xml = text(path);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rowNo = Number(attr(`<row${r[1]}>`, 'r')) || rows.length + 1;
      const row = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c${c[1]}>`;
        const t = attr(tag, 't');
        const inner = c[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let value = '';
        if (t === 's') value = shared[Number(v && v[1])] ?? '';
        else if (t === 'inlineStr') value = texts(inner);
        else if (v) value = decode(v[1]);
        const i = colIndex(attr(tag, 'r'));
        row[i >= 0 ? i : row.length] = value;
      }
      rows[rowNo - 1] = Array.from(row, x => (x === undefined ? '' : String(x)));
    }
    sheets.push({ name: attr(m[0], 'name') || '', rows: Array.from(rows, x => x || []) });
  }
  return sheets;
}

// ───────── 쓰기 ─────────
const esc = s => String(s ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = i => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// sheets: [{ name, rows: [[값…]…], widths: [칸 너비…], header: true(첫 줄 굵게·고정) }]
function writeXlsx(sheets) {
  const sheetXml = s => {
    const cols = (s.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const rows = s.rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
      const ref = `${colName(c)}${r + 1}`;
      const style = s.header && r === 0 ? 1 : 2;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
      if (v === null || v === undefined || v === '') return '';
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    const pane = s.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`;
  };
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    // 글꼴 0 = 보통, 1 = 굵게 / 칸 모양 0 = 기본, 1 = 머리줄(굵게·회색 바탕), 2 = 줄바꿈·위쪽 맞춤
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF0F3"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(files.map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
}

// zip 묶기 (압축 없이 저장 — 매크로 몇십 개라 작다)
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

module.exports = { readXlsx, writeXlsx };
