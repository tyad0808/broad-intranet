// 출력 파일의 크기 정보 읽기: PDF·AI·EPS 는 mm, JPG·PNG·TIF·PSD 는 픽셀·dpi·mm.
// 파일 전체를 열지 않고 필요한 부분만 읽는다 (큰 실사 파일도 빠르게). 못 읽으면 null.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const zlib = require('node:zlib');

const MM_PER_PT = 25.4 / 72;
const HEAD = 32 * 1024 * 1024;   // 앞부분 32MB
const TAIL = 8 * 1024 * 1024;    // 뒷부분 8MB
const FULL_LIMIT = 200 * 1024 * 1024; // 이보다 작은 PDF 는 못 찾으면 전체를 읽는다

async function readRange(fd, start, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fd.read(buf, 0, len, start);
  return buf.subarray(0, bytesRead);
}

// ---- PDF / AI(PDF 호환) ----

const num = '(-?\\d*\\.?\\d+)';
const BOX_RE = name => new RegExp('/' + name + '\\s*\\[\\s*' + num + '\\s+' + num + '\\s+' + num + '\\s+' + num + '\\s*\\]');

// 페이지 사전 하나에서 크기 (pt × UserUnit). 재단 크기(TrimBox)가 있으면 그것, 없으면 MediaBox
function pageSize(dict) {
  const box = (BOX_RE('TrimBox').exec(dict) || BOX_RE('MediaBox').exec(dict));
  if (!box) return null;
  const [x0, y0, x1, y1] = box.slice(1, 5).map(Number);
  const uu = /\/UserUnit\s+(\d*\.?\d+)/.exec(dict);
  const unit = uu ? Number(uu[1]) : 1;
  const w = Math.abs(x1 - x0) * unit, h = Math.abs(y1 - y0) * unit;
  return w > 0 && h > 0 ? { w, h, trim: /\/TrimBox/.test(box[0]) } : null;
}

// 글자(latin1)에서 '/Type /Page' 사전들 찾기
function findPages(text) {
  const out = [];
  const re = /\/Type\s*\/Page(?![s\w])/g;
  let m;
  while ((m = re.exec(text))) {
    // 이 표시를 둘러싼 사전 << ... >> 범위: 뒤로 가며 짝이 안 맞는 '<<' 를 찾는다 (안쪽 << >> 는 건너뜀)
    let start = -1, depth = 0;
    for (let i = m.index - 1; i > 0 && i > m.index - 20000; i--) {
      if (text[i] === '>' && text[i - 1] === '>') { depth++; i--; }
      else if (text[i] === '<' && text[i - 1] === '<') { if (depth === 0) { start = i - 1; break; } depth--; i--; }
    }
    if (start < 0) continue;
    let end = m.index;
    depth = 0;
    for (let i = start; i < text.length && i < m.index + 20000; i++) {
      if (text[i] === '<' && text[i + 1] === '<') { depth++; i++; }
      else if (text[i] === '>' && text[i + 1] === '>') { depth--; i++; if (depth === 0) { end = i + 1; break; } }
    }
    const dict = text.slice(start, end);
    const size = pageSize(dict);
    if (size) out.push(size);
  }
  return out;
}

// 압축된 객체 묶음(ObjStm) 안의 페이지 사전도 찾기
function findPagesInObjStm(buf) {
  const text = buf.toString('latin1');
  const out = [];
  const re = /\/Type\s*\/ObjStm[\s\S]{0,400}?stream\r?\n/g;
  let m;
  while ((m = re.exec(text)) && out.length < 50) {
    const s = m.index + m[0].length, e = text.indexOf('endstream', s);
    if (e < 0) break;
    try {
      const inflated = zlib.inflateSync(buf.subarray(s, e)).toString('latin1');
      out.push(...findPages(inflated));
    } catch { /* 압축 방식이 다르면 건너뜀 */ }
  }
  return out;
}

