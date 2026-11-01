# 올리기·배포

- 작업은 `main` 에 커밋하고 push 한다 (저장소 tyad0808/broad-intranet). 큰 실험은 브랜치에서 하고 사용자가 보고 나서 합친다.
- push 가 네트워크 오류로 실패하면 2·4·8·16초 쉬며 다시 시도한다.
- 서버: iwinv Ubuntu, 앱 위치 `/opt/broad-intranet/app`, 주소 https://intranet.broadstore.co.kr
- 사용자에게 안내할 업데이트 명령:
  ```
  bash /opt/broad-intranet/app/deploy/update.sh
  ```
  (백업 → git pull → npm ci → `systemctl restart broad-intranet`). CSS·JS 를 바꿨으면 브라우저에서 **Ctrl+F5** 도 안내.
- **업데이트 명령을 줄 때는 늘 되돌리기 명령도 함께 준다** (사용자 요청):
  ```
  bash /opt/broad-intranet/app/deploy/rollback.sh
  ```
  바로 전 업데이트 전 코드로 돌아간다 (서버 git reflog 의 pull 기록 기준, 바뀌는 내용 보여 주고 y 확인, DB 는 되돌리지 않고 백업만). 한 번 더 실행하면 한 단계 더 전으로, 다시 최신은 update.sh.
- 그래서 DB 바꾸기는 **칸·표를 더하기만** 한다 (지우거나 이름 바꾸지 않기) → 되돌린 예전 코드도 그대로 돈다.
