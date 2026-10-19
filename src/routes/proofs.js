// 시안 화면
//   직원용 /proofs …  : 시안 목록, 새 시안, 수정 시안 올리기, 문자 다시 보내기, 종료
//   고객용 /p/:token  : 로그인 없이 링크로 열어 확정 / 수정 요청
const express = require('express');
const multer = require('multer');
const { UserError, STATUS_LABELS, MAX_UPLOAD_MB } = require('../proofs');

// 파일이 들어오는 폼은 CSRF 검사보다 먼저 읽어야 토큰(_csrf)을 꺼낼 수 있다.
// 그래서 로그인한 직원의 업로드만 메모리로 받아 두고, 디스크에는 CSRF 검사를 통과한 뒤에 쓴다.
function proofUploadParser() {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20 },
  }).single('file');
  return (req, res, next) => {
    if (req.method !== 'POST' || !req.is('multipart/form-data')) return next();
    if (!req.user || req.user.status !== 'active') return res.status(403).end();
    upload(req, res, err => {
      if (err) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE'
          ? `파일이 너무 큽니다. ${MAX_UPLOAD_MB}MB 이하 JPG 로 저장해 주세요.`
          : '파일을 받지 못했습니다. 다시 시도하세요.';
        req.body = req.body || {};
      }
      next();
    });
  };
}

const baseUrlOf = req => `${req.protocol}://${req.get('host')}`;

function smsNotice(result) {
  if (!result) return '';
  return result.ok ? ' 고객에게 문자를 보냈습니다.' : ` 문자는 보내지 못했습니다: ${result.result}`;
}

