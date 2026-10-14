// 단독 실행용: 글자 수와 아웃라인 도형 수를 센다. dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  try {
    alert(domboCount());
  } catch (e) {
    alert(e.message);
  }
})();
