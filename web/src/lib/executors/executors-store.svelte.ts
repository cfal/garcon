import { getExecutors } from '$lib/api/executors.js';
import {
	effectiveExecutorId,
	parseExecutors,
	type ExecutorSnapshot,
} from '$shared/executors';

const localFallback: readonly ExecutorSnapshot[] = [
	{
		id: 'local',
		label: 'Local',
		kind: 'local',
		enabled: true,
		allowControllerCli: true,
		direction: null,
		availability: 'ready',
		instanceId: null,
		projectBasePath: null,
		lastError: null,
		machineServices: { files: true, git: true, gh: true, terminals: true },
	},
];

export class ExecutorsStore {
	readonly #listeners = new Set<() => void>();
	#snapshot = $state.raw<readonly ExecutorSnapshot[] | null>(null);
	error = $state<string | null>(null);
	loading = $state(false);
	#version = 0;
	#request: Promise<void> | null = null;

	constructor(private readonly read = getExecutors) {}

	get executors(): readonly ExecutorSnapshot[] {
		return this.#snapshot ?? localFallback;
	}
	get hasSnapshot(): boolean {
		return this.#snapshot !== null;
	}
	get hasRemoteExecutors(): boolean {
		return this.executors.some((executor) => executor.id !== 'local');
	}

	get(id?: string | null): ExecutorSnapshot | undefined {
		return this.executors.find((executor) => executor.id === effectiveExecutorId(id));
	}

	label(id?: string | null): string {
		return this.get(id)?.label ?? (effectiveExecutorId(id) === 'local' ? 'Local' : this.hasSnapshot ? 'Unavailable executor' : effectiveExecutorId(id));
	}

	isReady(id?: string | null): boolean {
		const executor = this.get(id);
		return executor?.enabled === true && executor.availability === 'ready';
	}

	filesAvailable(id?: string | null): boolean {
		return this.isReady(id) && this.get(id)?.machineServices.files === true;
	}

	gitAvailable(id?: string | null): boolean {
		return this.isReady(id) && this.get(id)?.machineServices.git === true;
	}

	ghAvailable(id?: string | null): boolean {
		return this.gitAvailable(id) && this.get(id)?.machineServices.gh === true;
	}

	gitContextKey(id?: string | null): string {
		const executor = this.get(id);
		return JSON.stringify([
			effectiveExecutorId(id),
			executor?.instanceId,
			executor?.projectBasePath,
			executor?.enabled,
			executor?.availability,
			executor?.machineServices.git,
			executor?.machineServices.gh,
		]);
	}

	pathContextKey(id?: string | null): string {
		const executor = this.get(id);
		return JSON.stringify([
			effectiveExecutorId(id),
			executor?.instanceId,
			executor?.projectBasePath,
			executor?.enabled,
			executor?.availability,
			executor?.machineServices.files,
		]);
	}

	applySnapshot(value: unknown): void {
		const executors = parseExecutors(value);
		if (!executors) throw new Error('Invalid executors snapshot');
		this.#snapshot = executors;
		this.error = null;
		this.#version += 1;
		for (const listener of this.#listeners) listener();
	}

	onChanged(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async refresh(): Promise<void> {
		if (this.#request) return this.#request;
		const version = this.#version;
		this.loading = true;
		this.#request = this.read()
			.then((executors) => {
				if (version === this.#version) this.applySnapshot(executors);
			})
			.catch((error: unknown) => {
				if (version === this.#version)
					this.error = error instanceof Error ? error.message : 'Unable to load executors';
			})
			.finally(() => {
				this.loading = false;
				this.#request = null;
			});
		return this.#request;
	}

	async refreshAfterMutation(): Promise<void> {
		await this.#request;
		await this.refresh();
	}
}

export function executorStatus(executor: ExecutorSnapshot): string {
	if (!executor.enabled) return 'Disabled';
	if (executor.availability === 'ready') return 'Ready';
	return executor.direction === 'executor-connects' ? 'Waiting for connection' : 'Offline';
}
