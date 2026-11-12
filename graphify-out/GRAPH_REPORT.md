# Graph Report - broad-intranet  (2026-11-12)

## Corpus Check
- 224 files · ~204,213 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 101 file(s) not represented in the graph (top: .woff2 92, .css 5, .otf 2)
- WARNING: 101 of 357 files seen (28%) have no supported extractor and are missing from this graph entirely. It may look complete while representing only part of the codebase.

## Summary
- 1535 nodes · 3355 edges · 116 communities (78 shown, 38 thin omitted)
- Extraction: 89% EXTRACTED · 11% INFERRED · 0% AMBIGUOUS · INFERRED: 357 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `979866cd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- routes/inbox.js
- godo.js
- esm.test.js
- logenFlow.test.js
- ops.test.js
- macros.js
- inbox.test.js
- routes/orders.js
- addUser
- 서버 설치 안내서 (iwinv · Ubuntu 24.04)
- server.js
- header.ejs
- app.js
- proofs.js
- package.json
- ref_node_assert
- src/auth.js
- db.js
- src/leave.js
- coupang.test.js
- createNotifier
- scripts
- collect.test.js
- transaction
- actions.js
- adminRoutes
- src/collector.js
- admin.js
- retention.js
- helpers.js
- src/stats.js
- smartstore.js
- applyOrders
- orders/detail.ejs
- brand.js
- channels.test.js
- naverClient.js
- orders/list.ejs
- coupangInquiry.test.js
- routes/calendar.js
- weeklyReport.js
- coupangClient.js
- stats.ejs
- SqliteSessionStore
- proof-maker.js
- inbox/detail.ejs
- 브로애드 통합관리 솔루션 직원 사용 안내서
- 2. 주문 보기
- channelRegistry.js
- live.js
- coupangInquiry.js
- home.ejs
- reportPdf.js
- coupang-order-check.js
- guide.js
- notices.js
- actions.test.js
- live.test.js
- routes/home.js
- Issue tracker: GitHub
- 3. 발주확인과 발송
- 5. 문의함과 메일함
- option-sample.js
- order-trace.js
- mailAccounts.test.js
- Agent skills
- Domain Docs
- 9. 관리자 메뉴 (관리자만)
- 사무실 NAS(시놀로지)로 인트라넷 백업 받기
- confirm.js
- setup.sh
- 1. 시작하기
- 6. 톡톡 상담
- upload.js
- channels.ejs
- templates.test.js
- weeklyReport.test.js
- nas-backup-setup.sh
- 7. 알림
- public/calendar.js
- 화면 디자인
- sync
- modal.js
- createCoupangClient
- users.ejs
- chat-list.ejs
- inbox/list.ejs
- communication.md
- git-deploy.md
- logen.md
- security.md
- terminology.md
- rollback.sh
- update.sh
- triage-labels.md
- talktalk-check.js

## God Nodes (most connected - your core abstractions)
1. `addUser()` - 59 edges
2. `orderRoutes()` - 56 edges
3. `startServer()` - 55 edges
4. `loginAs()` - 51 edges
5. `adminRoutes()` - 46 edges
6. `createApp()` - 44 edges
7. `openDb()` - 42 edges
8. `getSetting()` - 33 edges
9. `applyOrders()` - 29 edges
10. `inboxRoutes()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `코드 작성 규칙` --references--> `getSetting()`  [INFERRED]
  .claude/rules/code.md → src/collector.js
- `코드 작성 규칙` --references--> `setSetting()`  [INFERRED]
  .claude/rules/code.md → src/collector.js
- `코드 작성 규칙` --references--> `submit()`  [INFERRED]
  .claude/rules/code.md → test/helpers.js
- `사용 안내서 (사용자 요청, 2026-11)` --references--> `startServer()`  [INFERRED]
  .claude/rules/guide.md → test/helpers.js
- `코드 작성 규칙` --references--> `startServer()`  [INFERRED]
  .claude/rules/code.md → test/helpers.js

## Import Cycles
- None detected.

## Communities (116 total, 38 thin omitted)

### Community 0 - "routes/inbox.js"
Cohesion: 0.05
Nodes (61): digits(), groupSummaries(), historyForOrder(), nameKey(), ordersForInquiry(), PHONE_SQL(), phoneKey(), isMailSource() (+53 more)

### Community 1 - "godo.js"
Cohesion: 0.06
Nodes (44): fillGodoShipWay(), shipWayOf(), ALLOWED, createGodoClient(), request(), createGodoSource(), createGodoWriter(), perOrder() (+36 more)

