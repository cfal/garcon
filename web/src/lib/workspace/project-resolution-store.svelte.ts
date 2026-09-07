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

interface RetainedRecord {
	record: ProjectResolutionRecord;
	references: number;
}

interface PendingResolution {
	controller: AbortController;
	completion: Promise<void>;
	waiter: Promise<void>;
}

interface ChatBinding {
	projectPath: string;
	revision: number;
}

class ProjectResolutionRecord {
	snapshot = $state<ProjectResolutionSnapshot>({ kind: 'unchecked' });
	#request: PendingResolution | null = null;
	#disposed = false;

	constructor(
		readonly target: ProjectTarget,
		private readonly fetchResolution: typeof resolveProject,
		private readonly isRetained: () => boolean,
		private readonly onBindingChanged: (target: Extract<ProjectTarget, { kind: 'chat' }>) => void,
	) {}

	resolve(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		if (this.#request) return this.#request.waiter;
		const controller = new AbortController();
		if (this.snapshot.kind === 'unchecked') this.snapshot = { kind: 'resolving' };
		const pending: PendingResolution = {
			controller,
			completion: Promise.resolve(),
			waiter: Promise.resolve(),
		};
		this.#request = pending;
		const isCurrent = () =>
			this.#request === pending && !controller.signal.aborted && this.isRetained();
		let request: ReturnType<typeof resolveProject>;
		try {
			request = this.fetchResolution(this.target, controller.signal);
		} catch (error) {
			request = Promise.reject(error);
		}
		pending.completion = request
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
		pending.waiter = this.#waitForCurrentRequest(pending);
		return pending.waiter;
	}

	retry(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		const previous = this.#request;
		this.#request = null;
		previous?.controller.abort();
		this.snapshot = { kind: 'unchecked' };
		return this.resolve();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#request?.controller.abort();
		this.#request = null;
		this.snapshot = { kind: 'unchecked' };
	}

	async #waitForCurrentRequest(request: PendingResolution): Promise<void> {
		await request.completion;
		if (this.#disposed) return;
		const current = this.#request;
		if (current && current !== request) await current.waiter;
	}
}

export class ProjectResolutionStore {
	readonly #records = new SvelteMap<string, RetainedRecord>();
	readonly #chatBindings = new SvelteMap<string, ChatBinding>();
	#destroyed = false;

	constructor(
		private readonly fetchResolution: typeof resolveProject = resolveProject,
		private readonly onBindingChanged: (
			target: Extract<ProjectTarget, { kind: 'chat' }>,
		) => void = () => undefined,
	) {}

	retain(target: ProjectTarget): ProjectResolutionLease {
		if (this.#destroyed) throw new Error('Project resolution store has been destroyed');
		const key = projectTargetKey(target);
		if (target.kind === 'chat' && !this.#chatBindings.has(target.chatId)) {
			this.#chatBindings.set(target.chatId, { projectPath: target.projectPath, revision: 0 });
		}
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
			resolve: () =>
				released
					? Promise.reject(new Error('Project resolution lease has been released'))
					: record.resolve(),
			retry: () =>
				released
					? Promise.reject(new Error('Project resolution lease has been released'))
					: record.retry(),
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

	lifecycleKey(target: ProjectTarget): string {
		const key = projectTargetKey(target);
		if (target.kind === 'path') return key;
		return `${key}\u0000${this.#chatBindings.get(target.chatId)?.revision ?? 0}`;
	}

	markObsoleteChatTargets(chatId: string, currentProjectPath: string): void {
		const binding = this.#chatBindings.get(chatId);
		if (binding?.projectPath === currentProjectPath) return;
		this.#chatBindings.set(chatId, {
			projectPath: currentProjectPath,
			revision: (binding?.revision ?? 0) + 1,
		});
		for (const [key, retained] of this.#records) {
			const target = retained.record.target;
			if (
				target.kind !== 'chat' ||
				target.chatId !== chatId ||
				target.projectPath === currentProjectPath
			)
				continue;
			retained.record.dispose();
			this.#records.delete(key);
		}
	}

	removeChatTargets(chatId: string): void {
		this.#chatBindings.delete(chatId);
		for (const [key, retained] of this.#records) {
			const target = retained.record.target;
			if (target.kind !== 'chat' || target.chatId !== chatId) continue;
			retained.record.dispose();
			this.#records.delete(key);
		}
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		for (const retained of this.#records.values()) retained.record.dispose();
		this.#records.clear();
		this.#chatBindings.clear();
	}
}
