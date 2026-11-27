# Changelog

All notable changes to **Timo** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Fixed Main Chat & True SSE Streaming**: Persistent global `User <-> Timo` conversation (`chat_messages`, `GET /api/chat`, `POST /api/chat/send`, `POST /api/chat/stop`, `GET /api/chat/stream`) with 0ms optimistic rendering, token-by-token CLI streaming (`pi`, `qwen-code`, `codex`), and zero-dependency XSS-safe Markdown rendering.
- **Single Live-Updating Task Card**: Background engineering tasks embed as a single compact card in Main Chat with live progress updates and direct actions (`Stop`, `Retry`, `Approve / Decline`, `Dismiss`).
- **Task Lifecycle Management**: SQLite migration `0008-task-management` adding custom title rename (`PATCH /api/tasks/:id`), archive/unarchive filtering (`GET /api/tasks?archived=exclude|only|all`), safe/force deletion (`DELETE /api/tasks/:id`) with worktree & run-stream cleanup, explicit task retry (`POST /api/tasks/:id/retry`), and inbox dismissal (`POST /api/inbox/:taskId/:decisionKey/dismiss`).
- **Unified Workspace & Local Provider Discovery**: Equal-peer local workspace folder registry with native macOS folder picker, parent-directory repo auto-scan, Timo-managed Worktree overview & cleanup, automatic CLI provider/model discovery (`GET /api/executors/providers`), local Git/SSH/`gh` auth detection, isolated `0600` credentials vault (`~/.timo/credentials.json`), and `EnterpriseGitPlatformAdapter`.
- **Open-Source Standards & Guardrails**: GitHub Actions CI (`.github/workflows/ci.yml`), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.env.example`, `.editorconfig`, Issue/PR templates, bilingual `README.md` / `README_EN.md`, and automated product invariant tests.

### Changed
- **Actionable-Only Inbox ("待我处理")**: Pinned to the top of the sidebar and strictly scoped to items requiring human decision or intervention (red-line approvals, blocked failures, unknown external effects); completed deliveries no longer create manual confirmation todos.
- **Refined Monochrome Web Workbench**: Centered `⌘K` search, grouped Settings navigation (`General / Development / System`), official agent logos with labels, collapsible structured verification failure summaries, and sleek non-disruptive offline/reconnecting banner.

### Fixed
- Clean-checkout independent verification (`VerificationPipeline`) now symlinks read-only `node_modules` (root and 1-level workspace subpackages) during `command_check` and unlinks them cleanly in `finally`, preventing false `tsc: command not found` failures.
- Graceful `Ctrl+C` shutdown in `timo serve` interrupts live executor child processes within a bounded timeout and exits immediately on second `SIGINT`.
- Fixed `package.json` `bin.timo` path (`dist/src/cli.js`) and sanitized local absolute paths & non-public terms across documentation.

## [0.1.0] - 2026-11-26

### Added
- Event-driven SQLite WAL control plane (`task_events`, `TypedEventBus`, `outbox_jobs`) with Unix socket CLI and token-authenticated loopback HTTP/SSE API.
- Three-tier `StandingPolicy` authorization, two-phase `Amendment Diff` proposals, and Level-1/Level-2 Watchdog triage.
- Autonomous multi-repo `WorkspaceManager` (`git worktree`) with immutable `g1 -> g2` snapshot handoff and `HandoffCapsule`.
- Local **Capability MCP Gateway** with tool visibility pruning, generation Fencing Tokens (`403 GENERATION_REVOKED`), physical credential isolation, and `Intent-Before-Effect` external operations.
- Native `ExecutionAdapter` integrations for `pi`, `qwen-code`, `codex`, `opencode`, and optional `t3`.
- Declarative `VerificationPipeline` (`command_check`, `platform_mr`, `log_citation`) and S07 efficiency metrics (`GET /api/metrics`, `timo metrics`).
