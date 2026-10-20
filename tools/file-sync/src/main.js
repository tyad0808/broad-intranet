// 브로애드 파일 받기: NAS 폴더에 올린 파일을 출력 컴퓨터로 자동으로 받아 목록과 알림으로 보여 준다.
// 작업표시줄 트레이에 상주하고, 창을 닫아도 계속 받는다 (트레이 메뉴 '끝내기' 로 종료).
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Syncer, parseExts } = require('./core/sync');

const APP_ID = 'com.broad.filesync';
const ASSETS = path.join(__dirname, '..', 'assets');

// 시험용: 설정·기록을 둘 폴더를 바꿀 수 있다 (실제 사용 땐 쓰지 않음)
if (process.env.BROAD_FILESYNC_DATA) app.setPath('userData', process.env.BROAD_FILESYNC_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId(APP_ID); // 윈도우 알림에 앱 이름이 나오게

// ---- 설정 ----
const DEFAULTS = {
  source: '',                                              // NAS 폴더 (예: \\NAS\출력\실사출력)
  dest: path.join(os.homedir(), 'Desktop', '출력받음'),     // 받을 폴더
  intervalSec: 5,                                          // 몇 초마다 확인
  sound: true,                                             // 받으면 소리
  repeatSound: false,                                      // 확인할 때까지 소리 반복
  autoStart: true,                                         // 윈도우 켤 때 자동 실행
  skipExisting: true,                                      // 처음 켤 때 이미 있던 파일은 받지 않기
  remindMin: 30,                                           // 출력 전인 채 이만큼(분) 지나면 다시 알림 (0 이면 끔)
  moveDoneOnNas: false,                                    // 출력 완료하면 NAS 원본을 '_출력완료' 폴더로 (디자이너가 NAS 에서 보게)
  skipExt: '',                                             // 받지 않을 확장자 (예: psd, zip)
};
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function saveConfig(c) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2));
}

let config, win, tray, syncer = null, timer = null, busy = false, paused = false;
let status = { state: 'setup', message: 'NAS 폴더를 정하세요.' };

// ---- 상태 알리기 (창·트레이) ----
function snapshot() {
  return {
    config, status, paused,
    history: syncer ? syncer.history.slice(0, 500) : [],
    unseen: syncer ? syncer.unseen : 0,
    pending: syncer ? syncer.pending : 0,
  };
}
function icon(name) { return nativeImage.createFromPath(path.join(ASSETS, name + '.png')); }
function updateTray() {
  if (!tray) return;
  const unseen = syncer ? syncer.unseen : 0, pending = syncer ? syncer.pending : 0;
  const off = paused || status.state !== 'ok';
  tray.setImage(icon(off ? 'tray-off' : unseen ? 'tray-new' : 'tray'));
  const line = paused ? '잠시 멈춤' : status.state === 'ok' ? (pending ? `출력 전 ${pending}개` : '받는 중 (출력 전 파일 없음)')
    : status.state === 'offline' ? 'NAS 연결 끊김' : status.message;
  tray.setToolTip('브로애드 파일 받기 - ' + line);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '목록 열기', click: showWindow },
    { label: '받은 폴더 열기', click: () => shell.openPath(config.dest) },
    { label: '지금 확인', click: checkNow, enabled: !paused },
    { label: '알림 끄기 (새 파일 표시 지우기)', click: () => markSeen('all'), enabled: unseen > 0 },
    { type: 'separator' },
    { label: paused ? '다시 받기' : '잠시 멈춤', click: togglePause },
    { label: '끝내기', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}
function send() {
  if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
  updateTray();
}

// ---- 받기 ----
async function startSync() {
  clearTimeout(timer);
  syncer = null;
  if (!config.source) {
    status = { state: 'setup', message: 'NAS 폴더를 정하세요.' };
    send();
    return;
  }
  syncer = await new Syncer({
    source: config.source,
    dest: config.dest,
    statePath: path.join(app.getPath('userData'), 'state.json'),
    skipExisting: config.skipExisting,
    skipExt: config.skipExt,
  }).load();
  loop();
}

