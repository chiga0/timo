# 执行器接入与 T3 Code 采用决策

## 1. 核心架构决策：不 Fork T3，将其定位为“参考蓝本 + 可选外部 Adapter”

经过 M0 实机探测与 M1.1–M1.3 实战验证，并结合 Timo 的长期产品定位，确定以下执行器接入策略：

1. **绝不自研 Agent Loop / Harness**：模型多轮推理循环、上下文压缩、代码编辑工具与底层重试全部复用成熟外部运行时（Codex CLI、OpenCode、Pi、Claude Code 等）。
2. **不 Fork T3 Code 源码，也不将 Timo 主对话寄居在 T3 界面中**：
   - T3 的一等公民是 `Project → Thread → Turn`，而 Timo 的一等公民是跨外部系统的 `Task` 交付承诺、总助理分级授权、Watchdog 巡检、Capability MCP Gateway 与注意力防火墙。Fork T3 会导致长期深陷上游 `v0.1.x` 高速重构的 Rebase 泥潭，且核心控制面能力仍需全量自建。
   - **Timo 独立拥有极简黑白 Web 控制台、自主多仓 Worktree 管理与本地 MCP 能力网关**。
3. **保留 T3 作为可选的 `T3Adapter`（外部黑盒进程），并开放直连原生 CLI 适配器**：
   - 短期保留已通过实机验证的 [src/adapters/t3.ts](../src/adapters/t3.ts) 作为 `T3Adapter`，不浪费既有 M0/M1 成果；
   - 同步定义统一的 `ExecutionAdapter` 与 `RunStreamEvent` 抽象，按需补齐极薄的直连原生 CLI 适配器（`CodexAdapter`、`OpenCodeAdapter`、`PiAdapter`，各 ~150–250 行），使 Timo 彻底摆脱单一上游绑架，随时自由切换最新执行器。

## 2. 从 T3 Code 吸收的 4 项核心参考设计

虽然不 Fork T3，但把旁边的 `../t3code` 源码作为重要工程蓝本，精准吸收其已验证的 4 项优秀设计：

| 借鉴自 T3 Code 的设计 | 在 Timo 中的吸收与演进方式 |
| --- | --- |
| **统一会话与运行时抽象**（`ProviderInstance`、`ModelSelection`、统一 `Run` / `Activity Item` 模型） | 抽象为 Timo 的 `ExecutionAdapter` 协议与归一化 `RunStreamEvent`，让 Codex、OpenCode、Pi、T3 在 Live 实时流视图和 Watchdog 眼里完全同构。 |
| **中途无缝切换 Agent**（`ProviderSessionTransitionPolicy`、`portable-handoffs`） | 吸收“同 Provider 同环境优先原生 Resume，跨 Provider 走预算内结构化交接 + 按需读取遗漏引用”的策略，并叠加 Timo 自主的 **`g1 → g2` 不可变目录快照**与**代次 Fencing Token**，实现比同目录切换更强的防双写安全保证。 |
| **多仓 Plain Project Worktree 经验**（`TaskFolders`） | 参考其多仓目录组织思路，同时在 Timo 自主 `WorkspaceManager` 中修正 M0 暴露的边界隐患：显式校验每仓 `baseSha`（禁止缺分支静默 fallback）、显式管控仓外共享文件。 |
| **协议健壮性设计**（`outputSchema`、`clientRequestId` 幂等、增量游标 `afterPosition`） | 沉淀为 Timo 控制面 REST/SSE 的 `afterSeq` 断点续传、MCP Gateway 幂等键和结构化验证输出合同。 |

## 3. 统一 `ExecutionAdapter` 最小合同

所有外部执行器（原生 CLI 或 T3）只通过以下极窄接口接入 Timo 控制面：

| 方法 | 职责与返回语义 |
| --- | --- |
| `probe()` | 检查二进制/服务可达性、可用 Provider 与模型目录、凭据状态（服务启动 Preflight Check）。 |
| `spawn(input)` | 在指定独立工作目录中启动新执行，挂载 Handoff Capsule 与 Timo 签发的短命 MCP Gateway Endpoint，返回稳定外部引用（`sessionRef` / `runId`）。 |
| `resume(input)` | 针对同 Provider 原生会话续接（如缺权获批后原地恢复、或验收反馈后同预算内修复）。 |
| `steer(input)` | 在不销毁当前执行的前提下向活跃 Run 注入纠偏指令（供 Watchdog 二级总助理或用户在「实时运行流」触发）。 |
| `interrupt(input)` | 发出中断请求并核对进程/运行终态；中断与代次撤权分离执行。 |
| `streamEvents(runRef)` | 产出归一化的 `RunStreamEvent`（思考摘要、工具调用、终端输出、文件 Diff、终态），供 Watchdog 监测与前端 Live 视图实时透视。 |

## 4. `T3Adapter` 固定版本合同（保留兼容与 M0 实测基线）

当选择使用 `T3Adapter` 时，运行版本固定为 T3 `v0.1.12`（源码基线 `ca81b7b97a1c4b91e5ac25768d0f6629f37732fd`），核验 `SHA256SUMS` 后作为独立进程运行，通过公开 OAuth MCP（Streamable HTTP）调用：

| 适配动作 | T3 `v0.1.12` MCP 接缝 | Timo 侧处理与实测边界 |
| --- | --- | --- |
| 能力探测 | OAuth PKCE、`tools/list`、`t3_project_list`、`orchestrator_capabilities` | 启动即校验工具与 Provider 可用性；实测 Pi 驱动默认关闭，需在隔离配置显式启用。 |
| 发起运行 | `t3_thread_launch`（携带首条 prompt、`outputSchema` 与 `modelSelection.instanceId`） | 实测 `modelSelection` 线上字段为 `instanceId`；`launch` 本身即外部效果，必须带持久 `clientRequestId` 并先落盘意图。 |
| 追加消息 | `t3_thread_send`（`mode: queue`） | 按固定 `runId` 跟踪，不用最新 run 覆盖旧证据。 |
| 等待与读取 | `t3_thread_wait`（`untilOutput: true`）与 `t3_thread_read` 分页 | 实测结构化候选来自 `t3_thread_wait` 的 `output`；超时保留 `effect_unknown` 并优先按已知 `threadId/runId` 补查。 |
| 中断 | `t3_thread_interrupt`（支持 `stop: true`） | 仅作运行层中断，防越权依赖 Timo 网关作废旧代次 Fencing Token。 |

> `clientRequestId` 的去重作用域绑定 T3 OAuth 客户端会话 ID：同一 OAuth 授权内重建传输仍可安全重放；重新 OAuth 授权会更换去重作用域，跨授权未知结果必须先查询外部对象再处置。详见 [T3 集成探测手册](t3-integration.md)。
