import type { SubagentManagementModel } from './subagent-management.js';

export interface SubagentToolbarSource {
	readonly model: SubagentManagementModel;
	jumpToTool(anchorId: string): void;
}

export class SubagentToolbarState {
	#source = $state.raw<SubagentToolbarSource | null>(null);

	register(source: SubagentToolbarSource): () => void {
		this.#source = source;

		return () => {
			if (this.#source === source) {
				this.#source = null;
			}
		};
	}

	get model(): SubagentManagementModel | null {
		return this.#source?.model ?? null;
	}

	jumpToTool(anchorId: string): void {
		this.#source?.jumpToTool(anchorId);
	}
}
