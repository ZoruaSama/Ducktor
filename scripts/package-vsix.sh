#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/vsc-plugin"

for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '缺少 %s，请安装 Node.js 并将其加入 PATH。\n' "$tool" >&2
    exit 1
  fi
done

cd -- "$PLUGIN_DIR"
if [[ ! -d node_modules ]]; then
  npm ci
fi

PACKAGE_NAME="$(node -p 'const p = require("./package.json"); p.name + "-" + p.version + ".vsix"')"
OUTPUT="$ROOT_DIR/$PACKAGE_NAME"
# Git Bash 下使用 Windows 路径，避免原生 Node.js 将 POSIX 路径误作相对路径。
if command -v cygpath >/dev/null 2>&1; then
  OUTPUT="$(cygpath -m "$OUTPUT")"
fi

npm run package -- --out "$OUTPUT"
printf '\nVSIX 已生成：%s\n' "$OUTPUT"
