# T3 Code 集成探测手册

本手册用于判断 Timo 是否可以复用 T3 Code 的线程、执行器接入与观察能力。先核对固定版本，再在独立测试环境验证；不要求先实现 Timo 运行时，也不提供尚不存在的 `timo` 命令。

**当前证据（2026-11-26）：固定版服务与 MCP 接入探针通过。** 下载 GitHub `v0.1.12` 的 macOS arm64 CLI 发行资产，按该发行版的 `SHA256SUMS` 核验；实际运行二进制自报 `v0.1.12`。源码锚点与发行版分别记录，尚未比较自行构建的产物。

在仅绑定回环的临时实例上运行以下探针，参数为解包后的发行二进制。脚本使用合成双仓、临时 OAuth 授权和空线程，不发模型提示。

```sh
python3 scripts/probe-t3-mcp.py /absolute/path/to/t3
```

已验证匿名请求拒绝、OAuth PKCE 与配对、工具发现、只读身份能查询且不能建线程、受限身份创建双仓 worktree、逐仓 HEAD、空线程读取与等待、空闲线程的中断返回、撤权后拒绝。重启后用同一 OAuth 授权重新初始化 MCP 连接，读回原 worktree；重复启动返回原线程 ID。重新授权后同一个请求键创建了不同线程，验证了去重的作用域。工作目录异步就绪，第一次读取可能返回空路径。

