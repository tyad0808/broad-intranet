// 직원 사용 안내서: docs/guide.md 를 읽어 화면용 HTML 로 바꾼다
// 안내서에 쓰는 모양만 다룬다: 제목(# ## ###), 문단, 글머리표(-), 번호 목록(1.), 표(| |), 굵게(**), 링크
// 글자는 모두 먼저 이스케이프한다 → 안내서에 <script> 같은 게 들어가도 그대로 글자로 보인다
const fs = require('fs');
const path = require('path');

const GUIDE_PATH = path.join(__dirname, '..', 'docs', 'guide.md');

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 한 줄 안의 꾸밈: 굵게, [글자](주소), <주소>. 주소는 http(s) 만
function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

// 반환: { title, html, toc: [{ id, text }] }
function renderGuide(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const toc = [];
  let title = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (level === 1) title = h[2].trim();
      else if (level === 2) {
        const id = `s${toc.length + 1}`;
        toc.push({ id, text: h[2].trim() });
        out.push(`<h2 id="${id}">${inline(h[2])}</h2>`);
      } else out.push(`<h3>${inline(h[2])}</h3>`);
      i += 1;
      continue;
    }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const body = rows.filter(r => !/^\|[\s:|-]+\|?$/.test(r.trim()));
      const [head, ...rest] = body;
      out.push('<div class="guide-table"><table><thead><tr>' + cells(head).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rest.map(r => '<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    const list = /^(\s*)(-|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = list[2] !== '-';
      const items = [];
      while (i < lines.length && /^\s*(-|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*(-|\d+\.)\s+/, ''));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    // 문단: 빈 줄이나 다른 모양이 나올 때까지
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\||\s*(-|\d+\.)\s)/.test(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return { title, html: out.join('\n'), toc };
}

// 파일이 바뀌면 다시 읽는다 (업데이트 뒤 서버를 다시 켜지 않아도 새 내용)
let cache = null;
function loadGuide(file = GUIDE_PATH) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  if (!cache || cache.file !== file || cache.mtime !== mtime) cache = { file, mtime, guide: renderGuide(fs.readFileSync(file, 'utf8')) };
  return cache.guide;
}

module.exports = { renderGuide, loadGuide, GUIDE_PATH };
