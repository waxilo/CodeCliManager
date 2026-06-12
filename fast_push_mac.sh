#!/usr/bin/env bash
set -euo pipefail

DATETIME="$(date '+%Y-%m-%d %H:%M:%S')"

git add .
if ! git diff --cached --quiet; then
  git commit -m "${DATETIME}"
else
  echo "无变更，跳过提交"
fi
git push

read -r -p "按 Enter 键退出..."
