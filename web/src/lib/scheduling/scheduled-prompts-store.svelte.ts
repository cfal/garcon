import { untrack } from 'svelte';
import { ApiError } from '$lib/api/client.js';
import {
	createScheduledPrompt,
	getScheduledPrompts,
	removeScheduledPrompt,
	reorderScheduledPrompts,
	updateScheduledPrompt,
} from '$lib/api/scheduled-prompts.js';
import type {
	ScheduledPromptDefinitionInput,
	ScheduledPromptsSnapshot,
} from '$shared/scheduled-prompts';

export type ScheduledPromptsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ScheduledPromptsStoreDeps {
	get?: typeof getScheduledPrompts;
	create?: typeof createScheduledPrompt;
	update?: typeof updateScheduledPrompt;
	remove?: typeof removeScheduledPrompt;
	reorder?: typeof reorderScheduledPrompts;
}

export class ScheduledPromptsStore {
	status = $state<ScheduledPromptsStatus>('idle');
	snapshot = $state<ScheduledPromptsSnapshot | null>(null);
	error = $state<string | null>(null);
	isRefreshing = $state(false);
	#loadPromise: Promise<ScheduledPromptsSnapshot> | null = null;
	#refreshLoopPromise: Promise<void> | null = null;
	#refreshRequested = false;
	#localRevision = 0;

	constructor(private readonly deps: ScheduledPromptsStoreDeps = {}) {}

	get hasLoaded(): boolean {
		return this.snapshot !== null;
	}

	get prompts() {
		return this.snapshot?.prompts ?? [];
	}

	get runLog() {
		return this.snapshot?.runLog ?? [];
	}

	async ensureLoaded(): Promise<ScheduledPromptsSnapshot> {
		return this.snapshot ?? this.refresh({ initial: true });
	}

	async refresh(options: { initial?: boolean } = {}): Promise<ScheduledPromptsSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		const initial = options.initial === true || !this.snapshot;
		if (initial) this.status = 'loading';
		else this.isRefreshing = true;
		this.error = null;
		const get = this.deps.get ?? getScheduledPrompts;
		this.#loadPromise = get()
			.then((snapshot) => this.applySnapshot(snapshot))
			.catch((error) => {
				this.error = error instanceof Error ? error.message : 'Failed to load scheduled prompts';
				if (!this.snapshot) this.status = 'error';
				throw error;
			})
			.finally(() => {
				this.isRefreshing = false;
				this.#loadPromise = null;
			});
		return this.#loadPromise;
	}

	async refreshIfLoaded(): Promise<void> {
		if (!this.snapshot && this.status === 'idle') return;
		this.#refreshRequested = true;
		if (this.#refreshLoopPromise) return this.#refreshLoopPromise;
		this.#refreshLoopPromise = untrack(async () => {
			do {
				this.#refreshRequested = false;
				const joinedExistingLoad = this.#loadPromise !== null;
				try {
					await this.refresh();
				} catch {
					return;
				}
				if (joinedExistingLoad) this.#refreshRequested = true;
			} while (this.#refreshRequested);
		}).finally(() => {
			this.#refreshLoopPromise = null;
		});
		return this.#refreshLoopPromise;
	}

	async create(definition: ScheduledPromptDefinitionInput): Promise<ScheduledPromptsSnapshot> {
		const snapshot = await this.#requireSnapshot();
		try {
			const create = this.deps.create ?? createScheduledPrompt;
			const result = await create({
				expectedRevision: snapshot.revision,
				scheduledPrompt: definition,
			});
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async update(
		id: string,
		definition: ScheduledPromptDefinitionInput,
	): Promise<ScheduledPromptsSnapshot> {
		const snapshot = await this.#requireSnapshot();
		try {
			const update = this.deps.update ?? updateScheduledPrompt;
			const result = await update({
				expectedRevision: snapshot.revision,
				id,
				scheduledPrompt: definition,
			});
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async remove(id: string): Promise<ScheduledPromptsSnapshot> {
		const snapshot = await this.#requireSnapshot();
		try {
			const remove = this.deps.remove ?? removeScheduledPrompt;
			const result = await remove({ expectedRevision: snapshot.revision, id });
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async move(id: string, direction: 'up' | 'down'): Promise<void> {
		const snapshot = await this.#requireSnapshot();
		const index = snapshot.prompts.findIndex((scheduledPrompt) => scheduledPrompt.id === id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= snapshot.prompts.length) return;
		const prompts = [...snapshot.prompts];
		[prompts[index], prompts[target]] = [prompts[target], prompts[index]];
		const optimisticMarker = this.#localRevision + 1;
		this.#localRevision = optimisticMarker;
		this.snapshot = { ...snapshot, prompts };
		try {
			const reorder = this.deps.reorder ?? reorderScheduledPrompts;
			const result = await reorder({
				expectedRevision: snapshot.revision,
				orderedPromptIds: prompts.map((scheduledPrompt) => scheduledPrompt.id),
			});
			this.applySnapshot(result.snapshot);
		} catch (error) {
			if (this.#localRevision === optimisticMarker) this.snapshot = snapshot;
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	applySnapshot(snapshot: ScheduledPromptsSnapshot): ScheduledPromptsSnapshot {
		if (this.snapshot && snapshot.revision < this.snapshot.revision) return this.snapshot;
		this.snapshot = snapshot;
		this.status = 'ready';
		this.error = null;
		this.#localRevision += 1;
		return snapshot;
	}

	async #requireSnapshot(): Promise<ScheduledPromptsSnapshot> {
		return this.snapshot ?? this.ensureLoaded();
	}

	async #refreshAfterConflict(error: unknown): Promise<void> {
		if (error instanceof ApiError && error.status === 409) {
			try {
				await this.refresh();
			} catch {
				// The original conflict remains the actionable error.
			}
		}
	}
}

export function createScheduledPromptsStore(
	deps?: ScheduledPromptsStoreDeps,
): ScheduledPromptsStore {
	return new ScheduledPromptsStore(deps);
}