### Community 2 - "esm.test.js"
Cohesion: 0.07
Nodes (36): STATUSES, claimPatch(), CLAIMS, createEsmSource(), orders(), createEsmWriter(), each(), ESM_COURIERS (+28 more)

### Community 3 - "logenFlow.test.js"
Cohesion: 0.07
Nodes (36): contract(), first(), keysOf(), step(), ALLOWED, BASE, createLogenClient(), request() (+28 more)

### Community 4 - "ops.test.js"
Cohesion: 0.06
Nodes (30): backup(), { DatabaseSync }, fs, mirrorProofs(), path, { pipeline }, zlib, fs (+22 more)

### Community 5 - "macros.js"
Cohesion: 0.08
Nodes (37): close(), filter(), insert(), setActive(), setSetting(), applyUpload(), CATEGORIES, clean() (+29 more)

### Community 6 - "inbox.test.js"
Cohesion: 0.08
Nodes (27): attachmentParts(), backfillMail(), createMailFiles(), createMailSender(), createMailSource(), defaultConnect(), dropScriptStyle(), EXT_TYPES (+19 more)

### Community 7 - "routes/orders.js"
Cohesion: 0.08
Nodes (34): orderShipWay(), shipWay(), CASH_USE, evidenceFor(), evidenceView(), phoneOf(), sheetView(), shipChoiceFor() (+26 more)

### Community 8 - "addUser"
Cohesion: 0.10
Nodes (27): 코드 작성 규칙, 사용 안내서 (사용자 요청, 2026-11), assert, setup(), test, addUser(), loginAs(), startServer() (+19 more)

### Community 9 - "서버 설치 안내서 (iwinv · Ubuntu 24.04)"
Cohesion: 0.05
Nodes (36): 10. 자사몰 연결 (조회 + 발주확인·송장 등록), 11. 문의함 — 네이버메일·지메일 연결, 12. 문의함 — 스마트스토어 상품문의, 13. 문의함 — 쿠팡 문의 (상품별 고객문의 · 고객센터 문의), 14. 문의함 — 자사몰 문의 (1:1 문의 · 상품 문의 · 견적 문의), 15. 채팅 — 네이버 톡톡 (챗봇 API, 1단계: 받기·알림·대화 보기), 16. 예전 메일 가져오기 (검색용, 한 번만), 17. 자사몰 예전 주문의 배송 방법 채우기 (한 번만) (+28 more)

### Community 10 - "server.js"
Cohesion: 0.07
Nodes (24): createCollector(), runOnce(), createProofs(), clamp(), intervalMinutes(), INTERVALS, startLoop(), actions (+16 more)

### Community 11 - "header.ejs"
Cohesion: 0.14
Nodes (3): ADMIN_GROUPS, THEME_LABEL, THEME_NEXT

### Community 12 - "app.js"
Cohesion: 0.14
Nodes (25): express, createApp(), crypto, express, helmet, path, session, isManager() (+17 more)

### Community 13 - "proofs.js"
Cohesion: 0.11
Nodes (23): addonLines(), cleanLabel(), crypto, customerRequests(), DEFAULT_TERMS, dueView(), EXT, fs (+15 more)

### Community 14 - "package.json"
Cohesion: 0.10
Nodes (24): dependencies, bcryptjs@^3.0.3, dotenv@^18.0.5, ejs@^6.0.1, express@^5.2.1, helmet@^8.3.0, imapflow@^2.5.5, mailparser@^3.9.46 (+16 more)

### Community 15 - "ref_node_assert"
Cohesion: 0.10
Nodes (15): assert, test, assert, QNA, test, assert, test, assert (+7 more)

### Community 16 - "src/auth.js"
Cohesion: 0.13
Nodes (21): ask(), askHidden(), lines, main(), originalWrite, readline, rl, attemptLogin() (+13 more)

### Community 17 - "db.js"
Cohesion: 0.12
Nodes (20): addColumn(), addMissingColumns(), { DatabaseSync }, DESIGN_STAGE_NAMES, fs, migrate(), moveShippedToLastStage(), openDb() (+12 more)

### Community 18 - "src/leave.js"
Cohesion: 0.21
Nodes (22): addMonths(), dailyWageOf(), daysOf(), fmtDays(), grantsOf(), isDate(), KINDS, kstToday() (+14 more)

### Community 19 - "coupang.test.js"
Cohesion: 0.13
Nodes (20): claimPatches(), createCoupangSource(), sheets(), createCoupangWriter(), DONE_STATUSES, kstDate(), kstIso(), money() (+12 more)

### Community 20 - "createNotifier"
Cohesion: 0.14
Nodes (14): claimLabel(), EventHub, createNotifier(), afterCollect(), checkNas(), checkStorage(), checkUnassigned(), claims() (+6 more)

