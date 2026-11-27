# M4（Sprint 6）真实日常试用与效率度量初报（S07）

本报告记录 2026-11-27 在 macOS arm64（Node `v24.15.0`）上针对 `timo` 仓库自身开展的 3 轮真实自用试点（Dogfooding #1、#2 与实机跨执行器交接 #3），并建立可持续采集的 `GET /api/metrics`、`timo metrics` 与 Web 侧栏「效率度量（S07）」面板。

## 1. 实机试点汇总

| 序号 | 任务 / Task ID | 证据类型 | 执行器与版本 | 端到端耗时 | 交付结果与验收 | 人工打断 | 费用 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | 实现 Sprint 5 Step 5.1 快照交接（`d7ae0ae6`） | `REAL`（Web 下单 + 真实 `qwen-code`） | `qwen-code 0.25.3` | ~135s（首轮编码） | 产出 `src/workspace/handoff.ts`、`WorkspaceManager.handoff()`、`test/handoff.test.ts`（147/147 通过，合入 `6b8dfb7`）；暴露了干净验收目录 `node_modules/` symlink 未链接的环境缺陷并即刻修复 | 0 | 未知（未计量，不记零） |
| #2 | 补齐 `timo handoff` CLI 与单测（`0806b910`） | `REAL`（Web 下单 + 真实 `qwen-code` + 独立干净检出验收） | `qwen-code 0.25.3` | ~229s | **首次零干预全自动 `completed`**（`verdict: "verified"`, `exitCode: 0`, `productionDeployed: false`，158/158 通过，合入 `dd06706`） | 0 | 未知（未计量，不记零） |
| #3 | 实机跨执行器不可变交接 + 僵尸旧写者反例（`916950da`） | `MIXED`（真实 `qwen-code` + 真实 `pi` + 真实网关/Worktree；临时仓库无外部 MR 平台） | `qwen-code 0.25.3` → `pi 1.6.0` | 52.4s | `g1 → g2` 迁移未提交编辑与 `handoff-note.txt`，旧 Token 返回 `403 GENERATION_REVOKED`，`g2` 零污染完成独立 `command_check` 验收（详录见 [M3 交接证据](m3-handoff-evidence.md)） | 0 | 未知（未计量，不记零） |

## 2. 试点发现并修复的缺陷分级

### 阻塞交付（P0，已修复）
- **干净验收目录缺少 `node_modules`**：`.gitignore` 中的 `node_modules/` 带尾斜杠仅匹配目录而不匹配符号链接，导致 `WorkspaceManager.materializeCleanCheckout()` 未链接依赖、`command_check` 报 `tsc: command not found`。已在 [manager.ts](file:///Users/gawain/Documents/codebase/github/timo/src/workspace/manager.ts) 同时检测 `node_modules` / `node_modules/` 并写入 worktree `info/exclude`，在 Dogfooding #2 中实机验证一次性通过。

### 影响效率（P1，已修复）
- **`pi 1.6.0` JSONL 新增 `message_end` 事件类型**：已在 [pi.ts](file:///Users/gawain/Documents/codebase/github/timo/src/adapters/pi.ts) 补齐解析并忽略冗余 `message_update` 噪音；
- **Web 无法直接下发代码交付任务**：已补齐 [Composer.tsx](file:///Users/gawain/Documents/codebase/github/timo/web/src/components/Composer.tsx) 「代码交付 / 日志诊断」切换与 [cli.ts](file:///Users/gawain/Documents/codebase/github/timo/src/cli.ts) `timo create --repo` / `timo handoff` / `timo metrics`。

### 体验优化（P2，已修复）
- `1280×800` 下 `.shell` `height: 100dvh` 叠加 `46px` Topbar 导致底部 `交办` 按钮溢出：修复为 `calc(100dvh - 46px)`；
- 主对话 `已接单` 长 JSON 导致横向滚动条：增加 `overflow-wrap: anywhere`；
- Inspector「实时运行流」停留在顶部不自动追随最新事件：补齐自动滚底。

## 3. 诚实观察边界（待用户日常使用补齐）

- **已验证能力**：本地 `timo` 仓库日常开发（Web/CLI 下单 → 独立 worktree → 4 大常驻执行器 `pi / qwen-code / codex / opencode` → 实时运行流 + `steer` → 独立干净环境 `command_check` → 跨执行器不可变交接）已具备日常主力自用条件；
- **待真实样本补齐项**：
  1. 样本量目前为 3 单低风险任务，尚需目标用户在日常工作周内积累同任务、同预算的「Timo vs 手工切终端」手工基线对照数据（可直接调用 `renderS07ComparisonReport()` 与 `timo metrics` 生成）；
  2. 真实外部 GitHub / Aone 试验双仓的双 MR + 真实 CI 轮询尚未在获准外网仓库账号上跑过 `REAL` 全链（当前 S01/S04/S05/S06 外部平台部分均为 `FIXTURE` 通过）。
