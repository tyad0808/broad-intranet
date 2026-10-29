// 단독 실행용: 선택한 출력물에 번호를 붙인다 (조각 번호까지, 안쪽 왼쪽 위, 5mm). dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  try {
    alert(domboNumber({ pieces: confirm('작업물 안 조각 번호까지 붙일까요? (3-1, 3-2 …)\n(아니오: 작업물 번호만)'), textMm: 5, place: 'inside' }));
  } catch (e) {
    alert(e.message);
  }
})();
