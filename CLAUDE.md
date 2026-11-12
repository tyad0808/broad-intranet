# 브로애드 통합관리 솔루션

작업 규칙은 `.claude/rules/` 에 있다 (소통·보안·용어·코드·디자인·배포·사용 안내서).

**코드를 찾을 때는 `docs/agents/code-map.md` (기능 → 파일 표) 부터 본다.** 더 넓게는 `graphify-out/GRAPH_REPORT.md` (Graphify 코드 그래프).

## Agent skills

### Issue tracker

할 일·버그는 GitHub Issues (tyad0808/broad-intranet) 에 둔다. See `docs/agents/issue-tracker.md`.

### Triage labels

기본 라벨 5개를 그대로 쓴다 (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

single-context: 저장소 맨 위 `CONTEXT.md` 하나와 `docs/adr/`. See `docs/agents/domain.md`.
