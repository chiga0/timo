# Timo 实施里程碑与路线图

本文将 Timo 拆分为可逐段验证、以**尽快进入日常高频自用**为导向的实施里程碑。

**架构定案原则**：绝不自研 Agent Loop / Harness，不 Fork T3 Code；基于当前 `timo` 仓库自主演进事件驱动控制面、总助理分级委派授权、两级 Watchdog、自主多仓 Worktree、本地 Capability MCP Gateway 与极简黑白（Tailwind + shadcn/ui）Web 工作台，并通过统一 `ExecutionAdapter` 复用成熟外部运行时（Codex / OpenCode / Pi，以及保留为可选适配器的 T3 Code）。

**当前状态（2026-11-27）：Sprint 1–6（M0–M4 工程与度量体系）全部实现并验证通过（`npm run typecheck && npm run build && npm test` 159 项全通过）；本机四大常驻执行器（`pi 1.6.0`、`qwen-code 0.25.3`、`codex 0.149.1`、`opencode 1.19.6`）全部探测就绪，已完成 2 单真实 Web Dogfooding（含首单零干预 `completed` 独立验收合入 `dd06706`）与 1 次 `qwen-code → pi` 实机不可变交接留档（[M3 交接证据](m3-handoff-evidence.md)），并上线 M4 S07 效率度量（`GET /api/metrics`、`timo metrics`、Web 侧栏面板与 [M4 试用初报](m4-trial-report.md)）。真实外部平台双仓 MR/CI 与多周手工基线对照待目标用户在获准仓库日常使用中持续积累。** 关联文档：[README](../README.md)、[架构](architecture.md)、[领域模型](domain-model.md)、[技术设计](technical-design.md)、[执行器与 T3 决策](t3-adoption.md)、[托管开发任务书](implementation-plan.md)、[验收剧本](acceptance.md)、[产品设计 HTML](product.html)。

> **托管开发派发入口**：每个冲刺与里程碑已进一步拆解为可直接托管给外部 Agent 的原子任务包（含前置依赖、改动边界、禁止越界项、必含反例测试与可执行验收命令），详见 [托管开发任务书与逐阶段验收合同](implementation-plan.md)。

## 推进纪律

- 每次优先交付一条用户可操作、结果可独立核对的纵向切片；模拟器与真实适配器走同一条任务控制面，不造仅用于演示的旁路。
- 只有达到阶段退出条件并留存实际运行的检查与证据时，才更新对应状态；未验证项诚实保留为待验。
- 全树预算、期限与权限贯穿所有重试、Watchdog 会诊、换执行器与验收，绝不通过换 Runtime 重置额度。
- 凭据值与真实敏感业务数据绝不进入仓库、数据库或报告。

---

## M0：核实 T3 `v0.1.12` 外部接入边界（已通过）

**状态：PASS（2026-11-26）。** 固定发行资产 `v0.1.12`（`SHA256SUMS` 核验通过），在回环隔离实例上完成公开 OAuth MCP、只读身份拒绝、双仓 worktree、活动中断与继续、重启补查及 Codex → Pi 同线程交接探测。基于 M0 与 M1.3 的实机经验，确立了“不 Fork T3，将其定位为参考蓝本 + 可选外部 `T3Adapter`”的决策。详见 [T3 集成探测手册](t3-integration.md) 与 [执行器接入决策](t3-adoption.md)。

- [x] 核验 `v0.1.12` macOS arm64 发行资产、SHA-256 与运行版本；验证 OAuth 权限、双仓工作区、重启补查与请求去重。
- [x] 实测 Codex（`gpt-5.6-sol`）与 Pi（`pai-eas/qwen3.7-plus`）真实运行、活动中断、重启读回及跨 Provider 交接。
- [x] 固化最小 `T3Adapter` 合同与多仓/权限边界限制。

---

## M1：从本地 CLI 闭环演进到事件驱动控制面与极简黑白 Web 自用

### 已完成切片（M1.1–M1.6 工程闭环）