补测通过了缺分支回退、仓外共享链接及不存在的线程和 Provider 拒绝。在双仓测试中，A 的 `probe-base` 与 `main` 指向不同提交，B 没有 `probe-base`。实测 A 从指定分支起步，B 从它的 `main` 起步，两个线程目录中的仓外文件均链接到原项目文件。实验结束回收整个临时范围。缺快照回退语义见源码与上游文档，候选丢失与回收的完整实机反例留在后续故障验收。 [多仓使用指南](https://github.com/pingdotgg/t3code/blob/v0.1.12/docs/user/multi-repo-projects.md)

### 真实运行证据

T3 `v0.1.12`、Codex CLI `0.149.1`、Pi `1.6.0` 在回环隔离实例上验证。T3 使用独立目录、受限 MCP 客户端及临时 Git 项目。用户授权使用现有模型身份，提示仅包含合成文本。Pi 测试实例关闭工具、扩展发现、技能与项目上下文文件。

| 步骤 | 实际结果 |
| --- | --- |
| Codex 发送、读取、等待 | `gpt-5.6-sol` 通过 MCP 收到合成消息，运行进入 `completed`，助手回复与要求的标记匹配。另用 `gpt-5.4` 观察到该登录目录下模型不可用，Timo 应以实际账户模型目录及运行结果为准。 |
| 已开始输出后的中断 | 轮询读到运行中的助手部分文本，按该 runId 中断，返回 `interrupt_requested`；复查同一 runId 为 `interrupted`，活动记录为 `Stopped by an agent`。随后同一线程再次向 Codex 发送合成消息，获得预期回复。中断的是本轮，后台进程退出仍要单独核查。 |
| 重启后补查已完成运行 | Codex 回复后停止并重启隔离 T3，用原 OAuth 授权重新创建传输会话。读回原线程、原 run 的 `completed` 和标记文本。 |
| 切换到 Pi 并继续 | 用 T3 界面使用的 WebSocket 编排合同提交模型选择，收到成功回执。随后在原 threadId 上用 MCP 排队发消息。Pi 的 `pai-eas/qwen3.7-plus` 运行完成，出现 `Provider handoff`，回复完整复述了第二轮提示中未提供的原标记 `TIMO_CEDAR_4817`。切换通过协议复现，界面的实际点击流程留到 M1/M3。 |

早期诊断中，OpenCode 的百炼 Token Plan 请求在 T3 和原生 CLI 均出现 `Invalid API-key provided`。Pi 的百炼 Token Plan 也返回 401。最终通过的组合使用 Pi 已配置的 PAI-EAS 身份。首版将模型选择留在部署配置中，以实际可用的账号和模型为准。

具体产品合同见 [接入决策](t3-adoption.md)。

早期对本机 `t3 v0.1.11` 做过 CLI 冒烟，项目注册与重启后列表正常。本文采用上面的固定发行版结果作为实施依据。下文 PROBE 测试的状态按各自完整断言记录。

## 1. 先锁定版本

在 Timo 仓库根目录运行已有的只读检查脚本：

```sh
./scripts/check-t3-baseline.sh ../t3code v0.1.12
```

两个参数依次是 T3 源码目录和 Git 版本；省略时默认采用上述值。脚本检查指定提交的合同材料，并报告 `PATH` 中是否存在 `t3`。它不启动服务、不接入模型，也不证明线程切换或外部订阅可用。源码对象不存在时记录缺失，不通过切换当前工作区来绕过。

本轮使用三个不同的版本锚点：

| 锚点 | 固定 SHA | 时间与含义 |
| --- | --- | --- |
| 11 月 20 日本地源码 | `019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9` | 提交时间为 2026-11-20 08:11:52 UTC；本地 CLI 参数核对基线 |
| 发布 tag `v0.1.12` | `ca81b7b97a1c4b91e5ac25768d0f6629f37732fd` | 提交时间为 2026-11-25 06:49:37 UTC；发布候选的固定源码锚点 |
| 11 月 25 日上游 `main` 快照 | `9e385083d6255d4f4a94153ed25533f309f0da16` | 提交时间为 2026-11-25 15:52:14 UTC；本轮能力研究基线，不表示未来最新版本 |

11 月 20 日提交和 `v0.1.12` tag 内的 `apps/server/package.json`、`apps/desktop/package.json` 均写 `0.1.11`。因此必须分别记录 **源码 SHA、发布 tag、实际二进制版本、服务端版本**；不能只看一个 package 文件就推定运行包版本。固定来源：[本地源码锚点](https://github.com/pingdotgg/t3code/commit/019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9)、[发布源码锚点](https://github.com/pingdotgg/t3code/commit/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd)、[上游快照](https://github.com/pingdotgg/t3code/commit/9e385083d6255d4f4a94153ed25533f309f0da16)。

下面是补充的只读版本/帮助检查，不会代替运行测试；没有安装 `t3` 时跳过该分支，不自动安装：

```sh
T3_SRC=${T3_SRC:-../t3code}
git -C "$T3_SRC" show -s --format='%H %cI %s' v0.1.12
git -C "$T3_SRC" status --short
if command -v t3 >/dev/null 2>&1; then
  t3 --version
  t3 serve --help
  t3 project add --help
  t3 thread --help
  t3 thread start --help
  t3 thread send --help
  t3 thread show --help
fi
```

不要使用 `npx t3@latest` 做这一步：它可能下载并运行另一版本。也不要为了探测执行更新、安装后台服务或打开现有桌面实例。

## 2. 已核对的接口与能力

### CLI：11 月 20 日与 `v0.1.12` 均已核对定义

| 操作 | 已核实的形式 | 关键限制 |
| --- | --- | --- |
| 前台服务 | `t3 serve --base-dir <dir> --host 127.0.0.1 --port <port>` | 不打开浏览器；会写运行数据；`serve` 不自动注册当前目录 |
| 添加项目 | `t3 project add <path> --base-dir <dir> --title <title>` | 写入指定服务的数据；项目不是只读挂载 |
| 列出线程 | `t3 thread list --project <path-or-id> --base-dir <dir> --json` | 默认项目为当前目录；不是跨所有项目的列表 |
| 查看线程 | `t3 thread show <thread-id> --base-dir <dir> --messages 10 --json` | 查看状态与最近消息；不是完整原始事件订阅 |
| 创建任务 | `t3 thread start <project> <message> --base-dir <dir> --json` | 会创建线程并调用执行器；默认使用项目的模型与权限 |
| 指定执行器 | 在 `thread start` 添加 `--provider <instance-id> --model <slug>` | 二者必须同时给出；instance ID 不能用显示名称猜测 |
| 独立工作区 | 在 `thread start` 添加 `--worktree <base-ref> --branch <branch>` | `--branch` 需要 `--worktree`；多仓 base 按分支名解析，见下文 |
| 追加消息 | `t3 thread send <thread-id> <message> --base-dir <dir> --json` | 忙线程收到下一轮排队消息，不中断正在执行的 turn |
| 等待回复 | 在 `start` 或 `send` 添加 `--wait` | 失败/停止退出 1；需要人在应用回答退出 2；退出成功不是业务验收 |

公开 CLI 的隔离参数是 **`--base-dir`**，等价于 `T3CODE_HOME`，运行数据位于其 `userdata` 下。不要把开发脚本的参数混用到此 CLI。所审 `thread` 子命令只有 `list/start/send/show`；本手册不假设存在 `thread switch`、`thread watch`、`thread stop` 或 `thread subscribe`。

`list/show` 不创建业务任务，但它们也不是纯文件读取：CLI 以本机所有者身份签发临时 MCP 会话，使用后撤销。测试外部观察者的最小权限必须使用真正的外部 MCP 授权，不能以本机 CLI 读成功作为证据。

源码：[CLI 隔离参数](https://github.com/pingdotgg/t3code/blob/019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9/apps/server/src/cli/config.ts#L36)、[serve](https://github.com/pingdotgg/t3code/blob/019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9/apps/server/src/cli/server.ts#L82)、[项目添加](https://github.com/pingdotgg/t3code/blob/019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9/apps/server/src/cli/project.ts#L351)、[线程命令](https://github.com/pingdotgg/t3code/blob/019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9/apps/server/src/cli/thread.ts#L759)、[临时 MCP 会话](https://github.com/pingdotgg/t3code/blob/019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9/apps/server/src/cli/thread.ts#L214)、[tag 中的线程命令](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/apps/server/src/cli/thread.ts#L837)。

### 单项目多仓 worktree：以 `v0.1.12` 为准

普通目录（plain project）可以包含多个 Git 仓库。Web/desktop 的 **New worktree** 旁有仓库选择器；在 plain project 的选择器底部填写 base branch。每个选中仓库获得自己的 worktree，使用同一线程分支名；指定 base 分支不存在时，从该仓默认分支开始。仓库没有 commit 时会被排除。plain 根目录中仓外文件是指向原件的共享链接；rewind 不恢复它们，也不恢复目标时点没有快照的仓库，而会提示被留下的仓库。

**原始 SHA 的边界：**CLI 将 `--worktree` 原样传作 `baseRef`，单 Git 项目通过 `hasCommit` 可接受 SHA；plain 多仓路径却按 `refs/heads/<name>` 或 `refs/remotes/origin/<name>` 查找，不能用一个原始 SHA 锁定多个仓。本探针固定分支 `probe-base`，逐仓记录并核对实际 SHA；发现 fallback 就记录真实起点，不能仍声称所有仓都从请求基线开始。

来源：[多仓使用指南](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/docs/user/multi-repo-projects.md)、[单仓 base 校验](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/apps/server/src/orchestration-v2/ThreadLaunchService.ts#L454)、[逐仓分支与 fallback](https://github.com/pingdotgg/t3code/blob/ca81b7b97a1c4b91e5ac25768d0f6629f37732fd/apps/server/src/workspace/TaskFolders.ts#L687)。这些是 tag 能力，不能回填为 11 月 20 日版本的实测结论。

### 执行器切换：以上游快照为准

同一 T3 thread 可以切换 Codex、OpenCode、Pi；它们各自的原生会话并未因此合并。相同 driver 与 continuation key 可以原生续接，跨边界走 portable handoff。Codex 的兼容 key 与共享 `CODEX_HOME` 相关；Pi/OpenCode 默认按 provider instance 区分。

handoff 传递预算内的历史消息和相关活动，保留遗漏内容的读取引用；不复制原生 reasoning、tool-call state 和历史附件。切回原 provider 时，若其原生会话可用，可以补入增量历史。长历史交接不是原文全部重播，也不是跨执行器运行进程迁移。活动 turn 和背景工作会影响切换时机。

来源：[续接判断](https://github.com/pingdotgg/t3code/blob/9e385083d6255d4f4a94153ed25533f309f0da16/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts#L32)、[可移植交接](https://github.com/pingdotgg/t3code/blob/9e385083d6255d4f4a94153ed25533f309f0da16/docs/user/portable-handoffs.md)、[活动期切换限制](https://github.com/pingdotgg/t3code/blob/9e385083d6255d4f4a94153ed25533f309f0da16/apps/server/src/orchestration-v2/Orchestrator.ts#L4833)。

### 外部观察：先用 MCP 读取，订阅另行验证

官方外部入口是带 OAuth 的 `/mcp`。外部 agent 可以读取项目、线程与执行器目录；只读授权不能启动或修改任务。需要显式 `projectId/threadId`；跨项目列表可使用 `t3_thread_list` 的 `allProjects: true`。外部 agent 的委派入口是 `t3_thread_launch`，不是仅限 T3 内部调用者的 `delegate_task`。

`t3_thread_read` 支持 `afterPosition/nextPosition` 分页，`t3_thread_wait` 支持指定 run 和等待。这些不等于已具备给任意外部消费者使用的永久推送通道。仓库确有内部 WebSocket RPC `orchestration.subscribeThread`，包含 `afterSequence`；bounded snapshot 的 `historyCursor` 是另一类不透明游标，不能混用。是否把此合同接到 Timo，需要独立验证鉴权、断连恢复和版本兼容，不在此手册中伪造 HTTP 或 WebSocket 调用命令。

来源：[外部 agent 指南](https://github.com/pingdotgg/t3code/blob/019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9/docs/user/outside-agents.md#L53)、[MCP 读取与等待合同](https://github.com/pingdotgg/t3code/blob/019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9/packages/contracts/src/orchestratorMcp.ts#L446)、[WebSocket 流定义](https://github.com/pingdotgg/t3code/blob/019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9/packages/contracts/src/rpc.ts#L2104)、[订阅与快照游标](https://github.com/pingdotgg/t3code/blob/019e55bad5f9d5bea0ad69fe4b6a44f2c2ba52a9/packages/contracts/src/orchestrationV2.ts#L4125)。

## 3. 独立测试环境示例：尚未执行

以下命令会创建测试文件和运行数据；只有确定要开始探测时才执行。使用临时测试账户或独立测试机器，项目只含合成材料。**独立 `--base-dir` 只隔离 T3 数据，不隔离原生 CLI 登录、OS keychain、用户扩展、环境变量或宿主机文件权限。** 不复制日常 T3 数据，不指向真实业务仓库，不复用真实登录进行本轮初始化。

示例适用于 POSIX shell，需支持 `git init -b`。先核对安装版本的帮助。第一终端创建两个有提交的 fixture 仓库：每仓 `probe-base` 固定在初始提交，`main` 再前进一条，以便识别 fallback。身份、禁用签名和 hooks 只作为本次 Git 命令参数，不修改全局配置。

```sh
set -eu
TIMO_T3_LAB=$(mktemp -d "${TMPDIR:-/tmp}/timo-t3-probe.XXXXXX") || exit 1
case "$TIMO_T3_LAB" in /*) ;; *) exit 1 ;; esac
test -d "$TIMO_T3_LAB"
: > "$TIMO_T3_LAB/.timo-t3-probe"
TIMO_T3_PROJECT="$TIMO_T3_LAB/workspace"
TIMO_T3_DATA="$TIMO_T3_LAB/t3-data"
TIMO_T3_PORT=47831
mkdir -p "$TIMO_T3_PROJECT" "$TIMO_T3_LAB/empty-hooks"
if git -C "$TIMO_T3_PROJECT" rev-parse --show-toplevel >/dev/null 2>&1; then
  printf '%s\n' '测试根位于已有 Git 仓库内，请换独立临时目录。' >&2
  exit 1
fi
fixture_commit() {
  git -C "$1" -c user.name='Timo Fixture' -c user.email='fixture@example.invalid' \
    -c commit.gpgsign=false -c core.hooksPath="$TIMO_T3_LAB/empty-hooks" commit -qm "$2"
}
for name in repo-a repo-b; do
  repo="$TIMO_T3_PROJECT/$name"
  git init -q -b main --template="$TIMO_T3_LAB/empty-hooks" "$repo"
  printf '%s_BASE\n' "$name" > "$repo/fixture.txt"
  git -C "$repo" add fixture.txt
  fixture_commit "$repo" 'fixture base'
  git -C "$repo" branch probe-base
  printf '%s_MAIN_ADVANCED\n' "$name" >> "$repo/fixture.txt"
  git -C "$repo" add fixture.txt
  fixture_commit "$repo" 'fixture default advanced'
done
printf 'SHARED_FIXTURE\n' > "$TIMO_T3_PROJECT/shared.txt"
printf '复制此测试根路径到第二终端：%s\n' "$TIMO_T3_LAB"
t3 serve --base-dir "$TIMO_T3_DATA" --host 127.0.0.1 --port "$TIMO_T3_PORT"
```

服务在前台运行；端口占用时换测试端口，不终止其他服务。使用此实例输出的连接方式，不执行会打开日常桌面实例的 `t3 app`。不保存配对 URL/code。**只把 `workspace` 注册为项目；绝不注册测试根 `TIMO_T3_LAB`。T3 数据目录必须始终是项目根的兄弟目录，不能包含在项目中。**

第二终端复制刚打印的根路径；先验证必填值、目录和标记，再派生路径。以下后续操作均在这个已验证的终端执行：

```sh
set -eu
TIMO_T3_LAB='PASTE_PRINTED_TEST_ROOT'
: "${TIMO_T3_LAB:?必须填写第一终端打印的测试根}"
case "$TIMO_T3_LAB" in /*) ;; *) exit 1 ;; esac
test -d "$TIMO_T3_LAB"
test -f "$TIMO_T3_LAB/.timo-t3-probe"
TIMO_T3_PROJECT="$TIMO_T3_LAB/workspace"
TIMO_T3_DATA="$TIMO_T3_LAB/t3-data"
test -d "$TIMO_T3_PROJECT/repo-a/.git"
test -d "$TIMO_T3_PROJECT/repo-b/.git"
test ! -e "$TIMO_T3_PROJECT/.git"
TIMO_T3_A_BASE=$(git -C "$TIMO_T3_PROJECT/repo-a" rev-parse probe-base)
TIMO_T3_B_BASE=$(git -C "$TIMO_T3_PROJECT/repo-b" rev-parse probe-base)
TIMO_T3_B_DEFAULT=$(git -C "$TIMO_T3_PROJECT/repo-b" rev-parse main)
printf '%s\n' "A base=$TIMO_T3_A_BASE" "B base=$TIMO_T3_B_BASE" "B default=$TIMO_T3_B_DEFAULT"
t3 project add "$TIMO_T3_PROJECT" --base-dir "$TIMO_T3_DATA" --title "Multi-repo probe"
t3 thread list --project "$TIMO_T3_PROJECT" --base-dir "$TIMO_T3_DATA" --json
```

先在测试实例将新线程及本项目权限设为 `Supervised`，再配置测试 provider。上游初始默认是 `Full access`，不能依赖默认值；`Supervised` 也不是只读沙箱。[权限说明](https://github.com/pingdotgg/t3code/blob/9e385083d6255d4f4a94153ed25533f309f0da16/docs/user/permission-modes.md#L8)。

优先按下一节的 UI 入口选择两仓。若要对照 CLI，先核实本实例默认选择包含两仓，再替换实例 ID/model；此操作调用模型并可能计费：

```sh
: "${TIMO_T3_PROJECT:?先完成测试环境检查}" "${TIMO_T3_DATA:?先完成测试环境检查}"
TIMO_T3_PROVIDER='REPLACE_WITH_TEST_INSTANCE_ID'
TIMO_T3_MODEL='REPLACE_WITH_AVAILABLE_MODEL_SLUG'
t3 thread start "$TIMO_T3_PROJECT" \
  '只报告工作目录、两仓 HEAD 和 fixture.txt，不修改、不提交、不建子任务。' \
  --provider "$TIMO_T3_PROVIDER" --model "$TIMO_T3_MODEL" \
  --worktree probe-base --branch probe/cli-check \
  --base-dir "$TIMO_T3_DATA" --json
```

从结果取实际 `threadId`，用上表的 `thread show` 读取；不要把整段 JSON 当 ID。结束时在第一终端按 `Ctrl+C`，只停止本次前台服务并保留证据，不按进程名称批量终止。

## 4. 待运行测试清单

每项分别记录：实际 CLI/服务/provider 版本、测试环境、输入、事件或产物、断言结果、缺口。沿用[验收剧本](acceptance.md)的 `NOT_RUN / PASS / FAIL / UNKNOWN / BLOCKED`；证据不足以判断时标记 `UNKNOWN`，缺少 provider 登录或外部客户端时标记 `BLOCKED` 并说明原因。

探针使用 `PROBE-*` 编号，与里程碑 M0—M4 分开。M0 按里程碑完成最小接入，完整故障接力留到 M3；首版验证 Codex 与 Pi。观察使用 MCP 查询与等待，WebSocket 订阅留作可选扩展。

### PROBE-MR：一个 plain project、两个仓库（NOT_RUN）

1. 在 **Settings → Projects → Repositories** 确认项目发现 A/B，且根目录没有 `.git`。创建线程，选 **New worktree**，在旁边仓库选择器勾选 A/B，底部 base branch 填 `probe-base`。发送上面的只读任务。
2. 从实际 `worktreePath` 检查两仓 `git rev-parse HEAD`，必须分别等于记录的 A/B base；`git symbolic-ref --short HEAD` 应是同一线程分支名，`git worktree list --porcelain` 应分别关联各自原仓。再读原仓 `probe-base`，确认探测期间未移动。模型回答只作辅助，Git 读取是断言依据。
3. **缺分支 fallback：**确认原 B 仍在 `main`，在测试原仓删除其 `probe-base`（`git -C "$TIMO_T3_PROJECT/repo-b" branch -d probe-base`），新开两仓 worktree，仍请求 `probe-base`。预期 A=原 A base，B=记录的 B `main` SHA；之后用 `git -C "$TIMO_T3_PROJECT/repo-b" branch probe-base "$TIMO_T3_B_BASE"` 恢复测试分支。用实际起点判定，不能把两个不同 SHA 压成一个 base。
4. **仓外共享链接：**核对线程根 `shared.txt` 链接到原项目文件。让执行器在一次 turn 中经批准修改两仓 fixture 及该共享文件，验证共享原件和另一个线程也看见变化。回退该 turn 并恢复文件：两仓 fixture 应按快照回退，`shared.txt` 保持当前值。该现象是共享边界，不是隔离成功。
5. **缺早期快照：**另开仅选 A 的 worktree 线程，完成一次只改 A fixture 的 turn；再从 **Other repositories** 加入 B，完成一次只改 B fixture 的 turn。确认 B 已是 worktree，再回退到第一轮之前，选择恢复文件。预期有快照的 A 回退，目标时点无快照的 B 保留改动并被明确提示；独立检查 B 的差异。若实际已为 B 建有目标快照，则此负例尚未命中，记 `NOT_RUN/UNKNOWN`，不要删除数据库伪造证据。

通过标准：真实使用一个项目的多仓 worktree，逐仓起点、改动与回退边界均可解释。没有原子多仓 commit/push；共享文件和缺快照仓不能被汇报为已整体恢复。

### PROBE-SW：同线程切换与恢复（NOT_RUN）

1. 在 Codex 完成一轮，提供一个只用于会话记忆的合成约束，如“后续答案须附 `SESSION_MARKER_7`”；同时保留一个文件事实。
2. turn 结束后，在同一 T3 线程的 picker 切到 Pi，最后切回 Codex。逐次核对 T3 thread ID、provider instance、模型、handoff 活动、原始约束与两仓文件事实。其他执行器按需单独验证。
3. 记录可获得的 native thread/session 标识，区分原生 resume、首次 portable handoff、切回后的增量交接。标识不可见时写“未观测”，不用回答相似度推定原生恢复。
4. 分别测试活动 turn、待审批、后台任务期间的切换；预期可能拒绝、排队或重启，不能要求无条件热切换。测试 Stop 后队列仍挂起，显式 Resume/新消息后才继续。
5. 用合成长历史测试预算、遗漏引用和按需读取；历史附件不自动复制。上下文不足恢复行为需在每个实际版本单独观察。

通过标准：无丢失的新请求、无未解释的重复外部执行、身份与历史来源可解释，限制能清楚反馈。单次短对话成功不代表长任务恢复或所有模型组合通过。Pi 的安装最低版本以所测 T3 版本的 provider 指南为准，不从上游快照倒推旧包。

### PROBE-OBS：外部读取；WebSocket 为可选扩展（NOT_RUN）

1. 仅对测试实例配置支持 OAuth 的外部 MCP 客户端，并授予 `Read only`。不要使用本机 `t3 thread` 代替此角色。
2. 调用工具发现，保存工具名称与 schema 版本；用 `t3_thread_list`、`t3_thread_read` 读取合成线程，验证跨项目列表与分页。
3. 以下仅是 MCP 工具参数示例，不是 shell 命令；`threadId` 必须替换为测试返回值：

   ```json
   {"threadId":"REPLACE_WITH_TEST_THREAD_ID","view":"activity","afterPosition":-1,"limit":20,"maxCharsPerItem":4000}
   ```

4. 沿响应 `nextPosition` 读取后续页；长条目按 `itemId/textOffset` 续读。验证超时等待不取消任务、待人工输入能被观察、外部读取不创建任务。
5. **仅在选择 WebSocket 时执行：**验证首个 snapshot、sequence、断连重连、重复事件、旧游标、鉴权撤销和重启。按 `afterSequence = snapshotSequence` 接续，不混用 `historyCursor`。未做此项不能宣称 WS 接通，但不阻塞已经验证的 MCP 查询/等待路径。

通过标准：读取范围符合授权，分页无未解释遗漏；订阅方案必须证明重连后的状态与重新读取的 snapshot 一致。MCP 成功和 WebSocket 成功分别记录。

### PROBE-PERM：权限与人工控制（NOT_RUN）

1. 用只读外部身份请求启动或发送合成任务，预期被拒绝；确认拒绝后没有产生 run 或文件变化。随后撤销该外部身份，验证后续访问失败。
2. 在测试线程的 `Supervised` 模式请求修改 fixture 副本，观察审批；拒绝后确认文件未变。使用批准路径时再核对实际差异。
3. 换执行器、重启 provider session、创建子任务后重新核对权限，不以相同模式名称推定不同 provider 的执行语义一致。
4. 测试 Stop、Resume、待审批、排队消息，并记录后台工作的状态。已经发生的外部动作不会因会话 rewind 自动撤销。
5. 把“任务完成”与“结果验收”分开：人工或确定性检查核对 fixture/差异/预期输出；provider 的 completed、Goal 达成或 `--wait` 退出 0 只证明各自运行状态。

通过标准：拒绝有效、撤销有效、恢复不意外扩大权限、结果可独立核查。权限模式、凭据隔离、OS 沙箱和业务发布授权不能互相替代。

## 5. 探测记录与采用判断

每次记录至少包含：

```text
测试编号：
T3 源码 SHA / tag：
CLI 版本 / 服务端版本 / 客户端版本：
provider CLI 版本 / instance 标识 / model：
权限模式 / 外部身份权限：
输入与预期：
观察到的 threadId / runId / sequence 或读取游标：
产物路径与内容摘要：
耗时 / 使用量 / 人工介入次数：
状态：NOT_RUN | PASS | FAIL | UNKNOWN | BLOCKED
失败或未覆盖范围：
```

证据仅使用合成数据，导出前去除 token、配对 URL、账号信息、真实目录与对话内容。若使用 Usage 面板，标注其为 API 等价估算，不能当订阅账单或完整任务成本；部分文本生成调用不在统计中。[统计边界](https://github.com/pingdotgg/t3code/blob/9e385083d6255d4f4a94153ed25533f309f0da16/docs/user/usage.md#L9)。

优先采用已经通过探测的最小路径。只有选用外部事件订阅时，才要求其重连与权限断言通过；不为它或第三执行器增加首版门槛。任何失败先缩小到具体版本、接口与输入，不因源码存在或一次模型回答正确就宣布集成完成。
