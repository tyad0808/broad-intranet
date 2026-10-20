// 파일 받기 엔진: NAS 폴더 → 출력 컴퓨터 폴더 (실제 임시 폴더로 검사)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Syncer, isIgnored } = require('../tools/file-sync/src/core/sync.js');

function setup(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filesync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nas = path.join(root, 'nas'), pc = path.join(root, 'pc'), state = path.join(root, 'state.json');
  fs.mkdirSync(nas);
  const make = (o = {}) => new Syncer({ source: nas, dest: pc, statePath: state, ...opts, ...o });
  const put = (rel, content, mtime) => {
    const f = path.join(nas, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    if (mtime) fs.utimesSync(f, mtime, mtime);
  };
  return { root, nas, pc, state, make, put, pcFile: rel => path.join(pc, ...rel.split('/')) };
}

test('처음 켤 때 이미 있던 파일은 받지 않고, 그 뒤에 올린 파일만 받는다', async t => {
  const s = setup(t);
  s.put('옛날.pdf', 'old');
  const sync = s.make();
  const first = await sync.tick();
  assert.strictEqual(first.baseline, 1);
  assert.ok(!fs.existsSync(s.pcFile('옛날.pdf')));

  s.put('새 주문.ai', 'new file');
  assert.strictEqual((await sync.tick()).received.length, 0, '한 번 봤을 땐 아직 (올리는 중일 수 있음)');
  const r = await sync.tick();
  assert.strictEqual(r.received.length, 1);
  assert.strictEqual(r.received[0].name, '새 주문.ai');
  assert.strictEqual(r.received[0].kind, 'new');
  assert.strictEqual(fs.readFileSync(s.pcFile('새 주문.ai'), 'utf8'), 'new file');
  assert.strictEqual(sync.unseen, 1);
  assert.ok(fs.existsSync(path.join(s.nas, '새 주문.ai')), 'NAS 원본은 그대로');
});

test('올리는 중이라 크기가 계속 바뀌면 다 올라갈 때까지 기다린다', async t => {
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  s.put('큰파일.tif', 'a');
  await sync.tick();
  s.put('큰파일.tif', 'aaaa');      // 아직 올라가는 중
  assert.strictEqual((await sync.tick()).received.length, 0);
  s.put('큰파일.tif', 'aaaaaaaa');
  assert.strictEqual((await sync.tick()).received.length, 0);
  const r = await sync.tick();      // 그대로 → 다 올라감
  assert.strictEqual(r.received.length, 1);
  assert.strictEqual(fs.readFileSync(s.pcFile('큰파일.tif'), 'utf8'), 'aaaaaaaa');
  assert.deepStrictEqual(fs.readdirSync(s.pc), ['큰파일.tif'], '.part 임시 파일이 남지 않는다');
});

test('하위 폴더도 그대로, 시스템·임시 파일은 건너뛴다', async t => {
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  s.put('홍길동/현수막.pdf', 'x');
  s.put('@eaDir/현수막.pdf/SYNOFILE_THUMB_M.jpg', 'thumb');
  s.put('#recycle/지운것.pdf', 'x');
  s.put('Thumbs.db', 'x');
  s.put('~$작업.ai', 'x');
  s.put('올리는중.pdf.part', 'x');
  await sync.tick();
  const r = await sync.tick();
  assert.deepStrictEqual(r.received.map(e => [e.folder, e.name]), [['홍길동', '현수막.pdf']]);
  assert.ok(fs.existsSync(s.pcFile('홍길동/현수막.pdf')));
  assert.ok(isIgnored('.DS_Store') && isIgnored('._사진.jpg') && !isIgnored('사진.jpg'));
});

test('같은 이름으로 다시 올리면 수정본으로 받아 덮어쓴다', async t => {
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  s.put('시안.pdf', 'v1', new Date('2026-10-01'));
  await sync.tick(); await sync.tick();
  s.put('시안.pdf', 'version 2', new Date('2026-10-02'));
  await sync.tick();
  const r = await sync.tick();
  assert.strictEqual(r.received[0].kind, 'updated');
  assert.strictEqual(fs.readFileSync(s.pcFile('시안.pdf'), 'utf8'), 'version 2');
  assert.strictEqual(fs.statSync(s.pcFile('시안.pdf')).mtime.toISOString().slice(0, 10), '2026-10-02', '수정 시각도 NAS 와 같게');
});

test('받을 자리의 파일을 바꿀 수 없으면 다른 이름으로 받는다', async t => {
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  fs.mkdirSync(s.pcFile('출력중.pdf'), { recursive: true }); // 같은 이름이 폴더라 이름 바꾸기 실패 → 대신 다른 이름
  s.put('출력중.pdf', 'data');
  await sync.tick();
  const r = await sync.tick();
  assert.strictEqual(r.received.length, 1);
  assert.strictEqual(path.basename(r.received[0].localPath), '출력중 (2).pdf');
  assert.strictEqual(fs.readFileSync(r.received[0].localPath, 'utf8'), 'data');
});

test('NAS 에 연결이 안 되면 offline, 다시 되면 이어서 받는다', async t => {
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  fs.renameSync(s.nas, s.nas + '-off');
  const off = await sync.tick();
  assert.strictEqual(off.status, 'offline');
  fs.renameSync(s.nas + '-off', s.nas);
  s.put('복구 후.pdf', 'y');
  await sync.tick();
  assert.strictEqual((await sync.tick()).received.length, 1);
});

test('껐다 켜도 받은 기록과 확인 표시가 남고, 같은 파일을 또 받지 않는다', async t => {
  const s = setup(t);
  let sync = s.make();
  await sync.tick();
  s.put('a.pdf', '1'); s.put('b.pdf', '2');
  await sync.tick(); await sync.tick();
  await sync.markSeen(sync.history.find(h => h.name === 'a.pdf').id);
  assert.strictEqual(sync.unseen, 1);

  sync = await s.make().load();          // 다시 켬
  assert.strictEqual(sync.history.length, 2);
  assert.strictEqual(sync.unseen, 1);
  await sync.tick(); await sync.tick();
  assert.strictEqual(sync.history.length, 2, '이미 받은 것은 또 받지 않는다');
  await sync.markSeen('all');
  assert.strictEqual(sync.unseen, 0);
});

test('기존 파일 건너뛰기를 끄거나 지금 있는 것 모두 받기를 누르면 다 받는다', async t => {
  const s = setup(t);
  s.put('기존1.pdf', '1'); s.put('폴더/기존2.pdf', '2');
  const sync = s.make({ skipExisting: false });
  await sync.tick();
  assert.strictEqual((await sync.tick()).received.length, 2);

  const s2 = setup(t);
  s2.put('기존.pdf', '1');
  const sync2 = s2.make();
  await sync2.tick();                  // 건너뜀
  await sync2.importAll();
  await sync2.tick();
  assert.strictEqual((await sync2.tick()).received.length, 1);
});

test('출력 완료 체크: 출력 전 개수, 시각, 풀기, 껐다 켜도 유지', async t => {
  let clock = 1000;
  const s = setup(t, { now: () => clock });
  let sync = s.make();
  await sync.tick();
  s.put('a.pdf', '1'); s.put('b.pdf', '2');
  await sync.tick(); await sync.tick();
  assert.strictEqual(sync.pending, 2);
  const a = sync.history.find(h => h.name === 'a.pdf');
  clock = 5000;
  await sync.markDone(a.id);
  assert.strictEqual(sync.pending, 1);
  assert.strictEqual(a.doneAt, 5000);
  assert.strictEqual(a.seen, true, '출력 완료면 알림도 본 것');
  await sync.markDone(a.id, false);
  assert.strictEqual(sync.pending, 2, '잘못 눌렀으면 풀 수 있다');
  await sync.markDone(a.id);

  sync = await s.make({ now: () => clock }).load();
  assert.strictEqual(sync.pending, 1);
  assert.strictEqual(sync.history.find(h => h.name === 'a.pdf').done, true);
});

test('열어봄 표시와, 출력 전인 채 오래된 파일 찾기 (다시 알림용)', async t => {
  let clock = 0;
  const s = setup(t, { now: () => clock });
  const sync = s.make();
  await sync.tick();
  s.put('오래된.pdf', '1');
  await sync.tick(); await sync.tick();
  clock = 20 * 60e3;
  s.put('방금.pdf', '2');
  await sync.tick(); await sync.tick();
  clock = 31 * 60e3;
  assert.deepStrictEqual(sync.stale(30 * 60e3).map(h => h.name), ['오래된.pdf']);
  const old = sync.history.find(h => h.name === '오래된.pdf');
  await sync.markOpened(old.id);
  assert.strictEqual(old.openedAt, clock);
  assert.strictEqual(old.done, false, '열어 본 것은 출력 완료가 아니다');
  await sync.markDone(old.id);
  assert.deepStrictEqual(sync.stale(30 * 60e3), []);
});

test('같은 파일의 새 버전이 오면 출력 전이던 옛 버전은 바뀜 표시, 출력 전 개수에서 뺀다', async t => {
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  s.put('시안.pdf', 'v1', new Date('2026-10-01'));
  await sync.tick(); await sync.tick();
  s.put('시안.pdf', 'version 2', new Date('2026-10-02'));
  await sync.tick(); await sync.tick();
  const [v2, v1] = sync.history;
  assert.strictEqual(v2.kind, 'updated');
  assert.strictEqual(v1.replaced, true);
  assert.strictEqual(sync.pending, 1, '새 버전만 출력 전');
});

const { isUrgent } = require('../tools/file-sync/src/core/sync.js');

test('급한 파일 알아보기: [급] (급) 긴급, 앞뒤가 띄어진 급. 고급명함은 아님', () => {
  for (const rel of ['[급] 현수막.pdf', '현수막(급).ai', '급_명함.pdf', '명함_급.pdf', '급 배너.pdf', '긴급현수막.pdf', '급/현수막.pdf', '홍길동 [급]/a.pdf', 'URGENT-sign.pdf']) {
    assert.ok(isUrgent(rel), rel);
  }
  for (const rel of ['고급명함.pdf', '급식실 안내.pdf', '등급표.pdf', '현수막.pdf', '고급/명함.pdf']) {
    assert.ok(!isUrgent(rel), rel);
  }
});

test('받을 때 크기 정보와 급 표시를 기록에 남긴다', async t => {
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'file-sync', 'banner-3000x900.pdf'), path.join(s.nas, '[급] 현수막.pdf'));
  await sync.tick();
  const [e] = (await sync.tick()).received;
  assert.strictEqual(e.urgent, true);
  assert.strictEqual(Math.round(e.info.widthMm), 3000);
  assert.strictEqual(Math.round(e.info.heightMm), 900);
});