- [x] **M1.1 持久化接单**：单包 TS + SQLite WAL 迁移 + 幂等 `requestId` 去重与冲突退出码 4 + CLI `create/get` 与重启读回。
- [x] **M1.2 T3 MCP 适配器**：锁定 `@modelcontextprotocol/sdk` 1.32.2，完成 `launch / wait / read / stop`、错误分类与替换传输测试。
- [x] **M1.3 零仓 SSE 独立验收**：串起 `sse-v1` 独立重算验收器；并在隔离 T3 `v0.1.12` + Pi 上通过 `disconnect.log` 正例、重启原样读回、幂等冲突与 T3 拒绝路径验证。详细证据与待补项见 [M1.1–M1.3 开发合同](m1-delivery.md)。
- [x] **M1.4（Sprint 1）底座加固 + 事件驱动 HTTP/SSE 控制面**：修复 5 项底座缺陷（二进制制品、真实重启 `reconcile`、非阻塞并发池、原子锁与残留 `.sock` 自愈、通知去重与执行元信息回写）；引入 `task_events`、`TypedEventBus` 在线唤醒与 `outbox_jobs`；升级 `node:http`（Unix Socket + Loopback REST/SSE 分页断点续传）及 CLI `list` / `amend` / `stop`（含运行中实时中断与防复活）。
- [x] **M1.5（Sprint 2）极简黑白 Web 工作台 + 分级授权 + 一级 Watchdog**：实现 `StandingPolicy` 三层分级授权（Tier 0/1 总助理静默放行、Tier 2 红线挂起与批准原地恢复）、注意力防火墙 3 枚举白名单与 Inbox 结构化 `action` Upsert、两阶段 Amendment Diff 确认卡、一级 0-Token Watchdog（4 类检测与冷却去重），以及 React 19 + Vite 极简黑白三栏可折叠控制台（静态托管 + 实时 SSE + JSON 快照读取 + `⌘K` + 中文 IME 兼容）。
- [x] **M1.6（Sprint 3）自主 Worktree + 统一执行器（含 Live 运行流）+ 声明式 `VerificationPipeline` + 首单实机 Dogfooding（已通过）**：
  - `WorkspaceManager` 原生多仓 `git worktree`、精确 `baseSha` 与 manifest 持久化、缺分支整体回滚拒绝、脏目录回收保护、gitignored `node_modules` 符号链接隔离与独立验证干净检出（`materializeCleanCheckout`）；
  - 统一 `ExecutionAdapter` / `ExecutorRegistry`，接入本地常驻 **`QwenCodeAdapter`**（`qwen 0.25.3`，双向 `stream-json` 实时流 + `steer` + `--resume` + `--mcp-config httpUrl` 直连 Timo Capability MCP Gateway）、`PiAdapter`（`pi 1.6.0`）与 `T3ExecutionAdapter`；
  - Web 底部输入框与 CLI `timo create --repo` / `timo steer` / `timo executors` 代码交付入口；
  - **首单实机 Dogfooding（2026-11-27 `REAL`）**：通过 Timo 极简黑白 Web 页面（`http://127.0.0.1:8790`）向 `qwen-code` 下发 Sprint 5 Step 5.1 任务（`d7ae0ae6`），在独立 worktree 中完成 `src/workspace/handoff.ts`、`WorkspaceManager.handoff()` 与 `test/handoff.test.ts`（147/147 通过，提交 `96ef67a` → `6b8dfb7`），并在自用中即时定位并修复了 `100dvh` 顶部 46px 溢出、JSON 卡片横向溢出、Live 流自动滚底及 `node_modules/` symlink 忽略规则 4 项真实摩擦。

**M1 退出条件**：已达成（Web 实机自用闭环 + 实时运行流透视 + 强杀重启/并发/分级授权/一级 Watchdog 全部通过）。

---

## M2（Sprint 4）：Capability MCP Gateway + 多仓 MR/CI 0-Token 闭环（`FIXTURE` 通过，待 `REAL` 平台复核）

**依赖**：M1 退出条件通过；本地模拟平台可用；真实 MR/CI 操作依赖对应获准账号与网络。

### 可勾选切片

- [x] 上线本地 **Capability MCP Gateway**（基于 `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport`），路由 `/mcp/:taskId/:generation/:nonce`，作废代次即刻返回 `403 GENERATION_REVOKED`。
- [x] 实现 **工具可见性裁剪（Tool Visibility Pruning）**：`tools/list` 仅返回当前 `GrantRevision` / Tier 0 允许的工具，未授权发布工具隐藏且硬调被拒；`timo_request_grant` 支持 Tier 1 静默放行与 Tier 2 `Pause & Resume` 原地挂起。
- [x] 接入受控只读日志工具（含脱敏与体积上限）与 MR 创建/更新工具（含真实 `GhPlatformAdapter` 与测试 `FakePlatformAdapter`），真实凭据仅由网关进程持有，Worker 启动环境剥离敏感业务 Token（`buildIsolatedWorkerEnv`）。
- [x] 在网关内严格落实 `Intent-Before-Effect`：先持久化 `operations` 意图与稳定幂等键，按原 MR ID 与精确候选 `head SHA` 进行 0-Token 后台 `JOB_POLL_CI` 轮询；第 1 个 MR 成功后第 2 个失败重试不重复建第 1 个 MR；丢回执进入 `effect_unknown` 拒绝盲重发并通过 `/api/operations/:opId/reconcile` 核查恢复。
- [x] 在自主 `WorkspaceManager` 上串通前后端双仓修复 → 两个 MR → 两份 CI + 独立组合行为验收（`command_check` + `platform_mr`），Web 检查器接入「跨仓交付矩阵」与 `effect_unknown` 对账卡；显式标注 `productionDeployed: false`；任一仓新提交自动令旧证据失效。