async function pdfInfo(fd, size) {
  const head = await readRange(fd, 0, Math.min(size, HEAD));
  const tail = size > HEAD ? await readRange(fd, Math.max(HEAD, size - TAIL), Math.min(TAIL, size - HEAD)) : Buffer.alloc(0);
  let pages = [], count = 0;
  for (const part of [head, tail]) {
    const text = part.toString('latin1');
    pages.push(...findPages(text));
    const c = text.match(/\/Type\s*\/Pages[\s\S]{0,300}?\/Count\s+(\d+)/g) || [];
    for (const x of c) count = Math.max(count, Number(/\/Count\s+(\d+)/.exec(x)[1]));
  }
  if (!pages.length) pages = [...findPagesInObjStm(head), ...findPagesInObjStm(tail)];
  if (!pages.length && size > HEAD + TAIL && size <= FULL_LIMIT) {
    const all = await readRange(fd, 0, size);
    pages = findPages(all.toString('latin1'));
    if (!pages.length) pages = findPagesInObjStm(all);
  }
  if (!pages.length) return null;
  const p = pages[0];
  const same = pages.every(q => Math.abs(q.w - p.w) < 1 && Math.abs(q.h - p.h) < 1);
  return {
    kind: 'vector',
    widthMm: p.w * MM_PER_PT, heightMm: p.h * MM_PER_PT,
    pages: Math.max(count, pages.length), mixed: !same, trim: p.trim,
  };
}

// ---- EPS / 옛날 AI ----
function epsInfo(head) {
  const text = head.toString('latin1');
  const m = /%%HiResBoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(text) ||
    /%%BoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(text);
  if (!m) return null;
  const [x0, y0, x1, y1] = m.slice(1, 5).map(Number);
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  return w > 0 && h > 0 ? { kind: 'vector', widthMm: w * MM_PER_PT, heightMm: h * MM_PER_PT, pages: 1 } : null;
}

// ---- 이미지 ----
function raster(w, h, dpiX, dpiY) {
  const r = { kind: 'raster', px: [w, h] };
  if (dpiX > 1 && dpiY > 1) {
    r.dpi = Math.round(dpiX);
    r.widthMm = w / dpiX * 25.4;
    r.heightMm = h / dpiY * 25.4;
  }
  return r;
}

// TIFF 머리(IFD0) 읽기 — TIF 파일, JPG 의 EXIF 안 모두 같은 방식
function tiffIfd(b, base = 0) {
  if (b.length < base + 8) return null;
  const le = b.toString('latin1', base, base + 2) === 'II';
  if (!le && b.toString('latin1', base, base + 2) !== 'MM') return null;
  const u16 = o => (le ? b.readUInt16LE(base + o) : b.readUInt16BE(base + o));
  const u32 = o => (le ? b.readUInt32LE(base + o) : b.readUInt32BE(base + o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4), n = u16(ifd), tags = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (base + e + 12 > b.length) break;
    const tag = u16(e), type = u16(e + 2), val = e + 8;
    if (type === 3) tags[tag] = u16(val);
    else if (type === 4) tags[tag] = u32(val);
    else if (type === 5) { const o = u32(val); if (base + o + 8 <= b.length) tags[tag] = u32(o) / (u32(o + 4) || 1); }
  }
  return tags;
}
function resToDpi(res, unit) { return !res ? 0 : unit === 3 ? res * 2.54 : unit === 1 ? 0 : res; } // 2 또는 없음 = 인치

function tiffInfo(head) {
  const t = tiffIfd(head);
  if (!t || !t[256] || !t[257]) return null;
  return raster(t[256], t[257], resToDpi(t[282], t[296]), resToDpi(t[283] || t[282], t[296]));
}

function jpegInfo(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2, dpiX = 0, dpiY = 0, w = 0, h = 0;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1], len = b.readUInt16BE(i + 2);
    if (marker === 0xe0 && b.toString('latin1', i + 4, i + 9) === 'JFIF\0') {
      const units = b[i + 11], xd = b.readUInt16BE(i + 12), yd = b.readUInt16BE(i + 14);
      if (units === 1) { dpiX = xd; dpiY = yd; } else if (units === 2) { dpiX = xd * 2.54; dpiY = yd * 2.54; }
    } else if (marker === 0xe1 && b.toString('latin1', i + 4, i + 10) === 'Exif\0\0' && !dpiX) {
      const t = tiffIfd(b.subarray(i + 10, i + 2 + len));
      if (t) { dpiX = resToDpi(t[282], t[296]); dpiY = resToDpi(t[283] || t[282], t[296]); }
    } else if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xcb && marker !== 0xc8) || (marker >= 0xcd && marker <= 0xcf)) {
      h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7);
      break;
    }
    i += 2 + len;
  }
  return w && h ? raster(w, h, dpiX, dpiY) : null;
}