test('출력 완료하면 NAS 원본을 _출력완료 로 옮기고, 풀면 제자리로 (다시 받지 않음)', async t => {
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  s.put('홍길동/현수막.pdf', 'v1');
  await sync.tick(); await sync.tick();
  const h = sync.history[0];

  const r = await sync.markDone(h.id, true, { moveOnNas: true });
  assert.strictEqual(r.warning, undefined);
  assert.ok(!fs.existsSync(path.join(s.nas, '홍길동', '현수막.pdf')));
  assert.ok(fs.existsSync(path.join(s.nas, '_출력완료', '홍길동', '현수막.pdf')), '하위 폴더 그대로 _출력완료 안에');
  assert.strictEqual(h.nasDone, '_출력완료/홍길동/현수막.pdf');
  await sync.tick(); await sync.tick();
  assert.strictEqual(sync.history.length, 1, '_출력완료 폴더는 받지 않는다');

  await sync.markDone(h.id, false);
  assert.ok(fs.existsSync(path.join(s.nas, '홍길동', '현수막.pdf')), '풀면 제자리로');
  assert.strictEqual(h.nasDone, null);
  await sync.tick(); await sync.tick();
  assert.strictEqual(sync.history.length, 1, '제자리로 돌린 것을 또 받지 않는다');
});

