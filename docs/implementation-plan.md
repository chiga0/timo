# Timo 托管开发任务书与逐阶段验收合同

本文面向**将具体开发步骤托管给外部 Coding Agent（Codex / OpenCode / Pi / Claude Code 等）**的场景编写。每一个步骤（Step）都是一个边界清晰、上下文自包含、可直接派发并独立验收的原子任务包。

---

## 0. 托管 Agent 通用执行与交接协议（所有步骤必读）

任何接手本仓库开发任务的 Agent，开工前和交付时必须严格遵守以下规则：

1. **铁律红线**：
   - **绝不自研 Agent Loop / Harness**，不 Fork T3 Code 源码。
   - **绝不把真实凭据、Token、用户隐私日志或生产库写入仓库或 SQLite**；开发验证一律使用临时目录、合成夹具与测试身份。
   - **网络调用期间绝不持有 SQLite 事务**；外部写操作必须先持久化意图（`Intent-Before-Effect`）。
   - **绝不越界修改不在本 Step Scope 内的模块**；发现前置或相邻缺陷时记录在交付报告的“遗留问题”中，不要顺手大规模重构无关文件。
   - **绝不以“模型自报完成”或“跳过反例测试”宣告验收通过**；未运行项必须标 `NOT_RUN`，阻塞项必须标 `BLOCKED`。
2. **统一交付报告模板（每个 Step 结束时必须输出）**：
   ```text
   Step 编号与标题：
   修改/新增文件清单：
   实际运行的命令与版本（Node / TS / 依赖 / 外部 CLI）：
   自动化测试结果（总数 / 通过 / 失败 / 新增用例列表）：
   人工或实机验收观察（逐条对照本 Step 验收清单，标注 FIXTURE/REAL/MIXED）：
   已知限制、未覆盖项与遗留问题：
   是否满足本 Step 退出条件：YES / NO
   ```
3. **里程碑状态更新纪律**：只有当某里程碑下所有 Step 均实际通过验收，才允许在 [milestones.md](milestones.md) 中勾选对应状态。

---

## Sprint 1（M1.4）：底座加固与事件驱动控制面

### Step 1.1：修复现存 5 项底座缺陷与回归测试

- **前置依赖**：M1.1–M1.3 已通过（`npm test` 33 项通过）。
- **必读上下文**：[technical-design.md](technical-design.md)（第 5 节）、[artifacts.ts](../src/store/artifacts.ts)、[home.ts](../src/home.ts)、[runner.ts](../src/service/runner.ts)、[ipc.ts](../src/ipc.ts)、[migrations.ts](../src/store/migrations.ts)、[tasks.ts](../src/store/tasks.ts)、[task-service.ts](../src/service/task-service.ts)、[serve.ts](../src/service/serve.ts)。
- **任务说明（Scope）**：
  1. 修复 `ArtifactStore.put` 与 `writePrivateFile`，直接按原始 `Uint8Array` 写入二进制制品，严禁经 `"binary"` 字符串 UTF-8 二次转码。
  2. 修复 `TaskRunner` 的 `reconcile` 断链：扫描 `tasks.status IN ('running', 'waiting') AND thread_id IS NOT NULL` 的在途任务，在重启或超时后真实查询远端 `runStatus`；若远端 `completed`，自动执行 `readCandidate → acceptCandidate` 完成闭环。
  3. 修复 `TaskRunner.runOnce` 串行阻塞：改为有并发上限（默认 4，可配置）的非阻塞并行推进，不同 `taskId` 互不阻塞。
  4. 修复 `ipc.ts` 单实例锁：改用 `O_CREAT | O_EXCL` 原子建锁；确认旧锁 PID 已死后先清理残留 `.sock` 再监听；删除 `runner.ts` 未使用的 `readArtifact` 并修正 `serve.ts` 中 `clientFactory` 的 `as never` 类型断言。
  5. 修复 `notifications` 去重逻辑（支持同一任务多次进入同类等待态，引入 `dedupe_key`）与 `executions` / `run_references` 派发后回写实际 `providerInstanceId` 和 `model`。
  - **Out of Scope**：本步不改外部 IPC 协议（HTTP/SSE 留到 Step 1.3），不引入新前端。
