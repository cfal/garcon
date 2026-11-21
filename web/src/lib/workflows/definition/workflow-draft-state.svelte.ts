import { createRandomId } from '$lib/utils/random-id';
import {
	editWorkflowDefinition,
	parseWorkflowDefinition,
	type WorkflowDefinition,
	type WorkflowDefinitionEdit,
	type WorkflowDefinitionEditResult,
	type WorkflowDefinitionParseResult,
} from '$shared/workflow-definition';
import type { WorkflowRevision } from '$shared/workflow-runs';
import type { WorkflowFileState } from './workflow-file-state.svelte';

const HISTORY_LIMIT = 30;
const TYPE_MERGE_MS = 500;

export class WorkflowDraftState {
	readonly definitionId: string;
	readonly file: WorkflowFileState | null;
	revision = $state<number | null>(null);
	source = $state('');
	#baseline = $state('');
	result = $state.raw<WorkflowDefinitionParseResult>({ definition: null, diagnostics: [] });
	lastValid = $state.raw<WorkflowDefinition | null>(null);
	rejected = $state.raw<WorkflowDefinitionEditResult | null>(null);
	#past = $state.raw<string[]>([]);
	#future = $state.raw<string[]>([]);
	#lastTypedAt = 0;

	constructor(
		source: string,
		origin?: { definition?: WorkflowRevision; file?: WorkflowFileState; baseline?: string },
	) {
		this.definitionId = origin?.definition?.definitionId ?? createRandomId();
		this.revision = origin?.definition?.revision ?? null;
		this.file = origin?.file ?? null;
		this.#baseline = origin?.definition?.source ?? origin?.baseline ?? '';
		this.#apply(source);
	}

	get dirty(): boolean {
		return this.source !== (this.file?.baseline ?? this.#baseline);
	}

	get canUndo(): boolean {
		return this.#past.length > 0;
	}
	get canRedo(): boolean {
		return this.#future.length > 0;
	}

	#apply(source: string, result = parseWorkflowDefinition(source)): void {
		this.source = source;
		this.result = result;
		this.rejected = null;
		if (result.definition) this.lastValid = result.definition;
	}

	#remember(): void {
		this.#past = [...this.#past.slice(1 - HISTORY_LIMIT), this.source];
	}

	replaceSource(source: string, typing = false): void {
		if (this.source === source) return;
		const time = Date.now();
		if (!typing || !this.#lastTypedAt || time - this.#lastTypedAt > TYPE_MERGE_MS) this.#remember();
		this.#lastTypedAt = typing ? time : 0;
		this.#future = [];
		this.#apply(source);
	}

	edit(edits: readonly WorkflowDefinitionEdit[]): boolean {
		if (!this.result.definition) return false;
		const result = editWorkflowDefinition(this.source, edits);
		if (!result.definition) {
			this.rejected = result;
			return false;
		}
		this.rejected = null;
		if (result.source !== this.source) {
			this.#remember();
			this.#lastTypedAt = 0;
			this.#future = [];
			this.#apply(result.source, result);
		}
		return true;
	}

	undo(): boolean {
		const source = this.#past.at(-1);
		if (source === undefined) return false;
		this.#future = [...this.#future, this.source];
		this.#past = this.#past.slice(0, -1);
		this.#lastTypedAt = 0;
		this.#apply(source);
		return true;
	}

	redo(): boolean {
		const source = this.#future.at(-1);
		if (source === undefined) return false;
		this.#remember();
		this.#future = this.#future.slice(0, -1);
		this.#lastTypedAt = 0;
		this.#apply(source);
		return true;
	}

	acceptPublished(revision: WorkflowRevision): void {
		this.revision = revision.revision;
		this.#baseline = revision.source;
	}
}
