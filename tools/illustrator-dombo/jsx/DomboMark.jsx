// 단독 실행용: 파일 > 스크립트 > 기타 스크립트... 에서 이 파일을 고른다.
// dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  var d = domboDefaults();
  var w = new Window('dialog', '원형 돔보마크 찍기');
  w.alignChildren = 'fill';

  var gTarget = w.add('panel', undefined, '기준');
  gTarget.orientation = 'row';
  var rSel = gTarget.add('radiobutton', undefined, '선택한 작업물');
  var rAb = gTarget.add('radiobutton', undefined, '현재 대지');
  rSel.value = true;

  function numRow(parent, label, value) {
    var g = parent.add('group');
    g.add('statictext', undefined, label).preferredSize.width = 130;
    var e = g.add('edittext', undefined, String(value));
    e.characters = 6;
    g.add('statictext', undefined, 'mm');
    return e;
  }
  var gMark = w.add('panel', undefined, '원형 마크');
  gMark.alignChildren = 'left';
  var eDia = numRow(gMark, '마크 지름', d.diameterMm);
  var eOffset = numRow(gMark, '작업물과의 거리', d.offsetMm);
  var eSpacing = numRow(gMark, '마크 간격 (최대)', d.spacingMm);
  gMark.add('statictext', undefined, '간격 0 이면 네 모서리만 찍습니다.');

  var gAb = w.add('panel', undefined, '대지');
  gAb.alignChildren = 'left';
  var cFit = gAb.add('checkbox', undefined, '마크가 대지 밖이면 대지 넓히기');
  cFit.value = d.fitArtboard;
  var eMargin = numRow(gAb, '마크 바깥 여백', d.marginMm);

  var gBtn = w.add('group');
  gBtn.alignment = 'right';
  gBtn.add('button', undefined, '취소', { name: 'cancel' });
  gBtn.add('button', undefined, '찍기', { name: 'ok' });

  if (w.show() !== 1) return;

  try {
    var msg = domboPlace({
      target: rAb.value ? 'artboard' : 'selection',
      diameterMm: parseFloat(eDia.text),
      offsetMm: parseFloat(eOffset.text),
      spacingMm: parseFloat(eSpacing.text),
      marginMm: parseFloat(eMargin.text),
      fitArtboard: cFit.value
    });
    alert(msg);
  } catch (e) {
    alert(e.message);
  }
})();
