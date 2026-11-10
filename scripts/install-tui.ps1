# dsh-tui 一键安装 + 启动（Windows PowerShell 5.1+ / PowerShell 7）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1            # 安装 + 启动
#   powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1 -NoLaunch  # 只安装装配
#
# 说明：
#   - 官方 CLI（@deepseek-ai/dsh）依赖树大，npm 11（node 24 自带）安装时会
#     JavaScript heap OOM——本脚本一律走 pnpm（corepack 自带或 npx 兜底）。
#   - 默认用 npmmirror 镜像加速（国内网络）；设 NPM_CONFIG_REGISTRY 可覆盖。
#   - 每次调用经 pnpm dlx 拉取官方 CLI（缓存命中后秒级），不依赖全局 PATH。
param([switch]$NoLaunch)

$ErrorActionPreference = "Stop"
$Registry = if ($env:NPM_CONFIG_REGISTRY) { $env:NPM_CONFIG_REGISTRY } else { "https://registry.npmmirror.com" }

function Say([string]$Text) { Write-Host "== $Text ==" -ForegroundColor Cyan }
function Die([string]$Text) { Write-Host "x $Text" -ForegroundColor Red; exit 1 }

# 1. node（>=24.9.0）
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "缺少 Node.js（>=24.9.0）。请先安装：https://nodejs.org/"
}
$NodeVersion = [version](node -p "process.versions.node")
if ($NodeVersion -lt [version]"24.9.0") {
  Die "Node.js 版本过低（$(node -v)，需要 >=24.9.0）。请升级后重跑。"
}

# 2. pnpm（没有则 corepack 启用；corepack 的 shim 需新 shell，用 npx 兜底）
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Say "未检测到 pnpm，用 corepack 启用（Node 自带）"
  try { corepack enable } catch { }
}
$env:NPM_CONFIG_REGISTRY = $Registry
# pnpm 经 npm_config_registry（小写）读 registry——两个都设（pnpm dlx 不认 --registry 参数）
$env:npm_config_registry = $Registry
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Say "pnpm 不可直接调用——用 npx -y pnpm 兜底（首次会下载 pnpm）"
}

function Invoke-Dsh([string[]]$Args) {
  # 当前适配 0.2.2-rc.1：显式跟随 @next，避免落到旧全局 CLI。
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    & pnpm dlx @deepseek-ai/dsh@next @Args
  } else {
    & npx -y pnpm dlx @deepseek-ai/dsh@next @Args
  }
  if ($LASTEXITCODE -ne 0) { Die "官方 CLI 调用失败（exit $LASTEXITCODE）。网络问题可换镜像：`$env:NPM_CONFIG_REGISTRY='https://registry.npmjs.org' 后重跑" }
}

# 不 Die 的变体：调用方按 LASTEXITCODE 自行处理。
function Invoke-DshNoDie([string[]]$Args) {
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    & pnpm dlx @deepseek-ai/dsh@next @Args
  } else {
    & npx -y pnpm dlx @deepseek-ai/dsh@next @Args
  }
}

# 3. 官方 CLI 可用性确认
Say "安装官方 dsh CLI（pnpm，registry=$Registry）"
Invoke-Dsh @("--version") | Out-Null

# 4. 装配 tui 插件（幂等：重复执行会覆盖更新到最新）
Say "装配 tui 插件（@huiliyi37/dsh-tianshu-tui）"
Invoke-DshNoDie @("plugin", "--profile", "tui", "add", "@huiliyi37/dsh-tianshu-tui")
if ($LASTEXITCODE -ne 0) {
  # pnpm ≥ 11.7 对未裁决的原生构建 exit 1（0.2.2 宿主树含 node-pty 等）：
  # 把 profile 生成的 pnpm-workspace.yaml 里 allowBuilds 占位填掉再重试一次。
  # dsh-subprocess-local 保留 true（只 chmod node-pty 预编译 helper），其余 false。
  $Ws = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME "profiles/tui/pnpm-workspace.yaml" } else { Join-Path $HOME ".dsh/profiles/tui/pnpm-workspace.yaml" }
  if ((Test-Path $Ws) -and (Select-String -Path $Ws -Pattern "set this to true or false" -Quiet)) {
    Say "检测到未裁决的原生构建（pnpm ≥ 11.7），写入 allowBuilds 后重试"
    $lines = Get-Content $Ws | ForEach-Object {
      if ($_ -match "^(\s+)'@deepseek-ai/dsh-subprocess-local': set this to true or false") { "$($Matches[1])'@deepseek-ai/dsh-subprocess-local': true" }
      elseif ($_ -match "^(\s+)'[^']+': set this to true or false") { $_ -replace "set this to true or false", "false" }
      else { $_ }
    }
    Set-Content $Ws $lines
    # 首败可能留下「dep 已装但 bundle 未登记」的半截状态：先 remove 再 add。
    Invoke-DshNoDie @("plugin", "--profile", "tui", "remove", "@huiliyi37/dsh-tianshu-tui")
    Invoke-Dsh @("plugin", "--profile", "tui", "add", "@huiliyi37/dsh-tianshu-tui")
  } else {
    Die "插件装配失败（详见上方输出）"
  }
}

# 5. 启动
if ($NoLaunch) {
  Write-Host ""
  Write-Host "安装完成。启动："
  Write-Host "  pnpm dlx --registry $Registry @deepseek-ai/dsh@next --profile tui"
  Write-Host "（或 pnpm 全局安装后直接：dsh --profile tui）"
  exit 0
}
Say "启动 dsh TUI（--profile tui）"
Invoke-Dsh @("--profile", "tui")
