#!/usr/bin/env bash
set -euo pipefail

DATETIME="$(date '+%Y-%m-%d %H:%M:%S')"

git add .
git commit -m "${DATETIME}"
git push

read -r -p "按 Enter 键退出..."
