import type { GhAvailabilityReason, GhStatusResponse } from '$shared/gh';
import { getGhStatus } from '$lib/api/gh.js';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';

export interface GhExecutorCapabilityContext {
	available: boolean;
	authenticated: boolean;
	reason: GhAvailabilityReason | null;
	login: string | null;
	host: string | null;
	isLoading: boolean;
	hasChecked: boolean;
	lastError: string | null;
	ensureChecked: () => Promise<void>;
	refresh: () => Promise<void>;
}

export interface GhCapabilityContext {
	forExecutor(executorId: string): GhExecutorCapabilityContext;
}

type GhExecutorsPort = Pick<
	ExecutorsStore,
	'executors' | 'get' | 'onChanged' | 'gitContextKey' | 'ghAvailable'
>;

export class GhCapabilityStore implements GhCapabilityContext {
	readonly #entries = new Map<string, GhExecutorCapabilityStore>();
	readonly #unsubscribe: () => void;

	constructor(private readonly executors: GhExecutorsPort = new ExecutorsStore()) {
		this.#unsubscribe = executors.onChanged(() => {
			for (const [executorId, entry] of this.#entries) {
				entry.invalidate();
				if (!executors.get(executorId)) this.#entries.delete(executorId);
			}
		});
	}

	forExecutor(executorId: string): GhExecutorCapabilityStore {
		let entry = this.#entries.get(executorId);
		if (!entry) {
			entry = new GhExecutorCapabilityStore(executorId, this.executors);
			if (this.executors.get(executorId)) this.#entries.set(executorId, entry);
		}
		return entry;
	}

	destroy(): void {
		this.#unsubscribe();
		for (const entry of this.#entries.values()) entry.dispose();
		this.#entries.clear();
	}
}

export class GhExecutorCapabilityStore implements GhExecutorCapabilityContext {
	#loadGeneration = 0;
	#startupChecked = false;
	#startupPromise: Promise<void> | null = null;
	#abort: AbortController | null = null;
	#contextKey: string;

	constructor(
		readonly executorId: string,
		private readonly executors: GhExecutorsPort,
	) {
		this.#contextKey = executors.gitContextKey(executorId);
		this.hasChecked = !executors.ghAvailable(executorId);
	}

	available = $state(false);
	authenticated = $state(false);
	reason = $state<GhAvailabilityReason | null>(null);
	login = $state<string | null>(null);
	host = $state<string | null>(null);
	isLoading = $state(false);
	hasChecked = $state(false);
	lastError = $state<string | null>(null);

	invalidate(): void {
		const key = this.executors.gitContextKey(this.executorId);
		if (key === this.#contextKey) return;
		this.#contextKey = key;
		this.dispose();
		this.available = false;
		this.authenticated = false;
		this.hasChecked = !this.executors.ghAvailable(this.executorId);
		this.reason = null;
		this.login = null;
		this.host = null;
		this.lastError = null;
		this.#startupChecked = false;
	}

	dispose(): void {
		this.#loadGeneration++;
		this.#abort?.abort();
		this.#abort = null;
		this.#startupPromise = null;
		this.isLoading = false;
	}

	async ensureChecked(): Promise<void> {
		if (!this.executors.ghAvailable(this.executorId)) return;
		if (this.#startupChecked) return;
		if (this.#startupPromise) return this.#startupPromise;

		const request = this.#load().finally(() => {
			if (this.#startupPromise !== request) return;
			this.#startupChecked = true;
			this.#startupPromise = null;
		});
		this.#startupPromise = request;
		return request;
	}

	async refresh(): Promise<void> {
		this.dispose();
		this.#startupChecked = false;
		await this.ensureChecked();
	}

	async #load(): Promise<void> {
		const generation = ++this.#loadGeneration;
		this.#abort?.abort();
		const controller = new AbortController();
		this.#abort = controller;
		this.isLoading = true;
		this.lastError = null;

		try {
			const status = await getGhStatus(this.executorId, { signal: controller.signal });
			if (generation !== this.#loadGeneration) return;
			this.#applyStatus(status);
			this.hasChecked = true;
		} catch (error) {
			if (generation !== this.#loadGeneration) return;
			this.available = false;
			this.authenticated = false;
			this.reason = 'unknown';
			this.login = null;
			this.host = null;
			this.hasChecked = true;
			this.lastError =
				error instanceof Error ? error.message : 'Failed to check GitHub CLI status.';
		} finally {
			if (generation === this.#loadGeneration) {
				this.isLoading = false;
				this.#abort = null;
			}
		}
	}

	#applyStatus(status: GhStatusResponse): void {
		this.available = status.available;
		this.authenticated = status.authenticated;
		this.reason = status.reason;
		this.login = status.login ?? null;
		this.host = status.host ?? null;
	}
}

export function createGhCapabilityStore(executors?: GhExecutorsPort): GhCapabilityStore {
	return new GhCapabilityStore(executors);
}
