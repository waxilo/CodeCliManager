#!/usr/bin/env bash
# 一键：递增版本 → 提交推送 → 打 tag → 触发 GitHub Actions Release 构建发布
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

TAURI_CONF="src-tauri/tauri.conf.json"
PACKAGE_JSON="package.json"
CARGO_TOML="src-tauri/Cargo.toml"
REMOTE="${REMOTE:-origin}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

read_version() {
	grep -o '"version": "[^"]*"' "$TAURI_CONF" | head -1 | cut -d'"' -f4
}

write_version() {
	local ver="$1"
	sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${ver}\"/" "$TAURI_CONF" "$PACKAGE_JSON"
	sed -i '' "s/^version = \"[^\"]*\"/version = \"${ver}\"/" "$CARGO_TOML"
}

bump_patch() {
	echo "$1" | awk -F. '{ $NF = $NF + 1; print $1"."$2"."$3 }'
}

tag_exists_on_remote() {
	git ls-remote --tags "$REMOTE" "refs/tags/$1" | grep -q .
}

CURRENT="$(read_version)"
NEW="$(bump_patch "$CURRENT")"

while tag_exists_on_remote "v${NEW}"; do
	echo "Tag v${NEW} 已存在于 ${REMOTE}，继续递增版本..."
	NEW="$(bump_patch "$NEW")"
done

echo "版本: ${CURRENT} → ${NEW}"
write_version "$NEW"

DATETIME="$(date '+%Y-%m-%d %H:%M:%S')"
COMMIT_MSG="release: v${NEW} (${DATETIME})"

git add .
if git diff --cached --quiet; then
	echo "无变更可提交"
	exit 1
fi

git commit -m "$COMMIT_MSG"

echo "推送到 ${REMOTE}/${BRANCH}..."
git push "$REMOTE" "$BRANCH"

TAG="v${NEW}"
if git rev-parse "$TAG" >/dev/null 2>&1; then
	echo "本地 tag ${TAG} 已存在，删除后重建..."
	git tag -d "$TAG"
fi

git tag "$TAG"
echo "推送 tag ${TAG}..."
git push "$REMOTE" "$TAG"

echo ""
echo "完成："
echo "  - 代码已推送到 ${REMOTE}/${BRANCH}"
echo "  - Tag: ${TAG}"
echo "  - Release 工作流将自动构建 macOS / Windows 并发布到 GitHub Releases"

if command -v gh >/dev/null 2>&1; then
	REPO_URL="$(gh repo view --json url -q .url 2>/dev/null || true)"
	if [ -n "$REPO_URL" ]; then
		echo "  - Actions: ${REPO_URL}/actions/workflows/release.yml"
		echo "  - Releases: ${REPO_URL}/releases/tag/${TAG}"
	fi
fi

read -r -p "按 Enter 键退出..."
