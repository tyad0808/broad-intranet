// 회사 이름·로고: 관리자 화면에서 바꾼다 (왼쪽 위 이름·로고, 브라우저 탭 제목·아이콘, 로그인 화면)
// 로고 그림은 DB(settings)에 넣어 둔다 → 매일 백업에 함께 들어간다
// 그림은 PNG·JPG·WEBP 만 (SVG 는 안에 스크립트를 넣을 수 있어 받지 않는다). 파일 앞부분으로 진짜 종류를 확인한다
const crypto = require('crypto');
const { getSetting, setSetting } = require('./collector');

const DEFAULT_NAME = '통합 어드민(브로애드)';
// 왼쪽 메뉴 (관리자는 늘 맨 아래). 순서는 관리자 > 회사·로고 에서 바꾼다
const NAV_ITEMS = { orders: '주문', mail: '메일함', chat: '톡톡', inbox: '문의함', schedule: '일정' };
const DEFAULT_NAV = ['orders', 'mail', 'chat', 'inbox', 'schedule'];
// 저장된 순서에 빠진 메뉴(나중에 생긴 메뉴)는 기본 순서에서 바로 앞에 있던 메뉴 뒤에 끼운다
function navOrderOf(saved) {
  const order = [...new Set((Array.isArray(saved) ? saved : []).filter(k => NAV_ITEMS[k]))];
  DEFAULT_NAV.forEach((key, i) => {
    if (order.includes(key)) return;
    const prev = DEFAULT_NAV.slice(0, i).reverse().find(k => order.includes(k));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, key);
  });
  return order;
}
const MAX_NAME = 30;
const MAX_LOGO = 1024 * 1024;

// 파일 앞부분(매직 넘버)으로 그림 종류 확인
function imageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function createBrand(db) {
  let cache = null;
  function load() {
    if (cache) return cache;
    let logo = null;
    try {
      const saved = JSON.parse(getSetting(db, 'brand_logo') || 'null');
      if (saved && saved.type && saved.data) logo = { type: saved.type, data: Buffer.from(saved.data, 'base64'), v: saved.v };
    } catch { logo = null; }
    let nav = null;
    try { nav = JSON.parse(getSetting(db, 'nav_order') || 'null'); } catch { nav = null; }
    cache = { name: getSetting(db, 'brand_name') || DEFAULT_NAME, logo, navOrder: navOrderOf(nav) };
    return cache;
  }
  return {
    // 화면에 넘길 값: 이름, 로고 주소(바뀔 때마다 주소가 달라져 브라우저가 새로 받는다)
    view() {
      const b = load();
      return { name: b.name, logoUrl: b.logo ? `/brand/logo?v=${b.logo.v}` : null, logoType: b.logo ? b.logo.type : null, isDefaultName: b.name === DEFAULT_NAME, navOrder: b.navOrder };
    },
    logo: () => load().logo,
    setName(name) {
      const clean = String(name || '').replace(/\s+/g, ' ').trim();
      if (clean.length > MAX_NAME) return `이름은 ${MAX_NAME}자까지 쓸 수 있습니다.`;
      setSetting(db, 'brand_name', clean || DEFAULT_NAME);
      cache = null;
      return null;
    },
    setLogo(buf) {
      if (!buf || !buf.length) return '그림 파일을 골라 주세요.';
      if (buf.length > MAX_LOGO) return `로고는 ${MAX_LOGO / 1024 / 1024}MB 이하로 올려 주세요.`;
      const type = imageType(buf);
      if (!type) return 'PNG·JPG·WEBP 그림만 올릴 수 있습니다. (SVG·AI 파일은 PNG 로 내보내 주세요)';
      const v = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
      setSetting(db, 'brand_logo', JSON.stringify({ type, data: buf.toString('base64'), v }));
      cache = null;
      return null;
    },
    // 메뉴 하나를 위(-1)·아래(+1)로 한 칸
    moveNav(key, dir) {
      const order = load().navOrder.slice();
      const i = order.indexOf(key);
      const j = i + (dir === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      setSetting(db, 'nav_order', JSON.stringify(order));
      cache = null;
    },
    reset() {
      db.prepare("DELETE FROM settings WHERE key IN ('brand_name', 'brand_logo')").run();
      cache = null;
    },
  };
}

module.exports = { createBrand, imageType, DEFAULT_NAME, MAX_NAME, MAX_LOGO, NAV_ITEMS, DEFAULT_NAV };
