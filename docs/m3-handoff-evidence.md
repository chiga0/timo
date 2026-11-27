# M3（Sprint 5）实机跨执行器不可变交接验收证据（S02）

按 [验收剧本](acceptance.md) 第 10 节模板留存实机证据。本记录严格区分 `REAL`（真实本地 CLI 运行时、真实 Git Worktree、真实本地 Capability MCP Gateway）与 `MIXED`（外部 MR 平台未在本次临时仓库调用，故归为 `MIXED` / 本地无平台单仓交接）。

```text
剧本编号 / 执行日期：S02（单仓实机跨执行器交接 + 僵尸旧写者反例） / 2026-11-27
证据类型：MIXED（执行器 qwen-code 0.25.3、pi 1.6.0、WorkspaceManager 真实 git worktree、Capability MCP Gateway HTTP 服务、TaskRunner 与独立 command_check 均为 REAL；测试仓库为临时 Git 仓库 sse-demo，不含真实外部 MR/CI 平台调用）
执行者 / 独立验收者 / 目标用户：Timo 控制面（g1: qwen-code 0.25.3 → g2: pi 1.6.0） / VerifierRegistry command_check（node --test） / 本地开发者
Timo 提交 / 执行器与模型版本 / StandingPolicy 版本：dd06706 / qwen-code 0.25.3 + pi 1.6.0（pai-eas / DeepSeek-V4.1-Flash-1017） / StandingPolicy v1（default）
机器、网络位置、实际入口（Web / CLI）：macOS arm64，Node v24.15.0，本机回环，Timo 控制面 TaskService + TaskRunner + CapabilityMcpGateway
Task ID / Execution 代次 / Fencing Token 摘要 / Run ID：916950da-5123-4249-8930-dba33ed3d4f0 / g1 → g2 / g1 token 已作废（HTTP 403 GENERATION_REVOKED）/ g1: real-g1-qwen（session fcec987f-98d2-4998-96fb-761da3a2143d），g2: pi 自动分配 runId
BriefRevision / GrantRevision（含总助理自动批复与人工红线审批记录）：Brief v1 / Grant v1（read_worktree、write_worktree、run_local_tests、read_ci_status；未授予 deploy_prod）
各仓 baseSha / 候选 SHA / worktree 路径 / MR 与 CI 关联：
  - sse-demo baseSha: fe7a04abd7bae788fd3b9e20a767fbbdf7dae7c8
  - sse-demo headSha (g2): 52a74223a48421677854dd4157bbf71368bb98c5
  - candidateDigest: ef7a691e2822437aec1a14936ff9aa3bc16930520d3af847d4884c7fba010064
  - 外部 MR / CI：本次未连外部平台（NOT_RUN）
VerificationPlan 版本与检查环境：real-s02-v1（command_check: `node --test reconnect.test.mjs`，全新隔离 detached worktree）
预算、期限、实报成本及计量缺失：maxAttempts=5（g1 消耗 1 次，交接至 g2 后 remainingAttempts=4，未重置）；端到端总耗时 52,405ms；模型费用不可取得，诚实记为 unknown_unmetered（绝不记零）

步骤 | 预期 | 实际观察 | 原始证据位置或摘要 | PASS/FAIL/UNKNOWN/BLOCKED/NOT_RUN
1. Preflight 探测双执行器 | qwen-code 与 pi 均探测就绪 | qwen-code 0.25.3 (available=true) 与 pi 1.6.0 (available=true) | probed JSON 输出 | PASS
2. g1 真实执行（qwen-code） | 在 g1 worktree 诊断并留下未提交改动与未跟踪 handoff-note.txt | 产出 15 条流事件，生成 handoff-note.txt 与未提交 WIP 注释 | externalId=fcec987f-98d2-4998-96fb-761da3a2143d | PASS
3. 不可变 g1 → g2 交接 | 作废 g1 Token，迁移 diff 与 untracked 到独立 g2，保留剩余预算 4 | toGeneration=2，migratedUntracked=["handoff-note.txt"]，remainingAttempts=4 | handoff.capsule 摘要 | PASS
4. 反例：僵尸 g1 目录污染 | 往 g1 写入脏代码与 zombie.txt，g2 字节零污染 | g2UntouchedAfterZombie=true，g2 无 zombie.txt 且内容完好 | zombieChecks JSON | PASS
5. 反例：僵尸 g1 调用网关 | 使用旧 g1 Fencing Token 调 MCP 网关返回 403 GENERATION_REVOKED | HTTP 403，error.code="GENERATION_REVOKED" | zombieChecks JSON | PASS
6. 反例：g1 迟到验收回调 | 携带 expectedGeneration=1 的迟到完成回执被拒绝 | lateG1CallbackStatus="ignored_stale_generation" | zombieChecks JSON | PASS
7. g2 真实续接（pi 1.6.0） | 读取 Handoff Capsule 保留 handoff-note.txt、修复代码并提交 | 产出 61 条流事件，提交 52a74223，handoff-note.txt 完好保留 | g2EventCount=61, headSha=52a74223 | PASS
8. 独立干净环境验收 | 在全新 detached worktree 运行 node --test 并绑定精确 SHA | exitCode=0，verdict="verified"，status="completed"，productionDeployed=false | verification.result="accepted", stale=false | PASS

业务结果：已完成（本地临时仓独立验证通过，未发布）
剧本结论：PASS（MIXED：本地真实双执行器交接与僵尸旧写者三重防护全部实机通过；外部平台双 MR/CI 延续部分在本次测试外）
残留外部效果与所需处置：无（临时目录与 worktree 已在 finally 中完全清理）
人工净投入、打断次数与注意力防火墙评估：全过程 0 次人工打断，Inbox 零过程噪音
缺陷、复测候选与未验证范围：
  - 顺带发现并修复 pi 1.6.0 新增的 `message_end` JSONL 事件类型解析（src/adapters/pi.ts）；
  - 本机 codex 0.149.1 用户全局配置指向 `gpt-6.1-sol` 在当前账号返回 model_not_found，本次跨执行器实测采用 qwen-code → pi；
  - 真实外部 GitHub/Aone 双仓 MR + 真实 CI 延续需在获准试验仓库中复核。
```
