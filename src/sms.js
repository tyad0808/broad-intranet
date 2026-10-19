// 문자 보내기 (알리고). 보낸 문자는 성공·실패 모두 sms_log 에 남는다.
// .env 의 SMS_DRIVER
//   mock  (기본) 실제로 보내지 않고 기록만 남긴다. 개발·연습용
//   aligo 알리고 API 로 실제 발송. 알리고에 등록된 서버 IP 에서만 동작한다
const ALIGO_URL = 'https://apis.aligo.in/send/';
const SMS_MAX_BYTES = 90; // 이보다 길면 장문(LMS)으로 보낸다

// 문자 길이는 한글 2바이트, 영문·숫자 1바이트로 센다 (통신사 기준)
function smsBytes(text) {
  let n = 0;
  for (const ch of String(text)) n += ch.charCodeAt(0) < 128 ? 1 : 2;
  return n;
}

// 010-1234-5678, 010 1234 5678 → 01012345678. 전화번호가 아니면 null
function normalizePhone(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return /^0\d{8,11}$/.test(digits) ? digits : null;
}

function aligoSender(env, fetchImpl) {
  const { ALIGO_API_KEY, ALIGO_USER_ID, ALIGO_SENDER } = env;
  if (!ALIGO_API_KEY || !ALIGO_USER_ID || !ALIGO_SENDER) {
    throw new Error('SMS_DRIVER=aligo 인데 ALIGO_API_KEY, ALIGO_USER_ID, ALIGO_SENDER 중 빈 값이 있습니다.');
  }
  return async (receiver, message) => {
    const long = smsBytes(message) > SMS_MAX_BYTES;
    const body = new URLSearchParams({
      key: ALIGO_API_KEY,
      user_id: ALIGO_USER_ID,
      sender: ALIGO_SENDER,
      receiver,
      msg: message,
      msg_type: long ? 'LMS' : 'SMS',
      ...(long ? { title: env.ALIGO_LMS_TITLE || '브로애드' } : {}),
      ...(env.ALIGO_TEST_MODE === 'Y' ? { testmode_yn: 'Y' } : {}),
    });
    const res = await fetchImpl(ALIGO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    // 알리고는 성공하면 result_code 가 1 이상, 실패하면 음수
    const ok = Number(data.result_code) > 0;
    return { ok, result: ok ? `msg_id ${data.msg_id} (${data.msg_type})` : `${data.result_code} ${data.message}` };
  };
}

function createSms({ db, env = process.env, fetchImpl = fetch } = {}) {
  const driver = env.SMS_DRIVER === 'aligo' ? 'aligo' : 'mock';
  const send = driver === 'aligo'
    ? aligoSender(env, fetchImpl)
    : async () => ({ ok: true, result: '가짜 발송 (SMS_DRIVER=mock)' });
  const log = db.prepare('INSERT INTO sms_log (receiver, message, driver, ok, result, proof_id) VALUES (?, ?, ?, ?, ?, ?)');

  // 문자 1통을 보낸다. 실패해도 예외를 던지지 않고 { ok: false, result } 를 돌려준다
  async function sendSms(to, message, { proofId = null } = {}) {
    const receiver = normalizePhone(to);
    let outcome;
    if (!receiver) {
      outcome = { ok: false, result: '전화번호 형식이 올바르지 않습니다.' };
    } else {
      try {
        outcome = await send(receiver, message);
      } catch (err) {
        outcome = { ok: false, result: err.name === 'TimeoutError' ? '알리고 응답 없음 (10초)' : err.message };
      }
    }
    log.run(receiver || String(to || ''), message, driver, outcome.ok ? 1 : 0, outcome.result, proofId);
    if (!outcome.ok) console.error(`[문자 실패] ${to}: ${outcome.result}`);
    return outcome;
  }

  // 사장님 등 알림 받을 번호들 (.env 의 PROOF_NOTIFY_PHONES, 쉼표로 여러 개)
  const notifyPhones = String(env.PROOF_NOTIFY_PHONES || '').split(',').map(normalizePhone).filter(Boolean);

  return { driver, sendSms, notifyPhones };
}

module.exports = { createSms, smsBytes, normalizePhone };
