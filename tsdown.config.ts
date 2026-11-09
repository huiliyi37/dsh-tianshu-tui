import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  peerDependencies: Record<string, string>
  dependencies: Record<string, string>
}

/** Harness workspace root: private, never published. https://github.com/huiliyi37/dsh-tianshu-tui/issues/1 */
const UNPUBLISHED_ROOT = '@deepseek-ai/dsh-root'
const RETIRED_INVARIANTS = '@deepseek-ai/dsh-invariants'

function assertNoUnpublishedRoot(file: string): void {
  const code = readFileSync(file, 'utf8')
  if (code.includes(UNPUBLISHED_ROOT)) {
    throw new Error(
      `${file} imports ${UNPUBLISHED_ROOT}, which is not published. ` +
        'Build this package with tsdown.config.ts in this repo, not the harness workspace tsdown.',
    )
  }
}

function assertNoRetiredInvariants(file: string): void {
  const code = readFileSync(file, 'utf8')
  if (code.includes(RETIRED_INVARIANTS)) {
    throw new Error(`${file} must remain a compatibility no-op without ${RETIRED_INVARIANTS}.`)
  }
}

const shared = {
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  outputOptions: { codeSplitting: false },
  dts: false,
  clean: false,
  // Explicit peer + runtime list. A /^@deepseek-ai\// regex would leave
  // @deepseek-ai/dsh-root as a runtime import when this package is built
  // inside the harness monorepo.
  deps: {
    neverBundle: [...Object.keys(pkg.peerDependencies), ...Object.keys(pkg.dependencies)],
    alwaysBundle: [UNPUBLISHED_ROOT],
  },
  onSuccess() {
    assertNoUnpublishedRoot(join(root, 'lib/index.js'))
    assertNoUnpublishedRoot(join(root, 'lib/invariant.js'))
    assertNoRetiredInvariants(join(root, 'lib/invariant.js'))
  },
}

/** Build the package root and compatibility no-op invariant companion as independent bundles. */
export default defineConfig([
  { entry: ['lib/types/index.js'], ...shared },
  { entry: ['lib/types/invariant.js'], ...shared },
])
