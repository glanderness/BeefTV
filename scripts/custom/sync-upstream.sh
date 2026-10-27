#!/usr/bin/env bash
# 把上游最新代码同步进 custom 分支：更新 main 镜像 -> 合并进 custom -> 更新双语词典 -> 打包。
# 冲突时停下，按 CUSTOMIZATIONS.md 解决并 git commit 后重新运行即可。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "工作区有未提交的改动，请先提交或暂存。" >&2
    exit 1
fi
if [ -f .git/MERGE_HEAD ]; then
    echo "上一次合并尚未完成，请先解决冲突并 git commit。" >&2
    exit 1
fi

git fetch upstream main
git checkout main
git merge --ff-only upstream/main
git checkout custom

if ! git merge --no-ff main -m "chore(sync): 上游同步 - 合并 upstream/main"; then
    echo
    echo "合并出现冲突（rerere 已自动套用记住的解决方式，仍需人工处理的文件如下）："
    git diff --name-only --diff-filter=U
    echo "按 CUSTOMIZATIONS.md 的登记表处理后执行 git add 和 git commit，再重新运行本脚本。"
    exit 1
fi

cd web
bun install --frozen-lockfile
bun i18n/cli.mjs extract
bun run build

if [ -n "$(git status --porcelain src/i18n/locales/en.json)" ]; then
    echo
    echo "词典有新增词条，翻译后提交：git commit -am \"feat(i18n): 双语 - 同步上游新增词条\""
fi
