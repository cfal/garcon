import type { ExecutorSnapshot } from '$shared/executors';

export const localExecutor = {
	id: 'local', label: 'Local', kind: 'local', enabled: true, direction: null,
	allowControllerCli: true, allowExecutorManagement: true,
	availability: 'ready', projectBasePath: '/workspace', lastError: null,
	instanceId: 'synthetic-local-instance',
	bulk: null,
	machineServices: { files: true, git: true, gh: true, terminals: true },
} satisfies ExecutorSnapshot;

export const remoteExecutor = {
	id: '22222222-2222-4222-8222-222222222222', label: 'Worker', kind: 'remote',
	enabled: true, direction: 'executor-connects', availability: 'ready',
	allowControllerCli: false, allowExecutorManagement: false,
	projectBasePath: '/worker', lastError: null,
	instanceId: 'synthetic-remote-instance',
	bulk: { availability: 'ready', lastError: null },
	machineServices: { files: false, git: false, gh: false, terminals: false },
} satisfies ExecutorSnapshot;
