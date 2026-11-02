#!/usr/bin/env bash
# 사무실 NAS 백업 연결 (root 로 한 번만): bash /opt/broad-intranet/app/deploy/nas-backup-setup.sh
#
# NAS 가 매일 새벽 서버에 접속해서 백업 폴더(/var/lib/broad-intranet/backups)를 가져간다.
#   - NAS 전용 계정 nasbackup 을 만든다. 열쇠(키)로만 들어올 수 있고, 백업 폴더를 '읽기만' 할 수 있다
#     (명령 실행·다른 폴더 보기·파일 지우기/바꾸기 모두 안 됨 — rrsync -ro)
#   - NAS 가 가져갈 때마다 시각을 /var/lib/broad-intranet-nas/last_pull 에 적는다 → 관리자 › 저장 공간에 보이고, 3일 넘게 멈추면 알림
#   - 사무실 쪽은 아무것도 열 필요 없다 (NAS 가 바깥으로 나가서 가져오기만 함)
#
# NAS 의 '공개 열쇠'(ssh-ed25519 로 시작하는 한 줄)를 붙여 넣으라고 묻는다. 공개 열쇠는 비밀번호가 아니다.
# 여러 번 실행해도 된다 (열쇠를 바꿀 때도 이걸 다시 실행).
set -euo pipefail

DATA_DIR=/var/lib/broad-intranet
BACKUP_DIR=$DATA_DIR/backups
NAS_USER=nasbackup
NAS_HOME=/var/lib/broad-intranet-nas
APP_USER=intranet
WRAPPER=/usr/local/bin/intranet-nas-pull

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "root 로 실행하세요."
[ -d "$BACKUP_DIR" ] || fail "$BACKUP_DIR 이 없습니다. 인트라넷이 설치된 서버에서 실행하세요."

say "1/5 NAS 의 공개 열쇠를 붙여 넣어 주세요 (ssh-ed25519 로 시작하는 한 줄, 붙여 넣고 Enter)"
read -r KEY
KEY=$(printf '%s' "$KEY" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
case "$KEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;;
  *) fail "공개 열쇠 모양이 아닙니다. NAS 의 nas_key_public.txt 내용 한 줄을 그대로 붙여 넣어 주세요." ;;
esac
case "$KEY" in *PRIVATE*) fail "비밀 열쇠(PRIVATE)를 붙여 넣으셨어요. 공개 열쇠(nas_key_public.txt)를 붙여 넣어 주세요." ;; esac

say "2/5 rsync 를 확인합니다"
command -v rsync >/dev/null || apt-get install -y rsync
RRSYNC=$(command -v rrsync || true)
if [ -z "$RRSYNC" ]; then
  # Ubuntu 22.04 처럼 rrsync 가 설명서 폴더에만 있는 경우
  for f in /usr/share/doc/rsync/scripts/rrsync /usr/share/doc/rsync/scripts/rrsync.gz /usr/share/rsync/scripts/rrsync; do
    if [ -f "$f" ]; then
      case "$f" in *.gz) gunzip -c "$f" > /usr/local/bin/rrsync ;; *) cp "$f" /usr/local/bin/rrsync ;; esac
      chmod 755 /usr/local/bin/rrsync
      RRSYNC=/usr/local/bin/rrsync
      break
    fi
  done
fi
[ -n "$RRSYNC" ] || fail "rrsync 를 찾지 못했습니다. 화면을 캡처해서 알려 주세요."
head -1 "$RRSYNC" | grep -q python && { command -v python3 >/dev/null || apt-get install -y python3; }

say "3/5 NAS 전용 계정($NAS_USER)을 만듭니다 (열쇠로만 접속, 백업 폴더 읽기만)"
id "$NAS_USER" >/dev/null 2>&1 || useradd --system --home "$NAS_HOME" --shell /bin/sh "$NAS_USER"
usermod -aG "$APP_USER" "$NAS_USER"   # 백업 폴더를 읽을 수 있게 (쓰기는 rrsync 가 막는다)
passwd -l "$NAS_USER" >/dev/null 2>&1 || true   # 비밀번호로는 못 들어오게
mkdir -p "$NAS_HOME/.ssh"
chown "$NAS_USER:$NAS_USER" "$NAS_HOME"
chmod 755 "$NAS_HOME"   # 인트라넷이 last_pull 을 읽을 수 있게
chmod 750 "$DATA_DIR" "$BACKUP_DIR" 2>/dev/null || true
chmod -R g+rX "$BACKUP_DIR"

say "4/5 접속하면 백업 폴더만 내주고, 끝나면 시각을 적는 프로그램을 둡니다"
cat > "$WRAPPER" <<SH
#!/bin/sh
# NAS 백업 계정($NAS_USER)이 접속하면 이것만 실행된다: 백업 폴더를 읽기 전용으로 내주고, 성공하면 시각을 적는다
"$RRSYNC" -ro "$BACKUP_DIR" && date -u +%Y-%m-%dT%H:%M:%SZ > "$NAS_HOME/last_pull"
SH
chmod 755 "$WRAPPER"
printf 'restrict,command="%s" %s\n' "$WRAPPER" "$KEY" > "$NAS_HOME/.ssh/authorized_keys"
chown -R "$NAS_USER:$NAS_USER" "$NAS_HOME/.ssh"
chmod 700 "$NAS_HOME/.ssh"
chmod 600 "$NAS_HOME/.ssh/authorized_keys"
touch "$NAS_HOME/last_pull" 2>/dev/null && chown "$NAS_USER:$NAS_USER" "$NAS_HOME/last_pull" && : > "$NAS_HOME/last_pull"
chmod 644 "$NAS_HOME/last_pull"

# 서버 접속을 특정 계정만 허용하게 해 두었다면 nasbackup 도 넣는다
if grep -qE '^\s*AllowUsers' /etc/ssh/sshd_config 2>/dev/null && ! grep -qE "^\s*AllowUsers.*\b$NAS_USER\b" /etc/ssh/sshd_config; then
  sed -i -E "s/^(\s*AllowUsers.*)$/\1 $NAS_USER/" /etc/ssh/sshd_config
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi

say "5/5 확인: 백업 계정이 백업 폴더를 읽을 수 있는지"
if sudo -u "$NAS_USER" ls "$BACKUP_DIR" >/dev/null 2>&1; then
  echo "  ✔ 읽기 확인"
else
  fail "백업 계정이 백업 폴더를 못 읽습니다. 화면을 캡처해서 알려 주세요."
fi

printf '\n\033[1;32m✔ 서버 쪽 준비 끝\033[0m\n'
echo "  NAS 작업 스케줄러에 넣을 접속 정보:"
echo "    계정: $NAS_USER"
echo "    서버: $(hostname -f 2>/dev/null || hostname) (인트라넷 주소로 접속하면 됩니다)"
echo "  이제 NAS 에서 '인트라넷 백업 가져오기' 작업을 실행해 보세요."
echo "  인트라넷 관리자 › 저장 공간에 '마지막으로 가져감' 시각이 나오면 성공입니다."
