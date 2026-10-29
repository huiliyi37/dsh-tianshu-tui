import type { OverlayKeyResult, OverlayRenderer } from '../engine/overlay-engine.js';
import type { RivetTheme } from '../theme.js';
import { type DiscoveredProviderModel, type ProviderDraft } from './provider-profile.js';
export interface ProviderDiscoveryRequest {
    provider?: string;
    baseURL?: string;
    api?: string;
    apiKey?: string;
}
export type ProviderSaveResult = {
    kind: 'saved';
} | {
    kind: 'profile-error';
    message: string;
} | {
    kind: 'key-error';
    message: string;
};
export interface ProviderEditorSession {
    mode: 'create' | 'edit';
    title: string;
    draft: ProviderDraft;
    defaultBaseURL?: string;
    taken: readonly string[];
    discover(request: ProviderDiscoveryRequest, signal: AbortSignal): Promise<readonly DiscoveredProviderModel[]>;
    save(draft: ProviderDraft): Promise<ProviderSaveResult>;
}
export interface ProviderEditorOptions {
    getTheme: () => RivetTheme;
    onChange?: () => void;
}
export declare class ProviderEditorController implements OverlayRenderer {
    private phase;
    private session;
    private draft;
    private focus;
    private modelIndex;
    private candidates;
    private candidateIndex;
    private picked;
    private error;
    private notice;
    private openFlag;
    private closeRequested;
    private generation;
    private discoveryAbort;
    private readonly getTheme;
    private readonly onChange;
    constructor(opts: ProviderEditorOptions);
    open(session: ProviderEditorSession): void;
    openUnavailable(message: string): void;
    isOpen(): boolean;
    wantsClose(): boolean;
    onDeactivate(): void;
    private fields;
    private moveFocus;
    private selectedModel;
    private updateTextAt;
    private updateText;
    private cycleProtocol;
    private addModel;
    private removeModel;
    private discoveryRequest;
    private discover;
    private save;
    private handleCandidate;
    handleKey(name: string, char: string): OverlayKeyResult;
    beginPaste(): (text: string) => void;
    pasteText(text: string): void;
    showNotice(text: string): void;
    private withNotice;
    private field;
    private renderCandidates;
    render(width: number, height: number): string[];
}
