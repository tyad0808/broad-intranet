// .env 파일의 값을 process.env 로 읽어온다 (가장 먼저 실행해야 함)
require('dotenv').config();

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// 서버가 살아 있는지 확인하는 주소
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.send('브로애드 인트라넷 준비 중');
});

app.listen(PORT, () => {
  console.log(`브로애드 인트라넷 실행 중: http://localhost:${PORT}`);
});
