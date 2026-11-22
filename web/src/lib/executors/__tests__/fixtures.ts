import type { ExecutorSnapshot } from '$shared/executors';

export const localExecutor = {
	id: 'local', label: 'Local', kind: 'local', enabled: true, direction: null,
	allowControllerCli: true, allowExecutorManagement: true,
	availability: 'ready', projectBasePath: '/workspace', lastError: null,
	instanceId: 'synthetic-local-instance',
	bulk: null,
	executorServices: { files: true, git: true, gh: true, terminals: true, directoryCreation: true },
} satisfies ExecutorSnapshot;

export const remoteExecutor = {
	id: '22222222-2222-4222-8222-222222222222', label: 'Worker', kind: 'remote',
	enabled: true, direction: 'executor-connects', availability: 'ready',
	allowControllerCli: false, allowExecutorManagement: false,
	projectBasePath: '/worker', lastError: null,
	instanceId: 'synthetic-remote-instance',
	bulk: { availability: 'ready', lastError: null },
	executorServices: { files: false, git: false, gh: false, terminals: false, directoryCreation: false },
} satisfies ExecutorSnapshot;

export const localScope = { executorId: localExecutor.id, instanceId: localExecutor.instanceId };
export const remoteScope = { executorId: remoteExecutor.id, instanceId: remoteExecutor.instanceId };
