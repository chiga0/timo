# 安全策略（Security Policy）

## Timo 的本地优先安全模型

Timo 被设计为单用户、本地优先的研发交付控制面，围绕以下安全边界构建：

1. **回环隔离与强会话认证**：
   - 本地 CLI 仅通过权限为 `0600` 的 Unix Domain Socket（`~/.timo/timo.sock`）通信；
   - Web 控制面仅绑定 `127.0.0.1` 回环地址，所有 HTTP 与 SSE 请求必须携带高熵 Session Token（常量时间比对 `timingSafeEqual`）；请勿在无鉴权反向代理保护下将其暴露到公网。
2. **凭据物理隔离（Credential Isolation）**：
   - 平台 Token 与私有凭据独立存储在 `~/.timo/credentials.json`（文件模式 `0600`），API 仅返回脱敏配置状态，绝不回传明文；
   - 启动任何 Worker 执行器子进程前，`buildIsolatedWorkerEnv()` 会剥离 `GH_TOKEN`、`GITHUB_TOKEN`、`GITLAB_TOKEN`、`ENTERPRISE_GIT_TOKEN`、`TIMO_SESSION_TOKEN`、`*_SECRET_KEY`、`*_ACCESS_TOKEN` 等敏感环境变量；
   - 外部平台操作仅通过本地 Capability MCP Gateway 代理执行。
3. **代次隔离与工具裁剪（Fencing Token & Tool Pruning）**：
   - 每个执行代次绑定独立的 `(taskId, generation, nonce)` 网关端点；任务停止或交接（`g1 → g2`）时旧代次 Token 毫秒级作废，返回 `403 GENERATION_REVOKED`；
   - `tools/list` 仅暴露当前 `GrantRevision` 授权范围内的工具，红线操作（如生产发布、主干合并、生产敏感数据访问）强制挂起等待人工显式批准。

## 报告安全漏洞

如果你发现了安全漏洞（例如鉴权绕过、路径遍历、凭据泄露或沙箱逃逸），**请勿直接公开提 Issue**。请通过 GitHub Security Advisory（仓库 **Security → Advisories → Report a vulnerability**）私密上报，并提供：

- 漏洞描述与受影响的模块/文件路径；
- 最小可复现步骤或概念验证（PoC）；
- 潜在安全影响与修复建议（如有）。

我们会在收到报告后尽快确认并协同修复。
