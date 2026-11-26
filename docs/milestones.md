# Timo 实施里程碑与路线图

本文将 Timo 拆分为可逐段验证、以**尽快进入日常高频自用**为导向的实施里程碑。

**架构定案原则**：绝不自研 Agent Loop / Harness，不 Fork T3 Code；基于当前 `timo` 仓库自主演进事件驱动控制面、总助理分级委派授权、两级 Watchdog、自主多仓 Worktree、本地 Capability MCP Gateway 与极简黑白（Tailwind + shadcn/ui）Web 工作台，并通过统一 `ExecutionAdapter` 复用成熟外部运行时（Codex / OpenCode / Pi，以及保留为可选适配器的 T3 Code）。

**当前状态（2026-11-26）：M0、M1.1–M1.5（Sprint 1–2）均已通过工程与构建验收（`npm run typecheck && npm run build && npm test` 103 项全通过）；即将启动 Sprint 3（M1.6：自主 Worktree + 原生 CLI 适配器 + 真实单测验收，开启 Timo 自用）。** 关联文档：[README](../README.md)、[架构](architecture.md)、[领域模型](domain-model.md)、[技术设计](technical-design.md)、[执行器与 T3 决策](t3-adoption.md)、[托管开发任务书](implementation-plan.md)、[验收剧本](acceptance.md)、[产品设计 HTML](product.html)。

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

### 已完成切片（M1.1–M1.5）

- [x] **M1.1 持久化接单**：单包 TS + SQLite WAL 迁移 + 幂等 `requestId` 去重与冲突退出码 4 + CLI `create/get` 与重启读回。
- [x] **M1.2 T3 MCP 适配器**：锁定 `@modelcontextprotocol/sdk` 1.32.2，完成 `launch / wait / read / stop`、错误分类与替换传输测试。
- [x] **M1.3 零仓 SSE 独立验收**：串起 `sse-v1` 独立重算验收器；并在隔离 T3 `v0.1.12` + Pi 上通过 `disconnect.log` 正例、重启原样读回、幂等冲突与 T3 拒绝路径验证。详细证据与待补项见 [M1.1–M1.3 开发合同](m1-delivery.md)。
- [x] **M1.4（Sprint 1）底座加固 + 事件驱动 HTTP/SSE 控制面**：修复 5 项底座缺陷（二进制制品、真实重启 `reconcile`、非阻塞并发池、原子锁与残留 `.sock` 自愈、通知去重与执行元信息回写）；引入 `task_events`、`TypedEventBus` 在线唤醒与 `outbox_jobs`；升级 `node:http`（Unix Socket + Loopback REST/SSE 分页断点续传）及 CLI `list` / `amend` / `stop`（含运行中实时中断与防复活）。
- [x] **M1.5（Sprint 2）极简黑白 Web 工作台 + 分级授权 + 一级 Watchdog**：实现 `StandingPolicy` 三层分级授权（Tier 0/1 总助理静默放行、Tier 2 红线挂起与批准原地恢复）、注意力防火墙 3 枚举白名单与 Inbox 结构化 `action` Upsert、两阶段 Amendment Diff 确认卡、一级 0-Token Watchdog（4 类检测与冷却去重），以及 React 19 + Vite 极简黑白三栏可折叠控制台（静态托管 + 实时 SSE + JSON 快照读取 + `⌘K` + 中文 IME 兼容）。`npm run typecheck && npm run build && npm test` 103 项全通过（注：Web 样式当前以轻量化原生 Zinc CSS 实现，无外部 CSS 框架负担）。

### 下一短冲刺（M1.6，目标：正式开启 Timo 自用）

| 切片 | 冲刺 | 核心改动与依赖 | 可执行的通过条件 |
| --- | --- | --- | --- |
| **M1.6 自主 Worktree + 统一执行器（含 Live 运行流）+ 真实单测验收** | Sprint 3（3–4 天） | 1. 实现自主 `WorkspaceManager`（原生多仓 `git worktree`、精确 `baseSha` 校验、禁止静默 fallback）；<br>2. 抽离统一 `ExecutionAdapter` 与归一化 `RunStreamEvent`：保留 `T3Adapter`，新增至少 1 个直连原生 CLI 适配器（Codex / OpenCode / Pi），接通前端「实时运行流」SSE 透视与人工纠偏注入；<br>3. 抽离声明式 `VerifierRegistry`，在保留 `sse-v1` 的同时新增真实 `command_check`（隔离目录跑 `npm run typecheck && npm test`）。 | 1. 从极简黑白 Web 交办一项 `timo` 仓库自身的真实低风险开发需求；<br>2. 可在右侧检查器一键切到「实时运行流」看到真实工具调用与测试输出；<br>3. 独立验收在干净 worktree 跑通真实测试并附原文证据，进入日常自用试点。 |

**M1 退出条件**：用户从独立 Timo Web 工作台完成真实研发任务（含单测独立验收与实时流透视），且强杀重启、多任务并发、分级授权与一级 Watchdog 均有 `FIXTURE` + `REAL` 证据。

---

