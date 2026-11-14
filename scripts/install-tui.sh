#!/usr/bin/env bash
# dsh-tui 一键安装 + 启动（macOS / Linux）
#
# 用法：
#   bash scripts/install-tui.sh            # 安装官方 CLI + 装配 tui 插件 + 启动
#   bash scripts/install-tui.sh --no-launch  # 只安装装配，不启动（打印启动命令）
#
# 说明：
#   - 官方 CLI（@deepseek-ai/dsh）依赖树大，npm 11（node 24 自带）安装时会
#     JavaScript heap OOM——本脚本一律走 pnpm（corepack 自带或已有安装）。
#   - 默认用 npmmirror 镜像加速（国内网络）；设 NPM_CONFIG_REGISTRY 可覆盖。
#   - 每次调用经 pnpm dlx 拉取官方 CLI（缓存命中后秒级），不依赖全局 PATH。
set -euo pipefail

REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
# pnpm/npm 经环境变量读 registry（pnpm dlx 不认 --registry 参数）
export npm_config_registry="$REGISTRY"

say() { printf '\033[1;36m== %s ==\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# 1. node（>=24.9.0）
if ! command -v node >/dev/null 2>&1; then
  die "缺少 Node.js（>=24.9.0）。请先安装：https://nodejs.org/"
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 9) ? 0 : 1)'; then
  die "Node.js 版本过低（当前 $(node -v)，需要 >=24.9.0）。请升级后重跑。"
fi

# 2. pnpm（没有则用 corepack 启用——Node 自带）
if ! command -v pnpm >/dev/null 2>&1; then
  say "未检测到 pnpm，用 corepack 启用（Node 自带）"
  corepack enable 2>/dev/null || die "corepack 不可用。请手动安装：npm install -g pnpm"
  hash -r 2>/dev/null || true
  command -v pnpm >/dev/null 2>&1 || die "corepack 启用后仍找不到 pnpm。请手动安装：npm install -g pnpm"
fi

# 3. 官方 CLI（经 pnpm dlx，绕过 npm 11 的 OOM）
# 当前适配 0.2.2-rc.3：显式跟随 @next，避免落到旧全局 CLI 或仍停在 0.2.2-rc.1 的 latest。
DSH="pnpm dlx @deepseek-ai/dsh@next"

say "安装官方 dsh CLI（pnpm，registry=${REGISTRY}）"
if ! $DSH --version >/dev/null 2>&1; then
  die "官方 CLI 安装/执行失败。网络问题可换镜像：NPM_CONFIG_REGISTRY=https://registry.npmjs.org bash scripts/install-tui.sh"
fi

# 4. 装配 tui 插件（幂等：重复执行会覆盖更新到最新）
say "装配 tui 插件（@huiliyi37/dsh-tianshu-tui）"
if ! $DSH plugin --profile tui add @huiliyi37/dsh-tianshu-tui; then
  # pnpm ≥ 11.7 对未裁决的原生构建 exit 1（0.2.2 宿主树含 node-pty 等）：
  # 把 profile 生成的 pnpm-workspace.yaml 里 allowBuilds 占位填掉再重试一次。
  # dsh-subprocess-local 保留 true（只 chmod node-pty 预编译 helper），其余 false。
  WS="${DSH_HOME:-$HOME/.dsh}/profiles/tui/pnpm-workspace.yaml"
  if [ -f "$WS" ] && grep -q "set this to true or false" "$WS"; then
    say "检测到未裁决的原生构建（pnpm ≥ 11.7），写入 allowBuilds 后重试"
    sed -i.bak \
      -e "s|^\(  '@deepseek-ai/dsh-subprocess-local'\): set this to true or false|\1: true|" \
      -e "s|^\(  '[^']*'\): set this to true or false|\1: false|" \
      "$WS"
    # 首败可能留下「dep 已装但 bundle 未登记」的半截状态：先 remove 再 add。
    $DSH plugin --profile tui remove @huiliyi37/dsh-tianshu-tui || true
    $DSH plugin --profile tui add @huiliyi37/dsh-tianshu-tui
  else
    die "插件装配失败（详见上方输出）"
  fi
fi

# 5. 启动
if [ "${1:-}" = "--no-launch" ]; then
  echo
  echo "安装完成。启动："
  echo "  $DSH --profile tui"
  echo "（或安装 pnpm 全局后直接：dsh --profile tui）"
  exit 0
fi
say "启动 dsh TUI（--profile tui）"
exec $DSH --profile tui
