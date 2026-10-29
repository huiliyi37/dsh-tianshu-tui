/**
 * key-flow — /key 供应商密钥配置的装配层（提取自上游 tianshu-public
 * TuiApp 的 openKeyDialog 系列，2026-08 回流）。上游这些方法是 TuiApp
 * 实例私有方法；本仓按棘轮约束（ui/app.ts 只降不升）提取为独立模块，
 * TuiApp 仅保留 deps 注入与 overlay 注册。
 *
 * 分层：key-wizard（目录/引用决策）→ key-dialog/provider-editor（状态机+渲染）→
 * 本模块（供应商 picker 与 key 装配）；pi-ai 完整 profile 由 provider-flow 负责。
 *
 * @module dsh-tui/key-flow
 */
import type { OverlayController } from '../engine/overlay-controller.js';
import type { PickerController } from '../picker.js';
import { KeyDialogController, type KeyDialogCredentials } from './key-dialog.js';
import { type WizardProviderEntry } from './key-wizard.js';
import type { ProviderFlow } from './provider-flow.js';
/** ctx.reflect 的最小面（结构兼容 cordis reflect；key-flow 只消费 get）。 */
export interface KeyFlowReflect {
    get(name: string, optional?: boolean): unknown;
}
/** settings 服务最小面（describe/mutate；缺席时向导只存 key 不做 profile 激活）。 */
export interface KeyWizardSettingsFacet {
    describe(options?: {
        redactSecrets?: boolean;
    }): Array<{
        ns: string;
        value: unknown;
        user?: unknown;
    }>;
    mutate(ns: string, ops: Array<{
        op: string;
        path: readonly string[];
        value: unknown;
    }>): Promise<void>;
}
/** key-flow 装配依赖（全部由 TuiApp 注入；null = 服务缺席，走降级路径）。 */
export interface KeyFlowDeps {
    overlay: OverlayController | null;
    picker: PickerController | null;
    keyDialog: KeyDialogController | null;
    /** pi-ai 完整 provider 编辑器；缺省保持原 key-only 装配。 */
    providerFlow?: ProviderFlow;
    reflect: KeyFlowReflect;
    isDisposed: () => boolean;
    /** 首启引导：标准输入是否 TTY（非 TTY 不弹交互对话框）。 */
    stdinIsTTY: () => boolean;
    /** 首启引导：当前 API key 就绪标志（欢迎行已刷新）。 */
    apiKeyReady: () => boolean;
    /** 首启引导开关：false 时 maybeAutoOpenKeyDialog 恒不弹（测试替身/宿主显式禁用）。 */
    autoPrompt?: boolean;
    /** agent-default-model 面（缺省无默认供应商）。 */
    agentDefaultModel?: {
        currentSelection?: () => {
            provider: string;
        };
    };
    /** /config 凭据字段编辑入口 miss 时的回调（上游 finishConfigReturn）。 */
    onConfigEntryMissing?: () => void;
}
/**
 * /key 供应商密钥配置装配控制器。方法语义与上游 TuiApp 同名方法一致：
 * - openKeyDialog：llm 配置目录可用时先开供应商 picker（默认供应商 ● 置首、
 *   已配置 ✓ 后缀），选中后链到参数化的 key 对话框；目录缺席降级 DeepSeek 直开。
 * - openCredentialFromConfig：/config 凭据字段编辑入口（向导后段）。
 * - maybeAutoOpenKeyDialog：首启引导（TTY 缺 key 自动弹一次，run 级守护）。
 */
