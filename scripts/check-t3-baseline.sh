#!/bin/sh
# Check documentation and source entry points in a local T3 Git object.
set -eu
# Object probes must use the local object database even in a partial clone.
export GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1

usage() {
    cat <<'EOF'
用法: check-t3-baseline.sh [T3 本地仓库] [Git tag 或提交]
默认读取 Timo 同级目录的 t3code，版本为 v0.1.12。
退出 0 表示所列材料齐全，1 表示材料不全，2 表示参数、仓库或版本不可用。
不联网，不切换分支，不启动 T3。是否能找到 t3 CLI 单独报告。
EOF
}

case "${1-}" in
    -h|--help) usage; exit 0 ;;
esac
if [ "$#" -gt 2 ]; then
    usage >&2
    exit 2
fi

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
source_repo=${1:-"$script_dir/../../t3code"}
revision=${2:-v0.1.12}
if ! command -v git >/dev/null 2>&1; then
    echo '找不到 git。' >&2
    exit 2
fi
if ! git -C "$source_repo" rev-parse --git-dir >/dev/null 2>&1; then
    echo "无法读取 Git 仓库: $source_repo" >&2
    exit 2
fi
if ! commit=$(git -C "$source_repo" rev-parse --verify --end-of-options "${revision}^{commit}" 2>/dev/null); then
    echo "本地仓库无法解析版本: $revision" >&2
    exit 2
fi

printf 'T3 源码版本: %s (%s)\n' "$revision" "$commit"
if command -v t3 >/dev/null 2>&1; then
    echo '当前 PATH 中可找到 t3，安装版本与服务状态须另外核对。'
else
    echo '当前 PATH 中未找到 t3，仍可核对源码材料。'
fi

missing=0
for entry in \
    docs/user/outside-agents.md \
    docs/user/portable-handoffs.md \
    docs/user/multi-repo-projects.md \
    docs/user/permission-modes.md \
    apps/server/src/workspace/TaskFolders.ts \
    apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts
do
    if git -C "$source_repo" cat-file -e "$commit:$entry" 2>/dev/null; then
        printf '  已找到  %s\n' "$entry"
    else
        printf '  缺材料  %s\n' "$entry"
        missing=1
    fi
done

if [ "$missing" -ne 0 ]; then
    echo '部分预期材料缺失。请核对该版本的目录或替代接口。' >&2
    exit 1
fi
echo '源码入口齐全。服务、Provider、权限和真实交接需按集成手册另行验证。'
