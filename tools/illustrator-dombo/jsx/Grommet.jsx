// 단독 실행용: 선택한 객체에 아일렛(타공) 자리를 표시한다. dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  var d = domboGrommetDefaults();
  var w = new Window('dialog', '아일렛 마킹 (외곽선 기준)');
  w.alignChildren = 'fill';
  function numRow(parent, label, value, unit) {
    var g = parent.add('group');
    g.add('statictext', undefined, label).preferredSize.width = 120;
    var e = g.add('edittext', undefined, String(value));
    e.characters = 5;
    g.add('statictext', undefined, unit);
    return e;
  }
  var pc = w.add('panel', undefined, '방향별 개수 (모서리 포함)');
  pc.alignChildren = 'left';
  var eT = numRow(pc, '상단', d.top, '개');
  var eB = numRow(pc, '하단', d.bottom, '개');
  var eL = numRow(pc, '좌측', d.left, '개');
  var eR = numRow(pc, '우측', d.right, '개');
  var po = w.add('panel', undefined, '타공 규격');
  po.alignChildren = 'left';
  var eM = numRow(po, '외곽 여백', d.marginMm, 'mm');
  var eD = numRow(po, '타공 크기', d.diameterMm, 'mm');
  var eS = numRow(po, '선 두께', d.strokePt, 'pt');
  var gBtn = w.add('group');
  gBtn.alignment = 'right';
  gBtn.add('button', undefined, '취소', { name: 'cancel' });
  gBtn.add('button', undefined, '확인', { name: 'ok' });
  if (w.show() !== 1) return;
  try {
    alert(domboGrommet({
      top: eT.text, bottom: eB.text, left: eL.text, right: eR.text,
      marginMm: eM.text, diameterMm: eD.text, strokePt: eS.text
    }));
  } catch (e) {
    alert(e.message);
  }
})();
