// 관리자 메뉴: 직원 관리, 작업 단계 편집, 직무 편집
// 이 파일의 모든 주소는 app.js 에서 requireAdmin 을 거친 뒤에만 들어온다.
const express = require('express');
const { collectFlash } = require('./orders');
const { transaction } = require('../db');
const { CHANNELS } = require('../channels/labels');
const { storageInfo, humanSize } = require('../storage');
const retention = require('../retention');
const { parseRecipients, settingsOf: weeklySettings, DAYS, DEFAULT_SUBJECT, SAFE_SUBJECT, MIN_PASSWORD } = require('../weeklyReport');
const { intervalMinutes, MIN_MINUTES, MAX_MINUTES } = require('../schedule');

const STATUS_LABELS = {
  pending: '승인 대기',
  active: '사용 중',
  suspended: '정지',
  rejected: '거절',
};

function adminRoutes(db, sessionStore, collector, notifier, brand = null, weekly = null, logen = null) {
  const router = express.Router();
  // 왼쪽 메뉴에서 '관리자' 를 켜 둔다
  router.use((req, res, next) => { res.locals.navSection = 'admin'; next(); });

  // 처리 결과 안내 문구를 다음 화면에 한 번만 보여준다
  const flash = (req, type, message) => {
    req.session.flash = { type, message };
  };

  const findUser = id => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  const activeAdminCount = () =>
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n;

  // 대상 직원을 찾고, 자기 자신이면 막는다 (실수로 스스로를 정지·강등하는 사고 방지)
  function targetUser(req, res) {
    const user = findUser(req.params.id);
    if (!user) {
      flash(req, 'error', '직원을 찾을 수 없습니다.');
      res.redirect('/admin/users');
      return null;
    }
    if (user.id === req.user.id) {
      flash(req, 'error', '자기 자신의 상태나 역할은 바꿀 수 없습니다. 다른 관리자에게 요청하세요.');
      res.redirect('/admin/users');
      return null;
    }
    return user;
  }

  // 마지막 남은 관리자를 정지하거나 직원으로 바꾸면 아무도 관리할 수 없게 된다
  function wouldRemoveLastAdmin(user) {
    return user.role === 'admin' && user.status === 'active' && activeAdminCount() <= 1;
  }

  router.get('/', (req, res) => res.redirect('/admin/users'));

  // ───────── 직원 관리 ─────────
  router.get('/users', (req, res) => {
    const users = db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.status, u.job_id, u.created_at, u.locked_until, j.name AS job_name
      FROM users u LEFT JOIN jobs j ON j.id = u.job_id
      ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END,
               u.created_at DESC
    `).all();
    const jobs = db.prepare('SELECT id, name, active FROM jobs ORDER BY sort_order').all();
    res.render('admin/users', {
      title: '직원 관리',
      tab: 'users',
      pending: users.filter(u => u.status === 'pending'),
      others: users.filter(u => u.status !== 'pending'),
      jobs,
      STATUS_LABELS,
      now: new Date(),
    });
  });

  router.post('/users/:id/approve', (req, res) => {
    const user = targetUser(req, res);
    if (!user) return;
    db.prepare("UPDATE users SET status = 'active', approved_at = datetime('now') WHERE id = ?").run(user.id);
    flash(req, 'ok', `${user.name} 님을 승인했습니다.`);
    res.redirect('/admin/users');
  });

  router.post('/users/:id/reject', (req, res) => {
    const user = targetUser(req, res);
    if (!user) return;
    if (user.status !== 'pending') {
      flash(req, 'error', '승인 대기 중인 신청만 거절할 수 있습니다.');
      return res.redirect('/admin/users');
    }
    db.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").run(user.id);
    sessionStore.destroyUserSessions(user.id);
    notifier.hub.disconnectUser(user.id);
    flash(req, 'ok', `${user.name} 님의 가입 신청을 거절했습니다.`);
    res.redirect('/admin/users');
  });

  router.post('/users/:id/suspend', (req, res) => {
    const user = targetUser(req, res);
    if (!user) return;
    if (wouldRemoveLastAdmin(user)) {
      flash(req, 'error', '마지막 관리자는 정지할 수 없습니다.');
      return res.redirect('/admin/users');
    }
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(user.id);
    // 이미 로그인해 있는 창도 즉시 끊는다 (실시간 연결 포함)
    sessionStore.destroyUserSessions(user.id);
    notifier.hub.disconnectUser(user.id);
    flash(req, 'ok', `${user.name} 님의 계정을 정지했습니다. 즉시 로그아웃됩니다.`);
    res.redirect('/admin/users');
  });

  router.post('/users/:id/reactivate', (req, res) => {
    const user = targetUser(req, res);
    if (!user) return;
    db.prepare(
      "UPDATE users SET status = 'active', failed_logins = 0, locked_until = NULL, " +
      "approved_at = COALESCE(approved_at, datetime('now')) WHERE id = ?"
    ).run(user.id);
    flash(req, 'ok', `${user.name} 님의 계정을 다시 사용할 수 있게 했습니다.`);
    res.redirect('/admin/users');
  });

  router.post('/users/:id/unlock', (req, res) => {
    const user = findUser(req.params.id);
    if (user) {
      db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
      flash(req, 'ok', `${user.name} 님의 로그인 잠금을 풀었습니다.`);
    }
    res.redirect('/admin/users');
  });

  // 직무와 역할 변경
  router.post('/users/:id/update', (req, res) => {
    const user = findUser(req.params.id);
    if (!user) {
      flash(req, 'error', '직원을 찾을 수 없습니다.');
      return res.redirect('/admin/users');
    }
    const jobId = req.body.job_id ? Number(req.body.job_id) : null;
    if (jobId && !db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(jobId)) {
      flash(req, 'error', '없는 직무입니다.');
      return res.redirect('/admin/users');
    }
    const role = req.body.role === 'admin' ? 'admin' : 'staff';

    if (role !== user.role) {
      if (user.id === req.user.id) {
        flash(req, 'error', '자기 자신의 역할은 바꿀 수 없습니다.');
        return res.redirect('/admin/users');
      }
      if (role === 'staff' && wouldRemoveLastAdmin(user)) {
        flash(req, 'error', '마지막 관리자는 직원으로 바꿀 수 없습니다.');
        return res.redirect('/admin/users');
      }
    }

    db.prepare('UPDATE users SET job_id = ?, role = ? WHERE id = ?').run(jobId, role, user.id);
    flash(req, 'ok', `${user.name} 님의 정보를 저장했습니다.`);
    res.redirect('/admin/users');
  });

  // ───────── 작업 단계 / 직무: 같은 방식의 목록 편집 ─────────
  // table: 'work_stages' 또는 'jobs'
  function listEditor({ table, path, label }) {
    const back = `/admin/${path}`;
    const find = id => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id));
    const cleanName = raw => String(raw || '').trim().slice(0, 30);

    const isDuplicate = err => /UNIQUE/.test(String(err && err.message));

    router.post(`/${path}`, (req, res) => {
      const name = cleanName(req.body.name);
      if (!name) {
        flash(req, 'error', `${label} 이름을 입력하세요.`);
        return res.redirect(back);
      }
      const max = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM ${table}`).get().m;
      try {
        db.prepare(`INSERT INTO ${table} (name, sort_order) VALUES (?, ?)`).run(name, max + 10);
        flash(req, 'ok', `'${name}' ${label}을(를) 추가했습니다.`);
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        flash(req, 'error', `'${name}'은(는) 이미 있는 이름입니다.`);
      }
      res.redirect(back);
    });

    router.post(`/${path}/:id/rename`, (req, res) => {
      const item = find(req.params.id);
      const name = cleanName(req.body.name);
      if (!item || !name) {
        flash(req, 'error', '이름을 입력하세요.');
        return res.redirect(back);
      }
      try {
        db.prepare(`UPDATE ${table} SET name = ? WHERE id = ?`).run(name, item.id);
        flash(req, 'ok', `'${item.name}' → '${name}' 으로 바꿨습니다.`);
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        flash(req, 'error', `'${name}'은(는) 이미 있는 이름입니다.`);
      }
      res.redirect(back);
    });

    // 위/아래 이웃과 순서를 맞바꾼다
    router.post(`/${path}/:id/move`, (req, res) => {
      const item = find(req.params.id);
      if (item) {
        const up = req.body.dir === 'up';
        const neighbor = db.prepare(
          `SELECT * FROM ${table} WHERE sort_order ${up ? '<' : '>'} ? ORDER BY sort_order ${up ? 'DESC' : 'ASC'} LIMIT 1`
        ).get(item.sort_order);
        if (neighbor) {
          transaction(db, () => {
            db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`).run(neighbor.sort_order, item.id);
            db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`).run(item.sort_order, neighbor.id);
          });
        }
      }
      res.redirect(back);
    });

    // 숨기기/다시 보이기. 지우지 않는 이유: 이미 그 값을 쓰는 주문이나 직원 기록이 깨지지 않게
    router.post(`/${path}/:id/toggle`, (req, res) => {
      const item = find(req.params.id);
      if (!item) return res.redirect(back);
      if (item.active) {
        const activeCount = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE active = 1`).get().n;
        if (activeCount <= 1) {
          flash(req, 'error', `${label}은(는) 최소 1개는 보여야 합니다.`);
          return res.redirect(back);
        }
      }
      db.prepare(`UPDATE ${table} SET active = ? WHERE id = ?`).run(item.active ? 0 : 1, item.id);
      flash(req, 'ok', `'${item.name}'을(를) ${item.active ? '숨겼습니다' : '다시 보이게 했습니다'}.`);
      res.redirect(back);
    });

    return find;
  }

  router.get('/stages', (req, res) => {
    const stages = db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM orders o WHERE o.stage_id = s.id) AS order_count
      FROM work_stages s ORDER BY s.sort_order
    `).all();
    const designStages = db.prepare(`
      SELECT s.*, (
        SELECT COUNT(DISTINCT o.channel || ':' || o.channel_order_id) FROM orders o
        WHERE COALESCE(o.design_stage_id, (SELECT id FROM design_stages WHERE active = 1 ORDER BY sort_order LIMIT 1)) = s.id
      ) AS order_count
      FROM design_stages s ORDER BY s.sort_order
    `).all();
    res.render('admin/stages', { title: '작업 단계', tab: 'stages', stages, designStages });
  });
  listEditor({ table: 'work_stages', path: 'stages', label: '주문 단계' });
  // 디자인 단계: 편집 뒤에는 같은 '작업 단계' 화면으로 돌아간다
  router.get('/design-stages', (req, res) => res.redirect('/admin/stages'));
  listEditor({ table: 'design_stages', path: 'design-stages', label: '디자인 단계' });

  // ───────── 수기 주문 출처 + 수기 주문 채널 이름 ─────────
  const setting = key => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) || {}).value || '';
  router.get('/sources', (req, res) => {
    const sources = db.prepare(`
      SELECT s.*, (SELECT COUNT(DISTINCT o.channel_order_id) FROM orders o WHERE o.channel = 'manual' AND o.source_id = s.id) AS order_count
      FROM order_sources s ORDER BY s.sort_order
    `).all();
    res.render('admin/sources', {
      title: '주문 출처', tab: 'sources', sources,
      manualName: setting('manual_channel_name') || CHANNELS.manual.name,
      manualMark: setting('manual_channel_mark') || CHANNELS.manual.mark,
      defaultName: CHANNELS.manual.name,
      defaultMark: CHANNELS.manual.mark,
    });
  });
  listEditor({ table: 'order_sources', path: 'sources', label: '주문 출처' });

  // 주문 목록의 '수기 주문' 칩·카드에 보이는 이름과 한 글자 표시. 비우면 처음 이름으로 돌아간다
  router.post('/manual-channel', (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 20);
    const mark = Array.from(String(req.body.mark || '').trim())[0] || '';
    const save = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    save.run('manual_channel_name', name);
    save.run('manual_channel_mark', mark);
    flash(req, 'ok', `수기 주문 채널을 '${name || CHANNELS.manual.name}' (${mark || CHANNELS.manual.mark}) 로 저장했습니다.`);
    res.redirect('/admin/sources');
  });

  router.get('/jobs', (req, res) => {
    const jobs = db.prepare(`
      SELECT j.*, (SELECT COUNT(*) FROM users u WHERE u.job_id = j.id) AS user_count
      FROM jobs j ORDER BY j.sort_order
    `).all();
    res.render('admin/jobs', { title: '직무', tab: 'jobs', jobs });
  });
  const findJob = listEditor({ table: 'jobs', path: 'jobs', label: '직무' });

  // 이 직무를 담당 디자이너 지정 목록에 넣을지
  router.post('/jobs/:id/designer', (req, res) => {
    const job = findJob(req.params.id);
    if (job) {
      db.prepare('UPDATE jobs SET is_designer = ? WHERE id = ?').run(job.is_designer ? 0 : 1, job.id);
      flash(req, 'ok', `'${job.name}' 직무를 담당 디자이너 목록에서 ${job.is_designer ? '뺐습니다' : '보이게 했습니다'}.`);
    }
    res.redirect('/admin/jobs');
  });

  // ───────── 알림 설정 ─────────
  const getSetting = key => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  const putSetting = (key, value) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));

  router.get('/notify', (req, res) => {
    let recipients = [];
    try { recipients = JSON.parse(getSetting('unassigned_recipients') || '[]'); } catch { recipients = []; }
    const staff = db.prepare(`
      SELECT u.id, u.name, u.role, j.name AS job_name FROM users u LEFT JOIN jobs j ON j.id = u.job_id
      WHERE u.status = 'active' ORDER BY u.role, u.name
    `).all();
    res.render('admin/notify', {
      title: '알림 설정',
      tab: 'notify',
      threshold: Number(getSetting('unassigned_threshold')) || 5,
      repeatMinutes: Number(getSetting('unassigned_repeat_minutes')) || 30,
      recipients,
      staff,
      unassigned: notifier.unassignedCount(),
      weekly: { ...weeklySettings(db), ready: Boolean(weekly && weekly.ready), sender: weekly ? weekly.sender : null },
      DAYS, DEFAULT_SUBJECT, SAFE_SUBJECT, MIN_PASSWORD,
    });
  });

  // 주간 매출 보고 메일: 받는 주소·켜기
  // 받는 주소·요일·시각·제목·암호화(비밀번호 PDF)
  router.post('/weekly-report', (req, res) => {
    const fail = message => { flash(req, 'error', message); res.redirect('/admin/notify#weekly'); };
    const parsed = parseRecipients(req.body.recipients);
    if (parsed.error) return fail(parsed.error);
    const day = Number(req.body.day);
    const hour = Number(req.body.hour);
    if (!Number.isInteger(day) || day < 0 || day > 6 || !Number.isInteger(hour) || hour < 0 || hour > 23) return fail('보내는 요일과 시각을 골라 주세요.');
    const subject = String(req.body.subject || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const encrypt = req.body.encrypt === '1';
    // 비밀번호: 새로 적었을 때만 바꾼다 (비워 두면 그대로)
    const pw = String(req.body.password || '');
    if (pw) {
      if (pw.length < MIN_PASSWORD) return fail(`PDF 비밀번호는 ${MIN_PASSWORD}자 이상으로 정해 주세요.`);
      if (pw !== String(req.body.password2 || '')) return fail('비밀번호 두 칸이 서로 달라요.');
    }
    if (encrypt && !pw && !weeklySettings(db).hasPassword) return fail('암호화를 켜려면 PDF 비밀번호를 정해 주세요.');
    putSetting('weekly_report_to', JSON.stringify(parsed.list));
    putSetting('weekly_report_on', req.body.enabled === '1' && parsed.list.length ? '1' : '0');
    putSetting('weekly_report_day', day);
    putSetting('weekly_report_hour', hour);
    putSetting('weekly_report_subject', subject);
    putSetting('weekly_report_encrypt', encrypt ? '1' : '0');
    if (pw) putSetting('weekly_report_pw', pw);
    const when = `매주 ${DAYS[day]}요일 ${hour}시`;
    const warn = encrypt && /\{(매출|변화)\}/.test(subject) ? ' 암호화 중이라 제목의 {매출}·{변화}는 빼고 보내요.' : '';
    flash(req, 'ok', parsed.list.length
      ? `저장했습니다. ${req.body.enabled === '1' ? `${when}에 보냅니다${encrypt ? ' (비밀번호 PDF)' : ''}.` : '지금은 꺼져 있어요.'}${warn}`
      : '받는 주소를 모두 지웠습니다 (보내지 않음).');
    res.redirect('/admin/notify#weekly');
  });
  // 지금 테스트로 한 통 보내기 (이번 주 월요일부터 지금까지)
  router.post('/weekly-report/test', async (req, res, next) => {
    try {
      const r = weekly ? await weekly.send({ test: true }) : { ok: false, message: '보낼 메일 계정이 없습니다.' };
      flash(req, r.ok ? 'ok' : 'error', r.ok ? `테스트 메일을 ${r.message}` : r.message);
      res.redirect('/admin/notify#weekly');
    } catch (e) {
      next(e);
    }
  });

  router.post('/notify', (req, res) => {
    const threshold = Math.round(Number(req.body.threshold));
    const repeat = Math.round(Number(req.body.repeat_minutes));
    if (!(threshold >= 1 && threshold <= 999)) {
      flash(req, 'error', '기준 건수는 1~999 사이로 입력하세요.');
      return res.redirect('/admin/notify');
    }
    if (!(repeat >= 5 && repeat <= 240)) {
      flash(req, 'error', '다시 알림 간격은 5~240분 사이로 입력하세요.');
      return res.redirect('/admin/notify');
    }
    const picked = [].concat(req.body.recipients || []).map(Number).filter(Boolean);
    putSetting('unassigned_threshold', threshold);
    putSetting('unassigned_repeat_minutes', repeat);
    putSetting('unassigned_recipients', JSON.stringify(picked));
    notifier.checkUnassigned();
    flash(req, 'ok', '알림 설정을 저장했습니다.');
    res.redirect('/admin/notify');
  });

  // ───────── 주문 수집 상태 ─────────
  // ───────── 저장 공간 ─────────
  router.get('/storage', (req, res) => {
    const counts = db.prepare(`
      SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM inquiries WHERE deleted_at IS NULL) AS inquiries,
        (SELECT COALESCE(SUM(LENGTH(body)), 0) FROM inquiries) AS inquiry_bytes
    `).get();
    res.render('admin/storage', {
      title: '저장 공간', tab: 'storage', info: storageInfo(), counts, humanSize,
      hideDays: retention.hideDays(db), keepOrders: retention.keepMonths(db, 'orders'), keepInquiries: retention.keepMonths(db, 'inquiries'),
      HIDE_CHOICES: retention.HIDE_CHOICES, KEEP_CHOICES: retention.KEEP_CHOICES,
      preview: retention.previewCleanup(db), log: retention.cleanupLog(db),
    });
  });

  // ───────── 로젠 설정 ─────────
  router.get('/logen', (req, res) => {
    res.render('admin/logen', {
      title: '로젠 설정', tab: 'logen',
      logen: logen ? { env: logen.env, hasKey: logen.hasKey, writeOn: logen.writeOn, ...logen.settings(), waiting: logen.hasKey ? logen.waiting().length : 0,
        autoDispatch: logen.autoDispatch(), lastTick: logen.lastTick() } : null,
    });
  });

  // 계약정보·계약운임 불러오기 (로젠 호출 2번)
  router.post('/logen/contract', async (req, res, next) => {
    try {
      if (!logen || !logen.hasKey) {
        flash(req, 'error', '로젠 인증키(LOGEN_SECRET_KEY)가 .env 에 없습니다.');
        return res.redirect('/admin/logen');
      }
      try {
        const c = await logen.loadContract();
        flash(req, 'ok', `계약 정보를 불러왔습니다: ${c.salesNm} · ${c.fareTyNm} · 박스 ${c.boxes.length}종류`);
      } catch (e) {
        flash(req, 'error', `계약 정보를 불러오지 못했습니다: ${e.message}`);
      }
      res.redirect('/admin/logen');
    } catch (e) {
      next(e);
    }
  });

  router.post('/logen/auto-dispatch', (req, res) => {
    if (!logen) return res.redirect('/admin/logen');
    const on = req.body.on === '1';
    logen.setAutoDispatch(on);
    flash(req, 'ok', on ? '자동 발송처리를 켰습니다. 송장번호가 들어오면 바로 고객에게 발송 알림이 갑니다.' : '자동 발송처리를 껐습니다. 송장번호만 채워 두고, 발송처리는 직원이 누릅니다.');
    res.redirect('/admin/logen');
  });

  router.post('/logen/settings', (req, res) => {
    if (!logen) return res.redirect('/admin/logen');
    const r = logen.saveSettings({ name: req.body.name, addr: req.body.addr, tel: req.body.tel, box: req.body.box });
    flash(req, r.error ? 'error' : 'ok', r.error || '로젠 설정을 저장했습니다.');
    res.redirect('/admin/logen');
  });

  // ───────── 회사 이름·로고 ─────────
  router.get('/brand', (req, res) => {
    const { MAX_NAME, DEFAULT_NAME, NAV_ITEMS } = require('../brand');
    res.render('admin/brand', { title: '회사·로고', tab: 'brand', MAX_NAME, DEFAULT_NAME, NAV_ITEMS });
  });
  // 왼쪽 메뉴 순서 (모든 직원에게 같이 적용)
  router.post('/brand/nav', (req, res) => {
    brand.moveNav(String(req.body.key || ''), req.body.dir === 'up' ? 'up' : 'down');
    res.redirect('/admin/brand#nav');
  });
  router.post('/brand/name', (req, res) => {
    const error = brand.setName(req.body.name);
    flash(req, error ? 'error' : 'ok', error || '이름을 바꿨습니다.');
    res.redirect('/admin/brand');
  });
  // 로고 파일은 app.js 에서 미리 읽어 둔다 (req.files)
  router.post('/brand/logo', (req, res) => {
    const file = (req.files || [])[0];
    const error = req.uploadError ? '로고는 1MB 이하로 올려 주세요.' : brand.setLogo(file && file.content);
    flash(req, error ? 'error' : 'ok', error || '로고를 바꿨습니다.');
    res.redirect('/admin/brand');
  });
  router.post('/brand/reset', (req, res) => {
    brand.reset();
    flash(req, 'ok', '처음 이름과 B 로고로 되돌렸습니다.');
    res.redirect('/admin/brand');
  });

  // 목록에서 숨기는 기간, 보관 기간 (정해진 값 중에서만)
  router.post('/storage/settings', (req, res) => {
    const hide = Number(req.body.hide_done_days);
    const orders = Number(req.body.keep_orders_months);
    const inquiries = Number(req.body.keep_inquiries_months);
    if (!retention.HIDE_CHOICES.includes(hide) || !retention.KEEP_CHOICES.includes(orders) || !retention.KEEP_CHOICES.includes(inquiries)) {
      flash(req, 'error', '목록에서 보여줄 기간과 보관 기간을 목록에서 골라 주세요.');
      return res.redirect('/admin/storage');
    }
    putSetting('hide_done_days', hide);
    putSetting('keep_orders_months', orders);
    putSetting('keep_inquiries_months', inquiries);
    flash(req, 'ok', '저장했습니다.');
    res.redirect('/admin/storage');
  });

  // 보관 기간이 지난 끝난 주문·답변한 문의 지우기 (미리보기에서 본 숫자가 그사이 바뀌었으면 다시 확인받는다)
  router.post('/storage/cleanup', (req, res) => {
    const preview = retention.previewCleanup(db);
    if (Number(req.body.orders) !== preview.orders || Number(req.body.inquiries) !== preview.inquiries) {
      flash(req, 'error', '그사이 지울 건수가 바뀌었습니다. 숫자를 다시 확인하고 눌러 주세요.');
      return res.redirect('/admin/storage');
    }
    if (!preview.orders && !preview.inquiries) {
      flash(req, 'ok', '정리할 자료가 없습니다.');
      return res.redirect('/admin/storage');
    }
    const out = retention.runCleanup(db, { userId: req.user.id, userName: req.user.name });
    flash(req, 'ok', `정리했습니다: 주문 ${out.orders.toLocaleString()}건, 문의 ${out.inquiries.toLocaleString()}건.`);
    res.redirect('/admin/storage');
  });

  router.get('/collect', (req, res) => {
    const runs = db.prepare('SELECT * FROM collect_runs ORDER BY id DESC LIMIT 10').all();
    const recent = db.prepare(`
      SELECT o.channel_item_id, o.product_name, o.option_text, o.quantity, o.paid_at, o.channel_status,
             o.channel_confirmed, s.name AS stage_name
      FROM orders o LEFT JOIN work_stages s ON s.id = o.stage_id
      ORDER BY o.id DESC LIMIT 10
    `).all();
    const total = db.prepare("SELECT COUNT(DISTINCT channel || ':' || channel_order_id) AS n FROM orders").get().n;
    res.render('admin/collect', {
      title: '주문 수집',
      tab: 'collect',
      source: collector ? collector.source : null,
      orderInterval: intervalMinutes(db, 'order_interval_minutes'),
      inboxInterval: intervalMinutes(db, 'inbox_interval_minutes'),
      MIN_MINUTES, MAX_MINUTES,
      runs,
      recent,
      total,
    });
  });

  // 발주확인·발송처리 기록 (최근 200건)
  router.get('/actions', (req, res) => {
    const filter = ['problem', 'live', 'practice'].includes(req.query.f) ? req.query.f : '';
    const where = {
      problem: "WHERE a.result IN ('fail', 'partial', 'unknown')",
      live: "WHERE a.mode = 'live'",
      practice: "WHERE a.mode = 'practice'",
    }[filter] || '';
    const actions = db.prepare(`
      SELECT a.*, u.name AS user_name,
        (SELECT o.id FROM orders o WHERE o.channel = a.channel AND o.channel_order_id = a.channel_order_id
          ORDER BY CASE WHEN o.item_type = 'addon' THEN 1 ELSE 0 END, o.id LIMIT 1) AS order_id,
        (SELECT o.product_name FROM orders o WHERE o.channel = a.channel AND o.channel_order_id = a.channel_order_id
          ORDER BY CASE WHEN o.item_type = 'addon' THEN 1 ELSE 0 END, o.id LIMIT 1) AS product_name
      FROM order_actions a LEFT JOIN users u ON u.id = a.user_id
      ${where}
      ORDER BY a.id DESC LIMIT 200
    `).all();
    for (const a of actions) {
      try { a.detailObj = a.detail ? JSON.parse(a.detail) : null; } catch { a.detailObj = null; }
    }
    res.render('admin/actions', { title: '처리 기록', tab: 'actions', actions, filter });
  });

  // 자동 수집 간격 (분). 다음 회차부터 바로 적용
  router.post('/collect-interval', (req, res) => {
    const read = v => Number(String(v || '').trim());
    const order = read(req.body.order_interval_minutes);
    const inbox = read(req.body.inbox_interval_minutes);
    const ok = n => Number.isInteger(n) && n >= MIN_MINUTES && n <= MAX_MINUTES;
    if (!ok(order) || !ok(inbox)) {
      flash(req, 'error', `간격은 ${MIN_MINUTES}~${MAX_MINUTES}분 사이의 숫자로 적어 주세요.`);
      return res.redirect('/admin/collect');
    }
    const save = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    save.run('order_interval_minutes', String(order));
    save.run('inbox_interval_minutes', String(inbox));
    flash(req, 'ok', `자동 수집 간격을 저장했습니다: 주문 ${order}분, 메일 ${inbox}분마다 (다음 회차부터 적용).`);
    res.redirect('/admin/collect');
  });

  router.post('/collect', async (req, res) => {
    if (!collector) {
      flash(req, 'error', '주문 수집이 꺼져 있습니다 (ORDER_SOURCE=off).');
      return res.redirect('/admin/collect');
    }
    const result = await collector.run();
    const f = collectFlash(result);
    flash(req, f.type, f.message + (result.ok && result.archived ? `, 이미 배송된 지난 주문 ${result.archived}건(전체 탭에 보관)` : ''));
    res.redirect('/admin/collect');
  });

  return router;
}

module.exports = { adminRoutes, STATUS_LABELS };
