import type { WorkspaceProjectState } from './workspace-context.svelte.js';

export interface PortableSingletonController {
	setProjectState(projectState: WorkspaceProjectState): void;
	setPresentationVisible(visible: boolean): void;
	dispose(): void;
}
