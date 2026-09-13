import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { FileDraftCoordinator } from '$lib/files/persistence/file-draft-coordinator.js';
import { createMemoryFileDraftRepository } from '$lib/files/persistence/file-draft-repository.js';
import { FileSaveCoordinator } from '$lib/files/persistence/file-save-coordinator.js';

function document() {
	const value = new FileDocumentState(
		{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.ts' },
		'["/workspace","file.ts"]',
	);
	value.baseline = 'initial';
	value.content = 'changed';
	value.loadedRevision = 'v1:initial';
	value.saveController = new AbortController();
	value.pendingMutationCount = 1;
	return value;
}

describe('FileSaveCoordinator', () => {
	it('retries browser settlement without dispatching another HTTP Save', async () => {
		const repository = createMemoryFileDraftRepository();
		const deleteDraft = vi
			.spyOn(repository, 'deleteDraft')
			.mockRejectedValueOnce(new Error('quota'));
		const drafts = new FileDraftCoordinator({
			repository,
			deploymentId: 'deployment',
			userNamespace: 'user',
			browserSessionId: 'browser',
		});
		const saveText = vi.fn(async () => ({
			success: true as const,
			path: '/workspace/file.ts',
			message: 'saved',
			revision: 'v1:saved',
		}));
		const coordinator = new FileSaveCoordinator({
			saveText,
			getDrafts: () => drafts,
			getSoftTimeoutMs: () => 1_000,
			reconfigure: () => undefined,
		});
		const value = document();
		const controller = value.saveController!;

		await expect(
			coordinator.submit(value, 'changed', value.bufferVersion, 'reject', controller, 'v1:initial'),
		).resolves.toBe('unknown');
		expect(value.settledSubmissionRevision).toBe('v1:saved');

		await expect(coordinator.retrySettlement(value)).resolves.toBe(true);
		expect(saveText).toHaveBeenCalledOnce();
		expect(value.saveOutcome).toBe('idle');
		expect(deleteDraft).toHaveBeenCalledTimes(2);
	});

	it('keeps a generic server failure guarded as an unknown disk outcome', async () => {
		const drafts = new FileDraftCoordinator({
			repository: createMemoryFileDraftRepository(),
			deploymentId: 'deployment',
			userNamespace: 'user',
			browserSessionId: 'browser',
		});
		const coordinator = new FileSaveCoordinator({
			saveText: vi.fn(() =>
				Promise.reject(new ApiError(500, 'Internal server error', 'INTERNAL_ERROR')),
			),
			getDrafts: () => drafts,
			getSoftTimeoutMs: () => 1_000,
			reconfigure: () => undefined,
		});
		const value = document();

		await expect(
			coordinator.submit(
				value,
				'changed',
				value.bufferVersion,
				'reject',
				value.saveController!,
				'v1:initial',
			),
		).resolves.toBe('unknown');

		expect(value.saveOutcome).toBe('unknown');
		expect(value.pendingSubmission?.content).toBe('changed');
	});
});
