// 실시간 반영과 알림 (로그인한 직원의 모든 화면에서 실행)
(() => {
  const me = Number(document.body.dataset.userId);
  if (!me || !window.EventSource) return;

  // ───────── 소리 ─────────
  // 브라우저는 사용자가 화면을 한 번 누르기 전에는 소리를 막는다. 첫 클릭 때 소리 장치를 깨워 둔다.
  let audio = null;
  const wakeAudio = () => {
    if (!audio) {
      try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; }
    }
    if (audio && audio.state === 'suspended') audio.resume();
  };
  document.addEventListener('pointerdown', wakeAudio, { once: false });
  document.addEventListener('keydown', wakeAudio, { once: false });

  function beep() {
    if (!audio || audio.state !== 'running') return;
    // '딩-동' 두 음
    [[880, 0], [660, 0.18]].forEach(([freq, delay]) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      const t = audio.currentTime + delay;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }

  // ───────── 화면 알림 (오른쪽 위 토스트) ─────────
  const stack = document.createElement('div');
  stack.className = 'toast-stack';
  stack.setAttribute('aria-live', 'polite');
  document.body.appendChild(stack);

  function toast({ type, title, body, url }) {
    const el = document.createElement(url ? 'a' : 'div');
    el.className = `toast toast-${type}`;
    if (url) el.href = url;
    const strong = document.createElement('strong');
    strong.textContent = title;
    const p = document.createElement('div');
    p.textContent = body || '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', '닫기');
    close.textContent = '×';
    close.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); el.remove(); });
    el.append(close, strong, p);
    stack.prepend(el);
    // 미지정 초과는 직접 닫을 때까지, 나머지는 10초 뒤 사라진다
    if (type !== 'unassigned_over') setTimeout(() => el.remove(), 10_000);
  }

  // ───────── 브라우저 알림 (다른 창을 보고 있어도) ─────────
  const askButton = document.getElementById('enable-notify');
  if (askButton && 'Notification' in window && Notification.permission === 'default') {
    askButton.hidden = false;
    askButton.addEventListener('click', async () => {
      wakeAudio();
      await Notification.requestPermission();
      askButton.hidden = true;
    });
  }

  function systemNotify({ type, title, body, url }) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return; // 화면을 보고 있으면 토스트로 충분
    const n = new Notification(title, { body, tag: type });
    n.onclick = () => {
      window.focus();
      if (url) location.href = url;
      n.close();
    };
  }

  // ───────── 주문 목록 자동 새로고침 ─────────
  const liveList = document.getElementById('live-list');
  const orderCard = document.querySelector('[data-order-id]');
  let refreshTimer = null;

  function refreshList() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      // 직원이 담당자 상자를 고르는 중이면 끝날 때까지 기다린다
      if (liveList.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') {
        document.activeElement.addEventListener('blur', refreshList, { once: true });
        return;
      }
      try {
        const res = await fetch(location.href, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
        if (!res.ok || res.redirected) return;
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        // 탭 건수와 주문 목록만 바꾼다 (검색창은 건드리지 않아 입력 중인 글자가 지워지지 않음)
        for (const id of ['live-tabs', 'live-list']) {
          const fresh = doc.getElementById(id);
          const current = document.getElementById(id);
          if (fresh && current) current.innerHTML = fresh.innerHTML;
        }
        // 미지정 초과 배너: 새로 생기거나, 건수가 바뀌거나, 해소되어 사라지는 것을 반영
        const freshBar = doc.getElementById('unassigned-bar');
        const bar = document.getElementById('unassigned-bar');
        if (freshBar && bar) bar.innerHTML = freshBar.innerHTML;
        else if (freshBar) document.querySelector('main').before(freshBar);
        else if (bar) bar.remove();
      } catch {
        // 네트워크가 잠깐 끊긴 경우: 다음 소식 때 다시 시도
      }
    }, 400);
  }

  function showStaleBanner() {
    if (document.getElementById('stale-banner')) return;
    const banner = document.createElement('p');
    banner.id = 'stale-banner';
    banner.className = 'notice';
    banner.innerHTML = '다른 직원이 이 주문을 수정했습니다. <a href="">새로고침</a>해서 바뀐 내용을 확인하세요.';
    orderCard.prepend(banner);
  }

  // ───────── 서버와 연결 ─────────
  const source = new EventSource('/events');

  source.addEventListener('notify', e => {
    const data = JSON.parse(e.data);
    toast(data);
    beep();
    systemNotify(data);
  });

  source.addEventListener('orders-changed', e => {
    const { ids, actorId } = JSON.parse(e.data);
    if (liveList) refreshList();
    if (orderCard && actorId !== me && (ids.length === 0 || ids.includes(Number(orderCard.dataset.orderId)))) {
      showStaleBanner();
    }
  });
})();
