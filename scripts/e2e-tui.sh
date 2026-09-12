#!/usr/bin/env bash
# 真机交互式终端 e2e：在 pty 里驱动官方 dsh CLI + 本插件（profile link 到本仓库
# lib/ 构建产物），覆盖三项改动：
#   1. 启动复用上一个「没有任何内容」的会话 id，cwd 重绑启动目录
#   2. /session list 只读分页面板（15 行/页，←/→ 翻页）
#   3. /session 无参选择器（摘要 + 15 条/页分页 + ←/→）
#
# 隔离：DSH_HOME 用独立临时家目录（profiles/tui/node_modules 软链到 .dsh-dev 的
# 依赖树，不触碰开发者真实会话数据）。测试只操作自己创建的 /tmp 目录。
#
# 依赖：expect（macOS 自带 /usr/bin/expect）；vendor/dsh-runtime（scripts/dev.mjs
# 首次运行自动装配，或按 dev.sh 注释从 npx 缓存拷贝）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/vendor/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
EXPECT="$(command -v expect || true)"

if [ ! -f "$CLI" ]; then
  echo "缺少 vendor/dsh-runtime（官方 CLI 依赖树）。先跑:" >&2
  echo "  npx -y @deepseek-ai/dsh --version   # 生成 npx 缓存" >&2
  echo "  node scripts/dev.mjs --version      # 自动从缓存拷贝到 vendor/" >&2
  exit 1
fi
if [ -z "$EXPECT" ]; then
  echo "缺少 expect（交互式终端驱动）。macOS 自带；Linux: apt install expect / brew install expect" >&2
  exit 1
fi

# 独立 DSH_HOME：复用 .dsh-dev 的 profile 装配（node_modules 软链，省拷贝），
# sessions/settings 从零开始——测试数据与开发者环境完全隔离。
E2E_HOME="$(mktemp -d /tmp/dsh-tui-e2e-home.XXXXXX)"
OLD_PROJ="/tmp/dsh-tui-e2e-old"
NEW_PROJ="/tmp/dsh-tui-e2e-new"
mkdir -p "$E2E_HOME/profiles/tui" "$OLD_PROJ" "$NEW_PROJ"
cp "$ROOT/.dsh-dev/profiles/tui/package.json" "$E2E_HOME/profiles/tui/"
[ -f "$ROOT/.dsh-dev/profiles/tui/cordis.yml" ] && cp "$ROOT/.dsh-dev/profiles/tui/cordis.yml" "$E2E_HOME/profiles/tui/"
[ -f "$ROOT/.dsh-dev/profiles/tui/cordis.patch.yml" ] && cp "$ROOT/.dsh-dev/profiles/tui/cordis.patch.yml" "$E2E_HOME/profiles/tui/"
[ -f "$ROOT/.dsh-dev/profiles/tui/pnpm-workspace.yaml" ] && cp "$ROOT/.dsh-dev/profiles/tui/pnpm-workspace.yaml" "$E2E_HOME/profiles/tui/"
ln -s "$ROOT/.dsh-dev/profiles/tui/node_modules" "$E2E_HOME/profiles/tui/node_modules"

# 0.1.5 起 key-flow 会在缺 key 时自动弹设置框吞掉后续键入——注入占位 key
# 让弹窗不弹（被测的会话管理流程不需要真 key；进程环境同名变量优先）。
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-e2e-placeholder-key}"
export DSH_HOME="$E2E_HOME"
export DSH_TUI_SKIP_UPDATE=1
export E2E_CLI="$CLI"
export E2E_OLD_PROJ="$OLD_PROJ"
export E2E_NEW_PROJ="$NEW_PROJ"

echo "== dsh-tui e2e：DSH_HOME=${E2E_HOME}（旧项目=${OLD_PROJ} → 新项目=${NEW_PROJ}）=="#
"$EXPECT" "$ROOT/scripts/e2e-tui.exp"
status=$?

# 清理测试自建数据（独立家目录 + 两个项目目录；均为本测试创建，不触碰其它路径）。
# E2E_KEEP_TMP=1 跳过清理（调试/检查现场用）。
if [ "${E2E_KEEP_TMP:-0}" = "1" ]; then
  echo "E2E_KEEP_TMP=1：保留临时数据（${E2E_HOME} / ${OLD_PROJ} / ${NEW_PROJ}），不执行清理"
else
  rm -rf "$E2E_HOME" "$OLD_PROJ" "$NEW_PROJ"
fi
if [ "$status" -eq 0 ]; then
  echo "== e2e 全部通过 =="
else
  echo "== e2e 失败（exit $status，输出见上）==" >&2
fi
exit "$status"