async function loop() {
  clearTimeout(timer);
  if (!syncer || paused || busy) return;
  busy = true;
  try {
    const r = await syncer.tick();
    if (r.status === 'offline') {
      status = { state: 'offline', message: r.message, since: status.state === 'offline' ? status.since : Date.now() };
    } else {
      status = { state: 'ok', lastCheck: Date.now(), baseline: r.baseline, errors: r.errors };
    }
    if (r.received.length) notify(r.received);
  } catch (e) {
    status = { state: 'error', message: e.message };
  }
  busy = false;
  send();
  timer = setTimeout(loop, Math.max(2, Number(config.intervalSec) || 5) * 1000);
}

function checkNow() { if (!busy) loop(); }
function togglePause() {
  paused = !paused;
  if (paused) clearTimeout(timer); else loop();
  send();
}
async function markSeen(id) {
  if (syncer && await syncer.markSeen(id)) send();
}

// 출력 전인 채 오래된 파일이 있으면 다시 알린다 (remindMin 마다 한 번)
let lastRemind = 0;
// 시험용: BROAD_FILESYNC_REMIND_MS 로 '분' 대신 짧은 시간을 쓴다
const REMIND_TEST_MS = Number(process.env.BROAD_FILESYNC_REMIND_MS) || 0;
function remind() {
  const min = Number(config && config.remindMin) || 0;
  if (!syncer || paused || min <= 0) return;
  const now = Date.now(), wait = REMIND_TEST_MS || min * 60e3;
  if (now - lastRemind < wait) return;
  const stale = syncer.stale(wait);
  if (!stale.length) return;
  lastRemind = now;
  const lines = stale.slice(0, 3).map(e => (e.folder ? e.folder + ' / ' : '') + e.name);
  if (stale.length > 3) lines.push(`외 ${stale.length - 3}개`);
  if (Notification.isSupported()) {
    const n = new Notification({ title: `출력 안 한 파일 ${stale.length}개 (${min}분 넘음)`, body: lines.join('\n'), icon: path.join(ASSETS, 'app.png'), silent: true });
    n.on('click', showWindow);
    n.show();
  }
  if (config.sound && win && !win.isDestroyed()) win.webContents.send('chime', { repeat: false, urgent: stale.some(e => e.urgent) });
}

function notify(list) {
  const urgent = list.filter(e => e.urgent).length;
  list = list.slice().sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0)); // 급한 것을 먼저
  const title = (urgent ? `[급] ` : '') + (list.length === 1 ? '새 출력 파일이 왔습니다' : `새 출력 파일 ${list.length}개가 왔습니다`) +
    (urgent && list.length > 1 ? ` (급 ${urgent}개)` : '');
  const lines = list.slice(0, 3).map(e => (e.urgent ? '[급] ' : '') + (e.kind === 'updated' ? '[수정] ' : '') + (e.folder ? e.folder + ' / ' : '') + e.name);
  if (list.length > 3) lines.push(`외 ${list.length - 3}개`);
  if (Notification.isSupported()) {
    // 소리는 창에서 따로 낸다 (반복 기능 때문에). 소리를 껐을 때도 알림은 조용히
    const n = new Notification({ title, body: lines.join('\n'), icon: path.join(ASSETS, 'app.png'), silent: true });
    n.on('click', showWindow);
    n.show();
  }
  // 급한 파일은 '확인할 때까지 반복' 을 꺼 두었어도 반복한다
  if (config.sound && win && !win.isDestroyed()) win.webContents.send('chime', { repeat: config.repeatSound || urgent > 0, urgent: urgent > 0 });
}

// ---- 창 ----
function createWindow(show) {
  win = new BrowserWindow({
    width: 760, height: 620, minWidth: 520, minHeight: 400, show,
    title: '브로애드 파일 받기', icon: path.join(ASSETS, 'app.png'), autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,               // 창을 숨겨도 알림 소리가 나게
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // 닫기 = 트레이로 숨기기 (계속 받는다)
  win.on('close', e => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}
function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  win.show();
  win.focus();
}

// 윈도우는 시작 메뉴 바로가기(앱 ID 포함)가 있어야 알림 창을 띄워 준다. 시작 메뉴에서 찾기도 쉬워진다
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', '브로애드 파일 받기.lnk');
  try {
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
      target: process.execPath, appUserModelId: APP_ID, description: 'NAS 에 올린 출력 파일을 받아 알려 줍니다',
    });
  } catch { /* 바로가기를 못 만들어도 받기·소리는 된다 */ }
}

