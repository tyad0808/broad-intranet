// 답장에 붙인 파일 받기 (multipart/form-data)
// 파일은 메모리에만 잠깐 들고 있다가 메일로 보내고 버린다 — 서버 디스크에 저장하지 않는다.
// 보안 검사(CSRF)가 폼 값을 읽어야 해서 그보다 먼저 실행된다. 그래서 로그인한 직원의 요청만 읽는다.
const busboy = require('busboy');

const MAX_TOTAL = 20 * 1024 * 1024; // 한 번에 보낼 수 있는 파일 합계 (메일 서비스 한도 안쪽)
const MAX_FILES = 10;
const TOO_BIG = `첨부파일은 합계 ${MAX_TOTAL / 1024 / 1024}MB 까지 보낼 수 있습니다. 큰 파일은 웹하드 링크로 보내 주세요.`;

function replyUpload(req, res, next) {
  if (req.method !== 'POST' || !req.is('multipart/form-data')) return next();
  if (!req.user || req.user.status !== 'active') return next(); // 읽지 않으면 CSRF 검사에서 막힌다
  req.body = {};
  req.files = [];
  let total = 0;
  let finished = false;
  const done = () => { if (!finished) { finished = true; next(); } };
  let parser;
  try {
    parser = busboy({ headers: req.headers, limits: { files: MAX_FILES, fileSize: MAX_TOTAL, fields: 20, fieldSize: 100 * 1024 }, defParamCharset: 'utf8' });
  } catch {
    return next();
  }
  parser.on('field', (name, value) => { req.body[name] = value; });
  parser.on('file', (name, stream, info) => {
    const chunks = [];
    stream.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_TOTAL) req.uploadError = TOO_BIG;
      else chunks.push(chunk);
    });
    // 한 파일이 한도를 넘으면 busboy 가 거기서 자르고 'limit' 을 알린다 → 잘린 파일을 보내지 않도록 오류로
    stream.on('limit', () => { req.uploadError = TOO_BIG; });
    stream.on('end', () => {
      if (!info.filename || req.uploadError) return; // 파일을 고르지 않은 빈 칸
      req.files.push({ name: info.filename.slice(0, 200), type: info.mimeType || 'application/octet-stream', content: Buffer.concat(chunks) });
    });
  });
  parser.on('filesLimit', () => { req.uploadError = `파일은 한 번에 ${MAX_FILES}개까지 붙일 수 있습니다.`; });
  parser.on('error', () => { req.uploadError = '파일을 올리지 못했습니다. 다시 시도해 주세요.'; done(); });
  parser.on('close', done);
  req.pipe(parser);
}

module.exports = { replyUpload, MAX_TOTAL, MAX_FILES };
