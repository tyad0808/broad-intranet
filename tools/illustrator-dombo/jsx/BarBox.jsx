// 단독 실행용: 선택한 객체마다 막대 + 박스를 만든다. dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  var d = domboBarBoxDefaults();
  var w = new Window('dialog', '막대 + 박스 설정');
  w.alignChildren = 'left';

  var cBar = w.add('checkbox', undefined, '막대 만들기');
  cBar.value = d.useBar;
  function numRow(label, value) {
    var g = w.add('group');
    g.add('statictext', undefined, label).preferredSize.width = 120;
    var e = g.add('edittext', undefined, String(value));
    e.characters = 6;
    g.add('statictext', undefined, 'mm');
    return e;
  }
  var eHeight = numRow('막대 높이(두께)', d.barHeightMm);
  var eGap = numRow('막대 간격', d.barGapMm);
  var eMargin = numRow('박스 여백', d.boxMarginMm);
  var cCut = w.add('checkbox', undefined, '박스를 칼선(CutContour)으로');
  cCut.value = d.boxAsCut;

  var gBtn = w.add('group');
  gBtn.alignment = 'right';
  gBtn.add('button', undefined, '취소', { name: 'cancel' });
  gBtn.add('button', undefined, '만들기', { name: 'ok' });
  if (w.show() !== 1) return;

  try {
    alert(domboBarBox({
      useBar: cBar.value,
      barHeightMm: parseFloat(eHeight.text),
      barGapMm: parseFloat(eGap.text),
      boxMarginMm: parseFloat(eMargin.text),
      boxAsCut: cCut.value
    }));
  } catch (e) {
    alert(e.message);
  }
})();
