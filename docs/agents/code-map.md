# 코드 지도 (어디를 보면 되나)

작업을 시작할 때 **이 표부터** 보고 해당 파일로 바로 간다. 더 넓게 찾을 때는 `graphify-out/GRAPH_REPORT.md` (Graphify 코드 그래프 요약, 사용자 요청 2026-11).

## 기능 → 파일

| 기능 | 라우트·로직 | 화면 (EJS) | 브라우저 JS | 테스트 |
| --- | --- | --- | --- | --- |
| 주문 목록·거르기·한 줄 보기 | `src/routes/orders.js`, `src/orderColumns.js` (칸 순서·너비) | `orders/list.ejs`, `partials/multi-pick.ejs`, `partials/order-line.ejs`, `partials/ship-overview.ejs` | `orders.js` (메모·체크·mpick), `col-resize.js` (칸 너비 끌기), `chip-order.js` | `test/orders.test.js` |
| 주문 상세·시안·작업지시서 | `src/routes/orders.js`, `src/proofs.js` | `orders/detail.ejs`, `proof-maker.ejs`, `work-sheet.ejs`, `print.ejs` | `proof-maker.js`, `proof-paste.js`, `print.js` | `orders.test.js`, `proofs.test.js` |
| 발주확인·발송처리 (판매처로 보내기) | `src/actions.js`, `src/channels/*` (`*Client.js` 허용 목록) | `orders/bulk-*.ejs` | | `actions.test.js`, `esm.test.js`, `coupang.test.js` |
| 주문 수집 | `src/collector.js`, `src/channels/{smartstore,coupang,esm,godo}.js` | `admin/collect.ejs` | | `collect.test.js` |
| 로젠 송장 | `src/logen.js`, `src/channels/logen.js` | `partials/logen-card.ejs`, `admin/logen.ejs` | | `logen.test.js`, `logenFlow.test.js` |
| 홈 (오늘 할 일) | `src/routes/home.js` | `home.ejs` | `home.js` | `home.test.js` |
| 문의함·메일함·톡톡 | `src/routes/inbox.js`, `src/inbox/*` | `inbox/*.ejs`, `partials/customer-history.ejs` | `inbox.js`, `inbox-pane.js`, `talk-room.js`, `macro-picker.js` | `inbox.test.js`, `talktalk.test.js` |
| 매크로 (답장 문구) | `src/macros.js`, `src/routes/templates.js` | `templates*.ejs` | `templates.js` | `templates.test.js` |
| 일정 (달력) | `src/routes/calendar.js`, `src/events.js`, `src/schedule.js` | `schedule.ejs`, `partials/calendar*.ejs` | `calendar.js` | `calendar.test.js` |
| 휴가 | `src/leave.js` (일수 계산·연차수당), `src/routes/leave.js` | `leave.ejs`, `admin/leave.ejs` | `leave.js` | `leave.test.js` |
| 공지 팝업 | `src/routes/notices.js` | `notices.ejs`, `admin/notices.ejs`, 팝업은 `partials/footer.ejs` | `modal.js` | `notices.test.js` |
| 통계·주간 보고 | `src/stats.js`, `src/routes/stats.js`, `src/weeklyReport.js`, `src/reportPdf.js` | `stats.ejs`, `partials/stats-staff.ejs` | `stats.js` | `stats.test.js`, `weeklyReport.test.js` |
| 관리자 (직원·연봉·직무·단계·출처·칸·알림·저장공간) | `src/routes/admin.js` | `admin/*.ejs`, 탭 묶음 `partials/admin-tabs.ejs` | `admin-*.js` | `admin.test.js` |
| 판매처 연결 (키 넣기) | `src/channelRegistry.js`, `src/routes/channels.js` | `admin/channels.ejs` | | `channels.test.js` |
| 메일 계정 | `src/routes/mailAccounts.js`, `src/inbox/mailRegistry.js` | `admin/mail.ejs` | | `mailAccounts.test.js` |
| 회사 이름·로고·메뉴·업무 매뉴얼 | `src/brand.js` (NAV_ITEMS), `src/routes/manual.js` | `partials/header.ejs`, `admin/brand.ejs` | `manual.js` | `brand.test.js` |
| 사용 방법 (안내서) | `src/guide.js` | `guide.ejs` ← `docs/guide.md`, 그림 `public/guide-img/` | | `guide.test.js` |
| 로그인·권한·CSRF | `src/auth.js` (loadUser 의 users 칸 목록, requireAdmin/Manager, csrf) | `login.ejs`, `signup.ejs` | | `auth.test.js`, `roles.test.js`, `security.test.js` |
| 앱 조립·라우트 순서·res.locals | `src/app.js` (마운트 순서 중요: `/admin/leave` 는 requireAdmin 보다 먼저) | | | |
| DB 표·칸 (더하기만) | `src/db.js` (`addColumn`) | | | |
| 설정값 | `getSetting`/`setSetting` (`src/collector.js`) | | | |
| 비밀값 암호화 | `src/secretBox.js` | | | |
| 백업·보관 기간 | `src/storage.js`, `src/retention.js`, `deploy/*.sh` | `admin/storage.ejs` | | `ops.test.js` |

## CSS (`public/style.css`, 어두운 화면은 `public/dark.css`)

줄 번호는 바뀌므로 아래 **머리 주석**으로 찾는다 (`/* ───────── 이름`).

- 주문 목록 표: `주문 목록: 표처럼 한 줄씩` · 한 줄 보기: `주문 목록: 한 줄 보기 (body.orders-line` · 메모 칸: `주문 목록: 작업 메모 칸`
- 거르기 줄: `거르기 줄` · 한눈에 보기: `주문: 한눈에 보기`
- 주문 상세: `주문 상세 (리뉴얼)` · 문의함: `문의함·메일함 (리뉴얼)` · 톡톡: `톡톡 목록`, `톡톡 대화방`
- 홈: `홈 (오늘 할 일)` · 공지: `회사 공지 팝업` · 휴가: `휴가` · 통계: `통계` · 일정: `일정 (달력)`
- 새 디자인 `body.ds-v2` 규칙은 `.ds-v2` 로 검색

## 확인 도구

- 화면 캡처: 테스트 서버(`startServer` + 가짜 주문)를 Playwright 로 띄워 찍는다. 예시 데이터 이름은 `.claude/rules/guide.md` 규칙대로.
- 테스트 하나만: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="이름 일부" test/파일.test.js`
- 전체: `npm test` (약 2분)

## Graphify 다시 만들기

코드가 많이 바뀌면 그래프를 새로 만든다 (AI 호출 없음, 1분 안).

```
python3 -m venv /tmp/gfy && /tmp/gfy/bin/pip install -q graphifyy
/tmp/gfy/bin/graphify update .
```

`graphify-out/` 중 `GRAPH_REPORT.md` 만 git 에 올린다 (graph.json·graph.html 은 크고 매번 바뀜).
