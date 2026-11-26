# T3 接入决策与适配器合同

## 首版采用的方案

运行版本固定为 T3 `v0.1.12`，源码基线为 `ca81b7b97a1c4b91e5ac25768d0f6629f37732fd`。优先使用上游发行资产，核验 `SHA256SUMS` 后作为独立进程部署。需要源码构建时，从同一 SHA 拉取完整 T3 仓库，使用上游 workspace 与构建脚本产出进程。Timo 通过公开的 OAuth MCP 接入，两边可以独立选择 Node 版本和发布节奏。参考 [发行资产](https://github.com/pingdotgg/t3code/releases/tag/v0.1.12) 和 [上游构建流程](https://github.com/pingdotgg/t3code/blob/v0.1.12/.github/workflows/release.yml)。

T3 确实有带认证的线程快照、历史和 transcript HTTP 路由。此前讨论漏看了 `environmentHttp.ts`。写入、派发和中断的外部合同仍采用 MCP。T3 自带 Web 界面通过内部编排协议设置线程模型；该版本外部 MCP 的 `t3_thread_update` 只改线程标题。首版由用户在 T3 中完成同线程换 Agent，Timo 观察后续 run 的实际 provider。只有产品验证表明必须自动切换时，才评估上游公开接口或小范围 fork 补丁。参考 [HTTP 合同](https://github.com/pingdotgg/t3code/blob/v0.1.12/packages/contracts/src/environmentHttp.ts)、[MCP 工具](https://github.com/pingdotgg/t3code/blob/v0.1.12/apps/server/src/mcp/toolkits/orchestrator/tools.ts) 和 [T3 模型切换入口](https://github.com/pingdotgg/t3code/blob/v0.1.12/apps/web/src/components/chat/useApplyThreadModelPick.ts)。

### 适配器的最小合同

| 操作 | T3 接缝 | Timo 的处理 |
| --- | --- | --- |
| 探测与项目选择 | OAuth 发现和 PKCE、`tools/list`、`t3_project_list`、`orchestrator_capabilities` | 检查工具、字段和提供方能力。管理员注册项目，适配器绑定获准的实例、projectId 和 `modelSelection`。OAuth 凭据保存在本地凭据存储；到期或撤销后等待用户重新授权。 |
| 准备执行 | `t3_thread_launch`，可省略首条消息；返回 threadId、可空的 runId | 代码任务先开空线程。多仓用 `workspaceStrategy: worktree` 显式传原仓绝对路径列表。创建回执可能早于目录就绪，按 threadId 有界等待 `worktreePath`，逐仓核对实际 HEAD 和目录归属，再派发写任务。T3 按仓解析同一个 baseRef，出现非预期 fallback、目录未就绪或共享写入路径时保持待处理。 |
| 发起或追加工作 | `t3_thread_send`，显式 `mode: queue`；返回 messageId、runId 和 delivery | 先保存操作意图、稳定请求 ID、授权与执行代次。写入成功后保存回执。采用固定 runId 跟踪任务，不用最新 run 替代旧结果。 |
| 读取与等待 | `t3_thread_read` 的分页和 `t3_thread_wait` 的指定 runId | 用已知 threadId/runId 补查。超时保留未决。按 `hasMore` 与游标推进；最近运行摘要与业务结果独立。首版使用程序有界等待，事件只作为可选的唤醒来源。 |
| 中断与恢复 | `t3_thread_interrupt` 按 run 中断，`stop: true` 停线程并挂起队列 | 中断请求和运行终态分别记录，再核对原写者、后台进程及外部效果。恢复要经过当前授权，并明确是继续同一线程、放行已挂起队列，还是追加一个新 run。 |

`clientRequestId` 的去重作用域包含 T3 OAuth 客户端会话 ID。同一 OAuth 授权下，新建 MCP 传输会话仍可使用原键；重新 OAuth 授权会更换去重作用域。适配器应持久保存 T3 实例、OAuth 授权代次、请求 ID、输入摘要和精确回执。跨授权代次、环境重置或无法确认旧效果时先查已知对象，确认不了就保留未知并暂停重发。业务 ID 由 Timo 生成和保存。参考 [T3 OAuth 调用作用域](https://github.com/pingdotgg/t3code/blob/v0.1.12/apps/server/src/auth/McpOAuth.ts#L631) 和 [创建线程的请求去重](https://github.com/pingdotgg/t3code/blob/v0.1.12/apps/server/src/mcp/toolkits/project/handlers.ts#L227)。

Timo 选 TypeScript、Node.js 24 与 SQLite 作为第一版实现基线。协议 SDK 只进适配器，业务层依赖 `prepare / submit / read / wait / stop` 的少量输入和结果，测试可替换传输。适配器检查 T3 返回的结构，将 HTTP 鉴权失败、MCP 协议错误、工具拒绝、传输超时和效果未知分开。首版后端使用一个本地进程，HTTP 框架随 Timo 自己的业务 API 需求确定。

首版适配器与 T3 同机，核对 worktree 的读取操作在实际执行主机上完成。本地 Git 检查与 MCP 权限各有自己的信任边界。T3 外部 MCP 的写授权按环境授予，能操作多个项目。Timo 在业务入口按允许项目校验；需要目标平台强制隔离时，使用专用 T3 环境、专用业务身份和受控网络。

## M0 的验收依据

M0 已在固定发行版上验证核心接入。下表用于回归，具体通过证据与后续故障验收范围见 [集成探测手册](t3-integration.md)。

| 必须回答的问题 | 通过依据 |
| --- | --- |
| Timo 如何启动和继续一项工作？ | 首选以 OAuth 接入 T3 的外部 MCP。用受限测试身份发现工具，实际启动线程、读回 thread/run 标识、追加消息并观察结果。以查询或有界等待跟踪状态。 |
| 如何由用户停止，并继续同一任务？ | 验证选定接口的中断以及如何继续原线程，记录中断回执、后台进程和候选状态。若切换或恢复只能由人经 T3 界面操作，先测该路径，并在首版明确哪些步骤需人执行。 |
| 重启、断线或版本变化后，Timo 会知道什么？ | 使用已知 thread/run 标识重新查询仍存在的任务，核对队列、活动和终态。上游不可达时标记最后观测时间；响应丢失后先对账。 |
| T3 能否接管多仓工作区和执行器交接？ | 测一个项目内两个 worktree 的仓库、实际路径、HEAD 与共享文件。用 Codex 和 Pi 在同一线程做一次最薄接手，记录实际入口。长历史、后台写者、回执丢失等组合故障在 M3 复验。 |
| 权限是否真的约束运行？ | `Read only` 身份拒绝写操作，拟用执行身份能做必要动作且不接触未授权凭据。总助理创建或改动 Task 的工具也须验证调用者身份与请求归属。 |

## 依赖与耦合

Timo 把 T3 当独立运行的外部服务。首版对 T3 存在实际运行依赖，创建执行线程、调用原生 Agent，以及使用 T3 管理的多仓工作区都取决于它。T3 不可用时，Timo 仍可接单、查询既有 Task、记录用户更改并保存待派发工作。界面展示最后观测时间及待确认的外部效果。

依赖集中在一个窄适配器。它负责能力探测、线程的创建和读取、消息提交、中断，以及把外部标识和观察结果转换成 Timo 使用的结构。仅将实测支持的动作暴露给业务层。Timo 保存逻辑任务 ID 和带实例标识的 T3 线程／运行引用、独立要求、授权、候选和证据。通过版本探针确定可升级范围。T3 的数据库、内部类型包、Provider 凭据及会话格式由 T3 维护。

主对话优先使用 T3 界面。若实测支持可信的工具调用，主线程通过 Timo 工具建任务和管理进度，工作线程只取得它所属任务的能力。若该调用链暂不可用，首条试验可以从 Timo CLI 接单，经适配器派发到 T3，并用 T3 查看执行过程。这个替代入口可以验证业务路径，主对话体验仍需在 M1 验收。

运行时、存储和本地服务接口见 [技术设计与选型](technical-design.md)。
