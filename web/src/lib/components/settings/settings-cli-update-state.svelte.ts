import { getAgentCliUpdates, startAgentCliUpdate } from '$lib/api/agents.js';
import type { AgentCliUpdateStatus } from '$shared/agent-cli-update';
import { errorMessage } from '$lib/utils/error-message.js';

export interface CliUpdateApi {
	getAgentCliUpdates: typeof getAgentCliUpdates;
	startAgentCliUpdate: typeof startAgentCliUpdate;
}

const DEFAULT_API: CliUpdateApi = { getAgentCliUpdates, startAgentCliUpdate };
const RUN_POLL_INTERVAL_MS = 2_000;

// Native CLI versions and update runs for the agents on one executor. The
// executor owns each run, so this state only reads it back, polling just the
// agents whose run is active.
export class SettingsCliUpdateState {
	readonly #api: CliUpdateApi;
	readonly #agentOrder: readonly string[];
	#lifecycleId = 0;
	#loadGeneration = 0;
	#pollTimer: ReturnType<typeof setTimeout> | null = null;

	statusByAgent = $state<Record<string, AgentCliUpdateStatus>>({});
	failureByAgent = $state<Record<string, string>>({});
	startErrorByAgent = $state<Record<string, string>>({});
	startingByAgent = $state<Record<string, boolean>>({});
	loading = $state(false);
	checking = $state(false);
	loadError = $state<string | null>(null);

	// Agents the executor reported, whether their check succeeded or failed,
	// listed in `agentOrder` and then by ID.
	readonly agentIds = $derived.by(() => {
		const ids = new Set([...Object.keys(this.statusByAgent), ...Object.keys(this.failureByAgent)]);
		const rank = (id: string) => {
			const index = this.#agentOrder.indexOf(id);
			return index < 0 ? this.#agentOrder.length : index;
		};
		return [...ids].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
	});

	constructor(
		readonly executorId: string,
		agentOrder: readonly string[],
		api: CliUpdateApi = DEFAULT_API,
	) {
		this.#agentOrder = agentOrder;
		this.#api = api;
	}

	initialize(): () => void {
		const lifecycleId = ++this.#lifecycleId;
		void this.#load({ refresh: false }, lifecycleId);
		return () => {
			if (this.#lifecycleId === lifecycleId) this.destroy();
		};
	}

	destroy(): void {
		this.#lifecycleId += 1;
		this.#stopPolling();
		this.statusByAgent = {};
		this.failureByAgent = {};
		this.startErrorByAgent = {};
		this.startingByAgent = {};
		this.loading = false;
		this.checking = false;
		this.loadError = null;
	}

	statusFor(agentId: string): AgentCliUpdateStatus | undefined {
		return this.statusByAgent[agentId];
	}

	failureFor(agentId: string): string | undefined {
		return this.startErrorByAgent[agentId] ?? this.failureByAgent[agentId];
	}

	isStarting(agentId: string): boolean {
		return this.startingByAgent[agentId] ?? false;
	}

	// Bypasses the executor's cached latest-version lookups.
	async checkForUpdates(): Promise<void> {
		if (this.checking) return;
		this.checking = true;
		try {
			await this.#load({ refresh: true }, this.#lifecycleId);
		} finally {
			this.checking = false;
		}
	}

	async startUpdate(agentId: string): Promise<void> {
		if (this.isStarting(agentId) || this.statusFor(agentId)?.run.state === 'running') return;
		const lifecycleId = this.#lifecycleId;
		this.startingByAgent = { ...this.startingByAgent, [agentId]: true };
		this.startErrorByAgent = omit(this.startErrorByAgent, agentId);
		try {
			const status = await this.#api.startAgentCliUpdate(agentId, this.executorId);
			if (lifecycleId !== this.#lifecycleId) return;
			this.statusByAgent = { ...this.statusByAgent, [agentId]: status };
			this.#schedulePoll(lifecycleId);
		} catch (error) {
			if (lifecycleId !== this.#lifecycleId) return;
			this.startErrorByAgent = { ...this.startErrorByAgent, [agentId]: errorMessage(error) };
		} finally {
			if (lifecycleId === this.#lifecycleId) this.startingByAgent = omit(this.startingByAgent, agentId);
		}
	}

	// A read limited to `agentIds` replaces only those agents' entries.
	async #load(request: { refresh: boolean; agentIds?: readonly string[] }, lifecycleId: number): Promise<void> {
		const generation = ++this.#loadGeneration;
		this.loading = true;
		try {
			const response = await this.#api.getAgentCliUpdates(this.executorId, request);
			if (!this.#isCurrentLoad(generation, lifecycleId)) return;
			const replaced = request.agentIds ?? [...Object.keys(this.statusByAgent), ...Object.keys(this.failureByAgent)];
			this.statusByAgent = { ...omitAll(this.statusByAgent, replaced), ...response.statuses };
			this.failureByAgent = { ...omitAll(this.failureByAgent, replaced), ...response.failures };
			this.loadError = null;
		} catch (error) {
			if (!this.#isCurrentLoad(generation, lifecycleId)) return;
			this.loadError = errorMessage(error);
		} finally {
			if (this.#isCurrentLoad(generation, lifecycleId)) {
				this.loading = false;
				// A failed read during a run retries, since the run's outcome is still to come.
				this.#schedulePoll(lifecycleId);
			}
		}
	}

	#schedulePoll(lifecycleId: number): void {
		this.#stopPolling();
		const running = Object.entries(this.statusByAgent)
			.filter(([, status]) => status.run.state === 'running')
			.map(([agentId]) => agentId);
		if (running.length === 0) return;
		this.#pollTimer = setTimeout(() => {
			this.#pollTimer = null;
			if (lifecycleId === this.#lifecycleId) void this.#load({ refresh: false, agentIds: running }, lifecycleId);
		}, RUN_POLL_INTERVAL_MS);
	}

	#stopPolling(): void {
		if (this.#pollTimer) clearTimeout(this.#pollTimer);
		this.#pollTimer = null;
	}

	#isCurrentLoad(generation: number, lifecycleId: number): boolean {
		return generation === this.#loadGeneration && lifecycleId === this.#lifecycleId;
	}
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
	return omitAll(record, [key]);
}

function omitAll<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
	return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}
