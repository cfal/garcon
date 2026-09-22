import type { GhAvailabilityReason, GhStatusResponse } from '$shared/gh';
import { getGhStatus } from '$lib/api/gh.js';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';

export interface GhNodeCapabilityContext {
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
	forNode(nodeId: string): GhNodeCapabilityContext;
}

type GhNodesPort = Pick<
	ExecutionNodesStore,
	'nodes' | 'get' | 'onChanged' | 'gitContextKey' | 'ghAvailable'
>;

export class GhCapabilityStore implements GhCapabilityContext {
	readonly #entries = new Map<string, GhNodeCapabilityStore>();
	readonly #unsubscribe: () => void;

	constructor(private readonly nodes: GhNodesPort = new ExecutionNodesStore()) {
		this.#unsubscribe = nodes.onChanged(() => {
			for (const [nodeId, entry] of this.#entries) {
				entry.invalidate();
				if (!nodes.get(nodeId)) this.#entries.delete(nodeId);
			}
		});
	}

	forNode(nodeId: string): GhNodeCapabilityStore {
		let entry = this.#entries.get(nodeId);
		if (!entry) {
			entry = new GhNodeCapabilityStore(nodeId, this.nodes);
			if (this.nodes.get(nodeId)) this.#entries.set(nodeId, entry);
		}
		return entry;
	}

	destroy(): void {
		this.#unsubscribe();
		for (const entry of this.#entries.values()) entry.dispose();
		this.#entries.clear();
	}
}

export class GhNodeCapabilityStore implements GhNodeCapabilityContext {
	#loadGeneration = 0;
	#startupChecked = false;
	#startupPromise: Promise<void> | null = null;
	#abort: AbortController | null = null;
	#contextKey: string;

	constructor(
		readonly nodeId: string,
		private readonly nodes: GhNodesPort,
	) {
		this.#contextKey = nodes.gitContextKey(nodeId);
		this.hasChecked = !nodes.ghAvailable(nodeId);
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
		const key = this.nodes.gitContextKey(this.nodeId);
		if (key === this.#contextKey) return;
		this.#contextKey = key;
		this.dispose();
		this.available = false;
		this.authenticated = false;
		this.hasChecked = !this.nodes.ghAvailable(this.nodeId);
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
		if (!this.nodes.ghAvailable(this.nodeId)) return;
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
			const status = await getGhStatus(this.nodeId, { signal: controller.signal });
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

export function createGhCapabilityStore(nodes?: GhNodesPort): GhCapabilityStore {
	return new GhCapabilityStore(nodes);
}
