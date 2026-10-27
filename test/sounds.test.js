// 알림 소리: 관리자가 종류마다 소리 파일을 올리거나 기본 소리·소리 없음으로 정한다
const test = require('node:test');
const assert = require('node:assert');
const { soundType } = require('../src/sounds');
const { startServer, addUser, loginAs } = require('./helpers');

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(20)]);

test('소리 파일 종류는 파일 앞부분으로 확인한다 (MP3·WAV·OGG·M4A 만)', () => {
  assert.strictEqual(soundType(MP3), 'audio/mpeg');
  assert.strictEqual(soundType(Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(20)])), 'audio/mpeg');
  assert.strictEqual(soundType(WAV), 'audio/wav');
  assert.strictEqual(soundType(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)])), 'audio/ogg');
  assert.strictEqual(soundType(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(20)])), 'audio/mp4', '휴대폰 녹음');
  assert.strictEqual(soundType(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypqt  '), Buffer.alloc(20)])), null, '동영상(mov)은 아님');
  assert.strictEqual(soundType(Buffer.from('<html><script>alert(1)</script>')), null);
});

test('관리자 › 알림: 톡톡 소리 올리기 → 모든 화면에 알려 주고 파일을 내려 줌, 기본으로·소리 없음, 이상한 파일·직원은 막음', async t => {
  const { db, server, baseUrl } = await startServer();
  t.after(() => server.close());
  addUser(db, { email: 'boss@broad.test', role: 'admin' });
  addUser(db, { email: 'kim@broad.test' });
  const boss = await loginAs(baseUrl, 'boss@broad.test');
  const kim = await loginAs(baseUrl, 'kim@broad.test');
  const page = (await boss.request('/admin/notify')).text;
  assert.match(page, /id="sounds"/);
  assert.match(page, /💬 톡톡/);
  assert.doesNotMatch((await kim.request('/')).text, /data-sounds=/, '처음엔 모두 기본 소리');

  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const upload = (who, kind, name, content) => {
    const form = new FormData();
    form.append('_csrf', csrf);
    form.append('kind', kind);
    form.append('action', 'upload');
    form.append('file', new Blob([content]), name);
    return fetch(`${baseUrl}/admin/sounds`, { method: 'POST', body: form, headers: { cookie: who.cookie() }, redirect: 'manual' });
  };
  assert.strictEqual((await upload(boss, 'new_chat', '카톡.mp3', MP3)).status, 302);
  const home = (await kim.request('/')).text;
  const map = JSON.parse(/data-sounds="([^"]+)"/.exec(home)[1].replace(/&#34;/g, '"'));
  assert.match(map.new_chat, /^\/sounds\/new_chat\?v=[0-9a-f]{12}$/);
  const file = await fetch(`${baseUrl}${map.new_chat}`, { headers: { cookie: kim.cookie() } });
  assert.strictEqual(file.status, 200);
  assert.strictEqual(file.headers.get('content-type'), 'audio/mpeg');
  assert.strictEqual(Buffer.from(await file.arrayBuffer()).length, MP3.length);
  assert.notStrictEqual((await fetch(`${baseUrl}${map.new_chat}`, { redirect: 'manual' })).status, 200, '로그인해야 받음');
  assert.match((await boss.request('/admin/notify')).text, /올린 소리: 카톡\.mp3/);

  // 소리 파일이 아니면 막는다
  await upload(boss, 'new_mail', '가짜.mp3', Buffer.from('<html>not a sound</html>'));
  assert.match((await boss.request('/admin/notify')).text, /MP3·WAV·OGG·M4A 소리 파일만/);
  // 직원은 못 바꾼다
  assert.notStrictEqual((await upload(kim, 'new_mail', 'a.wav', WAV)).status, 302);

  await boss.submit('/admin/notify', '/admin/sounds', { kind: 'new_mail', action: 'off' });
  await boss.submit('/admin/notify', '/admin/sounds', { kind: 'new_chat', action: 'default' });
  const after = JSON.parse(/data-sounds="([^"]+)"/.exec((await kim.request('/')).text)[1].replace(/&#34;/g, '"'));
  assert.deepStrictEqual(after, { new_mail: 'off' });
  assert.strictEqual((await fetch(`${baseUrl}/sounds/new_chat`, { headers: { cookie: kim.cookie() } })).status, 404);
});
