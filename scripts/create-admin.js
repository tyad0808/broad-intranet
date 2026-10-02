// 첫 관리자 계정을 만드는 명령어
// 실행: npm run create-admin
// 이미 가입된 이메일이면 그 계정을 관리자 + 승인 상태로 바꾸고 비밀번호를 새로 설정한다.
require('dotenv').config({ quiet: true });

const readline = require('readline');
const { openDb } = require('../src/db');
const { hashPassword, validatePassword } = require('../src/auth');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
let hidden = false;

// 비밀번호를 입력하는 동안에는 키보드로 친 글자를 화면에 보여주지 않는다
const originalWrite = rl._writeToOutput.bind(rl);
rl._writeToOutput = text => {
  if (!hidden) originalWrite(text);
  else if (text.includes('\n') || text.includes('\r')) originalWrite('\n');
};

async function ask(question, { secret = false } = {}) {
  process.stdout.write(question);
  hidden = secret;
  const { value, done } = await lines.next();
  hidden = false;
  if (done) throw new Error('입력이 중간에 끝났습니다.');
  return secret ? value : value.trim();
}

const askHidden = question => ask(question, { secret: true });

async function main() {
  console.log('관리자 계정 만들기\n');
  const email = await ask('이메일: ');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('이메일 형식이 올바르지 않습니다.');
  const name = await ask('이름: ');
  if (!name) throw new Error('이름을 입력하세요.');

  const password = await askHidden('비밀번호 (8자 이상, 입력해도 화면에 안 보임): ');
  const pwError = validatePassword(password);
  if (pwError) throw new Error(pwError);
  const confirm = await askHidden('비밀번호 확인: ');
  if (password !== confirm) throw new Error('비밀번호 확인이 일치하지 않습니다.');

  const db = openDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare(
      "UPDATE users SET name = ?, password_hash = ?, role = 'admin', status = 'active', " +
      "failed_logins = 0, locked_until = NULL, approved_at = datetime('now') WHERE id = ?"
    ).run(name, hashPassword(password), existing.id);
    console.log(`\n기존 계정 ${email} 을(를) 관리자로 바꿨습니다.`);
  } else {
    db.prepare(
      "INSERT INTO users (email, password_hash, name, role, status, approved_at) " +
      "VALUES (?, ?, ?, 'admin', 'active', datetime('now'))"
    ).run(email, hashPassword(password), name);
    console.log(`\n관리자 계정 ${email} 을(를) 만들었습니다.`);
  }
  db.close();
}

main()
  .catch(err => {
    console.error(`\n실패: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
