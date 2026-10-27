// 알림 소리: 관리자가 종류마다(주문·톡톡·메일·문의) 소리 파일을 올리거나, 기본 소리 / 소리 없음 으로 정한다
// 소리 파일은 로고처럼 DB(settings)에 넣어 둔다 → 매일 백업에 함께 들어간다
// 파일은 MP3·WAV·OGG·M4A(휴대폰 녹음) 만, 1MB 까지. 파일 앞부분으로 진짜 종류를 확인한다
const crypto = require('crypto');

const KINDS = { new_order: '🛒 주문', new_chat: '💬 톡톡', new_mail: '✉️ 메일', new_inquiry: '❓ 문의' };
const MAX_SOUND = 1024 * 1024;
const keyOf = kind => `sound_${kind}`;

function soundType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (buf.slice(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  // M4A: 휴대폰 음성 녹음(아이폰·갤럭시)이 이 모양 — 'ftyp' 다음이 M4A·mp4 계열
  if (buf.slice(4, 8).toString('latin1') === 'ftyp' && /^(M4A |M4B |mp41|mp42|isom|iso[2-6]|dash)/.test(buf.slice(8, 12).toString('latin1'))) return 'audio/mp4';
  return null;
}

function createSounds(db) {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const delStmt = db.prepare('DELETE FROM settings WHERE key = ?');
  let cache = null;

  // { kind: { mode: 'default' | 'file' | 'off', name, type, data(base64), v } }
  function load() {
    if (cache) return cache;
    cache = {};
    for (const kind of Object.keys(KINDS)) {
      let saved = null;
      try { saved = JSON.parse((getStmt.get(keyOf(kind)) || {}).value || 'null'); } catch { saved = null; }
      cache[kind] = saved && (saved.mode === 'off' || (saved.mode === 'file' && saved.data)) ? saved : { mode: 'default' };
    }
    return cache;
  }

  return {
    KINDS,
    // 관리자 화면용 (파일 내용은 빼고)
    list() {
      const all = load();
      return Object.entries(KINDS).map(([kind, label]) => ({ kind, label, mode: all[kind].mode, name: all[kind].name || null, v: all[kind].v || null }));
    },
    // 화면(live.js)에 알려 줄 것: { new_chat: '/sounds/new_chat?v=…', new_mail: 'off' } (기본 소리는 빠짐)
    clientMap() {
      const all = load();
      const map = {};
      for (const kind of Object.keys(KINDS)) {
        if (all[kind].mode === 'off') map[kind] = 'off';
        else if (all[kind].mode === 'file') map[kind] = `/sounds/${kind}?v=${all[kind].v}`;
      }
      return map;
    },
    file(kind) {
      const s = KINDS[kind] ? load()[kind] : null;
      return s && s.mode === 'file' ? { type: s.type, data: Buffer.from(s.data, 'base64'), v: s.v } : null;
    },
    // 올린 파일로 바꾸기. 틀리면 오류 문구
    setFile(kind, file) {
      if (!KINDS[kind]) return '알 수 없는 알림 종류입니다.';
      if (!file || !file.content || !file.content.length) return '소리 파일을 골라 주세요.';
      if (file.content.length > MAX_SOUND) return `소리 파일은 ${MAX_SOUND / 1024 / 1024}MB 까지 올릴 수 있어요.`;
      const type = soundType(file.content);
      if (!type) return 'MP3·WAV·OGG·M4A 소리 파일만 올릴 수 있어요.';
      const v = crypto.createHash('sha256').update(file.content).digest('hex').slice(0, 12);
      const name = String(file.name || '소리').slice(0, 80);
      putStmt.run(keyOf(kind), JSON.stringify({ mode: 'file', type, name, data: file.content.toString('base64'), v }));
      cache = null;
      return null;
    },
    // 'default' = 기본 소리로 되돌리기, 'off' = 소리 없음
    setMode(kind, mode) {
      if (!KINDS[kind]) return '알 수 없는 알림 종류입니다.';
      if (mode === 'off') putStmt.run(keyOf(kind), JSON.stringify({ mode: 'off' }));
      else delStmt.run(keyOf(kind));
      cache = null;
      return null;
    },
  };
}

module.exports = { createSounds, soundType, KINDS, MAX_SOUND };
