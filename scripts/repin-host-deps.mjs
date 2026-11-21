#!/usr/bin/env node
/**
 * 把 package.json 里的官方宿主依赖重钉到指定版本，供 CI 的宿主版本矩阵使用。
 *
 * 背景：本包用 `engines.dsh` 声明兼容整条 0.2.2 补丁线
 * （`>=0.2.2-rc.3 <0.3.0-0`）。声明是"我们认为兼容"，实测只在发布时的那个
 * rc 上做过。CI 用本脚本把 dev/runtime 钉线换到矩阵版本，再跑 typecheck，
 * 让"声明范围"变成"实测范围"。
 *
 * 只改 devDependencies / dependencies——peerDependencies 是范围声明，不动。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]

if (!target || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(target)) {
  console.error('用法: node scripts/repin-host-deps.mjs <version>   例: 0.2.2-rc.3')
  process.exit(2)
}

const manifestPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
let changed = 0
for (const section of ['devDependencies', 'dependencies']) {
  const entries = pkg[section]
  if (!entries || typeof entries !== 'object') continue
  for (const name of Object.keys(entries)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    if (entries[name] === target) continue
    entries[name] = target
    changed++
  }
}
writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`repinned ${changed} host dependency entries to ${target}`)
