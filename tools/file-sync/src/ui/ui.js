// 목록 화면: 받은 파일 목록, 상태, 설정, 알림 소리
(function () {
  const $ = id => document.getElementById(id);
  let state = null, tab = 'pending', repeatTimer = null, looking = false, lookTimer = null, lookStart = 0, lastMove = 0, tickTimer = null;

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
    else if (s.state === 'ok') {
      // NAS 가 1분 넘게 대답이 없으면 (노트북 와이파이·파일 공유가 멈춘 경우) 멈췄다고 알린다
      const stuck = Math.round((Date.now() - (state.progress ? lastMove : lookStart)) / 1000);
      if ((state.progress || looking) && stuck >= 60) { cls = 'offline'; text = `NAS 응답 없음 (${stuck}초째)`; }
      else text = state.progress ? '받는 중' : looking ? `NAS 살펴보는 중… ${stuck}초` : '새 파일 기다리는 중';
    }
    else if (s.state === 'offline') text = 'NAS 연결 끊김';
    else if (s.state === 'setup') text = '설정 필요';
    else text = '오류';
    st.className = 'pill ' + cls;
    st.textContent = text;
    st.title = s.message || '';
    $('pause').textContent = state.paused ? '다시 받기' : '잠시 멈춤';
    const c = state.config;
    $('paths').textContent = c.source ? `${c.source}  →  ${c.dest}` : 'NAS 폴더를 아직 정하지 않았습니다. [설정] 에서 정하세요.';
    if (st.textContent.startsWith('NAS 응답 없음')) $('paths').textContent += '  · 와이파이를 껐다 켜 보세요';
    else if (s.state === 'offline') $('paths').textContent += `  (연결 안 됨: ${s.message})`;
    else if (s.lastCheck) $('paths').textContent += `  · 마지막 확인 ${new Date(s.lastCheck).toTimeString().slice(0, 8)}`;
    const rc = state.reconnects;
    if (rc && rc.count) $('paths').textContent += `  · 와이파이 자동 재연결 ${rc.count}번 (마지막 ${fmtTime(rc.last)})`;
    if (s.errors && s.errors.length) $('paths').textContent += `  · 받지 못한 파일 ${s.errors.length}개 (다음 확인 때 다시 시도)`;
  }

  const isPending = h => !h.done && !h.replaced;

  function renderList() {
    const q = $('search').value.trim().toLowerCase();
    const inTab = h => tab === 'all' || (tab === 'pending' ? isPending(h) : h.done);
    const list = state.history.filter(h => inTab(h) && (!q || (h.folder + '/' + h.name).toLowerCase().includes(q)));
    // 받은 시각 순서 (최신순·오래된순). '급한 것 위로' 를 켜면 출력 전인 급한 파일을 맨 위로
    const dir = state.config.sortOrder === 'old' ? 1 : -1, urgentFirst = state.config.urgentFirst !== false;
    const top = h => (urgentFirst && isPending(h) && h.urgent ? 1 : 0);
    list.sort((a, b) => (top(b) - top(a)) || dir * ((a.receivedAt - b.receivedAt) || (a.id - b.id)));
    $('sortOrder').value = dir === 1 ? 'old' : 'new';
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
      if (!h.seen) tags.appendChild(el('span', 'tag new', 'NEW'));
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
    $('seenAll').disabled = state.unseen === 0;
    $('seenAll').textContent = state.unseen ? `모두 확인 (${state.unseen})` : '모두 확인';
    const empty = $('empty');
    empty.hidden = list.length > 0;
    empty.textContent = q ? '찾는 파일이 없습니다.'
      : tab === 'pending' ? '출력할 파일이 없습니다. NAS 에 올리면 여기에 나옵니다.'
      : tab === 'done' ? '출력 완료로 체크한 파일이 없습니다.' : '받은 파일이 없습니다.';
    document.title = (state.pending ? `(${state.pending}) ` : '') + '브로애드 파일 받기';
    if (state.unseen === 0) stopRepeat();
  }

  // 받는 중: 몇 번째 / 몇 개, 받은 MB / 전체 MB, 속도, 남은 시간, 지금 받는 파일
  function fmtLeft(sec) {
    if (!isFinite(sec)) return '';
    if (sec < 60) return `약 ${Math.max(1, Math.round(sec))}초 남음`;
    if (sec < 3600) return `약 ${Math.round(sec / 60)}분 남음`;
    return `약 ${Math.floor(sec / 3600)}시간 ${Math.round(sec % 3600 / 60)}분 남음`;
  }
  function renderProgress(p, waiting) {
    const box = $('progress');
    if (!p && !waiting) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle('wait', !p);
    if (!p) {
      $('pMain').textContent = `NAS 에 올라가는 중인 파일 ${waiting}개`;
      $('pRate').textContent = '다 올라가면 바로 받습니다';
      $('pFile').textContent = ''; $('pFileSize').textContent = '';
      return;
    }
    const pct = p.batchTotal ? Math.min(100, Math.floor(p.batchDone / p.batchTotal * 100)) : 100;
    const sec = (Date.now() - p.startedAt) / 1000, speed = sec > 0.5 ? p.batchDone / sec : 0;
    $('pMain').textContent = `받는 중 ${p.index} / ${p.count}개 · ${fmtSize(p.batchDone)} / ${fmtSize(p.batchTotal)} (${pct}%)`;
    $('pRate').textContent = speed ? `${fmtSize(Math.round(speed))}/초 · ${fmtLeft((p.batchTotal - p.batchDone) / speed)}` : '';
    $('pBar').style.width = pct + '%';
    $('pFile').textContent = p.rel;
    $('pFileSize').textContent = `${fmtSize(p.fileDone)} / ${fmtSize(p.fileTotal)}`;
  }
  // NAS 를 살펴보는 데 1.5초 넘게 걸리면 '살펴보는 중' (파일이 많은 폴더는 오래 걸림)
  window.api.onChecking(on => {
    clearTimeout(lookTimer);
    clearInterval(tickTimer);
    if (on) {
      lookStart = lastMove = Date.now();
      lookTimer = setTimeout(() => { looking = true; if (state) renderStatus(); }, 1500);
      tickTimer = setInterval(() => { if (state && (looking || state.progress)) renderStatus(); }, 1000); // 초 세기
    } else if (looking) { looking = false; if (state) renderStatus(); }
  });
  window.api.onProgress(p => { lastMove = Date.now(); if (state) { state.progress = p; renderProgress(p, state.waiting); renderStatus(); } });

  function renderSkipped(sk) {
    $('skipped').hidden = !sk;
    if (sk) $('skippedText').textContent = `이 NAS 폴더를 처음 볼 때(${fmtTime(sk.at)}) 원래 있던 파일 ${sk.count}개는 받지 않았습니다. 그 뒤에 올린 파일만 받습니다.`;
  }
  $('skippedImport').onclick = async () => {
    if (!confirm(`원래 있던 파일 ${state.skipped.count}개를 지금 받을까요? (이미 받은 똑같은 파일은 건너뜁니다)`)) return;
    await window.api.importAll();
  };
  $('skippedClose').onclick = () => window.api.dismissSkipped();

  function render(s) {
    state = s;
    renderStatus();
    renderSkipped(s.skipped);
    renderProgress(s.progress, s.waiting);
    renderList();
    if (s.status.state === 'setup' && $('settings').hidden && !render.askedOnce) { render.askedOnce = true; openSettings(); }
  }

  // ---- 알림 소리: 기본(sounds/notify.wav), 급한 파일(sounds/urgent.wav) ----
  const SOUNDS = { normal: new Audio('sounds/notify.wav'), urgent: new Audio('sounds/urgent.wav') };
  Object.values(SOUNDS).forEach(a => { a.preload = 'auto'; });
  function play(kind) {
    const a = SOUNDS[kind] || SOUNDS.normal;
    a.currentTime = 0;
    a.play().catch(e => { document.body.dataset.soundError = e.name; chime(); }); // 파일을 못 틀면 기본 딩동
  }
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
  function stopRepeat() { clearInterval(repeatTimer); repeatTimer = null; repeatKind = 'normal'; }
  let repeatKind = 'normal';
  window.api.onChime(o => {
    const kind = o.urgent ? 'urgent' : 'normal';
    document.body.dataset.chimes = Number(document.body.dataset.chimes || 0) + 1; // 몇 번 울렸는지 (점검용)
    document.body.dataset.lastSound = kind;
    play(kind);
    if (o.repeat) {
      if (o.urgent) repeatKind = 'urgent'; // 급한 것이 섞이면 반복도 급한 소리로
      if (!repeatTimer) {
        repeatTimer = setInterval(() => {
          if (!state || state.unseen === 0) return stopRepeat();
          // 아직 안 본 급한 파일이 있을 때만 급한 소리
          play(repeatKind === 'urgent' && state.history.some(h => !h.seen && h.urgent) ? 'urgent' : 'normal');
        }, 6000);
      }
    }
  });

  // ---- 설정 ----
  const FIELDS = ['source', 'dest', 'intervalSec', 'remindMin', 'skipExt', 'wifiName'], CHECKS = ['sound', 'urgentFirst', 'repeatSound', 'autoStart', 'skipExisting', 'moveDoneOnNas', 'wifiReconnect'];
  function openSettings() {
    const c = state.config;
    FIELDS.forEach(k => { $(k).value = c[k] == null ? '' : c[k]; });
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
  $('testSound').onclick = () => play('normal');
  $('testUrgent').onclick = () => play('urgent');
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
    if (!confirm('지금 NAS 폴더에 있는 파일을 모두 받습니다. (이미 받은 똑같은 파일은 건너뜁니다) 할까요?')) return;
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
  $('seenAll').onclick = () => { stopRepeat(); window.api.markSeen('all'); };
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
  // 순서 설정은 저장해 두어 다음에 켜도 그대로
  $('sortOrder').onchange = async () => render(await window.api.saveConfig({ sortOrder: $('sortOrder').value }));
  setInterval(() => { if (state) renderList(); }, 60000); // '오늘/어제' 표시 새로

  window.api.onState(render);
  window.api.getState().then(render);
})();
