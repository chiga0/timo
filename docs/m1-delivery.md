# M1.1–M1.3 开发合同

目标是从本地入口交办一份合成 SSE 日志诊断，经固定版 T3 执行，独立检查候选，重启后仍能查询最终交付。实现使用 [技术设计](technical-design.md) 的单包、Unix socket 和 SQLite。M1.4–M1.6 单独验收。

## 启动与命令

实现后从干净检出执行 npm ci、npm run build、npm test。CLI 构建入口为 node dist/cli.js，发布时命令名为 timo。

| 命令 | 最小输入与结果 |
| --- | --- |
| timo serve | 前台启动任务服务，使用 TIMO_HOME 下的 SQLite、制品目录和 Unix socket。第二个实例报告冲突。 |
| timo create --request-id ID --log FILE | 从调用者目录读取合成日志并提交原始文本。返回包含 taskId 和 status 的 JSON。进程返回时任务和输入已经落盘。 |
| timo get TASK_ID | 返回 JSON，至少包含 taskId、status、waitingReason、inputDigest、threadId、runId 和 result。未产生的字段为 null。 |
| timo amend / timo stop | 归 M1.4 的公开命令。该阶段要求当前任务版本，过期写入返回冲突；未知外部效果按原操作 ID 补查。 |

退出码 0 表示本次 CLI 调用成功。2 表示参数或日志输入无效，3 表示任务不存在，4 表示请求冲突，1 表示服务或其他错误。成功的 JSON 只写 stdout，诊断写 stderr。同一 request-id 与相同原始日志字节返回原 taskId，同键不同内容退出 4。任务失败可通过成功的 get 查询。

`TIMO_HOME` 对应一个私有目录，默认 `~/.timo`。数据库名为 `timo.sqlite`，socket 名为 `timo.sock`。配置用 `TIMO_T3_URL`（完整 MCP 地址）、`TIMO_T3_PROJECT_ID`、`TIMO_T3_PROVIDER_ID`、`TIMO_T3_MODEL`。验收在服务环境中注入短期 `TIMO_T3_TOKEN`，生产凭据接入由后续配置支持。秘密不落任务库、不进入日志或命令行参数。缺少 T3 配置时任务可进入 waiting，原因 `t3_unavailable`；外部发送结果不明使用 `effect_unknown`。

## 状态与写入

持久化状态使用 accepted、running、waiting、verifying、completed、failed。允许按 [业务状态图](domain-model.md) 推进；M1.1–M1.3 实现 happy path、T3 不可达等待、明确失败和未知外部效果等待。首次状态快照和派发意图在同一事务提交；SQLite 为唯一写入点。重启后已完成结果原样读回，未发送任务可继续执行，已知外部标识优先复查。无法证明远端结果时留在 waiting，并明确原因，跨 OAuth 代次安全重放归 M1.4。

出站顺序为绑定项目 → launch 空线程 → 保存 threadId → queue 发送 → 保存 runId → 等待并读取该 run 的候选。创建和发送分别使用持久、稳定的请求 ID。网络调用期间不持有数据库事务。T3 的 completed 只推动任务进入 verifying。只有独立检查成功才写入 completed。适配器采用公开 OAuth MCP，检查工具错误与结构化输出。真实运行测试使用隔离项目和合成数据。 [接入合同](t3-adoption.md)

## SSE 诊断合同

输入为 UTF-8 文本，每条非空行格式为时间戳、连接 ID、事件名三段。事件名取 CONNECT、DISCONNECT、RECONNECT、HEARTBEAT。保留原文行号并计算原始字节的 SHA-256，输入大小上限 32 KiB。合法输入中对同一连接的 DISCONNECT 匹配其后首个尚未匹配的 RECONNECT；证据按断连行号升序，每个断连都要列出。没有恢复的断连其 reconnectLine 为 null。

候选是 JSON 对象，包含 inputDigest、verdict、incidents。verdict 取 disconnected、no_disconnect 或 unknown。每项事故包含 connectionId、disconnectLine、reconnectLine。模型提交采用 T3 的 outputSchema，独立验收程序从冻结日志重新求得预期事故及结论。摘要不符、漏报、多报、错行和伪造恢复均拒收。格式合法且没有断连时，正确的 no_disconnect 可以通过；空日志或格式非完整时只允许 unknown，业务任务进入 waiting 或明确失败，保留原因。finished result 至少保存 final verdict、incidents、inputDigest 与验证器版本。

## 交接验收

1. 用临时数据目录启动服务。T3 不可达时接单，两次同输入同请求号取得同一 ID，改内容则冲突。重启后按原 ID 继续查询。
2. 固定版 T3 上用已获准模型跑正例。核对外部 threadId/runId、终态、输入摘要与逐行证据。重启后原结果仍可读取。
3. 用替换传输注入真实感的结构化回执。验证没有断连的完整日志通过，空日志未知，伪造行号与摘要不匹配拒收，外部超时保持待确认。
4. 提交工程测试及实测说明。M1.6 的总助理入口使用单独探针，验证用户操作来源、角色和工作线程的权限差异。

夹具见 [验收样本](fixtures/m1/README.md)。验收者直接操作 CLI 和探针，读取固定输入与结果。
