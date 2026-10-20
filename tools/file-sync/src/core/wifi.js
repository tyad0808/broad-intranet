// 와이파이 다시 연결 (윈도우 netsh). 어떤 노트북은 NAS 파일 공유(445)가 멈췄다가 와이파이를 다시 잡아야 풀린다.
// 관리자 권한 없이 된다: netsh wlan disconnect → netsh wlan connect name=<프로필>
const { execFile } = require('node:child_process');

function run(args) {
  return new Promise(resolve => {
    execFile('netsh', args, { windowsHide: true, timeout: 15000, encoding: 'buffer' }, (err, out) => {
      // 한글 윈도우의 netsh 는 CP949 로 쓴다. 우리가 읽는 'SSID'·'프로필' 이름은 대부분 영문이라 latin1 로도 충분
      resolve({ ok: !err, text: out ? out.toString('latin1') : '' });
    });
  });
}

// 'netsh wlan show interfaces' 결과에서 지금 연결된 와이파이 이름 (BSSID 줄은 빼고)
function currentSsid(text) {
  const m = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(text);
  return m ? m[1] : '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 결과: { ok, name, message }
async function reconnect(name) {
  if (process.platform !== 'win32') return { ok: false, name, message: '윈도우가 아님' };
  if (!name) name = currentSsid((await run(['wlan', 'show', 'interfaces'])).text);
  if (!name) return { ok: false, name, message: '연결된 와이파이를 찾지 못함 (설정에 와이파이 이름을 적으세요)' };
  await run(['wlan', 'disconnect']);
  await sleep(3000);
  const r = await run(['wlan', 'connect', 'name=' + name]);
  return { ok: r.ok, name, message: r.ok ? '다시 연결함' : '다시 연결하지 못함' };
}

module.exports = { reconnect, currentSsid };
