import { ApiError, isIntermediaryResponse } from '$lib/api/client';
import type { readText, saveText } from '$lib/api/files';
import { isFileRevisionConflict } from '$lib/files/persistence/file-save-coordinator';
import * as m from '$lib/paraglide/messages.js';
import type { FileRevision } from '$shared/file-contracts';

export interface WorkflowFileTarget {
	executorId: string;
	projectPath?: string;
	filePath: string;
}

interface WorkflowFilePort {
	readText: typeof readText;
	saveText: typeof saveText;
}

interface WorkflowFileComparison {
	source: string;
	disk: string;
	revision: FileRevision;
}

export class WorkflowFileState {
	readonly target: WorkflowFileTarget;
	baseline = $state('');
	comparison = $state.raw<WorkflowFileComparison | null>(null);
	reconcileRequired = $state(false);
	busy = $state(false);
	error = $state<unknown>(null);
	#revision: FileRevision;
	#request: AbortController | null = null;
	#disposed = false;

	private constructor(
		private readonly api: WorkflowFilePort,
		target: WorkflowFileTarget,
		revision: FileRevision,
		source: string,
	) {
		this.target = target;
		this.#revision = revision;
		this.baseline = source;
	}

	static async open(
		api: WorkflowFilePort,
		target: WorkflowFileTarget,
		signal?: AbortSignal,
	): Promise<WorkflowFileState> {
		const result = await api.readText(target, { signal });
		return new WorkflowFileState(
			api,
			{ ...target, filePath: result.path },
			result.revision,
			result.content,
		);
	}

	async #perform(action: (request: AbortController) => Promise<void>): Promise<void> {
		if (this.busy || this.#disposed) return;
		const request = new AbortController();
		this.#request = request;
		this.busy = true;
		this.error = null;
		try {
			await action(request);
		} catch (error) {
			if (this.#request === request) this.error = error;
		} finally {
			if (this.#request === request) {
				this.#request = null;
				this.busy = false;
			}
		}
	}

	#acceptRevision(revision: FileRevision, source: string): void {
		this.#revision = revision;
		this.baseline = source;
		this.reconcileRequired = false;
		this.comparison = null;
	}

	async #save(source: string, revision: FileRevision): Promise<void> {
		await this.#perform(async (request) => {
			try {
				const result = await this.api.saveText(
					{
						...this.target,
						content: source,
						expectedRevision: revision,
						conflictResolution: 'reject',
					},
					{ signal: request.signal },
				);
				if (this.#request !== request) return;
				if (result.path !== this.target.filePath)
					throw new Error(m.workflow_studio_file_identity_changed());
				this.#acceptRevision(result.revision, source);
			} catch (error) {
				if (
					this.#request === request &&
					(isFileRevisionConflict(error) ||
						!(error instanceof ApiError) ||
						isIntermediaryResponse(error) ||
						error.errorCode === 'FILE_SAVE_OUTCOME_UNKNOWN')
				) {
					this.reconcileRequired = true;
					this.comparison = null;
				}
				throw error;
			}
		});
	}

	async save(source: string): Promise<void> {
		if (this.reconcileRequired || source === this.baseline) return;
		await this.#save(source, this.#revision);
	}

	async compare(getSource: () => string): Promise<void> {
		await this.#perform(async (request) => {
			const disk = await this.api.readText(this.target, { signal: request.signal });
			if (this.#request !== request) return;
			if (disk.path !== this.target.filePath)
				throw new Error(m.workflow_studio_file_identity_changed());
			const source = getSource();
			if (disk.content === source || disk.revision === this.#revision) {
				this.#acceptRevision(disk.revision, disk.content);
			} else {
				this.reconcileRequired = true;
				this.comparison = { source, disk: disk.content, revision: disk.revision };
			}
		});
	}

	acceptDisk(source: string): string | undefined {
		const comparison = this.comparison;
		if (this.busy || !comparison || comparison.source !== source) return;
		this.#acceptRevision(comparison.revision, comparison.disk);
		return comparison.disk;
	}

	async saveCompared(source: string, resolved: string, replaceSource: (source: string) => void) {
		const comparison = this.comparison;
		if (this.busy || !comparison || comparison.source !== source) return;
		this.comparison = null;
		replaceSource(resolved);
		await this.#save(resolved, comparison.revision);
	}

	dispose(): void {
		this.#disposed = true;
		this.#request?.abort();
		this.#request = null;
	}
}
