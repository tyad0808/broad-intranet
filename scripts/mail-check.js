// 메일 연결 점검: 계정마다 연결 → 받은편지함 → 최근 30일 검색 → 메일 한 통 받기 를 단계별로 해 보고 걸린 시간을 보여준다
// 메일 내용·비밀번호는 출력하지 않는다 (개수·크기만). 아무것도 바꾸지 않는다.
// 실행: cd /opt/broad-intranet/app && sudo -u intranet npm run mail-check
require('dotenv').config({ quiet: true });
const { mailAccountsFromEnv, defaultConnect, withTimeout } = require('../src/inbox/mail');

(async () => {
  const accounts = mailAccountsFromEnv();
  if (!accounts.length) return console.log('.env 에 메일 계정이 없습니다 (NAVER_MAIL_USER/PASS, GMAIL_USER/PASS).');
  for (const acc of accounts) {
    console.log(`\n▶ ${acc.label} (${acc.user.replace(/^(.{2}).*(@.*)$/, '$1***$2')})`);
    const t0 = Date.now();
    const step = async (name, fn, ms = 30_000) => {
      const t = Date.now();
      try {
        const out = await withTimeout(Promise.resolve().then(fn), ms, `${ms / 1000}초 안에 끝나지 않음`);
        console.log(`  ✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}초)${out ? ` — ${out}` : ''}`);
        return true;
      } catch (e) {
        console.log(`  ✗ ${name} 실패: ${e.message}${e.responseText ? ` / ${e.responseText}` : ''}`);
        return false;
      }
    };
    let client = null;
    let lock = null;
    let uids = [];
    const ok = await step('메일 서버 접속·로그인', async () => { client = await defaultConnect(acc); })
      && await step('받은편지함 열기', async () => { lock = await client.getMailboxLock('INBOX'); return `메일 ${client.mailbox.exists}통`; })
      && await step('최근 30일 메일 찾기', async () => {
        uids = (await client.search({ since: new Date(Date.now() - 30 * 24 * 3600 * 1000) }, { uid: true })) || [];
        return `${uids.length}통 (한 번에 최대 200통씩 가져옴)`;
      }, 60_000)
      && (uids.length === 0 || await step('가장 최근 메일 한 통 받아 보기', async () => {
        const m = await client.fetchOne(String(uids[uids.length - 1]), { uid: true, source: true }, { uid: true });
        return `${Math.round(((m && m.source && m.source.length) || 0) / 1024)}KB`;
      }, 60_000));
    if (lock) lock.release();
    if (client) await client.logout().catch(() => {});
    console.log(ok ? `  → 정상 (${((Date.now() - t0) / 1000).toFixed(1)}초)` : '  → 위에서 실패한 단계를 확인하세요');
  }
  process.exit(0);
})();