test('NAS 파일이 받은 뒤에 바뀌었으면 옮기지 않고 알려 준다 (출력 완료 체크는 된다)', async t => {
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  s.put('시안.pdf', 'v1', new Date('2026-10-01'));
  await sync.tick(); await sync.tick();
  s.put('시안.pdf', 'version 2', new Date('2026-10-02')); // 새 버전이 막 올라옴
  const r = await sync.markDone(sync.history[0].id, true, { moveOnNas: true });
  assert.match(r.warning, /바뀌었습니다/);
  assert.strictEqual(sync.history[0].done, true);
  assert.ok(fs.existsSync(path.join(s.nas, '시안.pdf')), '새 버전은 그대로');
});

test('받지 않을 확장자는 받지 않고, 나중에 설정에서 빼도 옛 파일이 쏟아지지 않는다', async t => {
  const s = setup(t);
  const sync = s.make({ skipExt: 'PSD, .zip  *.mp4' });
  assert.deepStrictEqual([...sync.skipExt], ['psd', 'zip', 'mp4']);
  await sync.tick();
  s.put('현수막.pdf', 'x');
  s.put('원본.psd', 'x');
  s.put('홍길동/모음.ZIP', 'x');
  await sync.tick();
  const r = await sync.tick();
  assert.deepStrictEqual(r.received.map(e => e.name), ['현수막.pdf']);
  assert.ok(!fs.existsSync(s.pcFile('원본.psd')) && !fs.existsSync(s.pcFile('홍길동/모음.ZIP')));

  // 설정에서 psd 를 빼면: 이미 있던 원본.psd 는 그대로 두고, 새로 바뀐 psd 만 받는다
  const again = s.make({ skipExt: 'zip' });
  await again.tick();
  assert.strictEqual((await again.tick()).received.length, 0);
  s.put('원본.psd', 'changed', new Date(Date.now() + 5000));
  await again.tick();
  assert.deepStrictEqual((await again.tick()).received.map(e => e.name), ['원본.psd']);
});

