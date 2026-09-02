#!/usr/bin/env node
/**
 * 跨平台本地自包含启动：不依赖 npx 拉取/全局 profile，直接在本仓库目录里跑 TUI。
 * 与 scripts/dev.sh 等价（Windows 主入口；macOS/Linux 两者皆可）。
 *
 * 结构：
 *   vendor/dsh-runtime/  官方 CLI 依赖树（从 npx 缓存拷入，gitignore）
 *   .dsh-dev/            本地开发 profile 家目录（gitignore），DSH_HOME 指到这里
 *
 * 首次运行自动装配：dsh-base（官方生态 base）+ 本插件（link: 本仓库）。
 * 之后每次：node vendor CLI --profile tui，全离线。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'vendor', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

function run(args) {
  // 父进程忽略 SIGINT，让前台子进程自己处理 Ctrl+C；以子进程退出码收尾
  const onInt = () => {}
  process.on('SIGINT', onInt)
  try {
    return spawnSync(process.execPath, args, { stdio: 'inherit' })
  } finally {
    process.off('SIGINT', onInt)
  }
}

function npxCacheRoots() {
  if (process.platform === 'win32') {
    const roots = []
    if (process.env.LocalAppData) roots.push(join(process.env.LocalAppData, 'npm-cache', '_npx'))
    roots.push(join(homedir(), '.npm', '_npx'))
    return roots
  }
  return [join(homedir(), '.npm', '_npx')]
}

function rebuildVendor() {
  for (const root of npxCacheRoots()) {
    let entries
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const nm = join(root, entry, 'node_modules')
      if (existsSync(join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
        console.log(`缺少 vendor/dsh-runtime，从 npx 缓存重建：${nm}`)
        // 目标必须是 node_modules 层级——平铺到 vendor/dsh-runtime 会让
        // bare-specifier 解析失败（LOCAL-DEV 踩坑 #1）
        cpSync(nm, join(ROOT, 'vendor', 'dsh-runtime', 'node_modules'), { recursive: true })
        return
      }
    }
  }
  console.error([
    '缺少 vendor/dsh-runtime（官方 CLI 依赖树），且 npx 缓存中未找到 @deepseek-ai/dsh。',
    '先跑一次 npx 生成缓存：',
    '  npx -y @deepseek-ai/dsh --version',
    '再重新运行本脚本（自动从缓存拷贝，无需手工 cp）。',
  ].join('\n'))
  process.exit(1)
}

function loadEnvFile(path) {
  // shell source 的最小子集：KEY=VALUE 行，# 注释与空行跳过，可选引号剥离。
  // 已设置的环境变量不覆盖（环境变量优先，与 dev.sh 的加载顺序一致）。
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t)
    if (!m) continue
    const value = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
    if (m[1] && process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

if (!existsSync(CLI)) {
  rebuildVendor()
}

process.env.DSH_HOME = join(ROOT, '.dsh-dev')
const PROFILE_DIR = join(process.env.DSH_HOME, 'profiles', 'tui')

// 加载 DeepSeek API key：优先已有环境变量，否则读机器级配置位 ~/.dsh/.env（不进仓库）
if (!process.env.DEEPSEEK_API_KEY) {
  const envFile = join(homedir(), '.dsh', '.env')
  if (existsSync(envFile)) loadEnvFile(envFile)
}

if (!existsSync(join(PROFILE_DIR, 'package.json'))) {
  console.log('首次运行：装配 profile tui（dsh-base + 本插件 link: 本仓库）...')
  const add = run([CLI, 'plugin', '--profile', 'tui', 'add', '@deepseek-ai/dsh-base@0.1.1-rc.2', `link:${ROOT}`])
  if (add.status !== 0) process.exit(add.status ?? 1)
}

const r = run([CLI, '--profile', 'tui', ...process.argv.slice(2)])
process.exit(r.status ?? (r.signal ? 130 : 1))
