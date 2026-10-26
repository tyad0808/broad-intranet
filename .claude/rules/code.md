# 코드 작성 규칙

- 스택: Node 22 (`node:sqlite`), Express 5, EJS. 의존성은 꼭 필요할 때만 더한다.
- 주석·이름은 주변 코드처럼 **쉬운 한국어 주석**으로.
- 폼은 CSRF 토큰(`_csrf`)을 넣는다. 되돌리기 어려운 버튼은 `data-confirm`, 두 번 누르기 막기는 `data-once`.
- 설정값은 `getSetting` / `setSetting` (`src/collector.js`).
- 날짜 모양이 채널마다 다르다 (스마트스토어 `+09:00`, 수기 `Z`). 비교·정렬은 `datetime()` 으로 맞춘다 — `ORDER_TIME` (`src/retention.js`).
- 주문은 `(channel, channel_order_id)` 묶음 단위로 다룬다.
- 테스트: `npm test` 가 모두 통과해야 올린다. 화면 문구를 바꾸면 그 문구를 찾는 테스트도 같이 고친다. 도우미: `test/helpers.js` 의 `startServer`, `loginAs`, `submit`.
