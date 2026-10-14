// 단독 실행용: 아크릴 텍스트 네스팅. nest-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "nest-core.jsx"

(function () {
  var d = nestTextDefaults();
  var w = new Window('dialog', '아크릴 텍스트 네스팅');
  w.alignChildren = 'fill';
  function numRow(parent, label, value, unit) {
    var g = parent.add('group');
    g.add('statictext', undefined, label).preferredSize.width = 140;
    var e = g.add('edittext', undefined, String(value));
    e.characters = 6;
    g.add('statictext', undefined, unit);
    return e;
  }
  var p = w.add('panel', undefined, '원판');
  p.alignChildren = 'left';
  var eW = numRow(p, '가로', d.sheetWMm, 'mm');
  var eH = numRow(p, '세로', d.sheetHMm, 'mm');
  var eM = numRow(p, '원판 여백', d.marginMm, 'mm');
  var u = w.add('panel', undefined, '나누기');
  u.alignChildren = 'left';
  var rG = u.add('radiobutton', undefined, '글자 단위 (한 글자씩)');
  var rP = u.add('radiobutton', undefined, '조각 단위 (떨어지는 획마다)');
  rG.value = true;
  var q = w.add('panel', undefined, '배치');
  q.alignChildren = 'left';
  var eG = numRow(q, '글자 사이 간격', d.gapMm, 'mm');
  var eQ = numRow(q, '세트 수량', d.quantity, '세트');
  var cR = q.add('checkbox', undefined, '90도 돌려서 넣기 허용');
  cR.value = d.allowRotate;
  var cL = q.add('checkbox', undefined, '레이저 선으로 (면 없음, 빨강 0.1pt)');
  cL.value = d.laserLine;
  var gBtn = w.add('group');
  gBtn.alignment = 'right';
  gBtn.add('button', undefined, '취소', { name: 'cancel' });
  gBtn.add('button', undefined, '네스팅', { name: 'ok' });
  if (w.show() !== 1) return;
  try {
    alert(nestText({
      sheetWMm: parseFloat(eW.text), sheetHMm: parseFloat(eH.text), marginMm: parseFloat(eM.text),
      unit: rP.value ? 'piece' : 'glyph', gapMm: parseFloat(eG.text), quantity: parseFloat(eQ.text),
      allowRotate: cR.value, laserLine: cL.value
    }));
  } catch (e) {
    alert(e.message);
  }
})();