test('NAS 에 못 닿은 까닭을 사람 말로 알려 준다', async t => {
  const { offlineReason } = require('../tools/file-sync/src/core/sync.js');
  assert.strictEqual(offlineReason({ code: 'ENOENT' }), '폴더를 찾을 수 없음');
  assert.strictEqual(offlineReason({ code: 'EPERM' }), '권한 없음 (NAS 로그인 확인)');
  assert.strictEqual(offlineReason({ code: 'UNKNOWN' }), '네트워크 응답 없음 (UNKNOWN)');
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  fs.rmSync(s.nas, { recursive: true });
  assert.strictEqual((await sync.tick()).message, '폴더를 찾을 수 없음');
});

test('하위 폴더를 잠깐 못 읽어도, 다시 읽힐 때 그 안의 파일을 또 받지 않는다', async t => {
  const s = setup(t);
  const { scan } = require('../tools/file-sync/src/core/sync.js');
  let broken = false;
  const sync = s.make({
    scan: async root => {
      const m = await scan(root);
      if (broken) { for (const k of [...m.keys()]) if (k.startsWith('홍길동/')) m.delete(k); m.unsure.push('홍길동/'); }
      return m;
    },
  });
  await sync.tick();
  s.put('홍길동/현수막.pdf', 'x'); s.put('홍길동/배너.pdf', 'y');
  await sync.tick();
  assert.strictEqual((await sync.tick()).received.length, 2);
  broken = true;                       // NAS 가 잠깐 그 폴더를 못 읽음
  await sync.tick();
  broken = false;
  await sync.tick();
  assert.strictEqual((await sync.tick()).received.length, 0);
  assert.strictEqual(sync.history.length, 2);
});

