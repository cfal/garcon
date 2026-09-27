import { describe, expect, it } from 'vitest';
import type { ExecutorSnapshot } from '$shared/executors';
import { resolveExecutorServiceNotice } from '../executor-service-notice.js';
import { remoteExecutor } from './fixtures.js';

const filesAndGit = { files: true, git: true, gh: false, terminals: false };

function executors(snapshot: ExecutorSnapshot | null, hasSnapshot = true) {
	const ready = () => snapshot?.enabled === true && snapshot.availability === 'ready';
	return {
		hasSnapshot,
		get: () => snapshot ?? undefined,
		isReady: ready,
		label: () => snapshot?.label ?? (hasSnapshot ? 'Unavailable executor' : remoteExecutor.id),
		filesAvailable: () => ready() && snapshot?.machineServices.files === true,
		gitAvailable: () => ready() && snapshot?.machineServices.git === true,
	} satisfies Parameters<typeof resolveExecutorServiceNotice>[0];
}

describe('resolveExecutorServiceNotice', () => {
	it('reports nothing when the executor provides the service', () => {
		const ready = executors({ ...remoteExecutor, machineServices: filesAndGit });
		expect(resolveExecutorServiceNotice(ready, remoteExecutor.id, 'files')).toBeNull();
		expect(resolveExecutorServiceNotice(ready, remoteExecutor.id, 'git')).toBeNull();
	});

	it('reports removed and unavailable executors before any service capability', () => {
		expect(resolveExecutorServiceNotice(executors(null), remoteExecutor.id, 'git')).toEqual({
			kind: 'executor-removed',
			executorId: remoteExecutor.id,
		});
		for (const snapshot of [
			{ ...remoteExecutor, availability: 'offline', machineServices: filesAndGit },
			{ ...remoteExecutor, enabled: false, machineServices: filesAndGit },
		] satisfies ExecutorSnapshot[]) {
			expect(resolveExecutorServiceNotice(executors(snapshot), remoteExecutor.id, 'files')).toEqual(
				{
					kind: 'executor-unavailable',
					executorLabel: 'Worker',
				},
			);
		}
		expect(
			resolveExecutorServiceNotice(executors(null, false), remoteExecutor.id, 'files'),
		).toEqual({
			kind: 'executor-unavailable',
			executorLabel: remoteExecutor.id,
		});
	});

	it('reports a ready executor that does not provide the service', () => {
		expect(
			resolveExecutorServiceNotice(executors(remoteExecutor), remoteExecutor.id, 'git'),
		).toEqual({
			kind: 'service-unavailable',
			service: 'git',
			executorLabel: 'Worker',
		});
	});
});
