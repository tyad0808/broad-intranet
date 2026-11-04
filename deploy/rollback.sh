#!/usr/bin/env bash
# 바로 전 업데이트 전으로 되돌리기 (root 로 실행): bash /opt/broad-intranet/app/deploy/rollback.sh
#
# update.sh 를 하기 바로 전 코드로 돌아간다. 한 번 더 실행하면 그 전 업데이트 전으로 (한 단계씩).
# 다시 최신으로 가려면 update.sh 를 실행하면 된다.
#
# - 어느 버전으로 업데이트했는지는 서버 git 기록(reflog)에서 찾는다 (업데이트 = git pull 한 번)
# - DB 는 되돌리지 않는다: 업데이트 뒤 들어온 주문·문의를 잃지 않게. 새 버전이 더한 칸·표는 남아도 예전 코드에 영향 없음
# - 되돌리기 전에 DB 를 백업한다 (update.sh 와 같은 방법)
set -euo pipefail

APP_DIR=/opt/broad-intranet/app
APP_USER=intranet

[ "$(id -u)" -eq 0 ] || { echo "root 로 실행하세요."; exit 1; }
cd "$APP_DIR"

NOW=$(git rev-parse HEAD)
# 지금 버전을 가져온 업데이트(pull) 기록을 찾아, 그 바로 전 버전
# (awk 가 중간에 끝나면 git 이 '파이프 끊김' 으로 실패해 set -e 가 말없이 멈춘다 → 끝까지 읽고 한 번만 출력)
PREV=$(git reflog --format='%H %gs' | awk -v now="$NOW" 'found == 1 { print $1; found = 2 } $1 == now && $2 ~ /^pull/ && !found { found = 1 }')
if [ -z "$PREV" ]; then
  echo "되돌릴 이전 버전 기록이 없습니다. (업데이트를 한 번 한 뒤부터 쓸 수 있어요)"
  exit 1
fi

echo "지금 버전     : $(git log -1 --format='%h %ad %s' --date=format:'%m/%d %H:%M' "$NOW")"
echo "되돌릴 버전   : $(git log -1 --format='%h %ad %s' --date=format:'%m/%d %H:%M' "$PREV")"
echo "빠지는 변경   :"
git log -n 20 --format='  - %s' "$PREV..$NOW"
read -r -p "되돌릴까요? (y 를 누르고 Enter) " answer
[ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "그만뒀습니다. 아무것도 바꾸지 않았어요."; exit 0; }

echo "▶ 되돌리기 전 DB 백업"
sudo -u "$APP_USER" node --disable-warning=ExperimentalWarning scripts/backup.js

echo "▶ 코드 되돌리기"
git reset --hard "$PREV"

echo "▶ 부품 설치"
npm ci --omit=dev --no-audit --no-fund

echo "▶ 재시작"
systemctl restart broad-intranet
sleep 2
systemctl is-active broad-intranet && echo "✔ 되돌리기 완료 ($(git log -1 --format='%h %s')). 다시 최신으로: bash $APP_DIR/deploy/update.sh"