test('기록이 어긋나도 이미 받은 똑같은 파일은 다시 받지 않는다 (지금 있는 것 모두 받기 포함)', async t => {
  const s = setup(t);
  const sync = s.make();
  await sync.tick();
  s.put('a.pdf', '1');
  await sync.tick(); await sync.tick();
  await sync.importAll();              // 받을 목록을 비움
  await sync.tick();
  assert.strictEqual((await sync.tick()).received.length, 0);
  assert.strictEqual(sync.history.length, 1);
  s.put('a.pdf', '22', new Date(Date.now() + 5000)); // 고친 파일은 받는다
  await sync.tick();
  assert.strictEqual((await sync.tick()).received[0].kind, 'updated');
});

test('예전 버전이 두 번 넣은 같은 파일 기록을 켤 때 하나로 합친다', () => {
  const { dedupeHistory } = require('../tools/file-sync/src/core/sync.js');
  const base = { rel: 'a.eps', size: 5, mtimeMs: 100, localPath: '/없음' };
  const h = [
    { ...base, id: 3, seen: false, done: false, replaced: false },             // 두 번째로 또 받은 것
    { ...base, rel: 'b.eps', id: 2, seen: true, done: false, replaced: false },
    { ...base, id: 1, seen: true, done: false, replaced: true },              // 처음 받은 것 (두 번째 때문에 '바뀜' 표시됨)
  ];
  assert.strictEqual(dedupeHistory(h), true);
  assert.deepStrictEqual(h.map(x => x.id), [2, 1]);
  assert.strictEqual(h[1].replaced, false, '바뀜 표시가 풀려 다시 출력 전');
  assert.strictEqual(h[1].seen, true);
  assert.strictEqual(dedupeHistory(h), false);
});

test('받는 중 진행 상황: 몇 번째·몇 개, 받은 양, 끝나면 null', async t => {
  const s = setup(t);
  const seen = [];
  const sync = s.make({ onProgress: p => seen.push(p && { ...p }) });
  await sync.tick();
  s.put('a.pdf', 'x'.repeat(3000)); s.put('b.pdf', 'y'.repeat(5000));
  await sync.tick();
  assert.strictEqual(sync.waitingCount, 2, 'NAS 에 올라가는 중인지 지켜보는 파일');
  await sync.tick();
  assert.strictEqual(sync.waitingCount, 0);
  const last = seen.filter(Boolean).pop();
  assert.strictEqual(last.count, 2);
  assert.strictEqual(last.index, 2);
  assert.strictEqual(last.batchTotal, 8000);
  assert.strictEqual(last.batchDone, 8000);
  assert.strictEqual(last.fileDone, last.fileTotal);
  assert.ok(seen.some(p => p && p.index === 1 && p.fileDone === 0), '파일을 받기 시작할 때도 알린다');
  assert.strictEqual(seen[seen.length - 1], null);
  assert.strictEqual(sync.progress, null);
});

test('처음 볼 때 건너뛴 파일 수를 남기고, 모두 받기나 닫기로 지운다', async t => {
  const s = setup(t);
  s.put('옛1.pdf', '1'); s.put('폴더/옛2.pdf', '2');
  const sync = s.make();
  await sync.tick();
  assert.strictEqual(sync.state.skipped.count, 2);
  await sync.dismissSkipped();
  assert.strictEqual(sync.state.skipped, null);
  const again = await s.make({ source: s.nas }).load();
  assert.strictEqual(again.state.skipped, null, '껐다 켜도 닫은 그대로');
  again.state.skipped = { count: 2, at: 1 };
  await again.importAll();
  assert.strictEqual(again.state.skipped, null);
  await again.tick();
  assert.strictEqual((await again.tick()).received.length, 2);
});
