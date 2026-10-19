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
