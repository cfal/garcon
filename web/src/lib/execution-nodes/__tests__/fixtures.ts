import type { ExecutionNodeSnapshot } from '$shared/execution-nodes';

export const localExecutionNode = {
	id: 'local', label: 'Local', kind: 'local', enabled: true, direction: null,
	allowControllerCli: true,
	availability: 'ready', projectBasePath: '/workspace', lastError: null,
	instanceId: 'synthetic-local-instance',
	machineServices: { files: true, git: true, gh: true, terminals: true },
} satisfies ExecutionNodeSnapshot;

export const remoteExecutionNode = {
	id: '22222222-2222-4222-8222-222222222222', label: 'Worker', kind: 'remote',
	enabled: true, direction: 'node-connects', availability: 'ready',
	allowControllerCli: false,
	projectBasePath: '/worker', lastError: null,
	instanceId: 'synthetic-remote-instance',
	machineServices: { files: false, git: false, gh: false, terminals: false },
} satisfies ExecutionNodeSnapshot;
