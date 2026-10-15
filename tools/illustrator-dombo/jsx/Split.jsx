// 단독 실행용: 선택한 것을 마스크 기준으로 N등분 (겹침 포함). dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  var d = domboSplitDefaults();
  var w = new Window('dialog', '마스크 기준 N등분 분할');
  w.alignChildren = 'fill';
  var pd = w.add('panel', undefined, '분할 방향');
  pd.orientation = 'row';
  var rH = pd.add('radiobutton', undefined, '가로 분할 (|||)');
  var rV = pd.add('radiobutton', undefined, '세로 분할 (≡)');
  rH.value = true;
  function numRow(parent, label, value, unit) {
    var g = parent.add('group');
    g.add('statictext', undefined, label).preferredSize.width = 120;
    var e = g.add('edittext', undefined, String(value));
    e.characters = 5;
    g.add('statictext', undefined, unit);
    return e;
  }
  var ps = w.add('panel', undefined, '상세 설정');
  ps.alignChildren = 'left';
  var eC = numRow(ps, '분할 개수', d.count, '개');
  var eO = numRow(ps, '겹침 (양쪽 합계)', d.overlapMm, 'mm');
  var eG = numRow(ps, '늘어놓는 간격', d.gapMm, 'mm');
  var gBtn = w.add('group');
  gBtn.alignment = 'center';
  gBtn.add('button', undefined, '취소', { name: 'cancel' });
  gBtn.add('button', undefined, '실행', { name: 'ok' });
  if (w.show() !== 1) return;
  try {
    alert(domboSplit({ direction: rV.value ? 'v' : 'h', count: eC.text, overlapMm: eO.text, gapMm: eG.text }));
  } catch (e) {
    alert(e.message);
  }
})();