### Community 21 - "scripts"
Cohesion: 0.09
Nodes (23): scripts, backup, coupang-check, coupang-inquiry-check, coupang-order-check, create-admin, dev, esm-check (+15 more)

### Community 22 - "collect.test.js"
Cohesion: 0.11
Nodes (12): createOrderSource(), ADDONS, ADDRESSES, createMockSource(), NAMES, PRODUCTS, createSmartstoreSource(), changedIds() (+4 more)

### Community 23 - "transaction"
Cohesion: 0.15
Nodes (16): importOldMail(), checkDispatchInput(), SHIP_METHODS, transaction(), listEditor(), express, MANUAL_SHIP_WAYS, manualRoutes() (+8 more)

### Community 24 - "actions.js"
Cohesion: 0.16
Nodes (19): canConfirm(), canDelay(), canDispatch(), CHANNEL_NAMES, checkDelayInput(), createOrderActions(), confirm(), delay() (+11 more)

### Community 25 - "adminRoutes"
Cohesion: 0.15
Nodes (15): getSetting(), COLUMNS, columnsCss(), DEFAULT_ORDER, loadColumns(), moveColumn(), readWidths(), saveColumns() (+7 more)

### Community 26 - "src/collector.js"
Cohesion: 0.13
Nodes (17): tidyOrders(), CHANNELS, channelStatusLabel(), CLAIM_STATUS, MANUAL_STATUS, normalizeSmartstoreUrl(), SMARTSTORE_STATUS, ALREADY_DONE (+9 more)

### Community 27 - "admin.js"
Cohesion: 0.13
Nodes (11): checkPattern(), clean(), fileLabel(), TOKEN_NAMES, TOKENS, labelPreview(), express, STATUS_LABELS (+3 more)

### Community 28 - "retention.js"
Cohesion: 0.20
Nodes (18): autoPersonalCleanup(), cleanupLog(), clearPersonal(), HIDE_CHOICES, hideCutoff(), hideDays(), KEEP_CHOICES, keepCutoff() (+10 more)

### Community 29 - "helpers.js"
Cohesion: 0.13
Nodes (13): assert, test, assert, PNG, test, browser(), request(), submit() (+5 more)

### Community 30 - "src/stats.js"
Cohesion: 0.22
Nodes (16): monthSales(), addDays(), express, kstDay(), quickRanges(), statsRoutes(), byChannel(), heatmap() (+8 more)

### Community 31 - "smartstore.js"
Cohesion: 0.21
Nodes (12): joinAddress(), memo(), money(), normalize(), toKstIso(), utcIso(), createNaverQnaSender(), createNaverQnaSource() (+4 more)

### Community 32 - "applyOrders"
Cohesion: 0.18
Nodes (13): applyOrders(), assert, fakeClient(), row(), setup(), test, assert, groupSetup() (+5 more)

### Community 33 - "orders/detail.ejs"
Cohesion: 0.12
Nodes (11): practice, waiting, allConfirmed, c, isToday, money, shipDueText, steps (+3 more)

### Community 34 - "brand.js"
Cohesion: 0.14
Nodes (13): createBrand(), load(), crypto, DEFAULT_NAV, imageType(), NAV_ITEMS, navOrderOf(), createSounds() (+5 more)

### Community 35 - "channels.test.js"
Cohesion: 0.18
Nodes (13): createChannelRegistry(), applyChannel(), keysOf(), view(), createChannelCollector(), createSecretBox(), crypto, parseKey() (+5 more)

### Community 36 - "naverClient.js"
Cohesion: 0.20
Nodes (13): ALLOWED, bcrypt, buildSignature(), createNaverClient(), getAccessToken(), request(), findAllowed(), isAllowed() (+5 more)

### Community 37 - "orders/list.ejs"
Cohesion: 0.12
Nodes (9): anyAction, assigneeOptions, designOptions, pickTexts, practiceChannels, stageKeep, stageOptions, chosen (+1 more)

### Community 38 - "coupangInquiry.test.js"
Cohesion: 0.18
Nodes (12): baseSubject(), createInboxCollector(), runOnce(), isMailSource(), linkMailThread(), createCoupangInquirySender(), createCoupangInquirySource(), withRo() (+4 more)

### Community 39 - "routes/calendar.js"
Cohesion: 0.29
Nodes (14): addDays(), backTo(), buildMonth(), buildWeek(), calendarRoutes(), editable(), COLORS, dueCountsBetween() (+6 more)

### Community 40 - "weeklyReport.js"
Cohesion: 0.29
Nodes (14): buildReport(), change(), send(), tick(), esc(), fillSubject(), fmt(), kstText() (+6 more)