export declare class KeyFlow {
    /** 首启引导守护：本 run 已自动弹过一次 key 对话框（restore 等后续流程不再重复弹）。 */
    private keyPromptShown;
    private readonly deps;
    constructor(deps: KeyFlowDeps);
    /**
     * /key：供应商配置向导。目录可用时先开 picker；pi-ai 进入完整 provider
     * 编辑器（settings 不可用时回退 key-only），其余进入参数化 key 对话框。
     * 目录缺席降级 DeepSeek 直开，凭据服务缺席时给降级指引。
     */
    openKeyDialog(): Promise<void>;
    /**
     * 打开参数化 key 对话框；entry 缺省即 DeepSeek 缺省目标（首启引导与降级）。
     * pi-ai 路由的 profile 未声明 apiKeyEnv 时挂 afterSave：保存后补写
     * `{providers: {<route>: {apiKeyEnv}}}`——路由即刻注册，/model 立即可选
     * （与 web 模型页的写入形状一致）；settings 缺席则只存 key 不激活。
     * @param entry - 目录条目；undefined = DeepSeek 缺省目标。
     * @param credentials - 凭据服务最小面；undefined = 服务缺席（对话框降级指引）。
     */
    openKeyDialogForEntry(entry: WizardProviderEntry | undefined, credentials: KeyDialogCredentials | undefined): Promise<void>;
    /**
     * 凭据字段编辑：从 /config 进该供应商的 /key 对话框（向导后段）。
     * 目录中找不到该供应商（目录已变更）或路由不使用 API Key 时走
     * onConfigEntryMissing 回调。
     * @param provider - 供应商路由 id。
     */
    openCredentialFromConfig(provider: string): Promise<void>;
    /**
     * 首启引导：交互终端（TTY）缺 API key 时自动打开一次设置对话框（Esc 可跳过）。
     * 挂载点在欢迎渲染/会话就绪之后（attach 尾；apiKeyReady 已由
     * prepareWelcome 刷新）；keyPromptShown 做 run 级守护，
     * restore/重进等后续流程不再重复弹；非 TTY（测试/管道）不弹交互对话框。
     */
    maybeAutoOpenKeyDialog(): void;
    /** llm 配置目录（llm seam 缺席或面不含该法时为空数组——降级 DeepSeek 直开）。 */
    keyWizardDirectory(): WizardProviderEntry[];
    /** settings 服务最小面（describe/mutate；缺席时向导只存 key 不做 profile 激活）。 */
    settingsMutationFacet(): KeyWizardSettingsFacet | undefined;
    /** 读取 settings 各命名空间的已解析值（ns 对象原样保留供 mutate 回传）。 */
    readResolvedSettingsSections(): Map<string, unknown>;
    /** 读取原始用户层；字段是否由用户覆盖只能在这一层判断，不能看 resolved 默认值。 */
    readUserSettingsSections(): Map<string, unknown> | undefined;
    private readSettingsSections;
    private profileValue;
    /**
     * 目录条目在已解析 settings 段里的 `apiKeyEnv`（组合层下发的 openrouter
     * profile 就带着 OPENROUTER_API_KEY）；llm-deepseek 段经 schema 缺省解析
     * 为 DEEPSEEK_API_KEY。无 profile/未声明返回 undefined（落派生规则）。
     */
    profileApiKeyEnv(sections: ReadonlyMap<string, unknown>, entry: WizardProviderEntry): string | undefined;
    private profileString;
    /** 仅官方 API Key 与未覆盖路由语义的内置 pi-ai deepseek 构成别名。 */
    private officialDeepSeekAlias;
    /**
     * 供应商探测实现：llm-deepseek 段用既有官方端点探测。pi-ai catalog 的
     * discoverModels 会本地短路，不能证明 key 有效，直接 unknown；declared
     * 自定义路由携带草稿 baseURL/api 走真实端点发现，成功才 ok。
     */
    private keyProbeFor;
    /** 保存 key 后激活路由：写入最小 profile（settingsPath 非空 = pi-ai 路由）。 */
    private activateRouteProfile;
    /** 当前 base 无 sessionController；按官方 groups 的 llm 数据源判定账号组非空。 */
    private deepSeekAccountAvailable;
    /** 当前默认模型所在的供应商路由（agent-default-model 缺席时无默认）。 */
    private defaultModelProvider;
}
