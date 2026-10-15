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
  var rSel = gTarget.add('radiobutton', undefined, '작업물 (선택 안 하면 문서 전체)');
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
  gMark.add('statictext', undefined, '간격은 위·아래 변에만 적용. 0 이면 네 모서리만.');

  var gOri = w.add('panel', undefined, '방향 표시점');
  gOri.alignChildren = 'left';
  var cOri = gOri.add('checkbox', undefined, '좌우를 알 수 있게 점 하나 더');
  cOri.value = d.orientMark;
  var gCorner = gOri.add('group');
  gCorner.add('statictext', undefined, '모서리').preferredSize.width = 130;
  var dCorner = gCorner.add('dropdownlist', undefined, ['오른쪽 아래', '왼쪽 아래', '오른쪽 위', '왼쪽 위']);
  dCorner.selection = 0;
  var eOri = numRow(gOri, '모서리 마크에서 거리', d.orientMm);

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
      fitArtboard: cFit.value,
      orientMark: cOri.value,
      orientCorner: ['rb', 'lb', 'rt', 'lt'][dCorner.selection.index],
      orientMm: parseFloat(eOri.text)
    });
    alert(msg);
  } catch (e) {
    alert(e.message);
  }
})();
