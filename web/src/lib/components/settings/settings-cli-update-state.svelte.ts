import { getAgentCliUpdates, startAgentCliUpdate } from '$lib/api/agents.js';
import type { AgentCliUpdateStatus, AgentCliUpdatesResponse } from '$shared/agent-cli-update';
import { ApiError } from '$lib/api/client.js';
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
	// Orders reads and starts per agent: a response replaces an agent's entry
	// only when its request was issued after that entry was written, so agent
	// polls, recovery reads, and full checks never discard one another.
	#sequence = 0;
	#agentWrittenAt: Record<string, number> = {};
	// The run each uncertain start replaced; a different run means it started after all.
	#startBaseline: Record<string, string | null> = {};
	#loadsInFlight = 0;
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
		this.#agentWrittenAt = {};
		this.#startBaseline = {};
		this.#loadsInFlight = 0;
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

	checkFailureFor(agentId: string): string | undefined {
		return this.failureByAgent[agentId];
	}

	startErrorFor(agentId: string): string | undefined {
		return this.startErrorByAgent[agentId];
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
		const baseline = this.statusFor(agentId)?.run.startedAt ?? null;
		try {
			const status = await this.#api.startAgentCliUpdate(agentId, this.executorId);
			if (lifecycleId !== this.#lifecycleId) return;
			this.#agentWrittenAt[agentId] = ++this.#sequence;
			this.statusByAgent = { ...this.statusByAgent, [agentId]: status };
			this.#schedulePoll(lifecycleId);
		} catch (error) {
			if (lifecycleId !== this.#lifecycleId) return;
			this.startErrorByAgent = { ...this.startErrorByAgent, [agentId]: errorMessage(error) };
			// A 4xx answer is a definite refusal. A timeout, lost reply, or server
			// failure may still have started the run, so its status is read again.
			if (!(error instanceof ApiError && error.status >= 400 && error.status < 500)) {
				this.#startBaseline[agentId] = baseline;
				void this.#load({ refresh: false, agentIds: [agentId] }, lifecycleId);
			}
		} finally {
			if (lifecycleId === this.#lifecycleId) this.startingByAgent = omit(this.startingByAgent, agentId);
		}
	}

	// A read limited to `agentIds` replaces only those agents' entries.
	async #load(request: { refresh: boolean; agentIds?: readonly string[] }, lifecycleId: number): Promise<void> {
		const issuedAt = ++this.#sequence;
		this.#loadsInFlight += 1;
		this.loading = true;
		try {
			const response = await this.#api.getAgentCliUpdates(this.executorId, request);
			if (lifecycleId !== this.#lifecycleId) return;
			this.#apply(response, request.agentIds ?? null, issuedAt);
			this.loadError = null;
		} catch (error) {
			if (lifecycleId !== this.#lifecycleId) return;
			this.loadError = errorMessage(error);
		} finally {
			if (lifecycleId === this.#lifecycleId) {
				this.#loadsInFlight -= 1;
				this.loading = this.#loadsInFlight > 0;
				// A failed read during a run retries, since the run's outcome is still to come.
				this.#schedulePoll(lifecycleId);
			}
		}
	}

	#apply(response: AgentCliUpdatesResponse, scope: readonly string[] | null, issuedAt: number): void {
		const agents = new Set([
			...(scope ?? [...Object.keys(this.statusByAgent), ...Object.keys(this.failureByAgent)]),
			...Object.keys(response.statuses),
			...Object.keys(response.failures),
		]);
		const statuses = { ...this.statusByAgent };
		const failures = { ...this.failureByAgent };
		let startErrors = this.startErrorByAgent;
		for (const agentId of agents) {
			if (issuedAt <= (this.#agentWrittenAt[agentId] ?? 0)) continue;
			this.#agentWrittenAt[agentId] = issuedAt;
			const status = response.statuses[agentId];
			if (status) statuses[agentId] = status;
			else delete statuses[agentId];
			const failure = response.failures[agentId];
			if (failure !== undefined) failures[agentId] = failure;
			else delete failures[agentId];
			const baseline = this.#startBaseline[agentId];
			if (baseline !== undefined && status?.run.startedAt && status.run.startedAt !== baseline) {
				startErrors = omit(startErrors, agentId);
				delete this.#startBaseline[agentId];
			}
		}
		this.statusByAgent = statuses;
		this.failureByAgent = failures;
		this.startErrorByAgent = startErrors;
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
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
	return Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));
}
