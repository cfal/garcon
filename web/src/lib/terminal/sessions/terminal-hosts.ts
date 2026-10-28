import { executorSupports, type ExecutorSnapshot } from '$shared/executors';
import { LOCAL_EXECUTOR_OPERATIONS } from '$shared/executor-contracts';
import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
import { parseTerminalReference } from '$shared/terminal-identity';
import type { TerminalClientSession } from './terminal-registry-types.js';

export function projectTerminalHosts(
	executors: readonly ExecutorSnapshot[] | undefined,
	sessions: readonly TerminalClientSession[],
) {
	const hosts = executors ?? [{
		id: 'local',
		label: 'Local',
		enabled: true,
		availability: 'ready',
		instanceId: null,
		operations: LOCAL_EXECUTOR_OPERATIONS,
		executorServices: { terminals: true },
	}];
	return hosts
		.filter(executor => executor.id === 'local' || executor.executorServices.terminals)
		.toSorted((left, right) => {
			if (left.id === 'local') return -1;
			if (right.id === 'local') return 1;
			return 0;
		})
		.map(executor => ({
			id: executor.id,
			instanceId: executor.instanceId,
			label: executor.label,
			available: executor.enabled && executor.availability === 'ready'
				&& executor.executorServices.terminals && executorSupports(executor, 'terminals.list'),
			full: sessions.filter(session =>
				(parseTerminalReference(session.metadata.terminalId)?.executorId ?? 'local') === executor.id,
			).length >= TERMINAL_SESSION_LIMIT,
		}));
}
