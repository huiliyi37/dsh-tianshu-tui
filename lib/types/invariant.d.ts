/**
 * Compatibility no-op invariant companion for @huiliyi37/dsh-tianshu-tui.
 *
 * The TUI owns no cross-plugin event/data relation: emitting packages assert
 * their streams, while process-local UI state is covered by behavioral and
 * real-composition tests. Host 0.2.2 no longer provides the official invariant
 * registry, so this entry deliberately neither injects nor registers it.
 *
 * Keep the published path and plugin exports for package-layout compatibility.
 *
 * @module @huiliyi37/dsh-tianshu-tui/invariant
 */
/** Cordis companion plugin name retained for profile compatibility. */
export declare const name = "tui-invariant";
/** No retired service is required during plugin activation. */
export declare const inject: string[];
/** Preserve the asynchronous disposer shape without installing any checks. */
export declare const apply: () => Promise<() => void>;