function pngInfo(b) {
  if (b.toString('latin1', 1, 4) !== 'PNG') return null;
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  let i = 8, dpiX = 0, dpiY = 0;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8);
    if (type === 'pHYs' && b[i + 16] === 1) { dpiX = b.readUInt32BE(i + 8) * 0.0254; dpiY = b.readUInt32BE(i + 12) * 0.0254; }
    if (type === 'IDAT' || type === 'IEND') break;
    i += 12 + len;
  }
  return raster(w, h, dpiX, dpiY);
}

function psdInfo(b) {
  if (b.toString('latin1', 0, 4) !== '8BPS') return null;
  const h = b.readUInt32BE(14), w = b.readUInt32BE(18);
  let o = 26;
  o += 4 + b.readUInt32BE(o);              // 색상표
  const resLen = b.readUInt32BE(o), end = o + 4 + resLen;
  o += 4;
  let dpi = 0;
  while (o + 12 <= end && o + 12 <= b.length) {
    if (b.toString('latin1', o, o + 4) !== '8BIM') break;
    const id = b.readUInt16BE(o + 4), nameLen = b[o + 6];
    let p = o + 6 + 1 + nameLen;
    if ((1 + nameLen) % 2) p++;
    const size = b.readUInt32BE(p);
    if (id === 0x03ed) dpi = b.readUInt32BE(p + 4) / 65536; // 가로 해상도 (16.16 고정소수, ppi)
    o = p + 4 + size + (size % 2);
  }
  return raster(w, h, dpi, dpi);
}

// 파일 크기 정보. 결과 예: { kind: 'vector', widthMm, heightMm, pages } / { kind: 'raster', px: [w, h], dpi, widthMm, heightMm }
async function readInfo(file) {
  const ext = path.extname(file).toLowerCase();
  let fd;
  try {
    fd = await fsp.open(file, 'r');
    const { size } = await fd.stat();
    const head = await readRange(fd, 0, Math.min(size, 4 * 1024 * 1024));
    const magic = head.toString('latin1', 0, 8);
    if (magic.startsWith('%PDF')) return await pdfInfo(fd, size);
    if (magic.startsWith('%!PS') || (head[0] === 0xc5 && head[1] === 0xd0)) {
      // EPS (윈도우 미리보기가 붙은 EPS 는 앞에 바이너리 머리가 있다)
      let ps = head;
      if (head[0] === 0xc5) { const off = head.readUInt32LE(4); ps = await readRange(fd, off, Math.min(256 * 1024, size - off)); }
      return epsInfo(ps);
    }
    if (ext === '.ai') {
      // 일부 AI 는 머리말 뒤에 %PDF 가 나온다
      if (head.indexOf('%PDF') >= 0 && head.indexOf('%PDF') < 1024) return await pdfInfo(fd, size);
      return epsInfo(head);
    }
    if (head[0] === 0xff && head[1] === 0xd8) return jpegInfo(head);
    if (magic.startsWith('\x89PNG')) return pngInfo(head);
    if (magic.startsWith('II*\0') || magic.startsWith('MM\0*')) return tiffInfo(head);
    if (magic.startsWith('8BPS')) return psdInfo(head);
    return null;
  } catch {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

// 목록에 보일 한 줄: '3000×900mm' / '4724×1417px · 150dpi · 800×240mm' / '3000×900mm · 3쪽'
function formatInfo(info) {
  if (!info) return '';
  const mm = (w, h) => `${Math.round(w)}×${Math.round(h)}mm`;
  if (info.kind === 'vector') {
    let s = mm(info.widthMm, info.heightMm);
    if (info.pages > 1) s += ` · ${info.pages}쪽` + (info.mixed ? ' (크기 다름)' : '');
    return s;
  }
  let s = `${info.px[0]}×${info.px[1]}px`;
  if (info.dpi) s += ` · ${info.dpi}dpi · ${mm(info.widthMm, info.heightMm)}`;
  return s;
}

module.exports = { readInfo, formatInfo };
