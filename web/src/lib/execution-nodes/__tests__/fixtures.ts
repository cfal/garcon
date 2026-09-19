import type { ExecutionNodeSnapshot } from '$shared/execution-nodes';

export const localExecutionNode = {
	id: 'local', label: 'Local', kind: 'local', enabled: true, direction: null,
	availability: 'ready', projectBasePath: '/workspace', lastError: null,
	machineServices: { files: true, git: true, terminals: true },
} satisfies ExecutionNodeSnapshot;

export const remoteExecutionNode = {
	id: '22222222-2222-4222-8222-222222222222', label: 'Worker', kind: 'remote',
	enabled: true, direction: 'node-connects', availability: 'ready',
	projectBasePath: '/worker', lastError: null,
	machineServices: { files: false, git: false, terminals: false },
} satisfies ExecutionNodeSnapshot;
