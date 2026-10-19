// 목록 화면: 받은 파일 목록, 상태, 설정, 알림 소리
(function () {
  const $ = id => document.getElementById(id);
  let state = null, tab = 'new', repeatTimer = null;

  // ---- 표시용 ----
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 ** 3).toFixed(2) + ' GB';
  }
  function fmtTime(t) {
    const d = new Date(t), now = new Date(), pad = x => String(x).padStart(2, '0');
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '오늘 ' + hm;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '어제 ' + hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  // ---- 그리기 ----
  function renderStatus() {
    const s = state.status, st = $('status');
    let cls = s.state, text;
    if (state.paused) { cls = 'paused'; text = '잠시 멈춤'; }
    else if (s.state === 'ok') text = '받는 중';
    else if (s.state === 'offline') text = 'NAS 연결 끊김';
    else if (s.state === 'setup') text = '설정 필요';
    else text = '오류';
    st.className = 'pill ' + cls;
    st.textContent = text;
    st.title = s.message || '';
    $('pause').textContent = state.paused ? '다시 받기' : '잠시 멈춤';
    const c = state.config;
    $('paths').textContent = c.source ? `${c.source}  →  ${c.dest}` : 'NAS 폴더를 아직 정하지 않았습니다. [설정] 에서 정하세요.';
    if (s.state === 'offline') $('paths').textContent += `  (연결 안 됨: ${s.message})`;
    if (s.errors && s.errors.length) $('paths').textContent += `  · 받지 못한 파일 ${s.errors.length}개 (다음 확인 때 다시 시도)`;
  }

  function renderList() {
    const q = $('search').value.trim().toLowerCase();
    const list = state.history.filter(h => (tab === 'all' || !h.seen) && (!q || (h.folder + '/' + h.name).toLowerCase().includes(q)));
    const tbody = $('rows');
    tbody.textContent = '';
    for (const h of list) {
      const tr = el('tr', h.seen ? '' : 'unseen');
      const kind = el('td', 'c-kind');
      kind.appendChild(el('span', 'kind ' + (h.seen ? 'seen' : h.kind), h.kind === 'updated' ? '수정' : h.seen ? '확인' : '새'));
      const name = el('td');
      name.appendChild(el('div', 'name', h.name));
      if (h.folder) name.appendChild(el('div', 'folder', h.folder));
      const act = el('td', 'c-act');
      const open = el('button', '', '열기');
      open.onclick = async e => { e.stopPropagation(); const err = await window.api.openFile(h.id); if (err) toast('열 수 없습니다: ' + err); };
      const folder = el('button', '', '폴더');
      folder.onclick = e => { e.stopPropagation(); window.api.showInFolder(h.id); };
      act.append(open, folder);
      tr.append(kind, name, el('td', 'c-size', fmtSize(h.size)), el('td', 'c-time', fmtTime(h.receivedAt)), act);
      tr.title = h.localPath;
      tr.onclick = () => { if (!h.seen) window.api.markSeen(h.id); };
      tr.ondblclick = () => open.onclick(new Event('click'));
      tbody.appendChild(tr);
    }
    $('newCount').textContent = state.unseen;
    $('newCount').classList.toggle('zero', state.unseen === 0);
    $('seenAll').disabled = state.unseen === 0;
    const empty = $('empty');
    empty.hidden = list.length > 0;
    empty.textContent = q ? '찾는 파일이 없습니다.' : tab === 'new' ? '새 파일이 없습니다. NAS 에 올리면 여기에 나옵니다.' : '받은 파일이 없습니다.';
    document.title = (state.unseen ? `(${state.unseen}) ` : '') + '브로애드 파일 받기';
    if (state.unseen === 0) stopRepeat();
  }

  function render(s) {
    state = s;
    renderStatus();
    renderList();
    if (s.status.state === 'setup' && $('settings').hidden && !render.askedOnce) { render.askedOnce = true; openSettings(); }
  }

  // ---- 알림 소리 (딩동) ----
  let audio = null;
  function chime() {
    try {
      audio = audio || new AudioContext();
      const t0 = audio.currentTime;
      [[880, 0], [1318.5, 0.18], [1760, 0.36]].forEach(([f, dt]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.5);
        o.connect(g).connect(audio.destination);
        o.start(t0 + dt);
        o.stop(t0 + dt + 0.55);
      });
    } catch (e) { /* 소리 장치 없음 */ }
  }
  function stopRepeat() { clearInterval(repeatTimer); repeatTimer = null; }
  window.api.onChime(o => {
    chime();
    if (o.repeat && !repeatTimer) repeatTimer = setInterval(() => { if (state && state.unseen > 0) chime(); else stopRepeat(); }, 6000);
  });

  // ---- 설정 ----
  const FIELDS = ['source', 'dest', 'intervalSec'], CHECKS = ['sound', 'repeatSound', 'autoStart', 'skipExisting'];
  function openSettings() {
    const c = state.config;
    FIELDS.forEach(k => { $(k).value = c[k]; });
    CHECKS.forEach(k => { $(k).checked = !!c[k]; });
    $('testResult').textContent = '';
    $('settings').hidden = false;
  }
  async function testSource() {
    const r = await window.api.testSource($('source').value.trim());
    $('testResult').textContent = r.message;
    $('testResult').className = 'note ' + (r.ok ? 'ok' : 'bad');
    return r.ok;
  }
  $('settingsBtn').onclick = openSettings;
  $('cancelSettings').onclick = () => { $('settings').hidden = true; };
  $('pickSource').onclick = async () => { const p = await window.api.chooseFolder($('source').value); if (p) { $('source').value = p; testSource(); } };
  $('pickDest').onclick = async () => { const p = await window.api.chooseFolder($('dest').value); if (p) $('dest').value = p; };
  $('testSource').onclick = testSource;
  $('testSound').onclick = chime;
  $('saveSettings').onclick = async () => {
    const patch = {};
    FIELDS.forEach(k => { patch[k] = $(k).value.trim(); });
    CHECKS.forEach(k => { patch[k] = $(k).checked; });
    if (!patch.source) { $('testResult').textContent = 'NAS 폴더를 넣으세요.'; $('testResult').className = 'note bad'; return; }
    if (!patch.dest) { toast('받을 폴더를 넣으세요.'); return; }
    if (patch.source.replace(/[\\/]+$/, '').toLowerCase() === patch.dest.replace(/[\\/]+$/, '').toLowerCase()) { toast('NAS 폴더와 받을 폴더가 같으면 안 됩니다.'); return; }
    render(await window.api.saveConfig(patch));
    $('settings').hidden = true;
    toast('저장했습니다.');
  };
  $('importAll').onclick = async () => {
    if (!confirm('지금 NAS 폴더에 있는 파일을 모두 받습니다. (이미 받은 것도 다시 받습니다) 할까요?')) return;
    await window.api.importAll();
    $('settings').hidden = true;
    toast('모두 받는 중입니다.');
  };
  $('clearHistory').onclick = async () => {
    if (!confirm('목록을 비웁니다. 받은 파일은 지워지지 않습니다. 할까요?')) return;
    await window.api.clearHistory();
  };

  // ---- 위쪽 버튼·탭 ----
  $('checkNow').onclick = () => { window.api.checkNow(); toast('확인 중…'); };
  $('pause').onclick = () => window.api.togglePause();
  $('openDest').onclick = () => window.api.openDest();
  $('seenAll').onclick = () => window.api.markSeen('all');
  $('tabNew').onclick = () => { tab = 'new'; $('tabNew').classList.add('on'); $('tabAll').classList.remove('on'); renderList(); };
  $('tabAll').onclick = () => { tab = 'all'; $('tabAll').classList.add('on'); $('tabNew').classList.remove('on'); renderList(); };
  $('search').oninput = renderList;
  setInterval(() => { if (state) renderList(); }, 60000); // '오늘/어제' 표시 새로

  window.api.onState(render);
  window.api.getState().then(render);
})();
