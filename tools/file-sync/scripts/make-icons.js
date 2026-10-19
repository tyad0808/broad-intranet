// 트레이 아이콘(PNG)을 코드로 그린다: 파랑(연결됨), 파랑+빨간 점(새 파일), 회색(NAS 끊김)
// 실행: node scripts/make-icons.js  → assets/*.png
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 둥근 사각형 바탕 + 흰 아래 화살표(받기) + 선택: 오른쪽 위 빨간 점
function icon(bg, dot) {
  return (x, y, s) => {
    const u = x / s, v = y / s;
    const inDot = dot && (u - 0.78) ** 2 + (v - 0.22) ** 2 < 0.2 ** 2;
    if (inDot) return [229, 57, 53, 255];
    const r = 0.22, cx = Math.min(Math.max(u, r), 1 - r), cy = Math.min(Math.max(v, r), 1 - r);
    if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return [0, 0, 0, 0];
    const stem = Math.abs(u - 0.5) < 0.08 && v > 0.2 && v < 0.6;
    const head = v >= 0.5 && v < 0.75 && Math.abs(u - 0.5) < (0.75 - v) * 1.1;
    const tray = v > 0.78 && v < 0.86 && u > 0.22 && u < 0.78;
    return stem || head || tray ? [255, 255, 255, 255] : [...bg, 255];
  };
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
const blue = [45, 111, 209], gray = [120, 120, 120];
// 16px 기본 + @2x(32px): 전기가 화면 배율에 맞춰 고른다. app.png 는 창·알림용 큰 아이콘
for (const [size, sfx] of [[16, ''], [32, '@2x']]) {
  fs.writeFileSync(path.join(out, `tray${sfx}.png`), png(size, icon(blue, false)));
  fs.writeFileSync(path.join(out, `tray-new${sfx}.png`), png(size, icon(blue, true)));
  fs.writeFileSync(path.join(out, `tray-off${sfx}.png`), png(size, icon(gray, false)));
}
fs.writeFileSync(path.join(out, 'app.png'), png(256, icon(blue, false)));
console.log('아이콘을 만들었습니다:', out);
