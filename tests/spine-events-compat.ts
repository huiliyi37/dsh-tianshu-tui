/**
 * 真实组合测试专用的 Session.events 兼容垫片。
 *
 * 背景：rc.1 移除了 `Session.events` getter（改 snapshotEvents()/eventAt()），
 * 而组合测试的 spine 替身 `@deepseek-ai/dsh-agent-spine-demo` 停在 0.1.2-alpha.2
 * （0.1.2-rc 线无发布），其投影内核仍按 alpha.2 表面读 `session.events`，
 * 直串 rc.1 的 dsh-agent-loop 即抛「events is not iterable」。
 *
 * 本垫片只在三个 real-composition spec 的模块面安装一次：把 `events` 以
 * getter 形式桥到 `snapshotEvents()`，让 stale spine 在 rc.1 服务树上可跑。
 * 生产代码零接触；官方发布 rc 线 spine-demo 后整体移除。
 */
import { Session } from '@deepseek-ai/dsh-session'

let installed = false

export function installSpineEventsCompat(): void {
  if (installed) return
  const proto = Session.prototype as unknown as Record<string, unknown>
  if (typeof proto.snapshotEvents !== 'function') return
  if ('events' in proto) return
  Object.defineProperty(proto, 'events', {
    get(this: { snapshotEvents(): readonly unknown[] }) {
      return this.snapshotEvents()
    },
    enumerable: false,
    configurable: true,
  })
  installed = true
}
