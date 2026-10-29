export declare const PI_AI_PROTOCOLS: readonly ['openai-completions', 'openai-responses', 'anthropic-messages'];
export type ProviderProfile = Record<string, unknown>;
export type ProviderModel = Record<string, unknown>;
export interface ProviderDraft {
    route: string;
    declared: boolean;
    profile: ProviderProfile;
    models: ProviderModel[];
    modelsOverridden: boolean;
    keyDraft: string;
}
export interface DiscoveredProviderModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    inputModalities?: readonly string[];
}
export type ProviderSettingsOp = {
    op: 'set';
    path: readonly string[];
    value: unknown;
} | {
    op: 'unset';
    path: readonly string[];
};
export declare function isProviderProfile(value: unknown): value is ProviderProfile;
export declare function providerModels(value: unknown): ProviderModel[];
export declare function providerString(profile: ProviderProfile, key: string): string | undefined;
export declare function setProviderString(draft: ProviderDraft, key: string, value: string): void;
export declare function normalizedApiKey(draft: ProviderDraft): string;
export declare function apiKeyFailure(draft: ProviderDraft): 'blank' | 'illegal' | undefined;
export declare function validProviderBaseURL(value: string): boolean;
export declare function normalizedProviderProfile(draft: ProviderDraft): ProviderProfile;
export declare function profileForSave(draft: ProviderDraft, keyRef: string, resolvedApiKeyEnv: string | undefined): ProviderProfile;
export declare function createProviderProfile(draft: ProviderDraft): ProviderProfile;
export declare function validateProviderDraft(draft: ProviderDraft, mode: 'create' | 'edit'): string | undefined;
export declare function providerPathOps(base: readonly string[], before: unknown, after: ProviderProfile): ProviderSettingsOp[];
export declare function discoveredModel(model: DiscoveredProviderModel): ProviderModel;
export declare function adoptProviderModels(current: readonly ProviderModel[], discovered: readonly DiscoveredProviderModel[], picked: ReadonlySet<string>): ProviderModel[];
