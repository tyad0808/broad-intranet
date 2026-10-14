// 관리자 메뉴: 직원 관리, 작업 단계 편집, 직무 편집
// 이 파일의 모든 주소는 app.js 에서 requireAdmin 을 거친 뒤에만 들어온다.
const express = require('express');
const { transaction } = require('../db');

const STATUS_LABELS = {
  pending: '승인 대기',
  active: '사용 중',
  suspended: '정지',
  rejected: '거절',
};

function adminRoutes(db, sessionStore, collector) {
  const router = express.Router();

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
    // 이미 로그인해 있는 창도 즉시 끊는다
    sessionStore.destroyUserSessions(user.id);
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
    res.render('admin/stages', { title: '작업 단계', tab: 'stages', stages });
  });
  listEditor({ table: 'work_stages', path: 'stages', label: '작업 단계' });

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

  // ───────── 주문 수집 상태 ─────────
  router.get('/collect', (req, res) => {
    const runs = db.prepare('SELECT * FROM collect_runs ORDER BY id DESC LIMIT 10').all();
    const recent = db.prepare(`
      SELECT o.channel_item_id, o.product_name, o.option_text, o.quantity, o.paid_at, o.channel_status,
             o.channel_confirmed, s.name AS stage_name
      FROM orders o LEFT JOIN work_stages s ON s.id = o.stage_id
      ORDER BY o.id DESC LIMIT 10
    `).all();
    const total = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    res.render('admin/collect', {
      title: '주문 수집',
      tab: 'collect',
      source: collector ? collector.source : null,
      intervalMinutes: collector ? collector.intervalMinutes : null,
      runs,
      recent,
      total,
    });
  });

  router.post('/collect', async (req, res) => {
    if (!collector) {
      flash(req, 'error', '주문 수집기가 설정되지 않았습니다.');
      return res.redirect('/admin/collect');
    }
    const result = await collector.run();
    if (result.ok) {
      flash(req, 'ok', `수집 완료: 새 주문 ${result.created}건, 바뀐 주문 ${result.updated}건`);
    } else {
      flash(req, 'error', `수집 실패: ${result.error}`);
    }
    res.redirect('/admin/collect');
  });

  return router;
}

module.exports = { adminRoutes, STATUS_LABELS };