- **达成目标（DoD）**：
  - 含中文/多字节 UTF-8 的日志文件冻结后重读字节与 SHA-256 100% 一致；
  - 模拟派发后进程强杀重启，新 `TaskRunner` 自动补查在途 run 并流转至 `completed`；
  - 同时提交 2 个任务（第 1 个慢响应 2 秒、第 2 个立即返回），第 2 个任务无需等待第 1 个即可完成；
  - 模拟旧进程遗留死 PID `.lock` 与残留 `.sock`，新 `timo serve` 可正常自愈启动，而活进程锁仍被拒绝。
- **必含反例测试**：
  - 中文日志往返摘要一致性测试；
  - 强杀重启补查（`operation=done` 但任务未终结）回归测试；
  - 双任务并发耗时验证测试；
  - 死锁 + 残留 socket 自愈启动 & 活锁拒绝测试；
  - 同一任务两次触发 `waiting_t3_auth` 均生成未投递通知测试。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  核对所有原有 33 项测试 + 新增至少 5 项回归测试全部通过，且 `src/` 中不再存在 `as never` 绕过 `clientFactory` 类型检查。

---

### Step 1.2：引入追加式事件账本（`task_events`）、`TypedEventBus` 与 `outbox_jobs`

- **前置依赖**：Step 1.1 通过。
- **必读上下文**：[architecture.md](architecture.md)、[domain-model.md](domain-model.md)、[technical-design.md](technical-design.md)、[migrations.ts](../src/store/migrations.ts)、[database.ts](../src/store/database.ts)。
- **任务说明（Scope）**：
  1. 新增 SQLite 迁移 `0002-event-ledger`，创建 `task_events`（自增 `seq`、不可变事件、`idempotency_key` 唯一约束）与 `outbox_jobs`（`job_id`, `task_id`, `kind`, `status`, `run_after`, `attempts`, `max_attempts`, `lease_until`, `payload_json`）。
  2. 实现 `EventLedger`：每次业务状态跃迁在同一 `BEGIN IMMEDIATE` 事务中追加 `task_events`、同步更新 `tasks` 物化投影和必要的 `outbox_jobs`，事务提交后通过进程内 `TypedEventBus` 广播事件。
  3. 改造后台调度器基于 `outbox_jobs` 运行（支持 `run_after` 指数退避、租约超时回收与并发池认领），在线态由 `EventBus` 立即唤醒，重启/离线由 `outbox_jobs` 扫描兜底。
  - **Out of Scope**：本步暂不改 CLI 外部命令格式，不接新执行器。
- **达成目标（DoD）**：
  - 任务创建、派发、等待、验证、完成、失败全链路均在 `task_events` 留下有序单调 `seq` 记录；
  - 订阅 `TypedEventBus` 可零延迟收到业务事件；按 `afterSeq` 查询 `task_events` 可精确重放增量历史；
  - 相同 `idempotency_key` 重复写入不产生重复事件或重复业务副作用。
- **必含反例测试**：
  - 重复事件幂等写入测试；
  - 事务内抛错回滚时，`TypedEventBus` 绝不误广播未提交事件；
  - Outbox 作业 `lease_until` 过期后被新实例重新认领测试；
  - `afterSeq` 增量查询与全量状态一致测试。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  检查迁移可从空库与既有 `0001-init` 旧库平滑升级；验证所有旧测试无回归，新增事件账本与 Outbox 测试全部通过。

---

### Step 1.3：升级 `node:http` 控制面（Unix Socket + Loopback REST/SSE）与 `amend` / `stop`

- **前置依赖**：Step 1.2 通过。
- **必读上下文**：[architecture.md](architecture.md)、[technical-design.md](technical-design.md)、[m1-delivery.md](m1-delivery.md)、[cli.ts](../src/cli.ts)、[ipc.ts](../src/ipc.ts)、[serve.ts](../src/service/serve.ts)。
- **任务说明（Scope）**：
  1. 用 Node 原生 `node:http` 替换自定义 NDJSON Socket 协议：
     - Unix Socket（`~/.timo/timo.sock`，`0600`）：服务本地 CLI，免 Token 高信任；
     - 可选 Loopback HTTP（`TIMO_HTTP_PORT`，绑定 `127.0.0.1`，启动生成随机高熵 Session Token，权限校验强制走 `Authorization: Bearer` 或安全 Cookie）。
  2. 提供统一 REST + SSE 路由：
     - `GET /api/health`、`GET /api/tasks`、`POST /api/tasks`、`GET /api/tasks/:id`、`GET /api/tasks/:id/events`；
     - `POST /api/tasks/:id/amend`（必传 `expectedBriefVersion`，版本不匹配返回 HTTP 409 / `version_conflict`）；
     - `POST /api/tasks/:id/stop`（立刻拒绝新派发、作废当前执行代次令牌占位并请求中断在途运行）；
     - `GET /api/events?afterSeq=N`（SSE 增量事件流，先补发 `seq > N` 历史，再实时推送 `EventBus` 新事件，带心跳保活）。
  3. 更新 `timo` CLI：新增 `timo list`、`timo amend TASK_ID --version N ...`、`timo stop TASK_ID`，保持原有退出码合同（0/1/2/3/4）。
  - **Out of Scope**：本步不开发 React 前端界面（留到 Step 2.3）。
