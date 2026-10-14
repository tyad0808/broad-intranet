// 단독 실행용: 파일 > 스크립트 > 기타 스크립트... 에서 이 파일을 고른다.
// dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  var d = domboDefaults();
  var w = new Window('dialog', '돔보마크 찍기');
  w.alignChildren = 'fill';

  var gTarget = w.add('panel', undefined, '기준');
  gTarget.orientation = 'row';
  var rSel = gTarget.add('radiobutton', undefined, '선택한 작업물');
  var rAb = gTarget.add('radiobutton', undefined, '현재 대지');
  rSel.value = true;

  var gShape = w.add('panel', undefined, '마크');
  gShape.alignChildren = 'left';
  var rowShape = gShape.add('group');
  var rL = rowShape.add('radiobutton', undefined, 'L자');
  var rSq = rowShape.add('radiobutton', undefined, '사각형');
  rL.value = true;
  var rowCount = gShape.add('group');
  var r4 = rowCount.add('radiobutton', undefined, '4점');
  var r3 = rowCount.add('radiobutton', undefined, '3점 (오른쪽 위 생략)');
  r4.value = true;

  function numRow(parent, label, value) {
    var g = parent.add('group');
    g.add('statictext', undefined, label).preferredSize.width = 130;
    var e = g.add('edittext', undefined, String(value));
    e.characters = 6;
    g.add('statictext', undefined, 'mm');
    return e;
  }
  var gSize = w.add('panel', undefined, '크기');
  gSize.alignChildren = 'left';
  var eSize = numRow(gSize, '마크 크기', d.sizeMm);
  var eThick = numRow(gSize, 'L자 선 두께', d.thickMm);
  var eOffset = numRow(gSize, '작업물과의 거리', d.offsetMm);
  var eMargin = numRow(gSize, '대지 여백', d.marginMm);
  var cFit = gSize.add('checkbox', undefined, '마크가 대지 밖이면 대지 넓히기');
  cFit.value = d.fitArtboard;

  var gBtn = w.add('group');
  gBtn.alignment = 'right';
  gBtn.add('button', undefined, '취소', { name: 'cancel' });
  gBtn.add('button', undefined, '찍기', { name: 'ok' });

  if (w.show() !== 1) return;

  try {
    var msg = domboPlace({
      target: rAb.value ? 'artboard' : 'selection',
      shape: rSq.value ? 'square' : 'L',
      count: r3.value ? 3 : 4,
      sizeMm: parseFloat(eSize.text),
      thickMm: parseFloat(eThick.text),
      offsetMm: parseFloat(eOffset.text),
      marginMm: parseFloat(eMargin.text),
      fitArtboard: cFit.value
    });
    alert(msg);
  } catch (e) {
    alert(e.message);
  }
})();
