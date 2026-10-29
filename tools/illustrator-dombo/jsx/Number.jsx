// 단독 실행용: 선택한 출력물에 번호를 붙인다 (우측 상단 바깥, 폰트 7mm, 10:1 파일이면 0.7mm). dombo-core.jsx 가 같은 폴더에 있어야 한다.
#target illustrator
#include "dombo-core.jsx"

(function () {
  try {
    alert(domboNumber({ pieces: false, scale: confirm('10:1 파일인가요? (1/10 로 그린 파일)\n(아니오: 1:1 파일)') ? 10 : 1, textMm: 7, side: 'top', gapMm: 3, box: false }));
  } catch (e) {
    alert(e.message);
  }
})();