- **达成目标（DoD）**：
  - CLI 全部命令经 HTTP over Unix Socket 稳定运行；
  - 浏览器或 `curl` 携带 Session Token 访问 Loopback REST 与 SSE 正常，无 Token 返回 `401`；
  - 过期版本号 `amend` 被拒（退出码 4 / HTTP 409）；`stop` 后在途任务停止派发且进入 `stopping` → `stopped`。
- **必含反例测试**：
  - 无 Token / 错误 Token 访问 Loopback API 返回 `401`；
  - `amend` 版本冲突返回 `409` 且原约定不被覆盖；
  - `stop` 竞态：停止后迟到的完成回调不得将已停止任务改写为 `completed`；
  - SSE 断线后用上次收到的 `lastSeq` 重连，无事件丢失、无乱序。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  另做一次手工冒烟：启动 `timo serve`，开终端 A 执行 `curl -N -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/events?afterSeq=0"`，终端 B 执行 `timo create` / `timo amend` / `timo stop`，核对终端 A 实时收到有序 SSE 事件且重启后 `timo get` 状态一致。

---

## Sprint 2（M1.5）：分级授权、一级 Watchdog 与极简黑白 Web 工作台

### Step 2.1：实现 `StandingPolicy` 三层分级授权与注意力防火墙路由

- **前置依赖**：Step 1.3 通过。
- **必读上下文**：[architecture.md](architecture.md)（注意力防火墙与三层分级授权章节）、[domain-model.md](domain-model.md)、[acceptance.md](acceptance.md)（S03、S06、S08）。
- **任务说明（Scope）**：
  1. 实现 `StandingPolicy` 配置加载（`~/.timo/policy.json`，含安全默认值）：明确划分 Tier 0（默认静默放行）、Tier 1（总助理可自主批复）与 Tier 2（红线，必须请示人）。
  2. 实现 `AuthorizationEvaluator`：
     - 收到 Worker 提权请求时，在 Tier 0/1 范围内由总助理直接签发新 `GrantRevision`（`approvedBy: "chief_of_staff"`），写审计事件并原地恢复；
     - 触及 Tier 2 红线时，任务进入 `waiting(needs_human_decision)`，生成带范围、有效期和可逆性说明的决策项。
  3. 实现两阶段写操作变更提案接口（`POST /api/tasks/:id/proposals` + `POST /api/proposals/:pid/confirm|cancel`），供主对话高危改口生成 Amendment Diff 确认卡。
  4. 实现注意力防火墙投影（`GET /api/inbox` 与主对话事件过滤）：硬性只放行 `DECISION_REQUIRED`、`DELIVERY_VERIFIED`、`TASK_BLOCKED_FINAL` 3 类事件；Inbox 按 `(taskId, decisionKey)` 原地 Upsert，禁止子步骤或过程日志进入。
  - **Out of Scope**：本步暂不接入真实外部平台凭据（留到 Sprint 4）。
- **达成目标（DoD）**：
  - 常规开发/预发只读提权自动放行且不进 Inbox；
  - 生产只读/生产发布等红线请求挂起任务并在 Inbox 生成 1 条结构化待决卡片；批准后原地恢复，拒绝后按原范围收口；
  - 同一任务多次更新待决信息，Inbox 始终只有 1 条最新记录。
- **必含反例测试**：
  - 过程事件（10 条工具日志 + 2 次重试 + 1 次总助理自动放行）写入后，`/api/inbox` 返回空数组；
  - 红线权限（如 `deploy_prod`）绝不被总助理自动放行；
  - 未经用户确认的变更提案（Proposal）绝不修改任务的当前 `BriefRevision`。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  核对 S06（分级授权部分）与 S08（注意力防火墙部分）的 `FIXTURE` 测试用例全通过。

