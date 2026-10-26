# 올리기·배포

- 작업은 `main` 에 커밋하고 push 한다 (저장소 tyad0808/broad-intranet). 큰 실험은 브랜치에서 하고 사용자가 보고 나서 합친다.
- push 가 네트워크 오류로 실패하면 2·4·8·16초 쉬며 다시 시도한다.
- 서버: iwinv Ubuntu, 앱 위치 `/opt/broad-intranet/app`, 주소 https://intranet.broadstore.co.kr
- 사용자에게 안내할 업데이트 명령:
  ```
  bash /opt/broad-intranet/app/deploy/update.sh
  ```
  (백업 → git pull → npm ci → `systemctl restart broad-intranet`). CSS·JS 를 바꿨으면 브라우저에서 **Ctrl+F5** 도 안내.
