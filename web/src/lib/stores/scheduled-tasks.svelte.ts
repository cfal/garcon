import { untrack } from 'svelte';
import { ApiError } from '$lib/api/client.js';
import {
	createScheduledTask,
	getScheduledTasks,
	removeScheduledTask,
	reorderScheduledTasks,
	updateScheduledTask,
} from '$lib/api/scheduled-tasks.js';
import type { ScheduledTaskDefinitionInput, ScheduledTasksSnapshot } from '$shared/scheduled-tasks';

export type ScheduledTasksStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ScheduledTasksStoreDeps {
	get?: typeof getScheduledTasks;
	create?: typeof createScheduledTask;
	update?: typeof updateScheduledTask;
	remove?: typeof removeScheduledTask;
	reorder?: typeof reorderScheduledTasks;
}

export class ScheduledTasksStore {
	status = $state<ScheduledTasksStatus>('idle');
	snapshot = $state<ScheduledTasksSnapshot | null>(null);
	error = $state<string | null>(null);
	isRefreshing = $state(false);
	#loadPromise: Promise<ScheduledTasksSnapshot> | null = null;
	#refreshLoopPromise: Promise<void> | null = null;
	#refreshRequested = false;
	#localRevision = 0;

	constructor(private readonly deps: ScheduledTasksStoreDeps = {}) {}

	get hasLoaded(): boolean {
		return this.snapshot !== null;
	}

	get tasks() {
		return this.snapshot?.tasks ?? [];
	}

	get runLog() {
		return this.snapshot?.runLog ?? [];
	}

	async ensureLoaded(): Promise<ScheduledTasksSnapshot> {
		return this.snapshot ?? this.refresh({ initial: true });
	}

	async refresh(options: { initial?: boolean } = {}): Promise<ScheduledTasksSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		const initial = options.initial === true || !this.snapshot;
		if (initial) this.status = 'loading';
		else this.isRefreshing = true;
		this.error = null;
		const get = this.deps.get ?? getScheduledTasks;
		this.#loadPromise = get()
			.then((snapshot) => this.applySnapshot(snapshot))
			.catch((error) => {
				this.error = error instanceof Error ? error.message : 'Failed to load scheduled tasks';
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

	async create(definition: ScheduledTaskDefinitionInput): Promise<ScheduledTasksSnapshot> {
		const snapshot = await this.#requireSnapshot();
		try {
			const create = this.deps.create ?? createScheduledTask;
			const result = await create({ expectedRevision: snapshot.revision, task: definition });
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async update(
		id: string,
		definition: ScheduledTaskDefinitionInput,
	): Promise<ScheduledTasksSnapshot> {
		const snapshot = await this.#requireSnapshot();
		try {
			const update = this.deps.update ?? updateScheduledTask;
			const result = await update({
				expectedRevision: snapshot.revision,
				id,
				task: definition,
			});
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async remove(id: string): Promise<ScheduledTasksSnapshot> {
		const snapshot = await this.#requireSnapshot();
		try {
			const remove = this.deps.remove ?? removeScheduledTask;
			const result = await remove({ expectedRevision: snapshot.revision, id });
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async move(id: string, direction: 'up' | 'down'): Promise<void> {
		const snapshot = await this.#requireSnapshot();
		const index = snapshot.tasks.findIndex((task) => task.id === id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= snapshot.tasks.length) return;
		const tasks = [...snapshot.tasks];
		[tasks[index], tasks[target]] = [tasks[target], tasks[index]];
		const optimisticMarker = this.#localRevision + 1;
		this.#localRevision = optimisticMarker;
		this.snapshot = { ...snapshot, tasks };
		try {
			const reorder = this.deps.reorder ?? reorderScheduledTasks;
			const result = await reorder({
				expectedRevision: snapshot.revision,
				orderedTaskIds: tasks.map((task) => task.id),
			});
			this.applySnapshot(result.snapshot);
		} catch (error) {
			if (this.#localRevision === optimisticMarker) this.snapshot = snapshot;
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	applySnapshot(snapshot: ScheduledTasksSnapshot): ScheduledTasksSnapshot {
		if (this.snapshot && snapshot.revision < this.snapshot.revision) return this.snapshot;
		this.snapshot = snapshot;
		this.status = 'ready';
		this.error = null;
		this.#localRevision += 1;
		return snapshot;
	}

	async #requireSnapshot(): Promise<ScheduledTasksSnapshot> {
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

export function createScheduledTasksStore(deps?: ScheduledTasksStoreDeps): ScheduledTasksStore {
	return new ScheduledTasksStore(deps);
}