---

### Step 2.2：实现一级 0-Token Watchdog（心跳 / 死循环 / 超时 / 范围漂移）

- **前置依赖**：Step 2.1 通过。
- **必读上下文**：[architecture.md](architecture.md)（两级 Watchdog 章节）、[domain-model.md](domain-model.md)、[acceptance.md](acceptance.md)（S08）。
- **任务说明（Scope）**：
  1. 在 Daemon 内实现 `WatchdogMonitor`（纯确定性定时器，支持注入可控时钟，**零模型调用**），按可配置阈值监测所有 `running` 执行：
     - `stall`：超过 `stallThresholdMs` 无任何活动心跳或输出；
     - `loop`：相同错误指纹连续出现 `>= maxSameFailure` 次；
     - `soft_deadline`：运行超过 `softDeadlineMs` 仍无候选或进展标记；
     - `scope_drift`：观测到变更文件数或目录越出约定白名单。
  2. 命中条件时写入 `WATCHDOG_SIGNAL` 事件并广播至 `EventBus`，同时更新任务检查器摘要字段（如 `watchdogStatus: "healthy" | "warning"` 与 `lastHeartbeatAt`）。
  3. 同一异常窗口内做去重冷却，避免反复刷屏同一警报。
  - **Out of Scope**：二级总助理自动纠偏（调用 LLM 会诊与 `steer`）留到 Step 5.2，本步聚焦一级 0-Token 精准检测与事件上报。
- **达成目标（DoD）**：
  - 4 类异常均在设定阈值内确定性触发对应 `WATCHDOG_SIGNAL`；
  - 正常长耗时等待（如 `waiting_external_ci`）不被误报为 `stall`。