## M2（Sprint 4）：Capability MCP Gateway + 多仓 MR/CI 0-Token 闭环

**依赖**：M1 退出条件通过；本地模拟平台可用；真实 MR/CI 操作依赖对应获准账号与网络。

### 可勾选切片

- [ ] 上线本地 **Capability MCP Gateway**（基于 `@modelcontextprotocol/sdk`），为每个执行代次签发短命 Endpoint 与 `Fencing Token`。
- [ ] 实现 **工具可见性裁剪（Tool Visibility Pruning）**：`tools/list` 仅返回当前 `GrantRevision` 允许的工具，禁止发布的任务对 Worker 隐藏发布工具；缺权时支持 `Pause & Resume` 原地挂起等待授权。
- [ ] 接入一种只读日志身份与 GitHub / 内部 Aone（`a1`）MR 能力，真实凭据仅由网关进程从 Keychain / CLI 读取，不暴露给 Worker。
- [ ] 在网关内严格落实 `Intent-Before-Effect`：持久化操作意图与稳定幂等键，按原 MR ID 与精确候选 `head SHA` 进行 0-Token 后台 CI 轮询（或 Webhook 接收），重试不重复建 MR。
- [ ] 在自主 `WorkspaceManager` 上串通前后端双仓修复 → 两个 MR → 两份 CI + 独立组合行为验收（`command_check` + `platform_mr`），显式禁止生产发布；任一仓新提交自动令旧组合证据失效。

**退出条件**：模拟全链与故障反例通过（S01、S05、S06），并在获准测试仓库跑通真实双仓诊断、双 MR、对应 CI 与组合验收。若真实平台尚不可用，仅记录模拟通过，M2 保持待真实验收。

---

## M3：不可变交接、二级 Watchdog 纠偏与未知效果对账

**依赖**：M2 的多仓交付、Capability MCP Gateway 与外部操作账本；至少两种已接入的原生执行器（如 Codex 与 Pi / OpenCode）。

### 可勾选切片

- [ ] 实现 **不可变目录快照交接（`g1 → g2` worktree）**：换执行器时先发中断并立即作废 `g1` 的 Fencing Token，将 `git diff` 与未跟踪文件迁移至全新 `g2` worktree，生成协议无关的 **Handoff Capsule**（同 Provider 优先原生 Resume，跨 Provider 读胶囊续接）。
- [ ] 验证“旧进程仍在 `g1` 持续写入或尝试调外部平台”反例：物理上不污染 `g2`，逻辑上被网关以 `GENERATION_REVOKED` 拦截。
- [ ] 实现 **二级总助理 Watchdog 巡检与自动纠偏**：一级看门狗触发死循环/范围漂移/卡死信号后，唤醒总助理会诊，自动向 Worker 注入纠偏指令（`steer`）、触发换执行器或生成结构化求助卡。
- [ ] 完整打通 `effect_unknown` 核对闭环（S04）：在平台建单成功但回执丢失的窗口中断连接，重启后先按原操作 ID 查平台事实；可确认则关联继续，无法确认则停在未知态由用户在 Web 核对卡处置，绝不盲目重试。
- [ ] 完整验证主对话写操作 **Amendment Diff 确认卡**（S03）及多任务防串台，叠加断线、重启、重复事件与旧代次迟到回执组合反例。

**退出条件**：S02、S03、S04、S08 的故障注入与获准真实交接均有可回读证据；旧代次越权写入、盲目重复建 MR、无进展死循环和收件箱过程刷屏均被确定性拦截。

---

## M4：日常真实试用与效率度量

**依赖**：M1–M3 退出条件通过；用户同意的真实试用仓库与任务。

### 可勾选切片

- [ ] 在 Timo 极简黑白 Web 中并发推进真实双仓任务与独立日志排查，包含至少一次 Codex ↔ Pi/OpenCode 不可变交接与一次服务重启恢复。
- [ ] 在专用测试资源上复核 S01–S08 全套正反例。
- [ ] 与用户原有纯手工切终端流程做同预算、同标准对照度量：记录正确交付率、端到端耗时、主动查状态次数、重复解释次数、审阅返工分钟数、总成本（未知单列）与打断次数（验证注意力防火墙与总助理分级授权的真实减负效果）。
- [ ] 整理试用缺陷，优先修复阻塞交付、错误归因与体验摩擦项。

**退出条件**：真实主路径与受控反例全部通过，用户确认可在标注范围内日常主力使用；样本有限时如实报告观察边界，不夸大无人值守可靠性。

---

## 后续拓展（由 M4 真实使用证据触发）

- 按高频需求接入更多原生执行器（如 Claude Code 等）及更多外部平台（工单、告警、容器诊断、受控发布）。
- 为项目 Runbook、个人偏好与事故经验补齐版本化知识挂载与修订路径。
- 需要笔记本休眠期间持续监听或内网路由时，引入获准的常在线执行端 / 守护节点。
- 仅在实测单负责人遇到独立工作面瓶颈时引入多执行器并行，仍纳入同一任务账本、总预算与注意力防火墙。
