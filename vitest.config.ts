import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** dsh-tui 独立测试配置：跑 tests/ 下全部 spec（node 环境，无 jsdom 依赖）。 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary'],
      // 阈值只按目录分组卡，不设全局阈值：整体 ~83% 里混着大量 TUI 装配代码
      // （app.ts 单体、overlay/keymap 粘合），卡全局只会逼人改测试凑数。
      // 纯函数目录才是"承诺过的行为"能兑现的地方，先在这里立门禁；
      // 数值取当前基线略低一档，用来防倒退，不是用来逼提覆盖。
      thresholds: {
        'src/format/**': { lines: 90, statements: 88, functions: 95 },
        'src/pi/**': { lines: 42, statements: 39, functions: 51 },
      },
    },
  },
})
