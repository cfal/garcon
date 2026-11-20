import { getAgentCliUpdates, startAgentCliUpdate } from '$lib/api/agents.js';
import type { AgentCliUpdateStatus } from '$shared/agent-cli-update';

export interface CliUpdateApi {
	getAgentCliUpdates: typeof getAgentCliUpdates;
	startAgentCliUpdate: typeof startAgentCliUpdate;
}

const DEFAULT_API: CliUpdateApi = { getAgentCliUpdates, startAgentCliUpdate };
const RUN_POLL_INTERVAL_MS = 2_000;

// Native CLI versions and update runs for the agents on one executor. The
// executor owns each run, so this state only reads it back and polls while one
// is running.
export class SettingsCliUpdateState {
	readonly #api: CliUpdateApi;
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

	constructor(
		readonly executorId: string,
		api: CliUpdateApi = DEFAULT_API,
	) {
		this.#api = api;
	}

	initialize(): () => void {
		const lifecycleId = ++this.#lifecycleId;
		void this.#load(false, lifecycleId);
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
			await this.#load(true, this.#lifecycleId);
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

	async #load(refresh: boolean, lifecycleId: number): Promise<void> {
		const generation = ++this.#loadGeneration;
		this.loading = true;
		try {
			const response = await this.#api.getAgentCliUpdates(this.executorId, { refresh });
			if (!this.#isCurrentLoad(generation, lifecycleId)) return;
			this.statusByAgent = { ...response.statuses };
			this.failureByAgent = { ...response.failures };
			this.loadError = null;
			this.#schedulePoll(lifecycleId);
		} catch (error) {
			if (!this.#isCurrentLoad(generation, lifecycleId)) return;
			this.loadError = errorMessage(error);
		} finally {
			if (this.#isCurrentLoad(generation, lifecycleId)) this.loading = false;
		}
	}

	#schedulePoll(lifecycleId: number): void {
		this.#stopPolling();
		const running = Object.values(this.statusByAgent).some((status) => status.run.state === 'running');
		if (!running) return;
		this.#pollTimer = setTimeout(() => {
			this.#pollTimer = null;
			if (lifecycleId === this.#lifecycleId) void this.#load(false, lifecycleId);
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

function omit(record: Record<string, string>, key: string): Record<string, string>;
function omit(record: Record<string, boolean>, key: string): Record<string, boolean>;
function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
	const { [key]: _removed, ...rest } = record;
	return rest;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
