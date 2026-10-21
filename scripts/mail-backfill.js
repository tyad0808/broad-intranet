// 예전 메일 가져오기: 처음 연결할 때 최근 30일만 가져왔으므로, 그보다 오래된 메일을 문의함에 넣어 검색할 수 있게 한다.
//   이미 지난 메일이라 '처리 완료' 로 넣는다 (메일 사이트에서 답장한 메일은 '답변완료'). 알림은 보내지 않는다.
//   이미 들어와 있는 메일은 건너뛴다 — 여러 번 실행해도 똑같은 메일이 두 번 들어가지 않는다.
//
// 실행 (미리보기, 몇 통인지 세기만):  npm run mail-backfill
// 실제로 가져오기:                   npm run mail-backfill -- --apply
// 기간 바꾸기 (기본 365일, 최대 730일): npm run mail-backfill -- --days 180 --apply
require('dotenv').config({ quiet: true });

const { openDb, transaction } = require('../src/db');
const { mailAccountsFromEnv, backfillMail } = require('../src/inbox/mail');

// 메일 계정 하나: 인트라넷에 없는 메일만 가져와 넣는다
async function importOldMail(db, account, { days = 365, apply = false, backfill = backfillMail, onProgress = () => {} } = {}) {
  const known = new Set(db.prepare('SELECT external_id FROM inquiries WHERE source = ?').all(account.source).map(r => r.external_id));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO inquiries (source, external_id, from_name, from_addr, reply_to, subject, body, attachments,
      message_id, references_hdr, received_at, status, handled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  return backfill(account, {
    days,
    has: id => known.has(id),
    onBatch: apply ? async items => {
      let added = 0;
      transaction(db, () => {
        for (const it of items) {
          added += Number(insert.run(it.source, it.external_id, it.from_name, it.from_addr, it.reply_to, it.subject, it.body,
            it.attachments, it.message_id, it.references_hdr, it.received_at, it.answered ? 'answered' : 'closed').changes);
        }
      });
      onProgress(added);
      return added;
    } : null,
  });
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const daysAt = process.argv.indexOf('--days');
  const days = daysAt > -1 ? Number(process.argv[daysAt + 1]) : 365;
  if (!Number.isInteger(days) || days < 1 || days > 730) {
    console.log('--days 는 1~730 사이 숫자로 적어 주세요. 예: npm run mail-backfill -- --days 365');
    process.exit(1);
  }
  const accounts = mailAccountsFromEnv();
  if (!accounts.length) {
    console.log('.env 에 메일 계정이 없습니다 (NAVER_MAIL_USER/PASS, GMAIL_USER/PASS).');
    process.exit(0);
  }
  (async () => {
    const db = openDb();
    console.log(apply ? `지난 ${days}일 메일을 가져옵니다.` : `미리보기: 지난 ${days}일 메일 중 새로 들어올 메일을 셉니다 (아무것도 바꾸지 않음).`);
    for (const acc of accounts) {
      const name = `${acc.kindLabel} (${acc.user.replace(/^(.{2}).*(@.*)$/, '$1***$2')})`;
      console.log(`\n▶ ${name}`);
      try {
        let sum = 0;
        const out = await importOldMail(db, acc, {
          days, apply,
          onProgress: n => { sum += n; process.stdout.write(`  … ${sum}통 넣음\n`); },
        });
        console.log(`  지난 ${days}일 메일 ${out.found}통 중 인트라넷에 없는 메일 ${out.todo}통`);
        if (apply) console.log(`  ✓ ${out.added}통을 '처리 완료' 로 넣었습니다`);
      } catch (e) {
        console.log(`  ✗ 실패: ${e.message}`);
      }
    }
    if (!apply) console.log('\n실제로 가져오려면: npm run mail-backfill -- --apply' + (days !== 365 ? ` --days ${days}` : ''));
    db.close();
  })();
}

module.exports = { importOldMail };
