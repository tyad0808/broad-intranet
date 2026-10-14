// 단독 실행용: 선택한 사각형들로 격자 칼선을 만든다. dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  try {
    alert(domboGridCut({ removeRects: confirm('기준 사각형을 지울까요?') }));
  } catch (e) {
    alert(e.message);
  }
})();
