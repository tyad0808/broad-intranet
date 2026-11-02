// 고객용 시안확정서 만들기: 칸 값과 시안 그림으로 A4 그림을 직접 그린다.
// 화면 미리보기는 가볍게(200dpi), [JPG로 저장]·[인쇄]는 같은 그림을 크게(400dpi) 다시 그린다. 넣은 그림·글자는 서버로 보내지 않는다.
(function () {
  const data = JSON.parse(document.getElementById('maker-data').textContent);
  const preview = document.querySelector('[data-maker-canvas]');
  const form = document.querySelector('[data-maker-form]');
  const W = 210; // A4 210×297mm
  const H = 297;
  // 저장·인쇄 해상도: 400dpi = 3307×4677 픽셀 (아이폰 브라우저가 만들 수 있는 그림 크기 한도 안쪽)
  const SAVE_DPI = 400;
  // 지금 그리는 곳 (미리보기 또는 저장용 큰 그림). 아래 그리기 함수들은 이 셋을 쓴다
  let canvas;
  let ctx;
  let MM;
  function target(c) {
    canvas = c;
    ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high'; // 시안 그림을 줄여 넣을 때 가장 좋은 품질로
    MM = c.width / W;
  }
  target(preview);
  const PT = 0.3528; // 1pt = 0.3528mm
  const FONT = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  const INK = '#111111';
  const GRAY = '#9ca0a7';
  const LINE = '#e3e5e8';
  const X0 = 10;
  const X1 = 200;

  let design = null; // 시안 그림 (Image)
  let logo = null;

  const font = (pt, weight) => `${weight || 400} ${pt * PT * MM}px ${FONT}`;
  function text(str, x, y, pt, { weight = 400, color = INK, align = 'left' } = {}) {
    ctx.font = font(pt, weight);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillText(str, x * MM, y * MM);
    return ctx.measureText(str).width / MM; // 쓴 너비 (mm)
  }
  const widthOf = (str, pt, weight) => { ctx.font = font(pt, weight); return ctx.measureText(str).width / MM; };

  // 정해진 너비에 맞게 줄을 나눈다 (띄어쓰기에서 먼저 끊고, 긴 낱말은 글자 단위로)
  function wrap(str, maxW, pt, weight) {
    const lines = [];
    for (const para of String(str || '').split('\n')) {
      let line = '';
      for (const ch of para) {
        const next = line + ch;
        if (widthOf(next, pt, weight) <= maxW || !line) { line = next; continue; }
        const cut = line.lastIndexOf(' ');
        if (cut > line.length * 0.5) { lines.push(line.slice(0, cut)); line = line.slice(cut + 1) + ch; }
        else { lines.push(line); line = ch; }
      }
      lines.push(line);
    }
    return lines.filter((l, i, a) => l.trim() || a.length === 1);
  }
  // 줄 수 제한: 넘치면 마지막 줄 끝을 … 로
  function clip(lines, max) {
    if (lines.length <= max) return lines;
    const out = lines.slice(0, max);
    out[max - 1] = out[max - 1].replace(/.{0,2}$/, '') + '…';
    return out;
  }
  function hline(y) {
    ctx.fillStyle = LINE;
    ctx.fillRect(X0 * MM, y * MM, (X1 - X0) * MM, 0.25 * MM);
  }
  const lab = (str, x, y) => text(str, x, y, 7.5, { color: GRAY });

  // '볼터치작업 × 1 (볼터치 무료옵션)' → 앞은 검정, 맨 끝 괄호는 연한 글씨
  function splitTail(line) {
    const s = line.trim();
    if (!s.endsWith(')')) return [s, ''];
    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === ')') depth++;
      else if (s[i] === '(' && --depth === 0) {
        return i > 0 && s[i - 1] === ' ' ? [s.slice(0, i).trim(), s.slice(i + 1, -1)] : [s, ''];
      }
    }
    return [s, ''];
  }

  const val = name => (form.elements[name] ? String(form.elements[name].value || '').trim() : '');
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  };

  function draw() {
    const v = {
      channel: val('channel'), orderNo: val('orderNo'), buyer: val('buyer'), receiver: val('receiver'), designer: val('designer'),
      revision: val('revision') || '0', phone: val('phone'), products: val('products'), addons: val('addons'), requests: val('requests'),
    };
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 맨 위 브랜드 줄
    const g = ctx.createLinearGradient(0, 0, canvas.width, 0);
    [['#1aa3e8', 0], ['#7b3fe4', 0.3], ['#e8336d', 0.55], ['#f7941d', 0.8], ['#ffd400', 1]].forEach(([c, o]) => g.addColorStop(o, c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, 1 * MM);

    // 로고 · 문서 이름
    if (logo && logo.naturalWidth) {
      const h = 5;
      const w = Math.min(40, (logo.naturalWidth / logo.naturalHeight) * h);
      ctx.drawImage(logo, X0 * MM, 4.5 * MM, w * MM, h * MM);
    } else {
      text(data.brandName || '', X0, 5, 10, { weight: 700 });
    }
    const dateW = text(today(), X1, 5.6, 8, { color: GRAY, align: 'right' });
    text('시안확정서', X1 - dateW - 2, 5.6, 8, { weight: 600, align: 'right' });

    // 구매처 · 주문번호 · 수정 횟수 · 담당 디자이너
    const metaY = 13;
    const cols = [1.3, 1, 0.55, 1];
    const unit = (X1 - X0 - 5 * 3) / cols.reduce((a, b) => a + b, 0);
    const xs = [];
    cols.reduce((x, f) => { xs.push(x); return x + f * unit + 5; }, X0);
    const valueY = metaY + 3.4;
    lab('구매처 / 구매자 (수령자)', xs[0], metaY);
    const who = [v.channel, v.buyer].filter(Boolean).join(' · ') || '-';
    const whoW = text(who, xs[0], valueY, 9.5, { weight: 500, color: who === '-' ? GRAY : INK });
    if (v.receiver) text(`(${v.receiver})`, xs[0] + whoW + 1, valueY, 9.5, { color: GRAY });
    lab('주문번호', xs[1], metaY);
    text(v.orderNo || '-', xs[1], valueY, 9.5, { weight: 500, color: v.orderNo ? INK : GRAY });
    lab('수정 횟수', xs[2], metaY);
    text(`${v.revision}회`, xs[2], valueY, 9.5, { weight: 500 });
    lab('담당 디자이너', xs[3], metaY);
    const nameW = v.designer ? text(v.designer, xs[3], valueY, 9.5, { weight: 500 }) + 1 : 0;
    if (v.phone) text(v.phone, xs[3] + nameW, valueY, 9.5, { color: GRAY });
    const metaBottom = valueY + 4.2 + 3;
    hline(metaBottom);

    // 작업정보: 왼쪽 상품 · 소재 · 사이즈 · 수량 / 오른쪽 추가옵션 · 고객 요청
    const specY = metaBottom + 3;
    const leftW = (X1 - X0 - 8) * 1.1 / 2.1;
    const rightX = X0 + leftW + 8;
    const rightW = X1 - rightX;
    let y = specY;
    lab('상품명', X0, y);
    y += 3.2;
    // 고객이 주문한 그대로: 상품마다 첫 줄(이름 × 수량)은 굵게, 다음 줄(옵션)은 보통 글씨. 상품 사이는 빈 줄
    const items = v.products ? v.products.split(/\n\s*\n/).map(b => b.split('\n').map(l => l.trim()).filter(Boolean)).filter(b => b.length) : [];
    if (!items.length) { text('-', X0, y, 10, { weight: 600, color: GRAY }); y += 4.9; }
    const MAX_LEFT = 62; // 상품 칸 높이 한도 (mm). 넘치면 '외 N개'
    for (let i = 0; i < items.length; i++) {
      if (y - specY > MAX_LEFT) { text(`외 상품 ${items.length - i}개`, X0, y, 8.5, { color: GRAY }); y += 4.5; break; }
      const [head, ...rest] = items[i];
      clip(wrap(head, leftW, 10, 600), 2).forEach(l => { text(l, X0, y, 10, { weight: 600 }); y += 4.9; });
      clip(wrap(rest.join(' · '), leftW, 8.5, 400), 3).filter(Boolean).forEach(l => { text(l, X0, y, 8.5, { color: '#444444' }); y += 4.2; });
      y += 2;
    }
    const leftBottom = y;

    let ry = specY;
    lab('추가옵션', rightX, ry);
    ry += 3.2;
    const addons = v.addons ? v.addons.split('\n').map(s => s.trim()).filter(Boolean) : [];
    if (!addons.length) { text('없음', rightX, ry, 9, { color: GRAY }); ry += 4.9; }
    addons.slice(0, 6).forEach((line, i) => {
      if (i === 5 && addons.length > 6) { text(`외 ${addons.length - 5}개`, rightX, ry, 9, { color: GRAY }); ry += 4.9; return; }
      const [main, tail] = splitTail(line);
      const mLines = clip(wrap(main, rightW, 9, 400), 2);
      mLines.forEach((l, j) => {
        const w = text(l, rightX, ry, 9);
        if (j === mLines.length - 1 && tail && w + widthOf(tail, 7.5) + 2 < rightW) text(tail, rightX + w + 1.5, ry + 0.45, 7.5, { color: GRAY });
        ry += 4.9;
      });
    });
    ry += 2;
    lab('고객 요청', rightX, ry);
    ry += 3.2;
    const reqLines = clip(wrap(v.requests || '없음', rightW, 9, 400), 4);
    reqLines.forEach(l => { text(l, rightX, ry, 9, { color: v.requests ? INK : GRAY }); ry += 4.75; });
    const specBottom = Math.max(leftBottom, ry) + 2;
    hline(specBottom);

    // 아래 약관 (높이를 먼저 재서 맨 아래에 붙인다)
    const terms = data.terms || [];
    const tcols = [1.5, 1, 1];
    const tunit = (X1 - X0 - 7 * 2) / 3.5;
    const blocks = terms.map((t, i) => {
      const w = tcols[i] * tunit;
      const lines = t.lines.map(l => wrap(l, w - 3.2, 7.4, 400));
      const h = (t.title ? 5.2 : 0) + lines.reduce((n, ls) => n + ls.length * 4.15 + 0.6, 0);
      return { t, w, lines, h };
    });
    const termsH = Math.max(0, ...blocks.map(b => b.h));
    const termsTop = H - (termsH ? termsH + 4 + 4.5 : 0);
    if (termsH) {
      ctx.fillStyle = '#f6f7f8';
      ctx.fillRect(0, termsTop * MM, canvas.width, (H - termsTop) * MM);
      let tx = X0;
      blocks.forEach(b => {
        let ty = termsTop + 4;
        if (b.t.title) { text(b.t.title, tx, ty, 9, { weight: 600 }); ty += 5.2; }
        b.lines.forEach(ls => {
          text('•', tx, ty, 7.4, { color: '#b5b9bf' });
          ls.forEach(l => { text(l, tx + 3.2, ty, 7.4, { color: '#6b7079' }); ty += 4.15; });
          ty += 0.6;
        });
        tx += b.w + 7;
      });
    }

    // 시안
    lab('치수단위 cm', X0, specBottom + 2);
    const box = { x: X0, y: specBottom + 6, w: X1 - X0, h: termsTop - 3 - (specBottom + 6) };
    if (design && design.naturalWidth && box.h > 10) {
      const k = Math.min(box.w / design.naturalWidth, box.h / design.naturalHeight);
      const dw = design.naturalWidth * k;
      const dh = design.naturalHeight * k;
      ctx.drawImage(design, (box.x + (box.w - dw) / 2) * MM, (box.y + (box.h - dh) / 2) * MM, dw * MM, dh * MM);
    } else {
      ctx.strokeStyle = '#d5d8dc';
      ctx.lineWidth = 0.3 * MM;
      ctx.setLineDash([2 * MM, 1.5 * MM]);
      ctx.strokeRect(box.x * MM, box.y * MM, box.w * MM, box.h * MM);
      ctx.setLineDash([]);
      text('시안 그림을 넣어 주세요', W / 2, box.y + box.h / 2 - 2, 12, { color: '#b5b9bf', align: 'center' });
    }
  }

  // 글꼴을 다 받은 뒤 그린다 (한글 글꼴은 쓰는 글자만 나눠 받음)
  let pending = null;
  async function render() {
    const all = [...form.querySelectorAll('input[type=text], input[type=number], textarea')].map(el => el.value).join('')
      + (data.terms || []).map(t => t.title + t.lines.join('')).join('') + '구매처주문번호수정횟수담당디자이너상품명소재두께사이즈긴쪽짧은수량추가옵션고객요청치수단위없음시안확정서그림을넣어주세요외개회0123456789.·×•…()';
    try {
      await Promise.all([400, 500, 600, 700].map(w => document.fonts.load(font(10, w), all)));
    } catch { /* 글꼴을 못 받아도 기본 글꼴로 그린다 */ }
    draw();
  }
  const later = () => { clearTimeout(pending); pending = setTimeout(render, 120); };
  form.addEventListener('input', later);

  // 시안 그림 넣기: 누르기 · 끌어다 놓기
  const drop = document.querySelector('[data-maker-drop]');
  const input = document.querySelector('[data-maker-input]');
  const fileLabel = document.querySelector('[data-maker-file]');
  function useFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) {
      alert('PNG·JPG·WEBP 그림만 넣을 수 있어요. (PDF·AI 파일은 JPG 로 내보내 주세요)');
      return;
    }
    const img = new Image();
    img.onload = () => { design = img; fileLabel.textContent = file.name && file.name !== 'image.png' ? file.name : '붙여 넣은 그림'; render(); };
    img.src = URL.createObjectURL(file);
  }
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => useFile(input.files[0]));
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => { e.preventDefault(); useFile(e.dataTransfer.files[0]); });
  // 캡처한 그림 붙여 넣기 (Ctrl+V). 글자 칸에 글자를 붙여 넣을 때는 그대로 둔다
  document.addEventListener('paste', e => {
    const file = [...((e.clipboardData && e.clipboardData.files) || [])].find(f => /^image\//.test(f.type));
    if (!file) return;
    e.preventDefault();
    useFile(file);
  });

  // 저장할 파일 이름: 시안확정서_주문번호_구매자.jpg
  function fileName() {
    const parts = ['시안확정서', val('orderNo'), val('buyer')].filter(Boolean).map(s => s.replace(/[\\/:*?"<>|\s]+/g, '_'));
    return `${parts.join('_')}.jpg`;
  }
  // 저장·인쇄용 큰 그림 (400dpi): 같은 그리기를 큰 캔버스에 한 번 더
  async function bigCanvas() {
    await render();
    const big = document.createElement('canvas');
    big.width = Math.round((W / 25.4) * SAVE_DPI);
    big.height = Math.round((H / 25.4) * SAVE_DPI);
    target(big);
    try { draw(); } finally { target(preview); }
    return big;
  }
  // JPG 안에 '400dpi' 라고 적어 둔다 (포토샵·인쇄에서 A4 크기로 바로 열리게). 모양이 다르면 그대로
  async function withDpi(blob, dpi) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const jfif = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff && buf[3] === 0xe0
      && String.fromCharCode(buf[6], buf[7], buf[8], buf[9]) === 'JFIF';
    if (jfif) {
      buf[13] = 1; // 단위: 인치
      buf[14] = dpi >> 8; buf[15] = dpi & 255;
      buf[16] = dpi >> 8; buf[17] = dpi & 255;
    }
    return new Blob([buf], { type: 'image/jpeg' });
  }
  const saveBtn = document.querySelector('[data-maker-save]');
  saveBtn.addEventListener('click', async () => {
    if (!design && !confirm('시안 그림이 없어요. 그래도 저장할까요?')) return;
    saveBtn.disabled = true;
    try {
      const big = await bigCanvas();
      const blob = await new Promise(ok => big.toBlob(ok, 'image/jpeg', 0.97));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await withDpi(blob, SAVE_DPI));
      a.download = fileName();
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } finally {
      saveBtn.disabled = false;
    }
  });
  // 인쇄: 새 창 없이, 이 화면에서 그 그림 한 장만 A4 로 인쇄 (style.css 의 body.maker-printing)
  document.querySelector('[data-maker-print]').addEventListener('click', async () => {
    const big = await bigCanvas();
    let box = document.querySelector('.maker-print');
    if (!box) {
      box = document.createElement('div');
      box.className = 'maker-print';
      box.innerHTML = '<img alt="">';
      document.body.appendChild(box);
    }
    const img = box.querySelector('img');
    img.onload = () => {
      document.body.classList.add('maker-printing');
      window.print();
    };
    img.src = big.toDataURL('image/jpeg', 0.97);
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('maker-printing'));

  // 처음: 로고 · 주문에 올려 둔 시안을 불러와서 그린다
  const loadImg = src => new Promise(resolve => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  Promise.all([loadImg(data.logoUrl), loadImg(data.imageUrl)]).then(([l, d]) => {
    logo = l;
    if (d) design = d;
    render();
  });
  render();
})();
