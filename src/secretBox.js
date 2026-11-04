// 관리자 화면에서 넣은 비밀값(메일 앱 비밀번호 등)을 DB 에 암호화해서 저장한다
//
// 열쇠는 서버 .env 의 SETTINGS_KEY (64자리 16진수 = 32바이트) 에만 있다.
//   만들기: openssl rand -hex 32
// 그래서 DB·NAS 백업 파일만 가져가서는 비밀값을 풀 수 없다. 열쇠를 바꾸거나 잃으면 저장한 비밀값을 다시 넣어야 한다.
// 방식: AES-256-GCM (풀 때 내용이 바뀌었는지도 확인). 저장 모양: v1:<iv>:<tag>:<암호문> (모두 base64)
const crypto = require('crypto');

function parseKey(text) {
  const hex = String(text || '').trim();
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

function createSecretBox(keyText = process.env.SETTINGS_KEY) {
  const key = parseKey(keyText);
  return {
    ready: Boolean(key),
    // 열쇠가 잘못 들어 있으면(길이·글자) 화면에 알려 주려고
    keyProblem: !key && String(keyText || '').trim() ? 'SETTINGS_KEY 는 64자리 16진수여야 합니다 (openssl rand -hex 32 로 만든 값).' : null,
    seal(plain) {
      if (!key) throw new Error('서버 .env 에 SETTINGS_KEY 가 없어 비밀번호를 저장할 수 없습니다.');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
    },
    // 풀지 못하면(열쇠가 바뀜·내용이 망가짐) null
    open(sealed) {
      if (!key || !sealed) return null;
      const [v, iv, tag, data] = String(sealed).split(':');
      if (v !== 'v1' || !iv || !tag || !data) return null;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

module.exports = { createSecretBox };
