// 4차 문의함: 메일·쇼핑몰 문의를 한 목록에서 보고, 담당자를 정하고, 인트라넷에서 바로 답변한다
//
// 답변 보내기는 출처마다 따로 켠다 (메일: .env 의 MAIL_SEND=on). 꺼져 있으면 연습 모드 — 보내지 않고 기록만 남긴다.
const express = require('express');
const { transaction } = require('../db');
const { previewType, isMailSource } = require('../inbox/mail');
const { IMAGE_HOSTS, PARTNER_CENTER_URL, MAX_IMAGE, orderNoIn, linkSaidOrders, imageKind } = require('../inbox/talktalk');
const { templatesFor } = require('./templates');
const { ordersForInquiry } = require('../customer');
const { INQUIRY_TIME, hideCutoff, hideDays, periodRange, periodLabel, quickPeriods } = require('../retention');

const TABS = { open: '미답변', mine: '내 담당', done: '답변완료', all: '전체' };
// 위쪽 큰 탭: 쇼핑몰 문의 / 메일 / 채팅 (섞여 있으면 헷갈려서 나눈다)
const BOXES = { shop: '쇼핑몰 문의', mail: '메일', chat: '채팅' };
// 화면 제목 = 왼쪽 메뉴 이름
const PAGE_TITLES = { shop: '문의함', mail: '메일함', chat: '톡톡' };
const isChatSource = source => source === 'talktalk';
const boxOf = source => (isMailSource(source) ? 'mail' : isChatSource(source) ? 'chat' : 'shop');
// 메일 출처: naver_mail, naver_mail2, gmail … (계정을 늘려도 그대로)
const MAIL_SQL = "(q.source GLOB 'naver_mail*' OR q.source GLOB 'gmail*')";
const CHAT_SQL = "(q.source = 'talktalk')";
// 지운 메일(deleted_at)은 어디에도 보이지 않는다
const LIVE_SQL = 'q.deleted_at IS NULL';
const BOX_SQL = { mail: `(${MAIL_SQL} AND ${LIVE_SQL})`, chat: CHAT_SQL, shop: `(NOT ${MAIL_SQL} AND NOT ${CHAT_SQL})` };
const STATUS_LABELS = { open: '미답변', answered: '답변완료', closed: '처리 완료' };
// 톡톡은 네이버 톡톡 파트너센터와 같은 이름으로: 대기(손님 말에 아직 답 안 함) · 진행중(답함) · 보류
const CHAT_STATUS = { open: '대기', answered: '진행중', closed: '보류' };
const CHAT_TABS = { all: '전체', wait: '대기', ing: '진행중', hold: '보류' };
const CHAT_TAB_SQL = { all: null, wait: "q.status = 'open'", ing: "q.status = 'answered'", hold: "q.status = 'closed'" };
const CHAT_DAYS = { 7: '최근 1주일', 30: '최근 1개월', 90: '최근 3개월' };
// 마지막 말·우리 마지막 답·안 읽은 손님 말 수 (우리 답 또는 직원이 읽은 곳 뒤에 온 손님 말)
const LAST_OUT_SQL = "(SELECT MAX(id) FROM chat_messages WHERE inquiry_id = q.id AND direction = 'out')";
const UNREAD_SQL = `(SELECT COUNT(*) FROM chat_messages m WHERE m.inquiry_id = q.id AND m.direction = 'in'
  AND m.id > MAX(COALESCE(q.chat_read_id, 0), COALESCE(${LAST_OUT_SQL}, 0)))`;
const LAST_AT_SQL = 'COALESCE(lm.created_at, q.received_at)';

