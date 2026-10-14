// 일러스트레이터 스크립트(ExtendScript)는 옛날 자바스크립트(ES3)라서
// 예약어(short, int, class ...)를 변수 이름으로 쓰거나 새 문법·함수를 쓰면 파일 전체가 안 읽힌다.
// (그러면 패널의 모든 버튼이 "함수가 아닙니다" 오류를 낸다)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dirs = ['../tools/illustrator-dombo/jsx', '../tools/illustrator-nesting/jsx'].map(d => path.join(__dirname, d));
const files = dirs.flatMap(d => fs.readdirSync(d).filter(f => f.endsWith('.jsx')).map(f => path.join(d, f)));

// 글자·주석·정규식 안의 내용을 지우고 코드만 남긴다 (줄 번호는 유지)
function codeOnly(src) {
  let out = '', i = 0, prev = '';
  const blank = s => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2) + 2; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += c + blank(src.slice(i + 1, j)) + c; i = j + 1; prev = 'x'; continue;
    }
    // 정규식: / 앞이 값이 아닌 자리 (연산자, 괄호, 쉼표 등)
    if (c === '/' && /[(,=:[!&|?{};]|^$/.test(prev)) {
      let j = i + 1, inClass = false;
      while (j < src.length && (src[j] !== '/' || inClass)) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      out += '/' + blank(src.slice(i + 1, j)) + '/'; i = j + 1; prev = 'x'; continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const RESERVED = ('abstract boolean byte char class const debugger double enum export extends final float goto ' +
  'implements import int interface long native package private protected public short static super ' +
  'synchronized throws transient volatile let yield').split(' ');
const NEWER = [
  [/=>/, '화살표 함수 (=>)'],
  [/`/, '템플릿 글자 (`)'],
  [/\.(forEach|map|filter|reduce|some|every|indexOf|lastIndexOf|trim)\s*\(/, '새 함수 (forEach/map/filter/indexOf/trim ...)'],
  [/\bJSON\./, 'JSON (ExtendScript 에 없음)'],
  [/\bObject\.(keys|assign|create|defineProperty)\b/, 'Object.keys 등'],
  [/\bArray\.isArray\b|\bDate\.now\b/, 'Array.isArray / Date.now'],
];

for (const file of files) {
  test(`ES3 로 읽힌다: ${path.basename(path.dirname(path.dirname(file)))}/${path.basename(file)}`, () => {
    const lines = codeOnly(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).split('\n');
    const problems = [];
    lines.forEach((line, n) => {
      if (/^\s*#(target|include)\b/.test(line)) return;
      for (const w of RESERVED) if (new RegExp('(^|[^\\w$.])' + w + '(?![\\w$])').test(line)) problems.push(`${n + 1}줄: 예약어 '${w}'`);
      for (const [re, what] of NEWER) if (re.test(line)) problems.push(`${n + 1}줄: ${what}`);
    });
    assert.deepStrictEqual(problems, []);
  });
}

test('검사기가 예약어와 새 문법을 실제로 잡아낸다', () => {
  const lines = codeOnly("var short = 1; // short 는 주석\nvar s = 'class 는 글자';\nvar r = /int/;\nlist.forEach(f);").split('\n');
  assert.ok(/\bshort\b/.test(lines[0]) && !/주석/.test(lines[0]));
  assert.ok(!/class/.test(lines[1]), '글자 안은 무시');
  assert.ok(!/int/.test(lines[2]), '정규식 안은 무시');
  assert.ok(/\.forEach\(/.test(lines[3]));
});
