---
paths:
  - "src/logen.js"
  - "src/channels/logen.js"
  - "scripts/logen-check.js"
  - "src/views/admin/logen.ejs"
  - "src/views/partials/logen-card.ejs"
  - "test/logen*.test.js"
---
# 로젠택배 API 규칙 (로젠 안내 메일 기준 — 어기면 이용이 막힐 수 있음)

- **허락된 API 5개만** 부른다: `contractTotalInfo`, `contPickFares`, `registerOrderData`, `inquirySlipNoMulti`, `inquiryCargoTrackingMulti`. "안내 메일에 언급되지 않은 API는 절대 호출하지 마시기 바랍니다."
- 한 번에 **10건 정도**, **동기·순차**로, 호출 사이에 **몇 초** 쉰다 (`createLogen({ gapMs: 3000 })` 의 줄 세우기).
- SecretKey 는 `.env` 의 `LOGEN_SECRET_KEY` 에만. 거래처코드는 `LOGEN_CUST_CD` — 개발 서버에서도 **우리 거래처코드**를 보낸다 (공개 테스트 코드 X).
- 자체 송장 출력 API 는 없다. 출력은 **iLOGEN 에서만**. iLOGEN 화면을 자동으로 조작하거나 긁어오지 않는다 (링크 버튼만 둔다).
- 로젠 API 는 "계약된 화주사가 주문을 등록하는 용도로만" 쓴다.
- 개발 서버(`LOGEN_ENV` ≠ prod)에는 실제 고객 정보 대신 연습용 받는 분을 보낸다. 보내는 분은 설정에 저장한 실제 값.
- 실제 등록은 `LOGEN_WRITE=on` 일 때만. 자동 발송처리는 관리자가 켤 때까지 꺼 둔다.
