import type { AgentCliInstallationStatus } from '$shared/agent-installation';
import { getAgentInstallationStatus, updateAgentInstallation } from '$lib/api/agent-installation';

export class AgentCliUpdateState {
	installation = $state<AgentCliInstallationStatus | null>(null);
	loading = $state(false);
	updating = $state(false);
	error = $state<string | null>(null);
	completed = $state(false);
	output = $state('');
	#active = false;
	#generation = 0;

	constructor(readonly agentId: string, readonly executorId: string, readonly instanceId: string) {}

	initialize(): () => void {
		this.#active = true;
		void this.refresh();
		return () => {
			this.#active = false;
			this.#generation++;
		};
	}

	async refresh(): Promise<void> {
		if (!this.#active || this.updating || this.loading) return;
		const generation = ++this.#generation;
		this.loading = true;
		this.#clearFeedback();
		try {
			const installation = await getAgentInstallationStatus(this.agentId, this.executorId);
			if (this.#isCurrent(generation)) this.installation = installation;
		} catch (error) {
			if (this.#isCurrent(generation)) {
				this.installation = null;
				this.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			if (this.#isCurrent(generation)) this.loading = false;
		}
	}

	async update(): Promise<void> {
		if (!this.#active || this.updating || this.loading) return;
		const generation = ++this.#generation;
		this.updating = true;
		this.#clearFeedback();
		try {
			const result = await updateAgentInstallation({ agentId: this.agentId, executorId: this.executorId, instanceId: this.instanceId });
			if (!this.#isCurrent(generation)) return;
			this.installation = result.installation;
			this.output = result.output;
			this.completed = true;
		} catch (error) {
			if (!this.#isCurrent(generation)) return;
			this.installation = null;
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.#isCurrent(generation)) this.updating = false;
		}
	}

	#isCurrent(generation: number): boolean {
		return this.#active && this.#generation === generation;
	}

	#clearFeedback(): void {
		this.error = null;
		this.completed = false;
		this.output = '';
	}
}
