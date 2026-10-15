#!/usr/bin/env bash
# 브로애드 인트라넷 서버 설치 스크립트 (Ubuntu 24.04, root 로 실행)
#
# 사용법: bash /opt/broad-intranet/app/deploy/setup.sh intranet.broadstore.co.kr
#
# 하는 일
#  1. 시간대(한국), 보안 업데이트 자동 설치, 비상용 메모리(스왑)
#  2. Node.js 22, Caddy(HTTPS 자동) 설치
#  3. 인트라넷 전용 계정(intranet) 생성, 데이터 폴더 준비, .env 만들기
#  4. 인트라넷을 서비스로 등록 (재부팅해도 자동 시작, 멈추면 자동 재시작)
#  5. 매일 새벽 3시 DB 자동 백업
#  6. 방화벽(22, 80, 443 만 열기), 비밀번호 무작위 대입 공격 차단(fail2ban)
#
# 여러 번 실행해도 안전하다 (이미 된 단계는 건너뛴다).
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/broad-intranet/app
DATA_DIR=/var/lib/broad-intranet
APP_USER=intranet

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "root 로 실행하세요."
[ -n "$DOMAIN" ] || fail "주소를 함께 적어 주세요. 예: bash $0 intranet.broadstore.co.kr"
[ -f "$APP_DIR/package.json" ] || fail "$APP_DIR 에 인트라넷 코드가 없습니다. 안내서의 '코드 내려받기' 단계를 먼저 하세요."
grep -q 'Ubuntu' /etc/os-release || fail "Ubuntu 에서만 동작하는 스크립트입니다."

export DEBIAN_FRONTEND=noninteractive

say "1/7 시간대를 한국으로 맞추고 기본 프로그램을 설치합니다"
timedatectl set-timezone Asia/Seoul
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ufw fail2ban unattended-upgrades ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https
# 보안 업데이트를 매일 자동으로 설치
echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades

say "2/7 비상용 메모리(스왑 1GB)를 만듭니다"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "이미 스왑이 있습니다. 건너뜁니다."
fi

say "3/7 Node.js 22 를 설치합니다"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "4/7 Caddy(HTTPS 자동 발급)를 설치합니다"
if ! command -v caddy >/dev/null; then
  # 공식 저장소(최신판)를 먼저 시도하고, 안 되면 Ubuntu 기본 저장소의 Caddy 를 쓴다
  if curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
     && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list \
     && apt-get update -y && apt-get install -y caddy; then
    echo "Caddy 공식 저장소에서 설치했습니다."
  else
    echo "공식 저장소 접속 실패. Ubuntu 기본 저장소의 Caddy 를 설치합니다."
    rm -f /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi
fi
caddy version

say "5/7 인트라넷 계정, 데이터 폴더, 설정 파일(.env)을 준비합니다"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
# 코드는 root 소유(인트라넷이 자기 코드를 고칠 수 없게), 데이터만 intranet 계정 소유
mkdir -p "$DATA_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

if [ ! -f "$APP_DIR/.env" ]; then
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > "$APP_DIR/.env" <<ENV
# 운영 서버 설정 (이 파일은 깃에 올라가지 않는다)
NODE_ENV=production
PORT=3000
SESSION_SECRET=$SECRET

DB_PATH=$DATA_DIR/intranet.db
BACKUP_DIR=$DATA_DIR/backups
BACKUP_KEEP_DAYS=14

# 네이버 키를 넣기 전까지는 off. 키를 넣은 뒤 naver 로 바꾸고 재시작
ORDER_SOURCE=off
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
# 발주확인·발송처리: off = 연습 모드(네이버로 보내지 않음), on = 실제로 보냄
NAVER_WRITE=off
COLLECT_INTERVAL_MINUTES=5
ENV
  echo ".env 를 새로 만들었습니다 (세션 비밀값 자동 생성)."
else
  echo ".env 가 이미 있어 그대로 둡니다."
fi
chown root:"$APP_USER" "$APP_DIR/.env"
chmod 640 "$APP_DIR/.env"

say "6/7 인트라넷 서비스와 매일 백업을 등록합니다"
NODE_BIN=$(command -v node)
cat > /etc/systemd/system/broad-intranet.service <<UNIT
[Unit]
Description=Broad intranet
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning src/server.js
Restart=always
RestartSec=3
# 보안: 시스템 파일을 고치지 못하게, 데이터 폴더만 쓰기 허용
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/broad-intranet-backup.service <<UNIT
[Unit]
Description=Broad intranet DB backup

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning scripts/backup.js
UNIT

cat > /etc/systemd/system/broad-intranet-backup.timer <<UNIT
[Unit]
Description=Broad intranet DB backup every day 03:00

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now broad-intranet.service
systemctl enable --now broad-intranet-backup.timer

say "7/7 HTTPS(Caddy)와 방화벽을 설정합니다"
cat > /etc/caddy/Caddyfile <<CADDY
# $DOMAIN 으로 들어온 요청을 인트라넷(내부 3000번)으로 전달. HTTPS 인증서는 자동 발급·갱신
$DOMAIN {
	reverse_proxy 127.0.0.1:3000
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy || systemctl restart caddy

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban

sleep 2
OUT_IP=$(curl -fsS --max-time 10 https://api.ipify.org || echo "확인 실패")
STATUS=$(systemctl is-active broad-intranet || true)

cat <<DONE

==================================================
 설치 완료
==================================================
 인트라넷 서비스 상태 : $STATUS
 접속 주소           : https://$DOMAIN
 네이버에 등록할 IP   : $OUT_IP

 다음 할 일
 1) 관리자 계정 만들기:
      cd $APP_DIR && sudo -u $APP_USER npm run create-admin
 2) 브라우저에서 https://$DOMAIN 접속해 로그인
    (주소 연결 직후에는 HTTPS 인증서 발급에 1~2분 걸릴 수 있음)
 3) 네이버 커머스 API센터에 위 IP 등록 → 키를 .env 에 넣고 ORDER_SOURCE=naver
==================================================
DONE
