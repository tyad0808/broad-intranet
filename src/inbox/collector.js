// 문의함 수집: 출처(메일 계정 등)마다 새 문의를 가져와 inquiries 표에 넣는다
// 한 출처가 실패해도 나머지는 계속 가져온다. 어디까지 읽었는지는 settings 에 출처별로 기억한다.
const { transaction } = require('../db');

// 메일 계정에서 온 것 (naver_mail, naver_mail2, gmail …)
const isMailSource = source => /^(naver_mail|gmail)/.test(String(source || ''));

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
      message_id, references_hdr, received_at, status, handled_at, order_no, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const markAnswered = db.prepare(`
    UPDATE inquiries SET status = 'answered', handled_at = datetime('now'), version = version + 1, updated_at = datetime('now')
    WHERE source = ? AND external_id = ? AND status = 'open'
  `);
  const updateMeta = db.prepare("UPDATE inquiries SET meta = ?, subject = ? WHERE source = ? AND external_id = ? AND status = 'open'");
  // 보낸 사람이 비어 있는 문의(쿠팡 문의는 고객 이름을 주지 않음): 문의에 적힌 주문번호의 주문자 이름으로 채운다
  //   주문이 문의보다 늦게 들어올 수도 있어 받을 때마다 다시 본다
  const fillNames = db.prepare(`
    UPDATE inquiries SET from_name = (
      SELECT COALESCE(NULLIF(o.buyer_name, ''), o.receiver_name) FROM orders o
      WHERE o.channel_order_id = inquiries.order_no AND COALESCE(NULLIF(o.buyer_name, ''), o.receiver_name) IS NOT NULL ORDER BY o.id LIMIT 1)
    WHERE (from_name IS NULL OR from_name = '') AND order_no IS NOT NULL
      AND EXISTS (SELECT 1 FROM orders o WHERE o.channel_order_id = inquiries.order_no AND COALESCE(NULLIF(o.buyer_name, ''), o.receiver_name) IS NOT NULL)
  `);
  let running = null;

  async function runOnce() {
    const result = { ok: true, created: 0, answered: 0, errors: [] };
    const createdRows = [];
    // 메일 계정들을 동시에 받는다 (걸리는 시간 = 가장 느린 계정 하나만큼)
    const fetched = await Promise.allSettled(sources.map(src => {
      const open = db.prepare("SELECT external_id, received_at FROM inquiries WHERE source = ? AND status = 'open' AND deleted_at IS NULL")
        .all(src.source);
      const openIds = open.map(r => r.external_id);
      // 가장 오래된 미답변 문의 시각: 그때부터 다시 읽어야 판매자센터에서 나중에 단 답변을 알아챈다
      const openSince = open.map(r => Date.parse(r.received_at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      return src.fetch({ state: getState(src.source), openIds, openSince: Number.isFinite(openSince) ? new Date(openSince) : null });
    }));
    for (const [n, src] of sources.entries()) {
      try {
        if (fetched[n].status === 'rejected') throw fetched[n].reason;
        const out = fetched[n].value;
        transaction(db, () => {
          for (const it of out.items) {
            // 받기 전에 이미 메일 사이트에서 답장한 메일은 처음부터 '답변완료'
            const r = insert.run(it.source, it.external_id, it.from_name, it.from_addr, it.reply_to, it.subject, it.body,
              it.attachments, it.message_id, it.references_hdr, it.received_at,
              it.answered ? 'answered' : 'open', it.answered ? new Date().toISOString() : null,
              it.order_no || null, it.meta || null);
            // 이미 있는 문의: 답변에 필요한 값(meta)만 최신으로 (쿠팡 고객센터 문의의 상담 답변 번호 등)
            if (!r.changes && it.meta) updateMeta.run(it.meta, it.subject, it.source, it.external_id);
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
    fillNames.run();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('inbox_last_run', JSON.stringify({ at: now().toISOString(), ok: result.ok, errors: result.errors }));
    if (notifier && (result.created || result.answered)) notifier.inboxChanged();
    // 처음 연결할 때 30일치를 한꺼번에 알리지 않도록, 알림은 최근 1시간 안에 온 것만
    const recent = createdRows.filter(r => now().getTime() - Date.parse(r.received_at) < 3600 * 1000);
    // 메일과 쇼핑몰 문의는 따로 알린다 (직원마다 메일함·문의함 알림을 따로 끌 수 있다)
    for (const box of ['mail', 'inbox']) {
      const list = recent.filter(r => isMailSource(r.source) === (box === 'mail'));
      if (!notifier || !list.length) continue;
      const word = box === 'mail' ? '메일' : '문의';
      const payload = {
        title: list.length === 1 ? `새 ${word} (${list[0].label})` : `새 ${word} ${list.length}건`,
        body: list.length === 1 ? `${list[0].from_name || list[0].from_addr || ''}: ${list[0].subject}` : list.slice(0, 3).map(r => r.subject).join(' / '),
        url: list.length === 1 ? `/inbox/${list[0].id}` : box === 'mail' ? '/inbox?box=mail' : '/inbox',
      };
      if (notifier.inboxNew) notifier.inboxNew(box, payload);
      else notifier.notify(box === 'mail' ? 'new_mail' : 'new_inquiry', payload, () => true);
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