// 톡톡 목록의 시각: 오늘이면 '오후 12:41', 올해면 '10.21', 그 전이면 '25.10.21'
function talkTime(value, now = new Date()) {
  const t = Date.parse(value || '');
  if (!Number.isFinite(t)) return '';
  const k = new Date(t + 9 * 3600 * 1000);
  const n = new Date(now.getTime() + 9 * 3600 * 1000);
  const pad = v => String(v).padStart(2, '0');
  if (k.toISOString().slice(0, 10) === n.toISOString().slice(0, 10)) {
    const h = k.getUTCHours();
    return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${pad(k.getUTCMinutes())}`;
  }
  const md = `${pad(k.getUTCMonth() + 1)}.${pad(k.getUTCDate())}`;
  return k.getUTCFullYear() === n.getUTCFullYear() ? md : `${String(k.getUTCFullYear()).slice(2)}.${md}`;
}
const metaOf = row => { try { return JSON.parse((row && row.meta) || '{}') || {}; } catch { return {}; } };
const MAX_REPLY = 10_000;

// 검색어 → 단어들 (띄어쓰기로 나눔, 최대 5개). 단어가 모두 들어 있는 문의를 찾는다
const searchTerms = q => [...new Set(String(q || '').trim().split(/\s+/).filter(Boolean))].slice(0, 5);
const SEARCH_FIELDS = ['q.subject', 'q.body', 'q.from_name', 'q.from_addr', 'q.order_no'];
// LIKE 에서 % _ 는 '아무 글자' 라서, 그 글자 자체를 찾을 수 있게 \ 를 앞에 붙인다
const likeOf = term => `%${term.replace(/[\\%_]/g, c => `\\${c}`)}%`;
function searchWhere(terms) {
  return {
    sql: terms.map(() => `(${SEARCH_FIELDS.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`),
    params: terms.flatMap(t => Array(SEARCH_FIELDS.length).fill(likeOf(t))),
  };
}
// 글자를 [{ text, hit }] 조각으로 (찾은 단어를 화면에서 노란색으로 칠할 때)
function highlightParts(text, terms) {
  const s = String(text || '');
  if (!terms.length || !s) return [{ text: s, hit: false }];
  const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return s.split(re).filter(Boolean).map(part => ({ text: part, hit: terms.some(t => t.toLowerCase() === part.toLowerCase()) }));
}

// '쿠팡으로 / 스마트스토어로 / 메일주소로' — 받침에 따라 '으로'/'로' (ㄹ 받침은 '로')
function withRo(word) {
  const last = String(word || '').trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return `${word}로`;
  const jong = code % 28;
  return `${word}${jong === 0 || jong === 8 ? '로' : '으로'}`;
}

// files: { naver_mail: 첨부파일 열기 } (메일함에서 그때그때 가져온다)
function inboxRoutes(db, { collector = null, senders = {}, files = {}, sourceLabels = {}, notifier, brandName = () => '' }) {
  const router = express.Router();
  const busy = new Set(); // 같은 문의에 답변을 두 번 연달아 보내는 것 방지

  const labelOf = source => sourceLabels[source] || source;
  const findInquiry = id => db.prepare(`
    SELECT q.*, u.name AS assignee_name, h.name AS handled_name FROM inquiries q
    LEFT JOIN users u ON u.id = q.assignee_id LEFT JOIN users h ON h.id = q.handled_by
    WHERE q.id = ? AND q.deleted_at IS NULL
  `).get(Number(id));
  const staff = () => db.prepare("SELECT id, name FROM users WHERE status = 'active' ORDER BY name").all();
  const modeOf = source => (senders[source] ? 'live' : 'practice');
  const bump = id => db.prepare("UPDATE inquiries SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(id);
  const back = req => safeBack(req.body.back || req.query.back);
  const selfUrl = (id, b) => `/inbox/${Number(id)}${b !== '/inbox' ? `?back=${encodeURIComponent(b)}` : ''}`;
  const flashTo = (req, res, url, type, message) => {
    req.session.flash = { type, message };
    res.redirect(url);
  };

  // ───────── 목록 ─────────
  router.get('/inbox', (req, res) => {
    if (req.query.box === 'chat' && !req.query.src) return chatList(req, res);
    const src = String(req.query.src || '');
    const q = String(req.query.q || '').trim().slice(0, 50);
    const terms = searchTerms(q);
    // 기간 보기 (from·to=YYYY-MM-DD, 받은 날 기준): 그 기간 문의를 답변한 것까지 모두
    const period = periodRange(req.query.from, req.query.to);
    // 검색·기간 보기는 처음에 '전체' 탭 (이미 답한 메일도 찾을 수 있게)
    const defaultTab = terms.length || period ? 'all' : 'open';
    const tab = TABS[req.query.tab] ? req.query.tab : defaultTab;
    // 출처를 골랐으면 그 출처의 탭, 아니면 고른 탭 (처음엔 쇼핑몰 문의)
    // 큰 탭 순서는 직원마다 (끌어다 놓아 바꿈). 맨 앞 탭이 처음 열린다
    // 채팅 탭은 톡톡을 연결했거나 채팅이 있을 때만
    const shown = Object.keys(BOXES).filter(b => b !== 'chat' || Object.keys(sourceLabels).some(isChatSource)
      || db.prepare(`SELECT 1 FROM inquiries q WHERE ${CHAT_SQL} LIMIT 1`).get());
    const boxOrder = userBoxOrder(req.user).filter(b => shown.includes(b));
    // 왼쪽 메뉴가 '문의함'(쇼핑몰 문의), '톡톡'(/inbox?box=chat), '메일함'(/inbox?box=mail)으로 나뉜다. 그냥 /inbox 는 문의함
    const inquiryBoxes = boxOrder.filter(b => b !== 'mail' && b !== 'chat');
    const box = src ? boxOf(src) : shown.includes(req.query.box) ? req.query.box : inquiryBoxes[0];
    const boxSql = b => BOX_SQL[b];

    // 큰 탭에 붙일 미답변 건수
    const boxCounts = Object.fromEntries(shown.map(b => [b,
      db.prepare(`SELECT COUNT(*) AS n FROM inquiries q WHERE q.status = 'open' AND ${boxSql(b)}`).get().n]));

    const search = searchWhere(terms);
    const base = [boxSql(box), ...search.sql];
    const params = [...search.params];
    if (period) {
      base.push(`${INQUIRY_TIME} >= ? AND ${INQUIRY_TIME} < ?`);
      params.push(period.start, period.end);
    }
    // 검색할 때: 다른 큰 탭에서 찾은 건수 (메일에서 찾았는데 쇼핑몰 문의에 있는 경우 알려주기)
    const otherHits = terms.length
      ? shown.filter(b => b !== box).map(b => ({
        box: b,
        n: db.prepare(`SELECT COUNT(*) AS n FROM inquiries q WHERE ${[boxSql(b), ...search.sql].join(' AND ')}`).get(...search.params).n,
      })).filter(h => h.n)
      : [];
    // 답변한 문의는 N일(기본 14일)이 지나면 '답변완료'·'전체' 에서 숨긴다 (검색·월별 보기로는 보임)
    const hidingOld = !terms.length && !period;
    const recent = `${INQUIRY_TIME} >= '${hideCutoff(db)}'`;
    const tabWhere = {
      open: ["q.status = 'open'"],
      mine: ["q.status = 'open'", 'q.assignee_id = ?'],
      done: ["q.status IN ('answered', 'closed')", ...(hidingOld ? [recent] : [])],
      all: hidingOld ? [`(q.status = 'open' OR ${recent})`] : [],
    };
    const tabParams = { mine: [req.user.id] };
    const whereSql = list => (list.length ? 'WHERE ' + list.join(' AND ') : '');

    // 탭 건수 (출처 칩 조건 포함), 출처 칩 건수 (탭 조건 포함)
    const srcWhere = src ? ['q.source = ?'] : [];
    const srcParams = src ? [src] : [];
    const tabCounts = {};
    for (const key of Object.keys(TABS)) {
      tabCounts[key] = db.prepare(`SELECT COUNT(*) AS n FROM inquiries q ${whereSql([...base, ...srcWhere, ...tabWhere[key]])}`)
        .get(...params, ...srcParams, ...(tabParams[key] || [])).n;
    }
    const sourceCounts = Object.fromEntries(db.prepare(`
      SELECT q.source, COUNT(*) AS n FROM inquiries q ${whereSql([...base, ...tabWhere[tab]])} GROUP BY q.source
    `).all(...params, ...(tabParams[tab] || [])).map(r => [r.source, r.n]));
    const sources = [...new Set([...Object.keys(sourceLabels), ...Object.keys(sourceCounts)])].filter(s => boxOf(s) === box);
    // 출처 칩 이름: 메일은 '네이버메일 / 지메일' 로 짧게. 같은 종류가 여러 개면 아이디를 붙여 구분 (네이버메일 · bro_ad)
    const kindOf = s => (/^naver_mail/.test(s) ? '네이버메일' : /^gmail/.test(s) ? '지메일' : null);
    const chipLabel = s => {
      const kind = kindOf(s);
      if (!kind) return labelOf(s);
      const same = sources.filter(x => kindOf(x) === kind).length;
      return same > 1 ? `${kind} · ${String(labelOf(s)).split('@')[0]}` : kind;
    };

    const rows = db.prepare(`
      SELECT q.id, q.source, q.from_name, q.from_addr, q.subject, q.received_at,
        substr(q.body, max(1, instr(lower(q.body), lower(?1)) - 40), 160) AS preview,
        instr(lower(q.body), lower(?1)) > 41 AS preview_cut,
        q.status, q.assignee_id, q.attachments, u.name AS assignee_name
      FROM inquiries q LEFT JOIN users u ON u.id = q.assignee_id
      ${whereSql([...base, ...srcWhere, ...tabWhere[tab]])}
      ORDER BY q.received_at DESC, q.id DESC LIMIT 300
    `).all(terms[0] || '', ...params, ...srcParams, ...(tabParams[tab] || []));

    let lastRun = null;
    try { lastRun = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'inbox_last_run'").get() || {}).value || 'null'); } catch { lastRun = null; }

    res.render('inbox/list', {
      title: PAGE_TITLES[box] || '문의함',
      navSection: box === 'mail' || box === 'chat' ? box : 'inbox',
      pageTitle: PAGE_TITLES[box] || '문의함',
      inquiryBoxes,
      rows, tab, defaultTab, TABS, tabCounts, src, sources, sourceCounts, q, labelOf, STATUS_LABELS,
      hl: text => highlightParts(text, terms), otherHits,
      from: period ? period.from : '', to: period ? period.to : '', periodText: periodLabel(period), quick: quickPeriods(), hidingOld: hidingOld && tab !== 'open' && tab !== 'mine', hideDays: hideDays(db),
      box, BOXES: Object.fromEntries(shown.map(b => [b, BOXES[b]])), boxCounts, chipLabel, boxOrder, defaultBox: inquiryBoxes[0],
      staff: staff(),
      canCollect: Boolean(collector),
      noSources: !Object.keys(sourceLabels).some(s => boxOf(s) === box),
      lastRun,
      currentUrl: req.originalUrl,
      // 채팅(톡톡)은 답장을 파트너센터에서 하므로 연습 모드 안내에서 뺀다
      modes: Object.fromEntries(Object.keys(sourceLabels).filter(s => boxOf(s) === box && !isChatSource(s)).map(s => [s, modeOf(s)])),
    });
  });

  // ───────── 톡톡 목록 (네이버 톡톡 파트너센터와 비슷한 모양) ─────────
  //   탭: 전체·대기·진행중·보류 / 거르기: 담당(who)·기간(days)·읽음(read)·정렬(sort) / 검색: 대화 내용·이름·고객 메모·상품·주문번호
  function chatList(req, res) {
    linkSaidOrders(db); // 손님이 말한 주문번호의 주문이 그사이 수집됐으면 연결
    const q = String(req.query.q || '').trim().slice(0, 50);
    const terms = searchTerms(q);
    const tab = CHAT_TABS[req.query.tab] ? req.query.tab : 'all';
    const who = String(req.query.who || '');
    const days = CHAT_DAYS[req.query.days] ? String(req.query.days) : '';
    const read = ['unread', 'read'].includes(req.query.read) ? req.query.read : '';
    const sort = req.query.sort === 'old' ? 'old' : '';

    const where = [CHAT_SQL];
    const params = [];
    for (const t of terms) {
      const fields = ['q.from_name', 'q.cust_memo', 'q.order_no', 'q.meta'].map(f => `${f} LIKE ? ESCAPE '\\'`);
      where.push(`(${fields.join(' OR ')} OR EXISTS (SELECT 1 FROM chat_messages s WHERE s.inquiry_id = q.id AND s.text LIKE ? ESCAPE '\\'))`);
      params.push(...Array(5).fill(likeOf(t)));
    }
    if (who === 'mine') { where.push('q.assignee_id = ?'); params.push(req.user.id); }
    else if (who === 'none') where.push('q.assignee_id IS NULL');
    else if (/^\d+$/.test(who)) { where.push('q.assignee_id = ?'); params.push(Number(who)); }
    if (days) { where.push(`${LAST_AT_SQL} >= ?`); params.push(new Date(Date.now() - Number(days) * 24 * 3600 * 1000).toISOString()); }
    if (read) where.push(`${UNREAD_SQL} ${read === 'unread' ? '> 0' : '= 0'}`);

    const from = `FROM inquiries q
      LEFT JOIN chat_messages lm ON lm.id = (SELECT MAX(id) FROM chat_messages WHERE inquiry_id = q.id)`;
    const sql = list => `WHERE ${list.filter(Boolean).join(' AND ')}`;
    const tabCounts = Object.fromEntries(Object.keys(CHAT_TABS).map(k => [k,
      db.prepare(`SELECT COUNT(*) AS n ${from} ${sql([...where, CHAT_TAB_SQL[k]])}`).get(...params).n]));
    const rows = db.prepare(`
      SELECT q.id, q.from_name, q.cust_memo, q.status, q.assignee_id, q.order_no, q.meta, q.received_at,
        lm.direction AS last_dir, lm.kind AS last_kind, COALESCE(lm.text, q.body) AS last_text, ${LAST_AT_SQL} AS last_at, ${UNREAD_SQL} AS unread,
        (SELECT o.product_name FROM orders o WHERE o.channel_order_id = q.order_no ORDER BY o.item_type = 'addon', o.id LIMIT 1) AS order_product
      ${from} ${sql([...where, CHAT_TAB_SQL[tab]])}
      ORDER BY ${LAST_AT_SQL} ${sort === 'old' ? 'ASC' : 'DESC'}, q.id DESC LIMIT 300
    `).all(...params).map(r => ({ ...r, product: metaOf(r).product || null }));

    res.render('inbox/chat-list', {
      title: '톡톡', navSection: 'chat',
      rows, tab, tabCounts, CHAT_TABS, CHAT_DAYS, CHAT_STATUS, q, who, days, read, sort, terms,
      hl: text => highlightParts(text, terms),
      talkTime, staff: staff(), brandName: brandName() || '우리', currentUrl: req.originalUrl, PARTNER_CENTER_URL,
    });
  }

  // 문의함 큰 탭 순서 저장 (끌어다 놓기). 내 계정에만 적용된다
  router.post('/me/inbox-order', (req, res) => {
    const order = [...new Set(String(req.body.order || '').split(',').map(x => x.trim()).filter(b => BOXES[b]))];
    db.prepare('UPDATE users SET inbox_order = ? WHERE id = ?').run(JSON.stringify(order), req.user.id);
    res.json({ ok: true, order });
  });

  // 지금 받기
  router.post('/inbox/collect', async (req, res, next) => {
    try {
      const b = back(req);
      if (!collector) return flashTo(req, res, b, 'error', '연결된 메일이 없습니다. .env 에 메일 계정을 넣어 주세요.');
      // 자동 받기가 진행 중이면 기다리게 하지 않고 바로 알려준다 (처음 30일치는 몇 분 걸릴 수 있음)
      if (collector.isRunning && collector.isRunning()) {
        return flashTo(req, res, b, 'warn', '지금 메일을 받는 중입니다. 1~2분 뒤 새로고침해 보세요. (처음에는 30일치라 오래 걸릴 수 있어요)');
      }
      // 10초 안에 끝나면 결과를 바로 보여주고, 더 걸리면 먼저 돌려준다 (새 메일은 받는 대로 목록에 자동으로 나타남)
      const running = collector.run();
      const r = await Promise.race([running, new Promise(resolve => setTimeout(() => resolve(null), 10_000).unref())]);
      if (!r) return flashTo(req, res, b, 'warn', '메일이 많아 계속 받는 중입니다. 새 메일은 받는 대로 목록에 자동으로 나타나요.');
      const parts = [`새 문의 ${r.created}건`];
      if (r.answered) parts.push(`메일 사이트에서 답장한 ${r.answered}건은 답변완료로`);
      if (r.ok) return flashTo(req, res, b, 'ok', `받기 완료: ${parts.join(', ')}.`);
      flashTo(req, res, b, 'error', `일부를 받지 못했습니다 — ${r.errors.join(' / ')} (${parts.join(', ')})`);
    } catch (e) {
      next(e);
    }
  });

  // 여러 건 '처리 완료' (광고·알림 메일처럼 답변이 필요 없는 것)
  router.post('/inbox/bulk/close', (req, res) => {
    const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean).slice(0, 300);
    const b = back(req);
    if (!ids.length) return flashTo(req, res, b, 'error', '처리할 문의를 체크해 주세요.');
    const marks = ids.map(() => '?').join(',');
    const n = db.prepare(`
      UPDATE inquiries SET status = 'closed', handled_by = ?, handled_at = datetime('now'), version = version + 1, updated_at = datetime('now')
      WHERE id IN (${marks}) AND status = 'open'
    `).run(req.user.id, ...ids).changes;
    notifier.inboxChanged(ids, req.user.id);
    flashTo(req, res, b, 'ok', `${n}건을 처리 완료로 바꿨습니다.`);
  });

  // 메일 삭제 (인트라넷에서만 — 네이버메일·지메일의 원본은 그대로)
  //   내용·답변 기록은 지우고 '누가 언제 지웠는지' 만 남긴다. 쇼핑몰 문의·채팅은 지우지 않는다
  const deleteMails = (ids, userId) => {
    const marks = ids.map(() => '?').join(',');
    const targets = db.prepare(`SELECT q.id FROM inquiries q WHERE q.id IN (${marks}) AND ${BOX_SQL.mail}`).all(...ids).map(r => r.id);
    if (!targets.length) return 0;
    const tm = targets.map(() => '?').join(',');
    transaction(db, () => {
      db.prepare(`DELETE FROM inquiry_replies WHERE inquiry_id IN (${tm})`).run(...targets);
      db.prepare(`
        UPDATE inquiries SET deleted_at = datetime('now'), deleted_by = ?, subject = NULL, body = NULL, from_name = NULL, from_addr = NULL,
          reply_to = NULL, attachments = '[]', message_id = NULL, references_hdr = NULL, order_no = NULL, meta = NULL, assignee_id = NULL,
          version = version + 1, updated_at = datetime('now')
        WHERE id IN (${tm})
      `).run(userId, ...targets);
    });
    notifier.inboxChanged(targets, userId);
    return targets.length;
  };

  router.post('/inbox/bulk/delete', (req, res) => {
    const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean).slice(0, 300);
    const b = back(req);
    if (!ids.length) return flashTo(req, res, b, 'error', '지울 메일을 체크해 주세요.');
    const n = deleteMails(ids, req.user.id);
    flashTo(req, res, b, n ? 'ok' : 'error', n ? `메일 ${n}통을 삭제했습니다. (메일 사이트의 원본은 그대로 있어요)` : '지울 수 있는 메일이 없습니다. (메일만 지울 수 있어요)');
  });

  router.post('/inbox/:id/delete', (req, res) => {
    const b = back(req);
    const inquiry = findInquiry(req.params.id);
    if (!inquiry) return flashTo(req, res, b, 'error', '문의를 찾을 수 없습니다.');
    if (!isMailSource(inquiry.source)) return flashTo(req, res, selfUrl(inquiry.id, b), 'error', '메일만 지울 수 있습니다.');
    deleteMails([inquiry.id], req.user.id);
    flashTo(req, res, b, 'ok', '메일을 삭제했습니다. (메일 사이트의 원본은 그대로 있어요)');
  });

  // ───────── 문의 하나 ─────────
  router.get('/inbox/:id', (req, res) => {
    const inquiry = findInquiry(req.params.id);
    if (!inquiry) return res.status(404).render('error', { title: '없는 문의', message: '문의를 찾을 수 없습니다.' });
    let attachments = [];
    try { attachments = JSON.parse(inquiry.attachments || '[]'); } catch { attachments = []; }
    // 채팅이면 주고받은 말 (오래된 것부터, 최근 500개)
    const chat = isChatSource(inquiry.source)
      ? db.prepare('SELECT * FROM (SELECT * FROM chat_messages WHERE inquiry_id = ? ORDER BY id DESC LIMIT 500) ORDER BY id').all(inquiry.id)
      : null;
    if (chat) {
      const names = new Map(staff().map(s => [`staff:${s.id}`, s.name]));
      chat.forEach(m => { m.who = names.get(m.sender) || ''; });
    }
    if (chat && chat.length) {
      // 직원이 열어 봤으니 지금까지 온 말은 읽음 (목록의 빨간 숫자가 사라진다)
      const lastId = chat[chat.length - 1].id;
      if (db.prepare('UPDATE inquiries SET chat_read_id = ? WHERE id = ? AND COALESCE(chat_read_id, 0) < ?').run(lastId, inquiry.id, lastId).changes) {
        notifier.inboxChanged([inquiry.id], req.user.id);
      }
      // 아직 주문과 연결 안 됐으면, 손님이 예전에 말한 주문번호를 다시 찾아본다 (주문이 나중에 들어온 경우)
      if (!inquiry.order_no) {
        const said = chat.filter(m => m.direction === 'in' && m.text).map(m => m.text).join('\n');
        const found = orderNoIn(db, said);
        if (found) {
          const meta = metaOf(inquiry);
          delete meta.saidNo;
          db.prepare('UPDATE inquiries SET order_no = ?, meta = ? WHERE id = ?').run(found, JSON.stringify(meta), inquiry.id);
          inquiry.order_no = found;
          inquiry.meta = JSON.stringify(meta);
        }
      }
    }
    const replies = db.prepare(`
      SELECT r.*, u.name AS user_name FROM inquiry_replies r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.inquiry_id = ? ORDER BY r.id
    `).all(inquiry.id);
    // 답장 문구에 넣을 값: 고객 이름('홍길동 (hong123)' → 홍길동), 주문번호로 찾은 상품명
    const relatedOrder = inquiry.order_no
      ? db.prepare("SELECT product_name FROM orders WHERE channel_order_id = ? ORDER BY item_type = 'addon', id LIMIT 1").get(String(inquiry.order_no))
      : null;
    const templates = templatesFor(db, isMailSource(inquiry.source) ? 'mail' : 'shop', {
      고객명: String(inquiry.from_name || '').replace(/\s*\(.*\)\s*$/, '').trim(),
      상품명: relatedOrder ? relatedOrder.product_name : '',
      주문번호: inquiry.order_no || '',
      회사명: brandName(),
    });
    const custOrders = ordersForInquiry(db, inquiry);
    res.render('inbox/detail', {
      title: inquiry.subject || '문의',
      templates,
      customer: { orders: custOrders.orders, nameOrders: custOrders.nameOrders, inquiries: [], nameInquiries: [], total: 1 },
      navSection: boxOf(inquiry.source) === 'shop' ? 'inbox' : boxOf(inquiry.source),
      inquiry, attachments, replies, staff: staff(),
      canOpenFiles: Boolean(files[inquiry.source]),
      isMail: isMailSource(inquiry.source),
      chat, PARTNER_CENTER_URL, CHAT_STATUS,
      chatProduct: chat ? metaOf(inquiry).product || null : null,
      saidNo: chat && !inquiry.order_no ? metaOf(inquiry).saidNo || null : null,
      linkedOrder: chat && inquiry.order_no
        ? db.prepare("SELECT id, channel, channel_order_id, product_name FROM orders WHERE channel_order_id = ? ORDER BY item_type = 'addon', id LIMIT 1").get(String(inquiry.order_no)) || null
        : null,
      withRo,
      previewType,
      label: labelOf(inquiry.source),
      mode: modeOf(inquiry.source),
      STATUS_LABELS,
      back: safeBack(req.query.back, boxOf(inquiry.source) === 'shop' ? '/inbox' : `/inbox?box=${boxOf(inquiry.source)}`),
    });
  });

  // 답변 보내기
  router.post('/inbox/:id/reply', async (req, res, next) => {
    const b = back(req);
    const inquiry = findInquiry(req.params.id);
    if (!inquiry) return flashTo(req, res, b, 'error', '문의를 찾을 수 없습니다.');
    const url = selfUrl(inquiry.id, b);
    const body = String(req.body.body || '').replace(/\r\n/g, '\n').trim();
    const isChat = isChatSource(inquiry.source);
    const attached = req.files || [];
    // 톡톡은 사진만 보내도 된다
    if (!body && !(isChat && attached.length)) return flashTo(req, res, url, 'error', isChat ? '보낼 말을 적거나 사진을 붙여 주세요.' : '답변 내용을 적어 주세요.');
    if (body.length > MAX_REPLY) return flashTo(req, res, url, 'error', `답변은 ${MAX_REPLY.toLocaleString()}자까지 쓸 수 있습니다.`);
    // 톡톡은 손님 말이 올 때마다 바뀌어서(대화가 이어지는 중) '먼저 바꾼 사람' 검사를 하지 않는다
    if (!isChat && Number(req.body.version) !== inquiry.version) {
      return flashTo(req, res, url, 'error', '그사이 다른 직원이 이 문의를 바꿨습니다. 바뀐 내용을 확인하고 다시 보내 주세요.');
    }
    if (req.uploadError) return flashTo(req, res, url, 'error', req.uploadError);
    if (isChat) {
      // 톡톡 사진: JPG·PNG·GIF, 한 장 20MB 까지 (네이버 한도)
      const bad = attached.find(f => !imageKind(f.content));
      if (bad) return flashTo(req, res, url, 'error', `${bad.name}: 톡톡에는 사진(JPG·PNG·GIF)만 보낼 수 있어요.`);
      const big = attached.find(f => f.content.length > MAX_IMAGE);
      if (big) return flashTo(req, res, url, 'error', `${big.name}: 사진은 한 장에 20MB 까지 보낼 수 있어요.`);
    }
    if (busy.has(inquiry.id)) return flashTo(req, res, url, 'error', '이미 보내는 중입니다. 잠시 후 새로고침해 보세요.');
    busy.add(inquiry.id);
    try {
      const sender = senders[inquiry.source];
      const out = sender
        ? await sender.reply(inquiry, body, attached)
        : { result: 'practice', message: `연습 모드라 ${withRo(labelOf(inquiry.source))} 보내지 않았습니다.${isChat ? ' (실제로 보내려면 서버 .env 에 TALKTALK_ANSWER=on)' : ''}` };
      // 기록에는 파일 이름·크기만 (파일 자체는 저장하지 않음)
      const fileList = attached.length ? JSON.stringify(attached.map(f => ({ name: f.name, size: f.content.length }))) : null;
      transaction(db, () => {
        db.prepare('INSERT INTO inquiry_replies (inquiry_id, user_id, body, mode, result, message, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(inquiry.id, req.user.id, body, sender ? 'live' : 'practice', out.result, out.message, fileList);
        if (out.result === 'ok') {
          db.prepare("UPDATE inquiries SET status = 'answered', handled_by = ?, handled_at = datetime('now') WHERE id = ?")
            .run(req.user.id, inquiry.id);
        }
        // 톡톡: 실제로 나간 말·사진은 대화에 '우리' 말풍선으로 (네이버가 되돌려 주는 echo 와는 하나로 합친다)
        if (isChat && out.sent && out.sent.length) {
          const add = db.prepare(`INSERT INTO chat_messages (inquiry_id, direction, kind, text, image_url, sender, created_at, echoed)
            VALUES (?, 'out', ?, ?, NULL, ?, ?, 0)`);
          const at = new Date().toISOString();
          for (const m of out.sent) add.run(inquiry.id, m.kind, m.kind === 'image' ? `📷 ${m.name}` : m.text, `staff:${req.user.id}`, at);
        }
        bump(inquiry.id);
      });
      notifier.inboxChanged([inquiry.id], req.user.id);
      const type = out.result === 'ok' ? 'ok' : out.result === 'practice' ? 'warn' : 'error';
      flashTo(req, res, url, type, out.message);
    } catch (e) {
      next(e);
    } finally {
      busy.delete(inquiry.id);
    }
  });

  // 받은 첨부파일 열기·내려받기 (?view=1 이면 그림을 화면에 바로 보여줌)
  router.get('/inbox/:id/files/:n', async (req, res) => {
    const inquiry = findInquiry(req.params.id);
    const opener = inquiry && files[inquiry.source];
    if (!opener) return res.status(404).render('error', { title: '없는 파일', message: '첨부파일을 찾을 수 없습니다.' });
    let file;
    try {
      file = await opener.open(inquiry, Number(req.params.n));
    } catch (e) {
      if (e.status === 404) return res.status(404).render('error', { title: '없는 파일', message: e.message });
      return res.status(502).render('error', { title: '파일을 가져오지 못함', message: `${labelOf(inquiry.source)}에서 첨부파일을 가져오지 못했습니다. 잠시 후 다시 시도하세요. (${e.message})` });
    }
    const image = req.query.view === '1' && previewType(file);
    const safeName = file.name.replace(/["\\\r\n]/g, '_');
    res.set({
      'Content-Type': image || 'application/octet-stream',
      'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename="${safeName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      'Cache-Control': 'private, max-age=600',
    });
    file.stream.on('error', () => res.destroy());
    res.on('close', () => { file.done().catch(() => {}); });
    file.stream.pipe(res);
  });

  // 채팅 사진: 네이버에 있는 사진을 서버가 대신 가져와 보여 준다 (화면이 바깥 주소를 직접 부르지 않게, 저장은 안 함)
  router.get('/inbox/:id/chat-image/:mid', async (req, res) => {
    const m = db.prepare("SELECT image_url FROM chat_messages WHERE id = ? AND inquiry_id = ? AND image_url IS NOT NULL")
      .get(Number(req.params.mid), Number(req.params.id));
    let url = null;
    try { url = m ? new URL(m.image_url) : null; } catch { url = null; }
    if (!url || url.protocol !== 'https:' || !IMAGE_HOSTS.test(url.hostname)) return res.status(404).end();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\/(png|jpeg|gif|webp)/.test(type)) return res.status(502).end();
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 20 * 1024 * 1024) return res.status(502).end();
      res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' }).send(buf);
    } catch {
      res.status(502).end();
    }
  });

  // 담당자 지정
  router.post('/inbox/:id/assign', (req, res) => {
    const b = back(req);
    const inquiry = findInquiry(req.params.id);
    if (!inquiry) return flashTo(req, res, b, 'error', '문의를 찾을 수 없습니다.');
    const assignee = req.body.assignee_id ? Number(req.body.assignee_id) : null;
    if (assignee && !staff().some(s => s.id === assignee)) return flashTo(req, res, b, 'error', '지정할 수 없는 직원입니다.');
    db.prepare('UPDATE inquiries SET assignee_id = ? WHERE id = ?').run(assignee, inquiry.id);
    bump(inquiry.id);
    notifier.inboxChanged([inquiry.id], req.user.id);
    if (assignee && assignee !== req.user.id) {
      notifier.notify('new_inquiry', {
        title: '문의 담당 지정', body: `${req.user.name} 님이 '${inquiry.subject}' 문의를 맡겼습니다.`, url: `/inbox/${inquiry.id}`,
      }, userId => userId === assignee);
    }
    res.redirect(req.body.from === 'detail' ? selfUrl(inquiry.id, b) : b);
  });

  // ───────── 톡톡 전용: 보류 · 고객 메모 · 주문 연결 ─────────
  const chatOnly = (req, res) => {
    const b = back(req);
    const inquiry = findInquiry(req.params.id);
    if (!inquiry || !isChatSource(inquiry.source)) {
      flashTo(req, res, b, 'error', '톡톡 대화를 찾을 수 없습니다.');
      return null;
    }
    return { inquiry, b, url: selfUrl(inquiry.id, b) };
  };
  const chatDone = (req, res, ctx, message) => {
    bump(ctx.inquiry.id);
    notifier.inboxChanged([ctx.inquiry.id], req.user.id);
    flashTo(req, res, ctx.url, 'ok', message);
  };

  // 보류: 나중에 볼 대화. 손님이 새로 말하면 다시 '대기' 로 온다
  router.post('/inbox/:id/hold', (req, res) => {
    const ctx = chatOnly(req, res);
    if (!ctx) return;
    db.prepare("UPDATE inquiries SET status = 'closed', handled_by = ?, handled_at = datetime('now') WHERE id = ?").run(req.user.id, ctx.inquiry.id);
    chatDone(req, res, ctx, '보류로 옮겼습니다. 손님이 새로 말하면 다시 대기로 와요.');
  });
  // 보류 풀기: 우리가 답한 적이 있으면 진행중, 없으면 대기
  router.post('/inbox/:id/unhold', (req, res) => {
    const ctx = chatOnly(req, res);
    if (!ctx) return;
    const answered = db.prepare("SELECT 1 FROM chat_messages WHERE inquiry_id = ? AND direction = 'out' LIMIT 1").get(ctx.inquiry.id);
    db.prepare('UPDATE inquiries SET status = ?, handled_by = NULL, handled_at = NULL WHERE id = ?').run(answered ? 'answered' : 'open', ctx.inquiry.id);
    chatDone(req, res, ctx, `보류를 풀었습니다 (${answered ? '진행중' : '대기'}).`);
  });

  // 고객 메모: 목록에서 이름 옆에 회색으로 (예: 실사-김대성)
  router.post('/inbox/:id/memo', (req, res) => {
    const ctx = chatOnly(req, res);
    if (!ctx) return;
    const memo = String(req.body.cust_memo || '').replace(/\s+/g, ' ').trim().slice(0, 30) || null;
    db.prepare('UPDATE inquiries SET cust_memo = ? WHERE id = ?').run(memo, ctx.inquiry.id);
    chatDone(req, res, ctx, memo ? '고객 메모를 저장했습니다.' : '고객 메모를 지웠습니다.');
  });

  // 주문 연결: 주문번호(또는 상품주문번호)로 인트라넷 주문을 찾아 이 대화에 붙인다. 손님이 대화에 주문번호를 쓰면 자동으로 붙는다
  router.post('/inbox/:id/link-order', (req, res) => {
    const ctx = chatOnly(req, res);
    if (!ctx) return;
    const raw = String(req.body.order_no || '').trim().slice(0, 40);
    if (!raw) return flashTo(req, res, ctx.url, 'error', '주문번호를 적어 주세요.');
    const find = db.prepare('SELECT channel_order_id FROM orders WHERE channel_order_id = ? OR channel_item_id = ? ORDER BY id LIMIT 1');
    const digits = raw.replace(/\D/g, '');
    const row = find.get(raw, raw) || (digits ? find.get(digits, digits) : null);
    if (!row) return flashTo(req, res, ctx.url, 'error', `주문번호 ${raw} 인 주문을 인트라넷에서 찾지 못했어요. 번호를 다시 확인해 주세요.`);
    const meta = metaOf(ctx.inquiry);
    delete meta.saidNo;
    db.prepare('UPDATE inquiries SET order_no = ?, meta = ? WHERE id = ?').run(String(row.channel_order_id), JSON.stringify(meta), ctx.inquiry.id);
    chatDone(req, res, ctx, `주문 ${row.channel_order_id} 와 연결했습니다.`);
  });
  router.post('/inbox/:id/unlink-order', (req, res) => {
    const ctx = chatOnly(req, res);
    if (!ctx) return;
    db.prepare('UPDATE inquiries SET order_no = NULL WHERE id = ?').run(ctx.inquiry.id);
    chatDone(req, res, ctx, '주문 연결을 풀었습니다. (손님이 주문번호를 다시 말하면 또 자동으로 연결돼요)');
  });

  // 처리 완료 (답변 필요 없음) / 다시 열기
  for (const [action, to, from, message] of [
    ['close', 'closed', 'open', '처리 완료로 바꿨습니다.'],
    ['reopen', 'open', null, '다시 미답변으로 돌렸습니다.'],
  ]) {
    router.post(`/inbox/:id/${action}`, (req, res) => {
      const b = back(req);
      const inquiry = findInquiry(req.params.id);
      if (!inquiry) return flashTo(req, res, b, 'error', '문의를 찾을 수 없습니다.');
      if (from && inquiry.status !== from) return flashTo(req, res, selfUrl(inquiry.id, b), 'error', '미답변 문의만 처리 완료로 바꿀 수 있습니다.');
      db.prepare(`UPDATE inquiries SET status = ?, handled_by = ?, handled_at = ${to === 'open' ? 'NULL' : "datetime('now')"} WHERE id = ?`)
        .run(to, to === 'open' ? null : req.user.id, inquiry.id);
      bump(inquiry.id);
      notifier.inboxChanged([inquiry.id], req.user.id);
      flashTo(req, res, selfUrl(inquiry.id, b), 'ok', message);
    });
  }

  return router;
}

// 직원이 정한 큰 탭 순서 (저장된 게 없거나 빠진 탭은 기본 순서로 뒤에)
function userBoxOrder(user) {
  let saved = [];
  try { saved = JSON.parse((user && user.inbox_order) || '[]'); } catch { saved = []; }
  return [...new Set([...saved.filter(b => BOXES[b]), ...Object.keys(BOXES)])];
}

// 돌아갈 주소는 문의함 목록만 허용
function safeBack(value, fallback = '/inbox') {
  const v = String(value || '');
  return /^\/inbox(\?[^\s]*)?$/.test(v) ? v : fallback;
}

module.exports = { inboxRoutes, TABS, withRo };
