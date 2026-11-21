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
/**
 * 宿主补丁线范围：engines.dsh 与 peer 共用（issue #63）。
 * 上界必须写成 `<0.3.0-0`——宿主判定用 `includePrerelease: true`，写 `<0.3.0`
 * 会把 0.3.0-rc.1 也放行（semver 里预发布版小于其正式版）。
 */
const HOST_RANGE = '>=0.2.2-rc.3 <0.3.0-0'
/** 本地开发/随包运行时的精确行；升宿主时跟这里一起改。 */
const HOST_PIN = '0.2.2-rc.5'

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
    engines: { node: string; dsh?: string }
    peerDependencies: Record<string, string>
    devDependencies: Record<string, string>
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

  it('宿主包版本策略：engines.dsh + peer 走补丁线范围，dev/runtime 精确钉当前宿主', () => {
    // issue #63：peer 精确钉旧版本，宿主升到 0.2.2-rc.5 后安装被兼容门拒绝。
    // 宿主 dsh-app-boot 的规则是「有 engines.dsh 就只看它、peer 被整体忽略」，
    // 所以范围声明落在 engines.dsh；peer 同步放宽，避免 profile 安装期的 peer 冲突。
    expect(pkg.engines.dsh, 'engines.dsh 是宿主兼容门的唯一判据').toBe(HOST_RANGE)
    for (const [name, version] of Object.entries(pkg.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) {
        expect(version, `peerDependencies.${name}`).toBe(HOST_RANGE)
      }
    }
    for (const section of ['devDependencies', 'dependencies'] as const) {
      for (const [name, version] of Object.entries(pkg[section])) {
        if (name.startsWith('@deepseek-ai/dsh-')) {
          expect(version, `${section}.${name}`).toBe(HOST_PIN)
        }
      }
    }
    expect(pkg.engines.node).toBe('>=24.9.0')
    expect(pkg.peerDependencies['@deepseek-ai/cordis']).toBe('~4.1.0')
    expect(pkg.devDependencies['@deepseek-ai/cordis']).toBe('~4.1.0')
    expect(pkg.devDependencies['@deepseek-ai/cordis-plugin-include']).toBe('~1.1.0')
    expect(pkg.devDependencies['@deepseek-ai/cordis-plugin-loader']).toBe('~1.1.0')
    expect(pkg.devDependencies['@deepseek-ai/cordis-plugin-timer']).toBe('~1.2.0')
    expect(pkg.devDependencies['@deepseek-ai/schemastery']).toBe('~3.19.0')
    expect(pkg.dependencies['node-addon-require-builtin']).toBe('^0.1.9')
  })

  it('PTC executor 随包发布，native/group 仅用于测试组合', () => {
    expect(pkg.dependencies['@deepseek-ai/dsh-tool-executor-ptc']).toBe(HOST_PIN)
    expect(pkg.devDependencies['@deepseek-ai/dsh-tool-executor-native']).toBe(HOST_PIN)
    expect(pkg.devDependencies['@deepseek-ai/cordis-plugin-group']).toBe('~1.1.0')
  })

  it('invariant companion 保持无官方服务依赖的兼容 no-op', async () => {
    expect(pkg.peerDependencies['@deepseek-ai/dsh-invariants']).toBeUndefined()
    expect(pkg.devDependencies['@deepseek-ai/dsh-invariants']).toBeUndefined()
    expect(pkg.dependencies['@huiliyi37/dsh-invariants']).toBeUndefined()
    expect(readRepo('src/invariant.ts')).not.toContain('@deepseek-ai/dsh-invariants')
    expect(readRepo('lib/invariant.js')).not.toContain('@deepseek-ai/dsh-invariants')
    const invariantUrl = new URL('../lib/invariant.js', import.meta.url).href
    const companion = (await import(invariantUrl)) as {
      inject: string[]
      apply: () => Promise<() => void>
    }
    expect(companion.inject).toEqual([])
    const dispose = await companion.apply()
    expect(dispose).toBeTypeOf('function')
    expect(dispose()).toBeUndefined()
  })

  it('#47 本包 patch 挂 agent-preset-registry 并关掉 host agent 面（对标 web）', () => {
    const patch = readRepo('cordis.patch.yml')
    const pkg = JSON.parse(readRepo('package.json')) as {
      dsh?: { bundle?: { patch?: string } }
      dependencies?: Record<string, string>
    }
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(patch).toContain('id: tui-runner')
    expect(patch).toContain('@huiliyi37/dsh-tianshu-tui')
    // 0.2.0：官方预设架构改为注册表 + 声明行（dsh-agent-presets 已退场）
    expect(patch).toContain('id: agent-preset-registry')
    expect(patch).toContain('@deepseek-ai/dsh-agent-preset-registry')
    expect(patch).toContain("name: '@deepseek-ai/dsh-agent-preset'")
    expect(patch).toMatch(/id:\s*tool-bash[\s\S]*disabled:\s*true/)
    expect(patch).toContain("name: '@deepseek-ai/dsh-time-context'")
    expect(patch).toContain("id: cordis-host-runner\n      name: '@deepseek-ai/dsh-cordis-host-runner'")
    expect(patch).toContain("id: cordis-inspect-providers\n      name: '@deepseek-ai/dsh-tool-cordis/host'")
    expect(patch).not.toContain('@deepseek-ai/dsh-schedule')
    expect(patch).not.toContain('@deepseek-ai/dsh-tool-schedule')
    for (const name of [
      '@deepseek-ai/dsh-agent-preset-registry',
      '@deepseek-ai/dsh-agent-preset',
      '@deepseek-ai/dsh-cordis-host-runner',
      '@deepseek-ai/dsh-plugin-market',
      '@deepseek-ai/dsh-time-context',
      '@deepseek-ai/dsh-tool-cordis',
      '@deepseek-ai/dsh-tool-executor-ptc',
    ]) {
      expect(pkg.dependencies?.[name], `${name} must ship with the profile bundle`).toBe(HOST_PIN)
    }
  })

  for (const forbidden of ['list-agents', 'modelSelectionSettings', 'tool-presentation']) {
    it(`legacy preset entry is forbidden: ${forbidden}`, () => {
      expect(readRepo('cordis.patch.yml')).not.toContain(forbidden)
    })
  }

  it('官方预设注册表可解析时（无则跳过）不声明自己的 bundle.patch', async () => {
    let manifest: { dsh?: { bundle?: { patch?: string } } }
    try {
      manifest = (await import('@deepseek-ai/dsh-agent-preset-registry/package.json', {
        with: { type: 'json' },
      })).default as { dsh?: { bundle?: { patch?: string } } }
    } catch {
      return
    }
    expect(manifest.dsh?.bundle?.patch).toBeUndefined()
  })
})
