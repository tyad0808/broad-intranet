#!/usr/bin/env bash
# 새 코드로 업데이트 (root 로 실행): bash /opt/broad-intranet/app/deploy/update.sh
# GitHub 의 최신 코드를 받고, 부품을 맞추고, 업데이트 전에 DB 를 백업한 뒤 재시작한다.
set -euo pipefail

APP_DIR=/opt/broad-intranet/app
APP_USER=intranet

[ "$(id -u)" -eq 0 ] || { echo "root 로 실행하세요."; exit 1; }
cd "$APP_DIR"

echo "▶ 업데이트 전 DB 백업"
sudo -u "$APP_USER" node --disable-warning=ExperimentalWarning scripts/backup.js

echo "▶ 최신 코드 받기"
git pull --ff-only

echo "▶ 부품 설치"
npm ci --omit=dev --no-audit --no-fund

echo "▶ 재시작"
systemctl restart broad-intranet
sleep 2
systemctl is-active broad-intranet && echo "✔ 업데이트 완료 ($(git log -1 --format='%h %s'))"
