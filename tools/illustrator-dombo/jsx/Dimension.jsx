// 단독 실행용: 선택한 객체에 치수를 표시한다 (기본 설정). dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  try {
    alert(domboDimension({ target: confirm('선택한 것마다 따로 표시할까요?\n(아니오: 전체를 하나로)') ? 'each' : 'all' }));
  } catch (e) {
    alert(e.message);
  }
})();
