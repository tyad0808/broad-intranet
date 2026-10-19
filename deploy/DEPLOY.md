# 서버 설치 안내서 (iwinv · Ubuntu 24.04)

인트라넷을 `https://intranet.broadstore.co.kr` 로 여는 순서입니다.
명령어는 **한 줄씩** 복사해서 붙여넣고 Enter 를 누르세요.

| 항목 | 값 |
|---|---|
| 서버 | iwinv `broad-intranet` (Ubuntu 24.04) |
| 공인 IP | `49.247.133.38` |
| 주소 | `intranet.broadstore.co.kr` |

---

## 1. 주소 연결 (가비아, 브라우저에서)

1. 가비아 로그인 → **My가비아** → **도메인** → `broadstore.co.kr` 의 **관리**
2. **DNS 정보 → DNS 관리**(또는 "DNS 설정") → **레코드 수정**
3. **레코드 추가**를 누르고 아래처럼 입력 → **저장**

   | 타입 | 호스트 | 값/위치 | TTL |
   |---|---|---|---|
   | A | `intranet` | `49.247.133.38` | 600 |

> ⚠️ 이미 있는 다른 레코드(`@`, `www` 등)는 **절대 고치거나 지우지 마세요.** 자사몰 접속이 끊깁니다.
> 화면에 "가비아 네임서버를 사용하지 않습니다" 같은 안내가 나오면 멈추고 알려주세요. 다른 곳에서 설정해야 합니다.

반영까지 보통 몇 분, 길면 1시간 정도 걸립니다.

---

## 2. 서버 접속 (내 PC 의 PowerShell)

```powershell
ssh root@49.247.133.38
```

- 처음 접속하면 `Are you sure you want to continue connecting (yes/no)?` → `yes` 입력
- `password:` → iwinv 에서 정한(또는 메일로 받은) **root 비밀번호** 입력. 입력해도 화면에 안 보이는 게 정상입니다.
- 접속되면 앞부분이 `root@broad-intranet:~#` 처럼 바뀝니다. 이제부터 명령어는 **서버에서** 실행됩니다.
- 접속을 끝낼 때는 `exit`

---

## 3. 코드 내려받기 (서버에서)

저장소가 비공개라서, 서버 전용 "읽기 전용 열쇠"(Deploy key)를 만들어 GitHub 에 등록합니다.

**3-1. 열쇠 만들기**
```bash
apt-get update && apt-get install -y git
```
```bash
ssh-keygen -t ed25519 -N "" -f /root/.ssh/broad_deploy -C broad-intranet-server
```
```bash
cat /root/.ssh/broad_deploy.pub
```
`ssh-ed25519 AAAA... broad-intranet-server` 로 시작하는 한 줄이 나옵니다. 이 줄 전체를 복사하세요
(PowerShell 에서는 드래그 후 마우스 오른쪽 클릭 = 복사).

> 이 한 줄은 공개해도 되는 "자물쇠" 쪽입니다. `/root/.ssh/broad_deploy`(`.pub` 없는 파일)는 열쇠이니 절대 밖으로 꺼내지 마세요.

**3-2. GitHub 에 등록 (브라우저에서)**
1. https://github.com/tyad0808/broad-intranet → **Settings** → 왼쪽 **Deploy keys** → **Add deploy key**
2. Title: `iwinv 서버`, Key: 복사한 줄 붙여넣기
3. **Allow write access 는 체크하지 마세요** (서버는 읽기만)
4. **Add key**

**3-3. 내려받기 (서버에서)**
```bash
git clone -c core.sshCommand="ssh -i /root/.ssh/broad_deploy -o StrictHostKeyChecking=accept-new" git@github.com:tyad0808/broad-intranet.git /opt/broad-intranet/app
```
`Receiving objects: 100%` 가 나오면 성공입니다.

---

## 4. 설치 (서버에서, 5~10분)

먼저 주소 연결이 끝났는지 확인합니다.
```bash
getent hosts intranet.broadstore.co.kr
```
`49.247.133.38  intranet.broadstore.co.kr` 이 나오면 준비 완료. 아무것도 안 나오면 1번이 아직 반영되지 않은 것이니 조금 기다리세요.

```bash
bash /opt/broad-intranet/app/deploy/setup.sh intranet.broadstore.co.kr
```

