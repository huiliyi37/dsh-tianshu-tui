#!/usr/bin/env bash
# 本地自包含启动：不依赖 npx 拉取/全局 profile，直接在本仓库目录里跑 TUI。
#
# 结构：
#   vendor/dsh-runtime/  官方 CLI 依赖树（从 ~/.npm/_npx/*/node_modules 拷入，gitignore）
#   .dsh-dev/            本地开发 profile 家目录（gitignore），DSH_HOME 指到这里
#
# 首次运行自动装配：dsh-base（官方生态 base）+ 本插件（link: 本仓库）。
# 之后每次：node vendor CLI --profile tui，全离线。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/vendor/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"

if [ ! -f "$CLI" ]; then
  echo "缺少 vendor/dsh-runtime（官方 CLI 依赖树）。重建："
  echo "  mkdir -p vendor && cp -R ~/.npm/_npx/*/node_modules vendor/dsh-runtime"
  echo "（npx -y @deepseek-ai/dsh 跑过一次后缓存即存在）"
  exit 1
fi

export DSH_HOME="$ROOT/.dsh-dev"
PROFILE_DIR="$DSH_HOME/profiles/tui"

# 加载 DeepSeek API key：优先已有环境变量，否则读机器级配置位 ~/.dsh/.env（不进仓库）
if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ -f "$HOME/.dsh/.env" ]; then
  set -a; . "$HOME/.dsh/.env"; set +a
fi

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "首次运行：装配 profile tui（dsh-base + 本插件 link: 本仓库）..."
  node "$CLI" plugin --profile tui add "@deepseek-ai/dsh-base@0.1.1-rc.2" "link:$ROOT"
fi

exec node "$CLI" --profile tui "$@"
