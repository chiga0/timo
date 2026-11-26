# Timo 仓库协作说明

- 先读 [README](README.md)、[实施里程碑](docs/milestones.md) 与 [托管开发任务书](docs/implementation-plan.md)。涉及任务归属、分级授权、Watchdog、工作目录或完成判定的改动，先核对 [架构](docs/architecture.md) 和相关 [验收剧本](docs/acceptance.md)。
- 绝不自研 Agent Loop / Harness，不 Fork T3 Code。外部执行器统一通过 `ExecutionAdapter` 接入成熟运行时（Codex / OpenCode / Pi / 可选 `T3Adapter`）；使用 `T3Adapter` 或更新 T3 版本时，核对并更新 [T3 集成手册](docs/t3-integration.md) 中的命令与能力证据。
- 使用临时仓库、合成日志和测试身份做开发验证。真实账号配置、token、登录缓存、任务数据库、生产日志和用户原始对话放在仓库之外。
- 文档使用中文，命令、字段名和平台术语保留原文。交付记录写清实际运行的检查、对应版本和未验证项（按 [托管开发任务书](docs/implementation-plan.md) 第 0 节模板汇报）。只有达到里程碑退出条件时才更新其状态。
- 面向用户的 PRD 与极简黑白交互设计统一维护在 [产品设计 HTML](docs/product.html)。产品行为、页面草图和用户验收场景一起更新，技术合同与实现细节见对应工程文档。