끝나면 `설치 완료` 상자와 함께 **네이버에 등록할 IP** 가 표시됩니다.

---

## 5. 관리자 계정 만들기 (서버에서)

```bash
cd /opt/broad-intranet/app && sudo -u intranet npm run create-admin
```
내 PC 에서 연습할 때와 같습니다. 이메일, 이름, 비밀번호 입력.

---

## 6. 접속 확인

- PC 와 **휴대폰**(와이파이를 끄고 LTE 로도)에서 `https://intranet.broadstore.co.kr`
- 주소창에 자물쇠 🔒 가 보이면 HTTPS 정상
- 처음 접속 때 "안전하지 않음"이 잠깐 보이면 1~2분 뒤 새로고침 (인증서 발급 중)

---

## 7. 네이버 연결 (실제 주문 수집 시작)

1. **네이버 커머스 API센터** → 내 애플리케이션 → **API 호출 IP** 에 4번에서 표시된 IP(`49.247.133.38` 예상) 등록
2. 애플리케이션 ID / 시크릿 확인
3. 서버에서 설정 파일 열기
   ```bash
   nano /opt/broad-intranet/app/.env
   ```
   아래 세 줄을 고칩니다 (화살표 키로 이동).
   ```
   ORDER_SOURCE=naver
   NAVER_CLIENT_ID=발급받은ID
   NAVER_CLIENT_SECRET=발급받은시크릿
   ```
   저장: `Ctrl + O` → Enter, 나가기: `Ctrl + X`
4. 재시작
   ```bash
   systemctl restart broad-intranet
   ```
5. 인트라넷 **관리자 → 주문 수집 → 지금 수집**. "성공"과 함께 최근 3일 주문이 들어오면 완료입니다.
   "실패"가 나오면 비고 칸의 내용을 알려주세요.

---

## 8. 발주확인·발송처리 켜기 (2차)

처음에는 **연습 모드**(`NAVER_WRITE=off`)입니다. 버튼을 눌러도 네이버로 보내지 않고 기록만 남습니다.

1. 업데이트 후 연습 모드에서 버튼·확인창·처리 기록이 잘 보이는지 확인
2. 설정 파일 열기: `nano /opt/broad-intranet/app/.env`
   - `NAVER_WRITE=off` 줄이 있으면 `on` 으로 바꾸고, 없으면 맨 아래에 `NAVER_WRITE=on` 을 추가
3. 재시작: `systemctl restart broad-intranet`
4. 확인: `journalctl -u broad-intranet -n 5 --no-pager` 에 `실제로 네이버에 보냄` 이 보이면 켜진 것
5. **처음에는 주문 1건만** 발주확인 → 발송처리 해 보고, 판매자센터에서 택배사·송장번호가 맞게 들어갔는지 확인
6. 문제가 생기면 2번에서 다시 `off` 로 바꾸고 재시작

---

## 9. 쿠팡 연결 (3차, 조회만)

1. 쿠팡 Wing → 추가판매정보 → **OPEN API 키 발급** (업체코드·Access Key·Secret Key)
2. 서버에서 설정 파일 열기: `nano /opt/broad-intranet/app/.env`
3. 맨 아래에 세 줄 추가 (= 뒤에 값을 붙여넣기, 띄어쓰기·따옴표 없이)
   ```
   COUPANG_VENDOR_ID=업체코드
   COUPANG_ACCESS_KEY=액세스키
   COUPANG_SECRET_KEY=시크릿키
   ```
   저장: `Ctrl + O` → Enter, 나가기: `Ctrl + X`
4. 재시작: `systemctl restart broad-intranet`
5. 인트라넷 **↻ 지금 수집** → "수집 완료" 면 성공. "일부 채널 수집 실패 (쿠팡: …)" 가 나오면 그 문구를 알려주세요.
6. 문제가 생기면 `.env` 에 `COUPANG=off` 한 줄을 넣고 재시작하면 쿠팡만 꺼집니다 (스마트스토어는 그대로).

### 쿠팡 발주확인(상품준비중)·송장 업로드 켜기