### Community 41 - "coupangClient.js"
Cohesion: 0.21
Nodes (11): ALLOWED, buildAuthorization(), CoupangApiError, request(), crypto, findAllowed(), isAllowed(), parseJson() (+3 more)

### Community 42 - "stats.ejs"
Cohesion: 0.14
Nodes (3): designers, smax, STAFF_SRC

### Community 43 - "SqliteSessionStore"
Cohesion: 0.18
Nodes (4): express-session@^1.19.0, express-session, session, SqliteSessionStore

### Community 44 - "proof-maker.js"
Cohesion: 0.28
Nodes (10): bigCanvas(), clip(), draw(), hline(), render(), splitTail(), target(), text() (+2 more)

### Community 45 - "inbox/detail.ejs"
Cohesion: 0.17
Nodes (6): failed, macroCount, macroCount, block(), orderRow(), STATE

### Community 46 - "브로애드 통합관리 솔루션 직원 사용 안내서"
Cohesion: 0.17
Nodes (11): 10. 휴가 (월차·연차), 11. 회사 공지, 4. 수기 주문 (직접 등록), 8. 이럴 땐 이렇게, 공지 쓰기 (관리자), 등록하기, 등록한 뒤, 문제를 알릴 때 (+3 more)

### Community 47 - "2. 주문 보기"
Cohesion: 0.17
Nodes (12): 2. 주문 보기, 고객용 시안확정서 (JPG로 저장), 보고 싶은 단계만 체크해서 보기 (노션처럼), 보류 (고객이 잠깐 멈춰 달라고 할 때), 시안 올리기와 작업지시서, 여러 주문의 담당을 한 번에 정하기, 인쇄, 작업 메모 (목록에서 바로) (+4 more)

### Community 48 - "channelRegistry.js"
Cohesion: 0.18
Nodes (5): CHANNELS, tryKeys(), defaultFactories, testError(), withTimeout()

### Community 49 - "live.js"
Cohesion: 0.22
Nodes (5): beep(), refreshChat(), refreshChats(), refreshList(), synth()

### Community 50 - "coupangInquiry.js"
Cohesion: 0.31
Nodes (6): KINDS, listFrom(), normalizeInquiry(), pick(), repliesOf(), toIso()

### Community 51 - "home.ejs"
Cohesion: 0.18
Nodes (4): lists, mine, nick, todo

### Community 52 - "reportPdf.js"
Cohesion: 0.25
Nodes (8): pdfkit@^0.17.2, pdfkit, buildReportPdf(), C, crypto, FONT_DIR, path, PDFDocument

### Community 53 - "coupang-order-check.js"
Cohesion: 0.22
Nodes (6): { DatabaseSync }, db, key, orderIds, path, rows

### Community 54 - "guide.js"
Cohesion: 0.36
Nodes (8): cells(), escapeHtml(), fs, GUIDE_PATH, inline(), loadGuide(), path, renderGuide()

### Community 55 - "notices.js"
Cohesion: 0.42
Nodes (8): express, flash(), kstToday(), noticeAdminRoutes(), noticeRoutes(), popupNotice(), readForm(), safeBack()

### Community 56 - "actions.test.js"
Cohesion: 0.28
Nodes (6): assert, order(), setupDb(), setupServer(), SHIP, test

### Community 57 - "live.test.js"
Cohesion: 0.33
Nodes (8): assert, fakeHub(), listen(), liveSetup(), order(), orders(), setup(), test

### Community 58 - "routes/home.js"
Cohesion: 0.25
Nodes (6): BOX_WHERE, CHANNEL_NAMES, express, isoOf(), MAIL_KIND(), SHOP_CHANNEL

### Community 59 - "Issue tracker: GitHub"
Cohesion: 0.29
Nodes (6): Conventions, Issue tracker: GitHub, Pull requests as a triage surface, Wayfinding operations, When a skill says "fetch the relevant ticket", When a skill says "publish to the issue tracker"

### Community 60 - "3. 발주확인과 발송"
Cohesion: 0.29
Nodes (7): 3. 발주확인과 발송, G마켓·옥션 주문, 꼭 알아 둘 것, 발송이 늦어질 때 (스마트스토어), 자사몰 세금계산서·현금영수증, 택배 주문 처리 순서, 택배가 아닌 발송

### Community 61 - "5. 문의함과 메일함"
Cohesion: 0.29
Nodes (7): 5. 문의함과 메일함, 고객 이력, 담당자, 답장하기, 매크로(답장 문구) 넣기, 매크로 만들고 고치기, 목록 보기