function sendImage(res, service, version) {
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(version.mime);
  res.sendFile(service.filePath(version), err => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

function proofRoutes(db, service, sms) {
  const router = express.Router();
  const flash = (req, type, message) => {
    req.session.flash = { type, message };
  };

  const findProof = (req, res) => {
    const proof = service.getProof(req.params.id);
    if (!proof) {
      res.status(404).render('error', { title: '없는 시안', message: '시안을 찾을 수 없습니다.' });
      return null;
    }
    return proof;
  };

  // 업로드 오류, 입력 오류는 안내 문구로, 나머지는 서버 오류로
  const handle = fn => async (req, res, next) => {
    try {
      if (req.uploadError) throw new UserError(req.uploadError);
      await fn(req, res);
    } catch (err) {
      if (!(err instanceof UserError)) return next(err);
      flash(req, 'error', err.message);
      res.redirect(req.get('referer') || '/proofs');
    }
  };

  router.get('/', (req, res) => {
    const status = STATUS_LABELS[req.query.status] ? req.query.status : 'all';
    res.render('proofs/list', {
      title: '시안',
      proofs: service.list(status),
      counts: service.counts(),
      status,
      labels: STATUS_LABELS,
    });
  });

  router.get('/new', (req, res) => {
    // 최근 주문에서 골라 연결 (전화번호·이름이 자동으로 채워짐)
    const orders = db.prepare(`
      SELECT id, channel_order_id, product_name, option_text, buyer_name, receiver_name, receiver_phone
      FROM orders ORDER BY COALESCE(paid_at, created_at) DESC LIMIT 200`).all();
    const selected = Number(req.query.order) || null;
    res.render('proofs/new', { title: '새 시안', orders, selected, smsDriver: sms.driver });
  });

  router.post('/', handle(async (req, res) => {
    const { proof, smsResult } = await service.create({
      user: req.user,
      fields: req.body,
      file: req.file,
      baseUrl: baseUrlOf(req),
      sendSms: req.body.send_sms === '1',
    });
    flash(req, smsResult && !smsResult.ok ? 'error' : 'notice', '시안을 만들었습니다.' + smsNotice(smsResult));
    res.redirect(`/proofs/${proof.id}`);
  }));

  router.get('/:id', (req, res) => {
    const proof = findProof(req, res);
    if (!proof) return;
    res.render('proofs/show', {
      title: proof.title,
      proof,
      versions: service.versions(proof.id),
      responses: service.responses(proof.id),
      smsLog: db.prepare('SELECT * FROM sms_log WHERE proof_id = ? ORDER BY id DESC LIMIT 20').all(proof.id),
      link: service.linkFor(proof, baseUrlOf(req)),
      expired: service.isExpired(proof),
      labels: STATUS_LABELS,
      smsDriver: sms.driver,
    });
  });

  router.get('/:id/v/:no', (req, res) => {
    const proof = service.getProof(req.params.id);
    const version = proof && service.getVersion(proof.id, req.params.no);
    if (!version) return res.status(404).end();
    sendImage(res, service, version);
  });

  router.post('/:id/versions', handle(async (req, res) => {
    const proof = findProof(req, res);
    if (!proof) return;
    if (proof.status === 'closed') throw new UserError('종료된 시안에는 올릴 수 없습니다.');
    const { versionNo, smsResult } = await service.addVersion({
      proof,
      user: req.user,
      fields: req.body,
      file: req.file,
      baseUrl: baseUrlOf(req),
      sendSms: req.body.send_sms === '1',
    });
    flash(req, smsResult && !smsResult.ok ? 'error' : 'notice', `${versionNo}차 시안을 올렸습니다.` + smsNotice(smsResult));
    res.redirect(`/proofs/${proof.id}`);
  }));

  router.post('/:id/resend', handle(async (req, res) => {
    const proof = findProof(req, res);
    if (!proof) return;
    const latest = service.latestVersion(proof.id);
    const result = await service.sendLink(proof, latest ? latest.version_no : 1, baseUrlOf(req));
    flash(req, result.ok ? 'notice' : 'error', result.ok ? '문자를 다시 보냈습니다.' : `문자를 보내지 못했습니다: ${result.result}`);
    res.redirect(`/proofs/${proof.id}`);
  }));

  router.post('/:id/close', handle(async (req, res) => {
    const proof = findProof(req, res);
    if (!proof) return;
    service.close(proof);
    flash(req, 'notice', '시안을 종료했습니다. 고객 링크가 더 이상 열리지 않습니다.');
    res.redirect(`/proofs/${proof.id}`);
  }));

  return router;
}

// 고객용: 로그인 없이 링크(무작위 주소)만으로 연다
function proofPublicRoutes(service) {
  const router = express.Router();

  const findProof = (req, res) => {
    const proof = service.getByToken(req.params.token);
    if (!proof) {
      res.status(404).render('proofs/public-closed', { title: '시안', message: '없는 주소입니다. 받으신 문자의 링크를 다시 확인해 주세요.' });
      return null;
    }
    const reason = service.closedReason(proof);
    if (reason) {
      res.status(410).render('proofs/public-closed', { title: proof.title, message: reason });
      return null;
    }
    return proof;
  };

  // 검색 사이트에 고객 시안이 노출되지 않게
  router.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  router.get('/:token', (req, res) => {
    const proof = findProof(req, res);
    if (!proof) return;
    const versions = service.versions(proof.id);
    res.render('proofs/public', {
      title: proof.title,
      proof,
      versions,
      latest: versions[versions.length - 1],
      responses: service.responses(proof.id),
      error: req.session.proofError || null,
    });
    delete req.session.proofError;
  });

  router.get('/:token/v/:no', (req, res) => {
    const proof = findProof(req, res);
    if (!proof) return;
    const version = service.getVersion(proof.id, req.params.no);
    if (!version) return res.status(404).end();
    sendImage(res, service, version);
  });

  const respond = action => async (req, res, next) => {
    const proof = findProof(req, res);
    if (!proof) return;
    try {
      await service.respond({
        proof,
        action,
        versionNo: req.body.version_no,
        name: req.body.name,
        comment: req.body.comment,
        pins: req.body.pins,
        agreed: req.body.agree === '1',
      });
    } catch (err) {
      if (!(err instanceof UserError)) return next(err);
      req.session.proofError = err.message;
    }
    res.redirect(`/p/${proof.token}`);
  };

  router.post('/:token/approve', respond('approve'));
  router.post('/:token/revise', respond('revise'));

  return router;
}

module.exports = { proofRoutes, proofPublicRoutes, proofUploadParser };
