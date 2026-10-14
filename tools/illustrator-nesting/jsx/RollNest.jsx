// 단독 실행용: 용지 폭 네스팅. nest-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "nest-core.jsx"

(function () {
  var d = nestRollDefaults();
  var w = new Window('dialog', '용지 폭 네스팅');
  w.alignChildren = 'fill';
  function numRow(parent, label, value, unit) {
    var g = parent.add('group');
    g.add('statictext', undefined, label).preferredSize.width = 140;
    var e = g.add('edittext', undefined, String(value));
    e.characters = 6;
    g.add('statictext', undefined, unit);
    return e;
  }
  var p = w.add('panel', undefined, '용지');
  p.alignChildren = 'left';
  var eW = numRow(p, '용지 폭', d.widthMm, 'mm');
  var eL = numRow(p, '최대 길이', d.maxLengthMm, 'mm');
  var eM = numRow(p, '용지 여백', d.marginMm, 'mm');
  var q = w.add('panel', undefined, '배치');
  q.alignChildren = 'left';
  var eG = numRow(q, '작업물 사이 간격', d.gapMm, 'mm');
  var eQ = numRow(q, '수량 (선택한 것마다)', d.quantity, '개');
  var cR = q.add('checkbox', undefined, '90도 돌려서 넣기 허용');
  cR.value = d.allowRotate;
  var gBtn = w.add('group');
  gBtn.alignment = 'right';
  gBtn.add('button', undefined, '취소', { name: 'cancel' });
  gBtn.add('button', undefined, '네스팅', { name: 'ok' });
  if (w.show() !== 1) return;
  try {
    alert(nestRoll({
      widthMm: parseFloat(eW.text), maxLengthMm: parseFloat(eL.text), marginMm: parseFloat(eM.text),
      gapMm: parseFloat(eG.text), quantity: parseFloat(eQ.text), allowRotate: cR.value
    }));
  } catch (e) {
    alert(e.message);
  }
})();
