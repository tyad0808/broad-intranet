# 비밀값·보안

- API 키·비밀번호는 **서버의 `.env` 에만** 둔다. 코드에 쓰거나 git 에 올리지 않는다 (`.env` 는 `.gitignore` 에 있음). 새 키가 생기면 `.env.example` 에 빈 칸과 설명만 더한다.
- 키·비밀번호를 채팅으로 받지 않는다. 사용자에게 `.env` 화면을 캡처하지 말라고 안내한다.
- **자사몰 서버는 건드리지 않는다.** 자사몰 API 는 견적 프로젝트 쪽에서 만든 것을 읽기만 한다.
- 바깥 API 는 허용 목록에 있는 주소만 부른다 (`src/channels/naverClient.js` `ALLOWED`, `coupangClient.js`, `logen.js`). 주소를 더하면 `test/collect.test.js` 의 허용 목록 테스트도 함께 고친다.
- 상태를 바꾸는 호출(발주확인·발송처리·답변·로젠 등록)은 `.env` 의 `*_WRITE=on` / `*_ANSWER=on` 일 때만 실제로 보낸다. 아니면 연습 모드(기록만).
