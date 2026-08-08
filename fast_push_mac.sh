#!/usr/bin/env bash
# 快速提交推送：暂存 → 提交 → 同步远程 → 推送（不升版本、不打 tag）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

REMOTE="${REMOTE:-origin}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
MANUAL_MSG="${1:-}"
NOTES_MODEL="${COMMIT_MSG_MODEL:-haiku}"

sync_remote_branch() {
	echo "同步 ${REMOTE}/${BRANCH}..."
	git fetch "$REMOTE"
	git pull --rebase "$REMOTE" "$BRANCH"
}

generate_commit_message() {
	if [ -n "$MANUAL_MSG" ]; then
		printf '%s' "$MANUAL_MSG"
		return 0
	fi

	if command -v claude >/dev/null 2>&1; then
		local diff
		diff="$(git diff --cached 2>/dev/null || true)"
		if [ -n "$diff" ]; then
			echo "调用 AI（${NOTES_MODEL}）生成提交说明..." >&2
			local msg
			msg="$(printf '%s' "$diff" | head -c 60000 | claude -p --model "$NOTES_MODEL" \
				'你是 git 提交助手。根据输入的 git diff，用简体中文写一句简洁的 commit message。要求：一行以内；聚焦改动目的；不要加引号、不要前缀解释。' \
				2>/dev/null || true)"
			msg="$(printf '%s' "$msg" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | head -n 1)"
			if [ -n "$msg" ]; then
				printf '%s' "$msg"
				return 0
			fi
		fi
	fi

	printf 'chore: 快速同步 (%s)' "$(date '+%Y-%m-%d %H:%M:%S')"
}

if [ -z "$(git status --porcelain)" ]; then
	echo "工作区干净，无需提交"
	exit 0
fi

git add -A
if git diff --cached --quiet; then
	echo "无变更可提交"
	exit 0
fi

COMMIT_MSG="$(generate_commit_message)"
echo "提交说明: ${COMMIT_MSG}"
git commit -m "$COMMIT_MSG"

if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "警告: 提交后仍有未暂存变更，自动一并纳入本次提交"
	git add -A
	git commit --amend --no-edit
fi

sync_remote_branch

echo "推送到 ${REMOTE}/${BRANCH}..."
git push "$REMOTE" "$BRANCH"

echo ""
echo "完成："
echo "  - 代码已推送到 ${REMOTE}/${BRANCH}"
echo "  - 未升版本、未打 tag（如需远程构建发布，请运行 ./fast_release_mac.sh）"

read -r -p "按 Enter 键退出..."