처음에는 연습 모드입니다. 연습 모드에서 버튼·확인창·처리 기록을 확인한 뒤:
```bash
sed -i '/^COUPANG_WRITE=/d' /opt/broad-intranet/app/.env && echo 'COUPANG_WRITE=on' >> /opt/broad-intranet/app/.env && systemctl restart broad-intranet
```
처음에는 **쿠팡 주문 1건만** 처리해 보고 Wing 에서 상품준비중·송장이 맞게 들어갔는지 확인하세요.
되돌리기: `sed -i 's/^COUPANG_WRITE=on/COUPANG_WRITE=off/' /opt/broad-intranet/app/.env && systemctl restart broad-intranet`

---

## 10. 자사몰 연결 (조회 + 발주확인·송장 등록)

자사몰 API(broad-quote 의 mall-api)가 같은 서버에서 돌고 있으므로 서버 안쪽 주소로 부른다.

1. 주문 권한 인증키 만들기 (키는 이때 한 번만 화면에 나옴 — 캡처하지 말 것)
   ```bash
   cd /opt/broad-quote && sudo -u broadquote node apiKeys.js add 인트라넷주문수집 --scopes orders --ip 127.0.0.1
   ```
2. `nano /opt/broad-intranet/app/.env` → 맨 아래에 `GODO_API_KEY=` 를 치고 그 뒤에 키 붙여넣기 → 저장
3. `systemctl restart broad-intranet` → 인트라넷 **↻ 지금 수집**
4. 잠시 끄려면 `.env` 에 `GODO=off`

### 자사몰 발주확인·송장 등록 켜기

자사몰 API 의 처리 기능(자사몰 관리자와 같은 처리 코드로 실행 → **고객에게 알림톡·SMS 가 실제로 나감**)을 쓴다.

1. 처리용 인증키 만들기 (조회 키와 따로, 한 번만 화면에 나옴 — 캡처하지 말 것)
   ```bash
   cd /opt/broad-quote && sudo -u broadquote node apiKeys.js add 인트라넷주문처리 --scopes orders:write --ip 127.0.0.1
   ```
2. `nano /opt/broad-intranet/app/.env` → 맨 아래에 `GODO_WRITE_KEY=` 를 치고 그 뒤에 키 붙여넣기 → 저장
3. 연결 확인 (택배사 목록만 읽음, 주문은 바꾸지 않음)
   ```bash
   cd /opt/broad-intranet/app && sudo -u intranet npm run godo-check
   ```
   `연결 정상` 과 로젠택배·경동택배에 ✓ 가 나오면 OK
4. `systemctl restart broad-intranet` → 자사몰 주문에서 버튼을 눌러 **연습 모드**로 먼저 확인 (처리 기록에 '연습' 으로 남음)
5. 실제로 보내려면 `.env` 에 `GODO_WRITE=on` 추가 → `systemctl restart broad-intranet`
   처음에는 본인 테스트 주문으로 발주확인 → 송장 등록까지 해 보고, 자사몰 관리자에서 상태·송장이 맞게 들어갔는지 확인

---

## 11. 문의함 — 네이버메일·지메일 연결

메일 비밀번호가 아니라 각 메일에서 발급하는 **앱 비밀번호**를 쓴다 (화면 캡처 금지, `.env` 에만).

1. 네이버메일: 네이버 메일 → 환경설정 → **POP3/IMAP 설정** → IMAP/SMTP **사용함** 저장
   → 네이버 내정보 → 보안설정 → **2단계 인증** 켠 뒤 **애플리케이션 비밀번호** 발급
2. 지메일: 구글 계정 → 보안 → **2단계 인증** 켜기 → **앱 비밀번호** 발급
   (지메일 설정 → 전달 및 POP/IMAP → IMAP 사용 확인)
3. `nano /opt/broad-intranet/app/.env` 맨 아래에
   ```
   NAVER_MAIL_USER=아이디@naver.com
   NAVER_MAIL_PASS=네이버_앱_비밀번호
   GMAIL_USER=아이디@gmail.com
   GMAIL_PASS=구글_앱_비밀번호
   ```
   같은 종류를 하나 더 연결하려면 번호를 붙여서 (최대 5개씩):
   ```
   NAVER_MAIL2_USER=두번째아이디@naver.com
   NAVER_MAIL2_PASS=그_계정의_앱_비밀번호
   ```
