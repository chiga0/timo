# Timo · 提莫

Timo 是一个本地优先的**个人研发与运维交付控制面（Delivery Control Plane）**。你在一个极简黑白主控制台里交办多件事、调整优先级、处理红线审批与查看核验结论。Timo 记住每件事涉及哪些仓库和环境、总助理可在什么范围内替你自主放行权限、现在在等谁、Watchdog 监测到什么异常，以及独立证据在哪里。

> “提莫，帮我查一下 SSE 断连。需要改代码的话，前后端一起修，提两个 MR，等 CI 后告诉我。这次不要发布。”

对这条请求，Timo 应该先由总助理在常设策略（Standing Policy）范围内静默放行只读日志，再由 Timo 自主为涉及的仓库准备独立 worktree，并通过本地能力网关向执行器仅暴露获准工具。你中途改用另一个原生执行器（如 Codex ↔ OpenCode / Pi），Timo 通过不可变目录快照（`g1 → g2`）与代次 Fencing Token 完成安全接力。两份 MR 都有结果且通过组合验收时，你只收到一条安静、可溯源的交付汇报；平时不被过程噪音打扰，但随时可一键下钻查看实时运行流。

**项目状态（2026-11-26）：M0 与 M1.1–M1.3 已实现并通过实机验收；总体架构与实施路线已定案，进入 Sprint 1（底座加固 + 事件驱动 HTTP/SSE 控制面）。** 仓库当前包含可运行的 TypeScript 单包（`src/`）：`timo serve` 前台任务服务（SQLite + Unix socket）、`timo create`/`timo get` CLI、T3 MCP 适配器与后台派发器，以及独立的 `sse-v1` 日志验收器。`npm test` 33 项工程测试全部通过；固定版 T3 `v0.1.12` 隔离实机已跑通正例、重启读回、幂等与冲突退出码（证据见 [M1 开发合同](docs/m1-delivery.md)）。M1.4–M4 将按定案的**自主控制面 + 极简黑白 Web + 复用成熟原生 Harness**路线推进。

## 核心原则

- **绝不自研 Agent Loop / Harness**：模型推理循环、上下文压缩与原生编辑工具全部直接复用成熟外部运行时（Codex CLI、OpenCode、Pi，以及作为可选外部适配器的 T3 Code）。不 Fork T3 Code 源码。
- **分级委派授权 + 能力网关**：用户给总助理设置常设委派策略与红线清单；常规权限由总助理自主批复不打扰人，高危红线才弹审批卡。本地 Capability MCP Gateway 按当前授权动态裁剪 `tools/list`，并通过代次 Fencing Token 与 `Intent-Before-Effect` 保证外部写入安全与幂等。
- **事件驱动 + 持久化账本**：在线态由 `TypedEventBus` 毫秒级驱动前端 SSE 与状态机 Reactor；断线、休眠或崩溃后由持久化事件日志与 Outbox 补查兜底。
- **两级 Watchdog + 注意力防火墙**：一级 0-Token 看门狗 7×24 盯进程心跳、死循环、超时与范围漂移，异常时唤醒总助理纠偏或换人；主对话与收件箱物理隔离执行噪音，默认安静、一键下钻透视「实时运行流」。
- **交付必须可独立核实**：任何执行器的 `run completed` 或单仓 CI 绿灯都不能单独宣告完成。声明式验证管线（单测、精准 MR/CI 核对、日志原文行号校验、人工签字）独立取证，证据可点击展开原文溯源。

## 从这里开始

| 如果你要做这件事 | 阅读或打开 |
| --- | --- |
| 体验极简黑白工作台原型，查看面向用户的 PRD 与 UI 交互规范 | [产品设计与极简原型](docs/product.html) |
| 理解总助理分级授权、事件驱动、Watchdog、能力网关与系统边界 | [架构与运行机制](docs/architecture.md) |
| 查看事件账本、StandingPolicy、Execution/FencingToken 与状态图 | [业务概念和领域模型](docs/domain-model.md) |
| 查技术栈选型、HTTP/SSE 控制面、工作区、实时运行流与底座技术债 | [技术设计与选型](docs/technical-design.md) |
| 确认执行器统一抽象、为何不 Fork T3 及吸收其哪些设计 | [执行器接入与 T3 决策](docs/t3-adoption.md) |
| 查看 Sprint 1–4 / M1–M4 实施路线与退出条件 | [实施里程碑](docs/milestones.md) |
| 派发给开发 Agent 的逐步骤任务单、改动边界与验收方式 | [托管开发任务书](docs/implementation-plan.md) |
| 查看 S01–S08 验收剧本与反例标准 | [首版验收剧本](docs/acceptance.md) |
| 查当前 M1.1–M1.3 的 CLI 合同与实机交付证据 | [M1.1–M1.3 开发合同](docs/m1-delivery.md) |
| 查固定版 T3 `v0.1.12` 的基线探针与实测记录 | [T3 集成探测手册](docs/t3-integration.md) |

## 快速验证当前工程基线

```sh
npm ci
npm run build
npm test
```

若需复核 T3 `v0.1.12` 只读参考基线（可选，相邻目录准备 `../t3code` 后运行）：

```sh
./scripts/check-t3-baseline.sh ../t3code v0.1.12
```

本项目使用 [MIT 许可证](LICENSE)。