### Community 62 - "option-sample.js"
Cohesion: 0.29
Nodes (5): channels, { DatabaseSync }, days, db, path

### Community 63 - "order-trace.js"
Cohesion: 0.29
Nodes (5): { DatabaseSync }, db, groups, key, path

### Community 64 - "mailAccounts.test.js"
Cohesion: 0.33
Nodes (6): assert, fakeConnect(), KEY, OTHER_KEY, setup(), test

### Community 65 - "Agent skills"
Cohesion: 0.33
Nodes (5): Agent skills, Domain docs, Issue tracker, Triage labels, 브로애드 통합관리 솔루션

### Community 66 - "Domain Docs"
Cohesion: 0.33
Nodes (5): Before exploring, read these, Domain Docs, File structure, Flag ADR conflicts, Use the glossary's vocabulary

### Community 67 - "9. 관리자 메뉴 (관리자만)"
Cohesion: 0.33
Nodes (6): 9. 관리자 메뉴 (관리자만), 메일 계정 끄기·다시 켜기, 업무 매뉴얼 링크, 연봉 · 예상 연차수당 (관리자만), 주문 목록 칸 순서, 직원 관리

### Community 68 - "사무실 NAS(시놀로지)로 인트라넷 백업 받기"
Cohesion: 0.33
Nodes (5): 1. 공유 폴더 만들기 (NAS), 2. 열쇠 만들기 (NAS, 한 번만), 3. 서버에 연결 허락하기 (서버, 한 번만), 4. 매일 가져오기 예약 (NAS), 사무실 NAS(시놀로지)로 인트라넷 백업 받기

### Community 69 - "confirm.js"
Cohesion: 0.53
Nodes (4): checkedChannels(), fill(), prepNote(), shipSummary()

### Community 70 - "setup.sh"
Cohesion: 0.60
Nodes (4): DEBIAN_FRONTEND, fail(), say(), setup.sh script

### Community 71 - "1. 시작하기"
Cohesion: 0.40
Nodes (5): 1. 시작하기, 로그인, 처음 한 번: 회원가입, 화면 구성, 화면 밝기 (다크모드)

### Community 72 - "6. 톡톡 상담"
Cohesion: 0.40
Nodes (5): 6. 톡톡 상담, 고객 메모, 답장 보내기, 상담 상태, 주문 연결

### Community 73 - "upload.js"
Cohesion: 0.50
Nodes (4): busboy@^1.6.0, busboy, busboy, replyUpload()

### Community 76 - "templates.test.js"
Cohesion: 0.40
Nodes (4): assert, fs, HEAD, test

### Community 77 - "weeklyReport.test.js"
Cohesion: 0.40
Nodes (3): assert, FRI_18, test

### Community 78 - "nas-backup-setup.sh"
Cohesion: 0.83
Nodes (3): fail(), say(), nas-backup-setup.sh script

### Community 79 - "7. 알림"
Cohesion: 0.50
Nodes (4): 7. 알림, 내 알림 켜고 끄기, 다른 창을 볼 때도 알림 받기, 어떤 알림이 누구에게 가나요

## Knowledge Gaps
- **1 isolated node(s):** `DEBIAN_FRONTEND`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 680 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **38 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `express` connect `app.js` to `routes/inbox.js`, `macros.js`, `routes/calendar.js`, `routes/orders.js`, `package.json`, `src/auth.js`, `src/leave.js`, `notices.js`, `transaction`, `routes/home.js`, `admin.js`, `src/stats.js`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `orderRoutes()` (e.g. with `routes/orders.js` and `canConfirm()`) actually correct?**
  _`orderRoutes()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `DEBIAN_FRONTEND` to the rest of the system?**
  _1 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `routes/inbox.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05311871227364185 - nodes in this community are weakly interconnected._
- **Why does `addUser()` connect `addUser` to `routes/inbox.js`, `godo.js`, `esm.test.js`, `logenFlow.test.js`, `ops.test.js`, `inbox.test.js`, `proofs.js`, `ref_node_assert`, `src/auth.js`, `db.js`, `src/leave.js`, `coupang.test.js`, `collect.test.js`, `helpers.js`, `applyOrders`, `channels.test.js`, `coupangInquiry.test.js`, `actions.test.js`, `live.test.js`, `mailAccounts.test.js`, `templates.test.js`, `weeklyReport.test.js`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `startServer()` (e.g. with `코드 작성 규칙` and `사용 안내서 (사용자 요청, 2026-11)`) actually correct?**
  _`startServer()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Should `godo.js` be split into smaller, more focused modules?**
  _Cohesion score 0.0647307924984876 - nodes in this community are weakly interconnected._