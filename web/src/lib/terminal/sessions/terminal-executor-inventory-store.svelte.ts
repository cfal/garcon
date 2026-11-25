import type { listTerminals } from '$lib/api/terminals.js';
import type { TerminalListResponse } from '$shared/terminal';
import * as m from '$lib/paraglide/messages.js';
import type { TerminalExecutorInventory, TerminalRegistryDeps } from './terminal-registry-types.js';

export class TerminalExecutorInventoryStore {
	executorInventories = $state<Record<string, TerminalExecutorInventory>>({});
	listStatus = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
	listError = $state<string | null>(null);

	readonly #lists = new Map<string, Promise<void>>();
	readonly #executorVersions = new Map<string, symbol>();
	readonly #executorAvailability = new Map<string, 'offline' | 'ready'>();
	#stopExecutors: (() => void) | undefined;
	#initialized = false;
	#destroyed = false;
	#inventoryRetry: ReturnType<typeof setTimeout> | null = null;
	#onInventoryReady: (() => void) | null = null;

	constructor(
		private readonly options: {
			executors: TerminalRegistryDeps['executors'];
			hosts(): readonly { id: string; available: boolean }[];
			authSuspended(): boolean;
			listTerminals: typeof listTerminals;
			mutationVersion(): number;
			acceptList(executorId: string, response: TerminalListResponse, mutationVersion: number): void;
			onReady(executorId: string): void;
			restoreAttachments(executorId: string): void;
			onRemoved(executorId: string): void;
			onUnavailable(executorId: string): void;
		},
	) {}

	startWatching(): void {
		this.#stopExecutors = this.options.executors?.onChanged(() => this.#executorsChanged());
		this.#executorsChanged();
	}

	initialize(): Promise<void> {
		this.#initialized = true;
		return this.list();
	}

	listPromiseFor(executorId: string): Promise<void> | undefined {
		return this.#lists.get(executorId);
	}

	hasExecutor(executorId: string): boolean {
		return this.#executorVersions.has(executorId);
	}

	invalidateReadiness(): void {
		this.#onInventoryReady = null;
	}

	destroy(): void {
		this.#destroyed = true;
		this.clearRetry();
		this.#stopExecutors?.();
		this.invalidateReadiness();
		this.#executorVersions.clear();
		this.#lists.clear();
		this.#executorAvailability.clear();
	}

	async list(executorId?: string): Promise<void> {
		if (executorId !== undefined) return this.#listExecutor(executorId);
		const hosts = this.options.hosts().filter((host) => host.available);
		const results = await Promise.allSettled(hosts.map((host) => this.#listExecutor(host.id)));
		if (!results.some((result) => result.status === 'fulfilled'))
			throw new Error(this.listError ?? m.terminal_list_failed());
	}

	async reconcileConnection(): Promise<void> {
		// Accepted inventories, including retries, release readiness; discarded replies do not.
		let onInventoryReady!: () => void;
		const readiness = new Promise<void>((resolve, reject) => {
			onInventoryReady = resolve;
			this.#onInventoryReady = resolve;
			void Promise.allSettled(
				this.options
					.hosts()
					.filter((host) => host.available)
					.map((host) => this.#refreshExecutor(host.id)),
			).then(() => reject(new Error(this.listError ?? m.terminal_list_failed())));
		});
		try {
			await readiness;
		} finally {
			if (this.#onInventoryReady === onInventoryReady) this.#onInventoryReady = null;
		}
	}

	async #listExecutor(executorId: string): Promise<void> {
		const pending = this.#lists.get(executorId);
		if (pending) return pending;
		const version = this.#executorVersions.get(executorId) ?? Symbol('executor-inventory');
		this.#executorVersions.set(executorId, version);
		const startedAtMutationVersion = this.options.mutationVersion();
		this.listStatus = 'loading';
		this.listError = null;
		this.executorInventories[executorId] = {
			...this.executorInventories[executorId],
			status: 'loading',
			error: null,
		};
		const listing = Promise.resolve().then(async () => {
			try {
				const response = await this.options.listTerminals(executorId);
				if (this.#destroyed || version !== this.#executorVersions.get(executorId)) return;
				this.options.acceptList(executorId, response, startedAtMutationVersion);
				this.executorInventories[executorId] = {
					status: 'ready',
					runtimeId: response.terminalRuntimeId,
					epoch: response.attachmentEpoch,
					error: null,
				};
				this.listStatus = 'ready';
				this.options.onReady(executorId);
				this.#onInventoryReady?.();
			} catch (error) {
				if (this.#destroyed || version !== this.#executorVersions.get(executorId)) return;
				this.executorInventories[executorId] = {
					...this.executorInventories[executorId],
					status: 'failed',
					error: error instanceof Error ? error.message : m.terminal_list_failed(),
				};
				this.listStatus = 'failed';
				this.listError = error instanceof Error ? error.message : m.terminal_list_failed();
				this.scheduleRetry();
				throw error;
			} finally {
				if (this.#lists.get(executorId) === listing) this.#lists.delete(executorId);
			}
		});
		this.#lists.set(executorId, listing);
		return listing;
	}

	#executorsChanged(): void {
		const hosts = this.options.hosts();
		const known = new Set(
			(this.options.executors?.executors ?? hosts).map((executor) => executor.id),
		);
		for (const executorId of known) {
			if (hosts.some((host) => host.id === executorId)) continue;
			if (this.#executorAvailability.get(executorId) !== 'offline') this.#loseExecutor(executorId);
			this.#executorAvailability.set(executorId, 'offline');
		}
		for (const executorId of this.#executorAvailability.keys()) {
			if (known.has(executorId)) continue;
			this.#loseExecutor(executorId);
			this.#executorAvailability.delete(executorId);
			this.#executorVersions.delete(executorId);
			delete this.executorInventories[executorId];
			this.options.onRemoved(executorId);
		}
		for (const host of hosts) {
			const availability = host.available ? 'ready' : 'offline';
			const previous = this.#executorAvailability.get(host.id);
			this.#executorAvailability.set(host.id, availability);
			if (previous === availability) continue;
			if (!host.available) this.#loseExecutor(host.id);
			else if (this.#initialized && !this.options.authSuspended()) {
				void this.#refreshExecutor(host.id);
			}
		}
	}

	async #refreshExecutor(executorId: string): Promise<void> {
		try {
			await this.list(executorId);
		} catch {
			return;
		}
		this.options.restoreAttachments(executorId);
	}

	scheduleRetry(): void {
		if (
			this.#inventoryRetry ||
			!this.#initialized ||
			this.options.authSuspended() ||
			this.#destroyed
		)
			return;
		if (
			!this.options
				.hosts()
				.some((host) => host.available && this.executorInventories[host.id]?.status === 'failed')
		)
			return;
		this.#inventoryRetry = setTimeout(() => {
			this.#inventoryRetry = null;
			for (const host of this.options.hosts())
				if (host.available && this.executorInventories[host.id]?.status === 'failed')
					void this.#refreshExecutor(host.id);
		}, 5_000);
	}

	clearRetry(): void {
		if (this.#inventoryRetry) clearTimeout(this.#inventoryRetry);
		this.#inventoryRetry = null;
	}

	#loseExecutor(executorId: string): void {
		this.#executorVersions.set(executorId, Symbol('executor-inventory'));
		this.#lists.delete(executorId);
		this.executorInventories[executorId] = {
			...this.executorInventories[executorId],
			status: 'failed',
			error: m.terminal_unavailable(),
		};
		this.options.onUnavailable(executorId);
	}
}
