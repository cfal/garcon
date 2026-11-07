import type { SubagentManagementModel } from './subagent-management.js';
import type { DisplaySummaryPaging } from './display-summary-paging.js';

export interface SubagentToolbarSource {
	readonly model: SubagentManagementModel;
	readonly paging?: DisplaySummaryPaging;
	jumpToTool(ordinal: number): void;
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

	get paging(): DisplaySummaryPaging | undefined { return this.#source?.paging; }

	jumpToTool(ordinal: number): void {
		this.#source?.jumpToTool(ordinal);
	}
}
