# 사무실 NAS(시놀로지)로 인트라넷 백업 받기

서버가 고장 나거나 해킹돼도 데이터가 남도록, **매일 새벽 사무실 NAS 가 서버에서 백업을 가져와** 한 부 더 보관해요.

- 가져오는 것: 매일 새벽 3시에 만든 **DB 백업**(주문·문의·톡톡·매크로·직원 계정 등 전부)과 **올린 시안 그림**
- NAS 가 서버로 **나가서 가져오기만** 해요. 사무실 인터넷·NAS 공유 설정은 바꾸지 않아요.
- NAS 전용 계정은 **백업 폴더를 읽기만** 할 수 있어요. 서버의 다른 파일은 못 보고, 아무것도 지우거나 바꿀 수 없어요.
- 백업에는 고객 이름·연락처·주소가 들어 있어요. **관리자만 보는 공유 폴더**에 받아요.
- NAS 에는 DB 백업을 **30일치까지만** 남겨요 (개인정보가 오래 쌓이지 않게).

아래는 DSM 7 기준이에요. 메뉴 이름이 조금 다르면 비슷한 이름을 찾거나 화면을 캡처해 주세요.

## 1. 공유 폴더 만들기 (NAS)

1. **제어판 › 공유 폴더 › 생성**
2. 이름: `intranet-backup`, 위치: **볼륨 1** (다른 볼륨이면 아래 명령의 `/volume1` 을 그 번호로 바꿔요)
3. **"네트워크 환경에서 공유 폴더 숨기기"** 체크, 휴지통은 꺼도 돼요
4. 권한: **administrators 만 읽기/쓰기**, 다른 사용자·그룹은 **액세스 금지**

## 2. 열쇠 만들기 (NAS, 한 번만)

1. **제어판 › 작업 스케줄러 › 생성 › 예약된 작업 › 사용자 정의 스크립트**
2. **일반** 탭: 작업 이름 `인트라넷 백업 열쇠 만들기`, 사용자 **root**, **활성화 체크 해제** (한 번만 직접 실행)
3. **작업 설정** 탭의 "사용자 정의 스크립트" 칸에 아래를 그대로 붙여 넣고 **확인**

```
DIR=/volume1/intranet-backup
mkdir -p $DIR/.ssh && chmod 700 $DIR/.ssh
[ -f $DIR/.ssh/nas_key ] || ssh-keygen -q -t ed25519 -N "" -C "synology-nas" -f $DIR/.ssh/nas_key
cp $DIR/.ssh/nas_key.pub $DIR/nas_key_public.txt
```

4. 목록에서 이 작업을 골라 **실행**
5. **File Station › intranet-backup** 에 `nas_key_public.txt` 가 생겨요. 내려받아 메모장으로 열고, **`ssh-ed25519` 로 시작하는 한 줄**을 복사해 두세요.
   - 이건 **공개 열쇠**라 비밀번호가 아니에요. `.ssh` 폴더 안의 `nas_key`(비밀 열쇠)는 열거나 옮기지 마세요.

## 3. 서버에 연결 허락하기 (서버, 한 번만)

서버에 접속해서 아래 명령을 실행하고, 물어보면 복사한 **공개 열쇠 한 줄을 붙여 넣고 Enter** 를 누르세요.

```
bash /opt/broad-intranet/app/deploy/nas-backup-setup.sh
```

"✔ 서버 쪽 준비 끝" 이 나오면 돼요. 열쇠를 바꿀 때도 이 명령을 다시 실행하면 돼요.

## 4. 매일 가져오기 예약 (NAS)

1. **제어판 › 작업 스케줄러 › 생성 › 예약된 작업 › 사용자 정의 스크립트**
2. **일반** 탭: 작업 이름 `인트라넷 백업 가져오기`, 사용자 **root**, 활성화 체크
3. **일정** 탭: **매일**, 시간 **04:30** (서버 백업이 3시에 끝난 뒤)
4. **작업 설정** 탭
   - **"실행 세부 정보를 이메일로 보내기"** 체크 → 이메일 입력 → **"스크립트가 비정상적으로 종료된 경우에만"** 체크 (실패할 때만 메일이 와요)
   - "사용자 정의 스크립트" 칸에 아래를 그대로 붙여 넣기

```
DIR=/volume1/intranet-backup
LOG=$DIR/backup-log.txt
exec >> $LOG 2>&1
echo "===== $(date '+%Y-%m-%d %H:%M:%S') start"
[ -f $DIR/.ssh/nas_key ] || { echo "ERROR: no key file $DIR/.ssh/nas_key (do step 2 again)"; exit 1; }
HOST=nasbackup@intranet.broadstore.co.kr
SSH="ssh -i $DIR/.ssh/nas_key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$DIR/.ssh/known_hosts -o BatchMode=yes -o ConnectTimeout=30"
mkdir -p $DIR/data
rsync -av --exclude 'proofs/' -e "$SSH" $HOST: $DIR/data/ || { echo "ERROR: db backup failed"; exit 1; }
rsync -av --delete -e "$SSH" $HOST:proofs/ $DIR/data/proofs/ || { echo "ERROR: proofs failed"; exit 1; }
find $DIR/data -maxdepth 1 -name 'intranet-*.db*' -mtime +30 -delete
echo "OK done"
```
```

5. **확인** 후, 목록에서 이 작업을 골라 **실행** 해서 바로 시험해 보세요.

## 5. 잘 됐는지 확인

- **File Station › intranet-backup › data** 에 `intranet-날짜.db.gz` 파일들과 `proofs` 폴더가 생겼으면 성공이에요.
- 인트라넷 **관리자 › 저장 공간 › 사무실 NAS 백업** 에 **"가져간 시각"** 이 나와요.
- NAS 가 **3일 넘게** 못 가져가면 관리자에게 알림이 가요 (NAS 꺼짐·인터넷 끊김 등).

## 안 될 때

- 가져오기가 실패하면 **File Station › intranet-backup › backup-log.txt** 를 내려받아 메모장으로 열고, 맨 아래 부분을 캡처해 주세요. 실행할 때마다 결과가 여기에 쌓여요.
- 인트라넷 주소가 클라우드플레어 같은 중간 서비스를 거친다면, 위 스크립트의 `intranet.broadstore.co.kr` 대신 **서버 IP 주소**를 넣어야 해요.

## 되살리기 (서버를 잃었을 때)

새 서버에 인트라넷을 설치한 뒤, NAS 의 가장 최근 `intranet-날짜.db.gz` 와 `proofs` 폴더를 새 서버의
`/var/lib/broad-intranet/` 에 넣으면 돼요. 이건 그때 같이 해요 (혼자 하지 마세요).