- **必含反例测试**：
  - 使用可控虚拟时钟验证 `stall`、`loop`、`soft_deadline`、`scope_drift` 四类触发；
  - 验证合法 `waiting_external_ci` 状态等待 30 分钟不误触发 `stall`；
  - 验证全过程模型调用计数为 `0`。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```

---

### Step 2.3：落地极简黑白 Web 工作台（React 19 + Vite + Tailwind v4 + shadcn/ui）

- **前置依赖**：Step 2.1、Step 2.2 通过。
- **必读上下文**：[product.html](product.html)（作为视觉、排版与交互的**唯一权威参考**）、[technical-design.md](technical-design.md)。
- **任务说明（Scope）**：
  1. 在仓库新增 `web/` 前端包（React 19 + Vite + Tailwind CSS v4 + shadcn/ui Zinc 黑白体系），构建产物输出至 `dist/web/` 并由 `timo serve` 的 Loopback HTTP 服务器直接静态托管。
  2. 严格还原 [product.html](product.html) 的全部交互与极简黑白规范：
     - 全视口锁定（`100dvh` 无外层双滚动条）、固定底部输入框（`Enter` 发送 / `Shift+Enter` 换行 / `@` 选任务）、左右侧栏可折叠（按钮 + `[` / `]` 快捷键）、浅/深黑白主题切换、`⌘K` 命令面板；
     - 顶部吸顶活跃任务胶囊条 + 不可变主对话流 + 4 类卡片（接单卡、红线审批卡、Amendment Diff 确认卡、`effect_unknown` 对账卡）；
     - 右侧检查器双 Tab（「交付概览」含 Watchdog 状态、预算条、权限护栏、跨仓交付矩阵、可展开原文证据、克制 outline 追问按钮、二次确认停止任务；「实时运行流」预留实时流接口占位与纠偏输入框）；
     - 左侧「待你决定」、「全部任务（含状态筛选）」、「环境与授权健康度」视图。
  3. 完整接入 Step 1.3 / 2.1 的真实 REST API 与 SSE `/api/events?afterSeq=N` 实时同步（断线自动续传）。
  - **Out of Scope**：不引入花哨彩色主题或重型图表库；不修改后端状态机逻辑。
- **达成目标（DoD）**：
  - 运行 `npm run build` 同时构建后端与 `dist/web/`；
  - 启动 `timo serve` 后在浏览器打开本地地址，即可真实创建任务、查看 SSE 实时状态更新、处理红线审批/Diff 确认卡、展开原文证据与停止任务。
- **必含反例与 UI 检查**：
  - 95% 黑白灰视觉一致性检查（无大面积彩色块、右侧底部追问按钮为克制 outline 样式）；
  - 模拟网络断开 3 秒后恢复，SSE 按 `afterSeq` 自动补齐断线期间产生的事件；
  - 窄屏与收起左右侧栏时底部输入框仍稳固贴底、无双滚动条。
- **验收方式**：
  ```sh
  npm run build && npm test
  ```
  启动 `timo serve`，打开浏览器完整走一遍：主对话下单 → CLI 侧查到同一 Task → Web 点击批准/停止 → 刷新页面状态与事件完整保留。

---

## Sprint 3（M1.6）：自主 Worktree、统一执行器（含 Live 运行流）与真实单测验收

### Step 3.1：实现自主 `WorkspaceManager`（多仓 Git Worktree 与精确基线校验）

- **前置依赖**：Step 1.3 通过（可与 Sprint 2 并行开发）。
- **必读上下文**：[architecture.md](architecture.md)、[technical-design.md](technical-design.md)、[t3-adoption.md](t3-adoption.md)。
- **任务说明（Scope）**：
  1. 实现 `src/workspace/manager.ts`，以原生 `git worktree` 在 `~/.timo/workspaces/<taskId>/g<generation>/<repoName>` 管理零仓、单仓与多仓目录。
  2. 准备目录时，逐仓校验目标 `baseRef` 存在并记录解析后的精确 `baseSha`；**某仓缺失指定分支时必须显式报错拒绝，严禁静默回退到默认分支**。
  3. 提供只读状态检查接口：列出每仓当前 `HEAD`、未提交 diff 摘要与未跟踪文件清单；提供安全回收接口：存在未交付脏文件或未跟踪文件且未显式允许丢弃时拒绝删除。
  - **Out of Scope**：`g1 → g2` 快照交接逻辑在 Step 5.1 扩展，本步先确保 `g1` 多仓创建、校验与安全清理 100% 稳定。
- **达成目标（DoD）**：
  - 同一原仓同时服务 2 个并发任务，各自拥有独立 worktree 与分支，互不干扰、不改动原工作目录；
  - 记录并核验每仓精确 `baseSha` 与最终候选 `headSha`。
- **必含反例测试**：
  - 双仓中 B 仓缺少指定 `baseRef` 时整体拒绝并清理半成品目录，不静默 fallback；
  - 脏 worktree（含未跟踪文件）默认回收被拒绝；
  - 原仓库工作区在并发任务期间保持干净。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  使用临时双仓 Git 夹具跑通创建、并发隔离、缺分支拒绝与脏目录保护全部自动化测试。

---

### Step 3.2：抽象统一 `ExecutionAdapter`、直连原生 CLI 适配器与 Live 运行流透视

- **前置依赖**：Step 2.3、Step 3.1 通过。
- **必读上下文**：[t3-adoption.md](t3-adoption.md)、[technical-design.md](technical-design.md)、[t3.ts](../src/adapters/t3.ts)、[acceptance.md](acceptance.md)（S08）。
- **任务说明（Scope）**：
  1. 定义统一 `ExecutionAdapter` 接口（`probe / spawn / resume / steer / interrupt / streamEvents`）与归一化 `RunStreamEvent` 类型（`thinking / tool_call / tool_result / shell / patch / status / error`）。
  2. 将现有 `src/adapters/t3.ts` 适配到 `ExecutionAdapter` 接口（保留原有实测能力）。
  3. 新增至少 1 个直连原生 CLI 的轻量适配器（优先从 `CodexAdapter`、`PiAdapter`、`OpenCodeAdapter` 中选一个本机已安装且可用的 CLI，约 150–250 行）：通过 `child_process.spawn` 在指定 worktree 启动、解析流式 JSON 输出为 `RunStreamEvent`、支持中断与纠偏消息注入。
  4. 将归一化 `RunStreamEvent` 写入 `~/.timo/runs/<taskId>/<runId>.ndjson`，新增 `GET /api/tasks/:id/runs/:runId/stream`（SSE）与 `POST /api/tasks/:id/steer` 接口，并与前端右侧检查器「实时运行流」Tab 完整打通。
  5. 将执行器输出事件接入 Step 2.2 的 Watchdog 心跳更新。
  - **Out of Scope**：不修改外部 CLI 源码，不自研 Agent Loop。
- **达成目标（DoD）**：
  - 服务启动执行 Preflight `probe()`，在 Web「环境与授权」面板准确显示已就绪的执行器；
  - 任务执行期间，主对话保持安静，切换到检查器「实时运行流」可实时看到真实工具调用、终端输出与文件变更，且支持人工注入纠偏指令。
- **必含反例测试**：
  - 用假 CLI 脚本测试流式解析、非零退出码、进程异常退出与 `interrupt` 清理；
  - 验证实时流只写 `.ndjson` 与 Live SSE，绝不写入 `task_events` 或污染 Inbox；
  - 验证请求不可用执行器时返回明确错误，不静默切换其他执行器。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  另执行 1 次真实本机 CLI 冒烟：从 Web 发起只读代码分析任务，打开右侧「实时运行流」肉眼确认流式输出与心跳更新正常。

---

### Step 3.3：声明式 `VerificationPipeline` 与 `command_check`（启动 Timo 自用试点）

- **前置依赖**：Step 3.1、Step 3.2 通过。
- **必读上下文**：[technical-design.md](technical-design.md)、[acceptance.md](acceptance.md)（S05）、[contract.ts](../src/sse/contract.ts)。
- **任务说明（Scope）**：
  1. 抽离 `VerifierRegistry` 与声明式 `VerificationPlan`，解除 `TaskService` 和 `tasks` 表对 `sse-v1` 的硬编码耦合（原有 `sse-v1` 作为 `log_citation` 插件保留，所有原有 SSE 测试继续通过）。
  2. 实现 `command_check` 验收插件：基于冻结候选 SHA 在**全新干净隔离目录**执行指定验证命令（如 `npm run typecheck && npm test`），收集退出码、stdout/stderr 关键摘要并绑定精确候选 SHA 落库。
  3. 实现陈旧证据自动失效：候选 SHA 更新后，旧 `Verification` 标记为 `stale`，不可用于放行 `completed`。
  4. 支持在独立验收未通过时，于预算上限内（默认最多 2 轮）将结构化失败输出喂回原执行器原地修复。
  - **Out of Scope**：跨平台真实 MR/CI 核对留到 Step 4.2。
- **达成目标（DoD）**：
  - 同一套 Timo 控制面既能跑 `sse-v1` 零仓日志诊断，也能跑真实仓库代码修改 + `command_check` 独立单测验收；
  - **完成首项自用试点**：从极简黑白 Web 交办 1 项针对 `timo` 仓库自身的低风险真实需求（如补齐某个小功能或文档/单测修正），在独立 worktree 修改并经干净环境 `npm test` 验收交付。
- **必含反例测试**：
  - 故意提交编译失败或单测失败的候选，验收器明确拒收，不因执行器自报“已修复”而放行；
  - 验收通过后修改候选产生新 SHA，确认旧证据失效不能直接完成；
  - 超过自动修复轮数上限后准确停止求助，不无限循环。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  留存 1 份自用试点的真实证据记录（按 [acceptance.md](acceptance.md) 第 10 节模板记录真实 `REAL` 观察）。

---

## Sprint 4（M2）：Capability MCP Gateway 与多仓 MR/CI 0-Token 闭环

### Step 4.1：实现本地 Capability MCP Gateway（工具裁剪 + Fencing Token + 凭据隔离）

- **前置依赖**：Step 2.1、Step 3.2 通过。
- **必读上下文**：[architecture.md](architecture.md)（三层分级授权与能力网关）、[technical-design.md](technical-design.md)、[acceptance.md](acceptance.md)（S06）。
- **任务说明（Scope）**：
  1. 基于已有 `@modelcontextprotocol/sdk`，在 Timo Daemon 内启动本地 Streamable HTTP **Capability MCP Gateway**，路由格式 `/mcp/:taskId/:generation/:nonce`。
  2. 实现四重门禁：
     - **Fencing Token 校验**：核对 `(taskId, generation, nonce)` 是否仍是当前活跃代次，过期/已停止代次一律返回 `403 GENERATION_REVOKED`；
     - **工具可见性裁剪**：`tools/list` 仅返回当前 `GrantRevision` 允许的工具集合（禁止发布的任务不暴露发布工具）；
     - **原地挂起提权**：提供 `timo_request_grant` 工具，命中 Tier 1 由总助理静默放行并更新可见工具集，命中 Tier 2 则任务进入 `waiting(needs_human_decision)` 挂起等待人批复；
     - **凭据隔离**：真实业务凭据仅由网关进程读取（环境变量 / Keychain / 受控企业 CLI），启动 Worker 时清理敏感业务环境变量。
  - **Out of Scope**：真实双仓组合测试脚本留到 Step 4.2。
- **达成目标（DoD）**：
  - Worker 仅能看到并调用获准工具；作废代次后任何旧 Token 调用立即被拒；Worker 进程环境中不存在真实业务 Token。
- **必含反例测试**：
  - 旧代次 Token 调用受控写工具返回 `GENERATION_REVOKED`；
  - 无发布授权任务的 `tools/list` 不包含发布工具，直接硬调也返回拒绝；
  - 触发红线提权时任务原地挂起，批准后同一任务无需重头执行即可继续调用新工具。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  通过 S06 全部 `FIXTURE` 断言。

---

### Step 4.2：接入日志/MR 平台工具、0-Token CI 轮询与双仓组合验收（S01 / S05）

- **前置依赖**：Step 3.3、Step 4.1 通过。
- **必读上下文**：[acceptance.md](acceptance.md)（S01、S05、S06）、[milestones.md](milestones.md)（M2）。
- **任务说明（Scope）**：
  1. 在 Capability MCP Gateway 上挂载三类受控业务工具：
     - 只读日志查询工具（校验账号、环境、时间窗并做脱敏裁剪）；
     - MR 创建/更新工具（对接 GitHub `gh` 或内部 Aone `a1`，强制执行 `Intent-Before-Effect` 写 `operations` 意图与稳定幂等键，保存平台 MR ID 与 head SHA）；
     - `platform_mr` 验收插件 + 后台 Outbox **0-Token CI 轮询器**（按原 MR ID 与精确 `head SHA` 跟踪 CI，不消耗大模型 Token）。
  2. 支持多仓组合候选（`{ repoA: shaA, repoB: shaB }`）与组合行为 `command_check` 验收，在 Web 右侧「跨仓交付矩阵」真实渲染每仓基线、head、MR、CI 与组合验收状态。
  - **Out of Scope**：跨执行器交接与丢回执复合故障留到 Sprint 5。
- **达成目标（DoD）**：
  - 模拟双仓与真实获准试验双仓均可跑通：只读诊断 → 双仓独立 worktree 修复 → 提两个 MR → 0-Token 等两份 CI → 组合重连验收 → 明确未发布。
- **必含反例测试**：
  - 两份单仓 CI 都绿但组合行为测试失败 → 整体拒收；
  - CI 绿灯对应旧 `head SHA` 而非最新候选 → 整体拒收；
  - 第 1 个 MR 成功、第 2 个失败 → 保留第 1 份回执，重试不重复创建第 1 个 MR；
  - 等待 CI 期间大模型调用计数为 `0`。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  按 [acceptance.md](acceptance.md) 执行 S01 与 S05 的 `FIXTURE` 全集，并在获准测试双仓执行 1 次 `REAL` 验证留存证据。

---

## Sprint 5（M3）：不可变交接、二级 Watchdog 会诊与未知效果对账

### Step 5.1：实现 `g1 → g2` 不可变目录快照交接与标准化 Handoff Capsule（S02）

- **前置依赖**：Step 3.2、Step 4.1、Step 4.2 通过。
- **必读上下文**：[architecture.md](architecture.md)（自主多仓与不可变交接）、[t3-adoption.md](t3-adoption.md)、[acceptance.md](acceptance.md)（S02）。
- **任务说明（Scope）**：
  1. 在 `WorkspaceManager` 中实现不可变交接流水线：
     - 中断旧代次 `g1` 运行；
     - **立即在网关作废 `g1` Fencing Token**；
     - 冻结 `g1` 每仓的 `git diff`（含已暂存与未暂存）与未跟踪文件清单，物化到全新独立目录 `g2` worktree；
     - 生成协议无关的 **Handoff Capsule**（当前 Brief/Grant、剩余预算、每仓 Diff 摘要、已排除失败假设、已有 MR/CI 外部操作 ID 与最新验收失败输出）。
  2. 支持至少 2 个不同执行器间切换（如 Codex ↔ Pi 或 OpenCode），并在 Web 检查器「换执行器」按钮接通真实接口。
  - **Out of Scope**：不尝试迁移原生进程内存状态。
- **达成目标（DoD）**：
  - 切换执行器后，未提交改动、未跟踪文件、已建 MR/CI、禁止发布护栏与全树剩余预算完整延续，绝不重置额度。
- **必含反例测试（S02 核心反例）**：
  - 启动一个模拟僵尸后台进程持续往 `g1` 目录写入脏文件，并拿旧 `g1` Token 向网关发起创建 MR 请求；
  - 验证：① `g2` 工作目录字节完全不受 `g1` 写入污染；② 旧 Token 调用网关 100% 返回 `GENERATION_REVOKED`；③ 旧代次迟到完成事件不覆盖当前 `g2` 状态。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  按 [acceptance.md](acceptance.md) 跑通 S02 `FIXTURE` + 至少 1 次真实双执行器 `REAL` 交接并留存证据。

---

### Step 5.2：二级总助理 Watchdog 纠偏与 `effect_unknown` 对账闭环（S03 / S04 / S08）

- **前置依赖**：Step 2.2、Step 4.2、Step 5.1 通过。
- **必读上下文**：[architecture.md](architecture.md)、[acceptance.md](acceptance.md)（S03、S04、S08）。
- **任务说明（Scope）**：
  1. 接入二级总助理 Watchdog 会诊：监听一级 `WATCHDOG_SIGNAL` 事件，读取最近压缩活动摘要，按规则执行自动处置——网络/进程中断自动补查恢复；死循环或范围漂移调用 `adapter.steer` 注入纠偏指令或触发 `g1 → g2` 换执行器；不可收敛时推送 `TASK_BLOCKED_FINAL` 结构化求助卡。
  2. 完整落地 `effect_unknown` 对账流与 Web 专用核对卡接口（`POST /api/operations/:opId/reconcile`、`POST /api/operations/:opId/resolve`）：响应丢失后先按原 `operationKey` 查询平台事实；查到即关联继续；查不到且平台无幂等保证时停留在 `waiting(effect_unknown)`，严禁自动重发。
  3. 跑通 S03 改口竞态分支（第二个 MR 已发往平台时收到改口），核实系统如实查询并披露真实外部效果，不擅自关闭已建 MR。
  - **Out of Scope**：不新增通用多机调度集群。
- **达成目标（DoD）**：
  - S03、S04、S08 全部正反例在 `FIXTURE` 下稳定 100% 通过，关键分支在试验项目通过 `REAL` 复核。
- **必含反例测试**：
  - 丢 ACK 窗口断网 + 强杀重启 + 换执行器复合故障注入，确认零重复创建 MR；
  - 平台无法确认且无幂等合同时，验证系统停在 `effect_unknown` 不盲重试；
  - 注入连续 3 次同错死循环，验证一级 Watchdog 触发 → 二级总助理注入纠偏或输出求助卡，不烧光全部预算；
  - 并发 2 仓 + 10+ 工具调用 + 总助理自动放行，验证 Inbox 零过程刷屏。
- **验收方式**：
  ```sh
  npm run typecheck && npm test
  ```
  按 [acceptance.md](acceptance.md) 第 10 节模板输出 S03、S04、S08 验收记录。

---

## Sprint 6（M4）：真实日常试用与同预算对照度量

### Step 6.1：全链路真实试点与效率对照报告（S07）

- **前置依赖**：Sprint 1–5 全部退出条件通过。
- **必读上下文**：[acceptance.md](acceptance.md)（S01–S08）、[milestones.md](milestones.md)（M4）。
- **任务说明（Scope）**：
  1. 在用户同意的真实试验/研发仓库上，通过 Timo 极简黑白 Web 并发推进真实双仓任务与独立日志排查，包含至少 1 次真实执行器交接与 1 次服务重启恢复。
  2. 与“用户直接手工切终端使用同一原生执行器”做同任务、同验收标准、同总预算对照试验。
  3. 整理缺陷分级（阻塞交付 / 影响效率 / 体验优化）与客观度量结论。
- **达成目标（DoD）**：
  - 输出真实、可回读的度量报告：正确交付率、端到端耗时、总成本（未知单列）、人工净投入分钟数、主动查状态次数、必要与非必要打断次数。
- **验收方式**：
  - 由目标用户亲自操作确认可在标注范围内日常主力使用，形成 M4 结项报告并决定后续拓展项。
