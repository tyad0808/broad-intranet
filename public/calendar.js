// 주문 목록 옆 회사 일정 달력
//  - ‹ › 로 달 넘기기 (달력 칸만 새로 받아 바꿔 끼움)
//  - 날짜 빈 곳을 누르면 그날 일정 추가, 일정을 누르면 자세히 보기
(() => {
  const panel = document.getElementById('calendar-panel');
  if (!panel) return;
  const viewDialog = document.getElementById('ev-view');
  const formDialog = document.getElementById('ev-form');
  const form = formDialog.querySelector('form');
  const md = s => `${Number(s.slice(5, 7))}월 ${Number(s.slice(8))}일`;
  const weekday = s => '일월화수목금토'[new Date(`${s}T00:00:00Z`).getUTCDay()];

  async function load(month) {
    try {
      const res = await fetch(`/calendar?month=${encodeURIComponent(month)}`, { credentials: 'same-origin' });
      if (!res.ok || res.redirected) return;
      panel.innerHTML = await res.text();
    } catch {
      // 네트워크가 잠깐 끊긴 경우: 그대로 둔다
    }
  }
  // 다른 직원이 일정을 바꾸면 live.js 가 부른다
  window.reloadCalendar = () => {
    const cal = panel.querySelector('.cal');
    if (cal) load(cal.dataset.month);
  };

  function openForm(values = {}) {
    form.reset();
    form.action = values.id ? `/calendar/events/${values.id}` : '/calendar/events';
    formDialog.querySelector('[data-ev-form-title]').textContent = values.id ? '일정 수정' : '일정 추가';
    form.elements.title.value = values.title || '';
    form.elements.start_date.value = values.start || '';
    form.elements.end_date.value = values.end || '';
    form.elements.time.value = values.time || '';
    form.elements.memo.value = values.memo || '';
    form.elements.color.value = values.color || 'blue';
    formDialog.showModal();
    form.elements.title.focus();
  }

  function openView(ev) {
    const when = ev.end ? `${md(ev.start)}(${weekday(ev.start)}) ~ ${md(ev.end)}(${weekday(ev.end)})` : `${md(ev.start)}(${weekday(ev.start)})`;
    viewDialog.querySelector('.ev-view-when').textContent = `${when} · ${ev.time || '종일'}`;
    viewDialog.querySelector('.ev-view-title').textContent = ev.title;
    viewDialog.querySelector('.ev-view-memo').textContent = ev.memo || '';
    viewDialog.querySelector('.ev-view-by').textContent = ev.creator ? `등록: ${ev.creator}` : '';
    const edit = viewDialog.querySelector('[data-ev-edit]');
    const del = viewDialog.querySelector('[data-ev-delete]');
    edit.hidden = del.hidden = !ev.canEdit;
    edit.onclick = () => { viewDialog.close(); openForm(ev); };
    del.action = `/calendar/events/${ev.id}/delete`;
    viewDialog.showModal();
  }

  panel.addEventListener('click', event => {
    const nav = event.target.closest('[data-cal-month]');
    if (nav) return load(nav.dataset.calMonth);
    const add = event.target.closest('[data-cal-add]');
    if (add) return openForm({ start: add.dataset.calAdd });
    const item = event.target.closest('[data-event]');
    if (item) return openView(JSON.parse(item.dataset.event));
    const day = event.target.closest('.cal-day');
    if (day) openForm({ start: day.dataset.date });
  });

  for (const dialog of [viewDialog, formDialog]) {
    dialog.addEventListener('click', event => {
      // 창 바깥(어두운 곳)이나 닫기 버튼을 누르면 닫는다
      if (event.target === dialog || event.target.closest('[data-ev-close]')) dialog.close();
    });
  }
})();
