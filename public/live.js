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

  // ───────── 윈도우 알림 (다른 창을 보고 있어도 화면 오른쪽 아래에) ─────────
  // 아직 안 켰으면 '알림 켜기', 막혀 있으면 푸는 방법을 왼쪽 메뉴 아래에 보여준다
  const card = document.getElementById('notify-card');
  function syncNotifyCard() {
    if (!card || !('Notification' in window)) return;
    const p = Notification.permission;
    card.hidden = p === 'granted';
    card.querySelector('[data-notify-ask]').hidden = p !== 'default';
    card.querySelector('[data-notify-denied]').hidden = p !== 'denied';
    card.querySelector('#enable-notify').hidden = p !== 'default';
  }
  if (card && 'Notification' in window) {
    syncNotifyCard();
    card.querySelector('#enable-notify').addEventListener('click', async () => {
      wakeAudio();
      await Notification.requestPermission();
      syncNotifyCard();
      if (Notification.permission === 'granted') new Notification('알림이 켜졌어요', { body: '새 주문·문의가 오면 이렇게 알려 드려요.' });
    });
  }

  function systemNotify({ type, title, body, url }) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    // 이 창을 보고 있으면 화면 안 알림으로 충분. 다른 창(다른 프로그램·다른 탭)을 보고 있을 때만 윈도우 알림
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    const icon = document.querySelector('link[rel="icon"]');
    // 인트라넷 탭을 여러 개 열어 두어도 같은 소식은 한 번만 (같은 tag 는 하나로 합쳐진다)
    const n = new Notification(title, { body, tag: `${type}:${title}:${body}`.slice(0, 200), icon: icon ? icon.href : undefined });
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
        // 일괄 처리용으로 체크해 둔 주문은 새로 그린 뒤에도 체크된 채로 둔다
        const checked = new Set([...liveList.querySelectorAll('input[name="ids"]:checked')].map(box => box.value));
        // 탭 건수와 주문 목록만 바꾼다 (검색창은 건드리지 않아 입력 중인 글자가 지워지지 않음)
        for (const id of ['live-tabs', 'live-list']) {
          const fresh = doc.getElementById(id);
          const current = document.getElementById(id);
          if (fresh && current) current.innerHTML = fresh.innerHTML;
        }
        liveList.querySelectorAll('input[name="ids"]').forEach(box => { box.checked = checked.has(box.value); });
        // 주문 목록 옆 달력도 같이: 납기를 바꾸면 '출고 N건' 이 바로 맞춰지게
        if (feed === 'orders' && typeof window.reloadCalendar === 'function') window.reloadCalendar();
        if (typeof window.syncBulkBar === 'function') window.syncBulkBar();
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

  // 위쪽 메뉴의 문의함 미답변 건수를 새로 고친다 (어느 화면에서든)
  let navTimer = null;
  function refreshNavBadge() {
    const nav = document.getElementById('main-nav');
    if (!nav) return;
    clearTimeout(navTimer);
    navTimer = setTimeout(async () => {
      try {
        const res = await fetch('/inbox?tab=open&src=_none_', { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
        if (!res.ok || res.redirected) return;
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        // 문의함·메일함 두 칸의 미답변 숫자
        for (const href of ['/inbox', '/inbox?box=mail']) {
          const fresh = doc.querySelector(`#main-nav a[href="${href}"]`);
          const link = nav.querySelector(`a[href="${href}"]`);
          if (fresh && link) link.innerHTML = fresh.innerHTML;
        }
      } catch {
        // 다음 소식 때 다시
      }
    }, 600);
  }

  // 주문 팝업을 닫을 때 modal.js 가 부른다
  if (liveList) window.refreshOrderList = refreshList;

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

  source.addEventListener('calendar-changed', e => {
    const { actorId } = JSON.parse(e.data);
    if (actorId !== me && typeof window.reloadCalendar === 'function') window.reloadCalendar();
  });

  // 문의함 화면이면 문의함 소식에, 주문 목록이면 주문 소식에 새로 그린다
  const feed = liveList ? liveList.dataset.feed || 'orders' : null;

  source.addEventListener('inbox-changed', () => {
    if (feed === 'inbox') refreshList();
    refreshNavBadge();
  });

  source.addEventListener('orders-changed', e => {
    const { ids, actorId } = JSON.parse(e.data);
    if (feed === 'orders') refreshList();
    if (orderCard && actorId !== me && (ids.length === 0 || ids.includes(Number(orderCard.dataset.orderId)))) {
      showStaleBanner();
    }
  });
})();
