// 문의함 수집: 출처(메일 계정 등)마다 새 문의를 가져와 inquiries 표에 넣는다
// 한 출처가 실패해도 나머지는 계속 가져온다. 어디까지 읽었는지는 settings 에 출처별로 기억한다.
const { transaction } = require('../db');

function createInboxCollector({ db, sources = [], notifier = null, now = () => new Date() }) {
  const getState = source => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`inbox_state_${source}`);
    try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
  };
  const setState = (source, state) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(`inbox_state_${source}`, JSON.stringify(state));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO inquiries (source, external_id, from_name, from_addr, reply_to, subject, body, attachments,
      message_id, references_hdr, received_at, status, handled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const markAnswered = db.prepare(`
    UPDATE inquiries SET status = 'answered', handled_at = datetime('now'), version = version + 1, updated_at = datetime('now')
    WHERE source = ? AND external_id = ? AND status = 'open'
  `);
  let running = null;

  async function runOnce() {
    const result = { ok: true, created: 0, answered: 0, errors: [] };
    const createdRows = [];
    for (const src of sources) {
      try {
        const openIds = db.prepare("SELECT external_id FROM inquiries WHERE source = ? AND status = 'open'")
          .all(src.source).map(r => r.external_id);
        const out = await src.fetch({ state: getState(src.source), openIds });
        transaction(db, () => {
          for (const it of out.items) {
            // 받기 전에 이미 메일 사이트에서 답장한 메일은 처음부터 '답변완료'
            const r = insert.run(it.source, it.external_id, it.from_name, it.from_addr, it.reply_to, it.subject, it.body,
              it.attachments, it.message_id, it.references_hdr, it.received_at,
              it.answered ? 'answered' : 'open', it.answered ? new Date().toISOString() : null);
            if (r.changes) {
              result.created++;
              if (!it.answered) createdRows.push({ id: Number(r.lastInsertRowid), label: src.label, ...it });
            }
          }
          for (const id of out.answeredIds || []) result.answered += markAnswered.run(src.source, id).changes;
          setState(src.source, out.state);
        });
      } catch (e) {
        result.ok = false;
        result.errors.push(`${src.label}: ${e.message}`);
      }
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('inbox_last_run', JSON.stringify({ at: now().toISOString(), ok: result.ok, errors: result.errors }));
    if (notifier && (result.created || result.answered)) notifier.inboxChanged();
    // 처음 연결할 때 30일치를 한꺼번에 알리지 않도록, 알림은 최근 1시간 안에 온 것만
    const recent = createdRows.filter(r => now().getTime() - Date.parse(r.received_at) < 3600 * 1000);
    if (notifier && recent.length) {
      notifier.notify('new_inquiry', {
        title: recent.length === 1 ? `새 문의 (${recent[0].label})` : `새 문의 ${recent.length}건`,
        body: recent.length === 1 ? `${recent[0].from_name || recent[0].from_addr || ''}: ${recent[0].subject}` : recent.slice(0, 3).map(r => r.subject).join(' / '),
        url: recent.length === 1 ? `/inbox/${recent[0].id}` : '/inbox',
      }, () => true);
    }
    return result;
  }

  return {
    sources,
    // 이미 받는 중이면 그 결과를 함께 기다린다 (자동 수집과 '지금 받기' 가 겹쳐도 한 번만)
    run() {
      if (!running) running = runOnce().finally(() => { running = null; });
      return running;
    },
    isRunning: () => Boolean(running),
  };
}

module.exports = { createInboxCollector };
