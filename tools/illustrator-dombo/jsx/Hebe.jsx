// 단독 실행용: 선택한 것의 실제 가로·세로와 헤베(㎡)를 알려 준다. dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  try {
    alert(domboHebe({ scale: confirm('10:1 파일인가요? (1/10 로 그린 파일)\n(아니오: 1:1 파일)') ? 10 : 1 }));
  } catch (e) {
    alert(e.message);
  }
})();