**退出条件**：S01、S05、S06（及 S04 丢回执对账）`FIXTURE` 全套正反例自动化测试已全部通过（138/138）。因当前未连接获准真实试验双仓与真实 MR/CI 凭据，`REAL` 外部平台验收诚实记为待验，M2 保持「`FIXTURE` 通过 / 待 `REAL` 复核」状态。

---

## M3（Sprint 5）：不可变交接、二级 Watchdog 纠偏与未知效果对账（`FIXTURE` 通过，待 `REAL` 双执行器实机复核）

**依赖**：M2 的多仓交付、Capability MCP Gateway 与外部操作账本；至少两种已接入的原生执行器（本机已就绪 `qwen-code 0.25.3` 与 `pi 1.6.0`）。

### 可勾选切片

- [x] 实现 **不可变目录快照交接（`g1 → g2` worktree）**：新增 [handoff.ts](../src/workspace/handoff.ts) 与 `WorkspaceManager.handoff()`、`TaskService.handoffTask()`、`POST /api/tasks/:id/handoff` 与 Web 检查器「换执行器」入口；先作废 `g1` Fencing Token 并中断旧运行，将 `git diff`（含 staged + unstaged）与未跟踪文件（二进制安全）迁移至全新 `g2` worktree，生成协议无关的 **Handoff Capsule**（保留剩余预算、已有 MR/CI 与最新失败摘要，绝不重置额度）。
- [x] 验证“旧进程仍在 `g1` 持续写入或尝试调外部平台”反例（S02）：`g2` 字节零污染、`g1` Token 被网关以 HTTP `403 GENERATION_REVOKED` 拦截、`g1` 迟到验收回调被 `ignored_stale_generation` 拒绝。
- [x] 实现 **二级总助理 Watchdog 巡检与自动纠偏**：新增 [triage.ts](../src/watchdog/triage.ts)（`WatchdogTriageEngine`），监听 `watchdog_signal`，按上限先自动 `steer` 纠偏或触发 `g1 → g2` 换执行器，无法收敛时收敛为 1 张结构化 `decision_required`（`task_blocked_final`）求助卡并暂停任务，避免烧光预算。
- [x] 完整打通 `effect_unknown` 核对闭环（S04）：新增 `POST /api/operations/:opId/resolve` 与 Web 对账卡「重新向平台核查 / 人工确认不存在」双动作；丢回执重启后先查平台事实，可确认即关联继续，不可确认则停留 `effect_unknown` 绝不盲重发。
- [x] 完整验证主对话写操作 **Amendment Diff 确认卡**（S03）多任务隔离与过期版本冲突拒绝（151/151 自动化测试全通过）。

**退出条件**：S02、S03、S04、S08 全部 `FIXTURE` 正反例自动化测试已通过，且已完成 1 次真实 `qwen-code 0.25.3 → pi 1.6.0` 跨执行器交接与僵尸旧写者 `403 GENERATION_REVOKED` 实机留档（见 [M3 交接证据](m3-handoff-evidence.md)）；外部平台真实双 MR 延续部分待在获准试验仓复核。

---

## M4（Sprint 6）：日常真实试用与效率度量（工程度量与首批实机自用已上线，持续积累对照样本）

**依赖**：M1–M3 退出条件通过；用户同意的真实试用仓库与任务。

### 可勾选切片

- [x] 在 Timo 极简黑白 Web 中跑通真实研发自用（Dogfooding #1/#2，含首单零干预 `completed` 独立验收合入）及真实 `qwen-code → pi` 不可变交接（见 [M3 交接证据](m3-handoff-evidence.md) 与 [M4 试用初报](m4-trial-report.md)）。
- [x] 上线可持续采集的 S07 效率度量模块（[efficiency.ts](../src/metrics/efficiency.ts)、`GET /api/metrics`、`GET /api/tasks/:id/metrics`、`timo metrics` 与 Web 侧栏「效率度量（S07）」卡片，严格落实未计量费用标为 `unknown_unmetered` 绝不记零）。
- [x] 整理并修复首批试用暴露的 P0/P1/P2 缺陷（`node_modules/` symlink 验收隔离、`100dvh` 布局溢出、JSON 换行、Live 自动滚底、`pi 1.6.0` `message_end` 解析）。
- [ ] 在获准外部双仓与用户日常工作周内补齐 S01–S08 真实外网平台复核与「Timo vs 纯手工切终端」多样本 S07 同预算对照记录。

**退出条件**：本地研发自用主路径、度量体系与受控反例全部通过；外部平台双仓真实验证与大样本人工效率对照按诚实边界记为持续积累项。

---

## 后续拓展（由 M4 真实使用证据触发）

- 按高频需求接入更多原生执行器（如 Claude Code 等）及更多外部平台（工单、告警、容器诊断、受控发布）。
- 为项目 Runbook、个人偏好与事故经验补齐版本化知识挂载与修订路径。
- 需要笔记本休眠期间持续监听或内网路由时，引入获准的常在线执行端 / 守护节点。
- 仅在实测单负责人遇到独立工作面瓶颈时引入多执行器并行，仍纳入同一任务账本、总预算与注意力防火墙。
