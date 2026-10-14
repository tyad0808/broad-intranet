#!/bin/bash
# 네스팅 패널을 맥 일러스트레이터에 설치한다. 터미널에서: bash install-mac.sh
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.broad.nesting"

# 서명하지 않은 사내 확장을 열 수 있게 허용 (CC 2017 ~ 최신)
for v in 7 8 9 10 11 12; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/CSXS" "$SRC/jsx" "$SRC/roll.html" "$SRC/text.html" "$SRC/panel.js" "$SRC/text-panel.js" "$SRC/nest-shape.js" "$SRC/style.css" "$DEST/"
echo "설치 완료: $DEST"
echo "일러스트레이터를 다시 켜고 [창 > 확장] 에서 '용지 폭 네스팅' 또는 '아크릴 텍스트 네스팅' 을 여세요."