function applyAutoStart() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ openAtLogin: !!config.autoStart, args: ['--hidden'] });
}

// ---- 창에서 부르는 기능 ----
const entry = id => (syncer ? syncer.history.find(h => h.id === id) : null);
ipcMain.handle('get-state', () => snapshot());
ipcMain.handle('save-config', async (_e, patch) => {
  const before = config;
  config = { ...config, ...patch };
  config.intervalSec = Math.min(600, Math.max(2, Number(config.intervalSec) || 5));
  config.remindMin = Math.min(1440, Math.max(0, Math.round(Number(config.remindMin) || 0)));
  config.skipExt = [...parseExts(config.skipExt)].join(', ');
  if (syncer) syncer.skipExt = parseExts(config.skipExt);
  saveConfig(config);
  applyAutoStart();
  if (before.source !== config.source || before.dest !== config.dest || before.skipExisting !== config.skipExisting) await startSync();
  else send();
  return snapshot();
});
ipcMain.handle('choose-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: current || undefined });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('test-source', async (_e, dir) => {
  try {
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory()) return { ok: false, message: '폴더가 아닙니다.' };
    const items = await fs.promises.readdir(dir);
    return { ok: true, message: `연결됨 (안에 ${items.length}개)` };
  } catch (e) {
    return { ok: false, message: '열 수 없습니다: ' + (e.code || e.message) };
  }
});
ipcMain.handle('open-file', async (_e, id) => {
  const h = entry(id);
  if (!h) return '목록에 없는 파일입니다.';
  await syncer.markOpened(id);
  send();
  const err = await shell.openPath(h.localPath);
  return err || '';
});
ipcMain.handle('show-in-folder', async (_e, id) => {
  const h = entry(id);
  if (!h) return;
  await markSeen(id);
  if (fs.existsSync(h.localPath)) shell.showItemInFolder(h.localPath);
  else shell.openPath(path.dirname(h.localPath));
});
ipcMain.handle('open-dest', () => shell.openPath(config.dest));
ipcMain.handle('mark-seen', (_e, id) => markSeen(id));
ipcMain.handle('mark-done', async (_e, id, done) => {
  if (!syncer) return '';
  const opt = { moveOnNas: !!config.moveDoneOnNas }, warnings = [];
  const ids = id === 'all' ? syncer.history.filter(h => !h.done && !h.replaced).map(h => h.id) : [id];
  for (const x of ids) {
    const r = await syncer.markDone(x, id === 'all' ? true : done, opt);
    if (r.warning) warnings.push(r.warning);
  }
  send();
  return warnings.length ? warnings[0] + (warnings.length > 1 ? ` 외 ${warnings.length - 1}건` : '') : '';
});
ipcMain.handle('check-now', () => checkNow());
ipcMain.handle('toggle-pause', () => togglePause());
ipcMain.handle('import-all', async () => {
  if (!syncer) return;
  await syncer.importAll();
  checkNow();
});
ipcMain.handle('clear-history', async () => {
  if (syncer) { await syncer.clearHistory(); send(); }
});

// ---- 시작 ----
app.on('second-instance', showWindow); // 이미 켜져 있으면 창만 띄운다
app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => { app.isQuitting = true; });

app.whenReady().then(async () => {
  config = loadConfig();
  ensureStartMenuShortcut();
  applyAutoStart();
  tray = new Tray(icon('tray-off'));
  tray.on('click', showWindow);
  const hidden = process.argv.includes('--hidden') && !!config.source;
  createWindow(!hidden);
  await startSync();
  setInterval(remind, REMIND_TEST_MS ? 500 : 60e3);
});
