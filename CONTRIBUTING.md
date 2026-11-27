# 贡献指南（Contributing to Timo）

感谢你对 Timo 的关注与贡献！在提交 Issue 或 Pull Request 之前，请先花两分钟了解本项目的架构红线与开发流程。

## 核心架构与产品红线

1. **绝不自研 Agent Loop / Harness**：Timo 是交付控制面（Control Plane），推理循环、工具调用与上下文压缩统一通过 `ExecutionAdapter` 复用成熟外部运行时（`pi`、`qwen-code`、`codex`、`opencode` 等），不 Fork T3 Code。
2. **隐私与凭据物理隔离**：绝不将真实账号配置、Token、内部域名、生产日志、SQLite 数据库或个人路径提交到仓库；开发与测试一律使用临时目录（`mktemp`）与合成夹具。
3. **守住 5 条产品设计不变量**（详见 [AGENTS.md](AGENTS.md) 与 [docs/product.html](docs/product.html)）：
   - 固定主对话 ≠ 单任务聊天窗口（普通问答绝不创建后台 Task 污染任务列表）；
   - 后台任务以单张实时演进的精简任务卡嵌入主对话，不在主对话暴露生硬技术按钮；
   - 「待我处理」固定置顶且严格最小化（仅红线审批、阻塞失败、外部效果未知；已完成绝不进入待办）；
   - 默认静音、按需展开，原始日志与 stderr 必须折叠；
   - 修改产品行为时同步更新 [docs/product.html](docs/product.html) 并补齐契约测试。

## 本地开发环境

要求 **Node.js >= 24** 和 **Git**：

```sh
git clone https://github.com/chiga0/timo.git
cd timo
npm ci
npm run typecheck
npm run build
npm test
```

本地启动 Web 工作台调试：

```sh
TIMO_HTTP_PORT=8790 npm start
```

前端热重载开发（需先在另一个终端启动 `timo serve`）：

```sh
npm run dev:web
```

## 提交 Pull Request 前的检查清单

- [ ] `npm run typecheck` 通过（服务端与前端零类型错误）
- [ ] `npm run build` 通过（`dist/src` 与 `dist/web` 构建正常）
- [ ] `npm test` 全部通过，且新功能/修复附带正例与反例测试
- [ ] 如涉及产品交互或信息架构调整，已同步更新 [docs/product.html](docs/product.html)
- [ ] 自检 `git diff`，确认无个人绝对路径、真实凭据、Token 或私有业务域名
