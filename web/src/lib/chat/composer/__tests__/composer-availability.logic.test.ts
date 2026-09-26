import { describe, expect, it } from 'vitest';
import type { ExecutorSnapshot } from '$shared/executors';
import type { ProjectTarget } from '$shared/project-resolution';
import { remoteExecutor } from '$lib/executors/__tests__/fixtures.js';
import {
	resolveComposerAvailabilityNotice,
	type ComposerAvailabilityInput,
} from '$lib/chat/composer/composer-availability.js';

const target: ProjectTarget = {
	kind: 'chat',
	chatId: 'chat-1',
	executorId: remoteExecutor.id,
	projectPath: '/worker/project',
};

function executors(snapshot: ExecutorSnapshot | null, hasSnapshot = true) {
	return {
		hasSnapshot,
		get: () => snapshot ?? undefined,
		isReady: () => snapshot?.availability === 'ready',
		label: () => snapshot?.label ?? 'Unavailable executor',
	} satisfies ComposerAvailabilityInput['executors'];
}

function input(overrides: Partial<ComposerAvailabilityInput> = {}): ComposerAvailabilityInput {
	return {
		executorId: remoteExecutor.id,
		executors: executors(remoteExecutor),
		projectTarget: target,
		projectResolution: { kind: 'available', effectiveProjectKey: '/worker/project' },
		catalog: { isValidated: true, error: null },
		providerAvailable: true,
		...overrides,
	};
}

describe('resolveComposerAvailabilityNotice', () => {
	it('reports nothing for a ready composer or while the catalog is still loading', () => {
		expect(resolveComposerAvailabilityNotice(input())).toBeNull();
		expect(
			resolveComposerAvailabilityNotice(input({
				catalog: { isValidated: false, error: null },
				providerAvailable: false,
			})),
		).toBeNull();
	});

	it('distinguishes a removed executor from a configured unavailable executor', () => {
		expect(resolveComposerAvailabilityNotice(input({ executors: executors(null) }))).toEqual({
			kind: 'executor-removed',
			executorId: remoteExecutor.id,
		});
		expect(
			resolveComposerAvailabilityNotice(input({
				executors: executors({ ...remoteExecutor, availability: 'offline' }),
			})),
		).toEqual({ kind: 'executor-unavailable', executorLabel: 'Worker' });
		expect(
			resolveComposerAvailabilityNotice(input({ executors: executors(null, false) })),
		).toEqual({ kind: 'executor-unavailable', executorLabel: 'Unavailable executor' });
	});

	it('orders executor, project, catalog, and provider obstacles outermost first', () => {
		const everythingFailing = input({
			projectResolution: { kind: 'unavailable', reason: 'not-found' },
			catalog: { isValidated: false, error: 'Synthetic catalog failure' },
			providerAvailable: false,
		});
		expect(
			resolveComposerAvailabilityNotice({ ...everythingFailing, executors: executors(null) })?.kind,
		).toBe('executor-removed');
		expect(resolveComposerAvailabilityNotice(everythingFailing)).toEqual({
			kind: 'project-unavailable',
			projectPath: '/worker/project',
			reason: 'not-found',
		});
		expect(
			resolveComposerAvailabilityNotice({
				...everythingFailing,
				projectResolution: { kind: 'request-failed', message: 'Synthetic project check failure' },
			}),
		).toEqual({
			kind: 'project-unavailable',
			projectPath: '/worker/project',
			requestError: 'Synthetic project check failure',
		});
		expect(
			resolveComposerAvailabilityNotice({ ...everythingFailing, projectResolution: { kind: 'resolving' } }),
		).toEqual({ kind: 'catalog-failed', message: 'Synthetic catalog failure' });
		expect(
			resolveComposerAvailabilityNotice(input({ providerAvailable: false })),
		).toEqual({ kind: 'provider-unavailable' });
	});

	it('ignores project resolution without a composer project target', () => {
		expect(
			resolveComposerAvailabilityNotice(input({
				projectTarget: null,
				projectResolution: { kind: 'unavailable', reason: 'not-found' },
			})),
		).toBeNull();
	});
});
