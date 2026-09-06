import { SvelteMap } from 'svelte/reactivity';
import {
	projectTargetKey,
	type ProjectResolution,
	type ProjectTarget,
} from '$shared/project-resolution';
import { ApiError } from '$lib/api/client.js';
import { resolveProject } from '$lib/api/project-resolution.js';

export type ProjectResolutionSnapshot =
	| { readonly kind: 'unchecked' }
	| { readonly kind: 'resolving' }
	| ProjectResolution
	| { readonly kind: 'request-failed'; readonly message: string };

export interface ProjectResolutionLease {
	readonly target: ProjectTarget;
	readonly snapshot: ProjectResolutionSnapshot;
	resolve(): Promise<void>;
	retry(): Promise<void>;
	release(): void;
}

interface ChatInvalidationOptions {
	preserveProjectPath?: string;
}

interface RetainedRecord {
	record: ProjectResolutionRecord;
	references: number;
}

class ProjectResolutionRecord {
	snapshot = $state<ProjectResolutionSnapshot>({ kind: 'unchecked' });
	#request: { controller: AbortController; promise: Promise<void> } | null = null;

	constructor(
		readonly target: ProjectTarget,
		private readonly fetchResolution: typeof resolveProject,
		private readonly isRetained: () => boolean,
		private readonly onBindingChanged: (target: Extract<ProjectTarget, { kind: 'chat' }>) => void,
	) {}

	resolve(): Promise<void> {
		if (this.#request) return this.#request.promise;
		const controller = new AbortController();
		this.snapshot = { kind: 'resolving' };
		const pending = { controller, promise: Promise.resolve() };
		this.#request = pending;
		const isCurrent = () =>
			this.#request === pending && !controller.signal.aborted && this.isRetained();
		pending.promise = this.fetchResolution(this.target, controller.signal)
			.then((response) => {
				if (isCurrent()) this.snapshot = response.resolution;
			})
			.catch((error: unknown) => {
				if (!isCurrent()) return;
				this.snapshot = {
					kind: 'request-failed',
					message: error instanceof Error ? error.message : 'Project check failed',
				};
				if (
					error instanceof ApiError &&
					error.errorCode === 'PROJECT_PATH_CHANGED' &&
					this.target.kind === 'chat'
				) {
					this.onBindingChanged(this.target);
				}
			})
			.finally(() => {
				if (this.#request === pending) this.#request = null;
			});
		return pending.promise;
	}

	retry(): Promise<void> {
		this.invalidate();
		return this.resolve();
	}

	invalidate(): void {
		this.#request?.controller.abort();
		this.#request = null;
		this.snapshot = { kind: 'unchecked' };
	}

	dispose(): void {
		this.invalidate();
	}
}

export class ProjectResolutionStore {
	readonly #records = new SvelteMap<string, RetainedRecord>();

	constructor(
		private readonly fetchResolution: typeof resolveProject = resolveProject,
		private readonly onBindingChanged: (
			target: Extract<ProjectTarget, { kind: 'chat' }>,
		) => void = () => undefined,
	) {}

	retain(target: ProjectTarget): ProjectResolutionLease {
		const key = projectTargetKey(target);
		let retained = this.#records.get(key);
		if (!retained) {
			const record = new ProjectResolutionRecord(
				target,
				this.fetchResolution,
				(): boolean => this.#records.get(key)?.record === record,
				this.onBindingChanged,
			);
			retained = { record, references: 0 };
			this.#records.set(key, retained);
		}
		retained.references += 1;
		let released = false;
		const record = retained.record;
		return {
			target: record.target,
			get snapshot() {
				return record.snapshot;
			},
			resolve: () => record.resolve(),
			retry: () => record.retry(),
			release: () => {
				if (released) return;
				released = true;
				const current = this.#records.get(key);
				if (!current || current.record !== record) return;
				current.references -= 1;
				if (current.references > 0) return;
				record.dispose();
				this.#records.delete(key);
			},
		};
	}

	snapshotFor(target: ProjectTarget): ProjectResolutionSnapshot {
		return this.#records.get(projectTargetKey(target))?.record.snapshot ?? { kind: 'unchecked' };
	}

	invalidateChat(chatId: string, options: ChatInvalidationOptions = {}): void {
		for (const retained of this.#records.values()) {
			if (
				retained.record.target.kind === 'chat' &&
				retained.record.target.chatId === chatId &&
				retained.record.target.projectPath !== options.preserveProjectPath
			) {
				retained.record.invalidate();
			}
		}
	}

	destroy(): void {
		for (const retained of this.#records.values()) retained.record.dispose();
		this.#records.clear();
	}
}
