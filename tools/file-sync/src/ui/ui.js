// 목록 화면: 받은 파일 목록, 상태, 설정, 알림 소리
(function () {
  const $ = id => document.getElementById(id);
  let state = null, tab = 'pending', repeatTimer = null;

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
  // 크기 정보 한 줄 (core/fileinfo.js 의 formatInfo 와 같게)
  function fmtInfo(info) {
    if (!info) return '';
    const mm = (w, h) => `${Math.round(w)}×${Math.round(h)}mm`;
    if (info.kind === 'vector') {
      return mm(info.widthMm, info.heightMm) + (info.pages > 1 ? ` · ${info.pages}쪽` + (info.mixed ? ' (크기 다름)' : '') : '');
    }
    return `${info.px[0]}×${info.px[1]}px` + (info.dpi ? ` · ${info.dpi}dpi · ${mm(info.widthMm, info.heightMm)}` : '');
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

  const isPending = h => !h.done && !h.replaced;

  function renderList() {
    const q = $('search').value.trim().toLowerCase();
    const inTab = h => tab === 'all' || (tab === 'pending' ? isPending(h) : h.done);
    const list = state.history.filter(h => inTab(h) && (!q || (h.folder + '/' + h.name).toLowerCase().includes(q)));
    // 출력 전인 급한 파일을 맨 위로 (나머지는 받은 순서 그대로)
    list.sort((a, b) => (isPending(b) && b.urgent ? 1 : 0) - (isPending(a) && a.urgent ? 1 : 0));
    const tbody = $('rows');
    tbody.textContent = '';
    for (const h of list) {
      const tr = el('tr', [h.seen ? '' : 'unseen', h.done ? 'done' : '', h.replaced && !h.done ? 'replaced' : '', h.urgent && isPending(h) ? 'urgent' : ''].join(' ').trim());
      // 출력 완료 체크
      const doneTd = el('td', 'c-done');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!h.done;
      box.title = h.done ? '출력 완료 (누르면 풀기)' : '출력 프로그램에서 열었으면 체크';
      box.onclick = async e => {
        e.stopPropagation();
        const warning = await window.api.markDone(h.id, box.checked);
        if (warning) toast(warning);
      };
      doneTd.appendChild(box);
      // 이름 + 표시
      const name = el('td');
      name.appendChild(el('div', 'name', h.name));
      const tags = el('div', 'tags');
      if (h.urgent) tags.appendChild(el('span', 'tag urgent', '급'));
      if (!h.seen) tags.appendChild(el('span', 'tag', '새'));
      if (h.kind === 'updated') tags.appendChild(el('span', 'tag updated', '수정본'));
      if (h.done) tags.appendChild(el('span', 'tag done', '출력 완료 ' + fmtTime(h.doneAt)));
      else if (h.replaced) tags.appendChild(el('span', 'tag replaced', '새 버전으로 바뀜'));
      if (h.openedAt) tags.appendChild(el('span', '', '열어봄 ' + fmtTime(h.openedAt)));
      if (h.nasDone) tags.appendChild(el('span', '', 'NAS: _출력완료'));
      if (h.folder) tags.appendChild(el('span', 'folder', h.folder));
      name.appendChild(tags);
      const act = el('td', 'c-act');
      const open = el('button', '', '열기');
      open.onclick = async e => { e.stopPropagation(); const err = await window.api.openFile(h.id); if (err) toast('열 수 없습니다: ' + err); };
      const folder = el('button', '', '폴더');
      folder.onclick = e => { e.stopPropagation(); window.api.showInFolder(h.id); };
      act.append(open, folder);
      const sizeTd = el('td', 'c-size');
      if (h.info) sizeTd.appendChild(el('div', 'spec', fmtInfo(h.info)));
      sizeTd.appendChild(el('div', 'bytes', fmtSize(h.size)));
      tr.append(doneTd, name, sizeTd, el('td', 'c-time', fmtTime(h.receivedAt)), act);
      tr.title = h.localPath;
      tr.onclick = () => { if (!h.seen) window.api.markSeen(h.id); };
      tr.ondblclick = () => open.onclick(new Event('click'));
      tbody.appendChild(tr);
    }
    $('pendingCount').textContent = state.pending;
    $('pendingCount').classList.toggle('zero', state.pending === 0);
    $('doneAll').disabled = state.pending === 0;
    const empty = $('empty');
    empty.hidden = list.length > 0;
    empty.textContent = q ? '찾는 파일이 없습니다.'
      : tab === 'pending' ? '출력할 파일이 없습니다. NAS 에 올리면 여기에 나옵니다.'
      : tab === 'done' ? '출력 완료로 체크한 파일이 없습니다.' : '받은 파일이 없습니다.';
    document.title = (state.pending ? `(${state.pending}) ` : '') + '브로애드 파일 받기';
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
    document.body.dataset.chimes = Number(document.body.dataset.chimes || 0) + 1; // 몇 번 울렸는지 (점검용)
    chime();
    if (o.repeat && !repeatTimer) repeatTimer = setInterval(() => { if (state && state.unseen > 0) chime(); else stopRepeat(); }, 6000);
  });

  // ---- 설정 ----
  const FIELDS = ['source', 'dest', 'intervalSec', 'remindMin'], CHECKS = ['sound', 'repeatSound', 'autoStart', 'skipExisting', 'moveDoneOnNas'];
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
  $('doneAll').onclick = () => {
    if (confirm(`출력 전인 ${state.pending}개를 모두 출력 완료로 체크할까요?`)) {
      window.api.markDone('all', true).then(w => { if (w) toast(w); });
    }
  };
  document.querySelectorAll('[data-tab]').forEach(b => {
    b.onclick = () => {
      tab = b.getAttribute('data-tab');
      document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
      renderList();
    };
  });
  $('search').oninput = renderList;
  setInterval(() => { if (state) renderList(); }, 60000); // '오늘/어제' 표시 새로

  window.api.onState(render);
  window.api.getState().then(render);
})();
