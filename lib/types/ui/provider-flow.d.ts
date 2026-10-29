import type { OverlayController } from '../engine/overlay-controller.js';
import type { ProviderEditorController } from './provider-editor.js';
import type { WizardProviderEntry } from './key-wizard.js';
export interface ProviderFlowReflect {
    get(name: string, optional?: boolean): unknown;
}
export interface ProviderFlowDeps {
    overlay: OverlayController | null;
    editor: ProviderEditorController | null;
    reflect: ProviderFlowReflect;
    isDisposed: () => boolean;
    onSaved: () => void;
}
export declare class ProviderFlow {
    private readonly deps;
    constructor(deps: ProviderFlowDeps);
    private settings;
    private namespace;
    private takenRoutes;
    private unavailable;
    openCreate(): Promise<void>;
    openEdit(entry: WizardProviderEntry): Promise<boolean>;
    private openSession;
}
