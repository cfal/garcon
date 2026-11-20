import type { AgentCliUpdateStatus } from '$shared/agent-cli-update';

// What a CLI update row offers: a one-click update, a command to run by hand, or nothing.
export type AgentCliUpdateAction = 'update' | 'manual' | 'none';

export interface AgentCliUpdateView {
	readonly updateAvailable: boolean;
	readonly action: AgentCliUpdateAction;
	readonly running: boolean;
	readonly outcome: 'succeeded' | 'failed' | 'unchanged' | null;
}

export function agentCliUpdateView(status: AgentCliUpdateStatus): AgentCliUpdateView {
	const running = status.run.state === 'running';
	const updateAvailable = status.advisory === 'behind-latest';
	const action: AgentCliUpdateAction = running || !updateAvailable
		? 'none'
		: status.canUpdate
			? 'update'
			: status.updateCommand
				? 'manual'
				: 'none';
	const outcome = status.run.state === 'idle' || running ? null : status.run.state;
	return { updateAvailable, action, running, outcome };
}
