/**
 * 发布契约：github: / npm 安装读的是 lib/*.js，不是 src。
 * harness 仓根包 @deepseek-ai/dsh-root 不发布；bundle 一旦 import 它，真实安装必炸
 * （https://github.com/huiliyi37/dsh-tianshu-tui/issues/1）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const UNPUBLISHED_ROOT = '@deepseek-ai/dsh-root'
const BUNDLES = ['lib/index.js', 'lib/invariant.js'] as const

function readRepo(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function gitIgnored(rel: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT })
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 1) {
      return false
    }
    throw error
  }
}

function importSpecifiers(code: string): string[] {
  const specifiers: string[] = []
  const fromRe = /\bfrom\s+["']([^"']+)["']/g
  const sideRe = /^import\s+["']([^"']+)["']/gm
  for (const re of [fromRe, sideRe]) {
    for (const match of code.matchAll(re)) {
      const spec = match[1]
      if (spec !== undefined) specifiers.push(spec)
    }
  }
  return specifiers
}

describe('published bundle contract', () => {
  const pkg = JSON.parse(readRepo('package.json')) as {
    peerDependencies: Record<string, string>
    dependencies: Record<string, string>
  }
  const allowedDeepseek = new Set(Object.keys(pkg.peerDependencies))
  const allowedRuntime = new Set(Object.keys(pkg.dependencies))

  for (const rel of BUNDLES) {
    it(`${rel} is tracked so github: installs do not rebuild inside the harness workspace`, () => {
      expect(gitIgnored(rel), `${rel} is gitignored; github clones will have no entry`).toBe(false)
    })

    it(`${rel} never imports unpublished ${UNPUBLISHED_ROOT}`, () => {
      const code = readRepo(rel)
      expect(code).not.toContain(UNPUBLISHED_ROOT)
      expect(importSpecifiers(code)).not.toContain(UNPUBLISHED_ROOT)
    })

    it(`${rel} only imports published peers, runtime deps, or node builtins`, () => {
      const unexpected = importSpecifiers(readRepo(rel)).filter((spec) => {
        if (spec.startsWith('node:')) return false
        if (allowedRuntime.has(spec)) return false
        if (spec.startsWith('@deepseek-ai/')) return !allowedDeepseek.has(spec)
        return true
      })
      expect(unexpected).toEqual([])
    })
  }

  it('#47 本包 patch 挂 agent-presets 并关掉 host agent 面（对标 web）', () => {
    const patch = readRepo('cordis.patch.yml')
    const pkg = JSON.parse(readRepo('package.json')) as {
      dsh?: { bundle?: { patch?: string } }
      dependencies?: Record<string, string>
    }
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(patch).toContain('id: tui-runner')
    expect(patch).toContain('@huiliyi37/dsh-tianshu-tui')
    expect(patch).toContain('id: agent-presets')
    expect(patch).toContain('@deepseek-ai/dsh-agent-presets')
    expect(patch).toMatch(/id:\s*tool-bash[\s\S]*disabled:\s*true/)
    expect(pkg.dependencies?.['@deepseek-ai/dsh-agent-presets']).toBe('0.1.5-rc.1')
  })

  it('官方预设包可解析时（无则跳过）不声明自己的 bundle.patch', async () => {
    let manifest: { dsh?: { bundle?: { patch?: string } } }
    try {
      manifest = (await import('@deepseek-ai/dsh-agent-presets/package.json', {
        with: { type: 'json' },
      })).default as { dsh?: { bundle?: { patch?: string } } }
    } catch {
      return
    }
    expect(manifest.dsh?.bundle?.patch).toBeUndefined()
  })
})

/**
 * 任务6 follow-up（#54 回归守卫）：内置 LSP 三件套的裸导入闭包必须完整。
 * 三件套把运行时依赖声明为 peerDependencies——pnpm autoInstallPeers:false 或
 * legacy-peer-deps 下都不会自动补装；tui 必须把他们实际 import 的每个
 * @huiliyi37/* 包显式列进自己的 dependencies（rc.23 就是漏了 cordis/tools/
 * brand 等导致整棵插件树启动失败）。
 */
describe('@huiliyi37 LSP 三件套依赖闭包守卫（#54）', () => {
  const TRIO = ['@huiliyi37/dsh-lsp', '@huiliyi37/dsh-lsp-local', '@huiliyi37/dsh-tool-lsp'] as const

  function walkLib(dir: string): string[] {
    const out: string[] = []
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walkLib(full))
      else if (entry.name.endsWith('.js')) out.push(full)
    }
    return out
  }

  function bareImports(file: string): string[] {
    const code = readFileSync(file, 'utf8')
    const specs: string[] = []
    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\@[^"'./][^"']*)["']/g)) {
      specs.push(m[1] as string)
    }
    return specs
  }

  it('裸包名导入都已声明为 tui dependencies，且安装进 node_modules 可解析', () => {
    execFileSync('node', ['--input-type=module', '-e',
      "for (const p of ['@huiliyi37/dsh-lsp','@huiliyi37/dsh-lsp-local','@huiliyi37/dsh-tool-lsp']) await import(p)",
    ], { cwd: ROOT })
    const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const declared = new Set(Object.keys(pkgJson.dependencies))
    const problems: string[] = []
    for (const pkgName of TRIO) {
      for (const file of walkLib(join(ROOT, 'node_modules', pkgName, 'lib'))) {
        for (const spec of bareImports(file)) {
          if (!spec.startsWith('@huiliyi37/') || spec.includes('/')) continue
          if (!declared.has(spec)) problems.push(`${pkgName} → ${spec} 未声明于 tui dependencies`)
        }
      }
    }
    expect(problems, '三件套出现未声明的裸导入——装进 profile 后必炸（#54 同款）').toEqual([])
  })
})
