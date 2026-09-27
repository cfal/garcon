import type { ExecutorsStore } from './executors-store.svelte.js';

type ExecutorAvailability = Pick<ExecutorsStore, 'isReady' | 'hasSnapshot' | 'get' | 'label'>;

export type ExecutorAvailabilityNotice =
	| { readonly kind: 'executor-removed'; readonly executorId: string }
	| { readonly kind: 'executor-unavailable'; readonly executorLabel: string };

export type ExecutorServiceNotice =
	| ExecutorAvailabilityNotice
	| {
			readonly kind: 'service-unavailable';
			readonly service: 'files' | 'git';
			readonly executorLabel: string;
	  };

export function resolveExecutorAvailabilityNotice(
	executors: ExecutorAvailability,
	executorId: string,
): ExecutorAvailabilityNotice | null {
	if (executors.isReady(executorId)) return null;
	return executors.hasSnapshot && !executors.get(executorId)
		? { kind: 'executor-removed', executorId }
		: { kind: 'executor-unavailable', executorLabel: executors.label(executorId) };
}

// Machine-service surfaces report executor-level outages separately from project
// failures, since choosing another folder cannot recover them.
export function resolveExecutorServiceNotice(
	executors: ExecutorAvailability & Pick<ExecutorsStore, 'filesAvailable' | 'gitAvailable'>,
	executorId: string,
	service: 'files' | 'git',
): ExecutorServiceNotice | null {
	const unavailable = resolveExecutorAvailabilityNotice(executors, executorId);
	if (unavailable) return unavailable;
	const available =
		service === 'files' ? executors.filesAvailable(executorId) : executors.gitAvailable(executorId);
	return available
		? null
		: { kind: 'service-unavailable', service, executorLabel: executors.label(executorId) };
}