4. `systemctl restart broad-intranet` → 인트라넷 위쪽 **문의함** → **↻ 지금 받기** (처음엔 최근 30일치)
5. 답장을 실제로 보내려면 `.env` 에 `MAIL_SEND=on` → 재시작. 그 전에는 연습 모드

---

## 12. 문의함 — 스마트스토어 상품문의

1. 커머스API센터 → 내 애플리케이션 → API 그룹에서 **'문의'** 를 [추가]
2. 업데이트 후 점검 (읽기만): `cd /opt/broad-intranet/app && sudo -u intranet npm run naver-inquiry-check`
   → `✓ 문의 N건` 이 나오면 OK. 실패하면 그 줄을 확인
3. `systemctl restart broad-intranet` → 문의함에 '스마트스토어' 출처가 생기고 상품문의가 들어온다 (처음엔 최근 30일)
4. 답변을 실제로 등록하려면 `.env` 에 `NAVER_ANSWER=on` → 재시작 (그 전에는 연습 모드)

---

## 13. 문의함 — 쿠팡 문의 (상품별 고객문의 · 고객센터 문의)

1. `.env` 에 `COUPANG_WING_ID=WING로그인아이디` (비밀번호 아님, 답변할 때 '누가 답했는지' 로 필요)
2. 점검 (읽기만): `cd /opt/broad-intranet/app && sudo -u intranet npm run coupang-inquiry-check`
3. `systemctl restart broad-intranet` → 문의함 🛒 쇼핑몰 문의 탭에 '쿠팡' 출처 (처음엔 최근 30일, 7일씩 나눠 읽음)
4. 답변을 실제로 등록하려면 `.env` 에 `COUPANG_ANSWER=on` → 재시작 (그 전에는 연습 모드)

## 14. 문의함 — 자사몰 문의 (1:1 문의 · 상품 문의 · 견적 문의)

1. 견적 프로젝트 쪽에서 기존 키에 권한 더하기 (키는 그대로라 인트라넷 `.env` 는 안 바뀜):
   `cd /opt/broad-quote && sudo -u broadquote node apiKeys.js grant 주문수집 inquiries` /
   `sudo -u broadquote node apiKeys.js grant 주문처리 inquiries:write` (이름은 `node apiKeys.js list` 로 확인)
2. 점검 (읽기만): `cd /opt/broad-intranet/app && sudo -u intranet npm run godo-inquiry-check`
3. `systemctl restart broad-intranet` → 문의함 🛒 쇼핑몰 문의 탭에 '자사몰' 출처 (처음엔 최근 30일)
4. 답변을 실제로 등록하려면 `.env` 에 `GODO_ANSWER=on` → 재시작 (그 전에는 연습 모드)

---

## 평소에 쓰는 명령어 (서버에서)

| 하고 싶은 일 | 명령어 |
|---|---|
| 새 코드로 업데이트 | `bash /opt/broad-intranet/app/deploy/update.sh` |
| 인트라넷이 켜져 있는지 | `systemctl status broad-intranet` (q 로 나가기) |
| 최근 기록(오류 확인) | `journalctl -u broad-intranet -n 50 --no-pager` |
| 재시작 | `systemctl restart broad-intranet` |
| 지금 바로 백업 | `systemctl start broad-intranet-backup` |
| 백업 목록 | `ls -lh /var/lib/broad-intranet/backups` |

- 백업은 매일 새벽 3시 자동, 14일치 보관, 압축(.db.gz) 저장 (`/var/lib/broad-intranet/backups`)
- 서버가 재부팅돼도 인트라넷은 자동으로 다시 켜집니다
- 보안 업데이트는 매일 자동 설치됩니다

## 백업에서 되살리기 (사고가 났을 때만)

```bash
systemctl stop broad-intranet
cp /var/lib/broad-intranet/intranet.db /var/lib/broad-intranet/intranet.db.before-restore
# 백업은 압축(.db.gz)되어 있으므로 풀어서 넣는다 (예전 .db 백업이면 cp 로 복사)
gunzip -c /var/lib/broad-intranet/backups/intranet-날짜-시각.db.gz > /var/lib/broad-intranet/intranet.db
rm -f /var/lib/broad-intranet/intranet.db-wal /var/lib/broad-intranet/intranet.db-shm
chown intranet:intranet /var/lib/broad-intranet/intranet.db
systemctl start broad-intranet
```
