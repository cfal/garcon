import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { FileDraftCoordinator } from '$lib/files/persistence/file-draft-coordinator.js';
import { createMemoryFileDraftRepository } from '$lib/files/persistence/file-draft-repository.js';
import { FileSaveCoordinator } from '$lib/files/persistence/file-save-coordinator.js';
import { MAX_FILE_VIEW_BYTES } from '$shared/file-contracts';

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
	it.each([
		['ASCII 9 MiB', 'x', 9 * 1024 * 1024],
		['escaped text at the file limit', '\t', MAX_FILE_VIEW_BYTES],
	] as const)('journals all three snapshots before saving %s', async (_name, character, length) => {
		const repository = createMemoryFileDraftRepository();
		const drafts = new FileDraftCoordinator({
			repository,
			deploymentId: 'deployment',
			userNamespace: 'user',
			browserSessionId: 'browser',
		});
		const value = document();
		value.baseline = character.repeat(length);
		value.content = character.repeat(length - 1) + '!';
		const saveText = vi.fn(async () => {
			const [journal] = await repository.getDrafts('user', 'deployment', 'browser');
			expect(journal?.baselineContent).toBe(value.baseline);
			expect(journal?.content).toBe(value.content);
			expect(journal?.unknownSubmission?.content).toBe(value.content);
			return {
				success: true as const,
				path: '/workspace/file.ts',
				message: 'saved',
				revision: 'v1:saved',
			};
		});
		const coordinator = new FileSaveCoordinator({
			saveText,
			getDrafts: () => drafts,
			getSoftTimeoutMs: () => 1_000,
			reconfigure: () => undefined,
		});
		try {
			await drafts.settle(value);
			await expect(
				coordinator.submit(
					value,
					value.content,
					value.bufferVersion,
					'reject',
					value.saveController!,
					'v1:initial',
				),
			).resolves.toBe('saved');
			expect(saveText).toHaveBeenCalledOnce();
			expect(value.dirty).toBe(false);
			expect(value.saveOutcome).toBe('idle');
			expect(await repository.getDrafts('user', 'deployment', 'browser')).toEqual([]);
		} finally {
			drafts.destroy();
		}
	});

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
		coordinator.finishAttempt(value, controller);
		expect(value.saveController).toBe(controller);
		expect(value.pendingMutationCount).toBe(1);
		value.pendingMutationCount += 1;

		await expect(coordinator.retrySettlement(value)).resolves.toBe(true);
		expect(saveText).toHaveBeenCalledOnce();
		expect(value.saveOutcome).toBe('idle');
		expect(deleteDraft).toHaveBeenCalledTimes(2);
		expect(value.saveController).toBeNull();
		expect(value.pendingMutationCount).toBe(1);
		coordinator.finishAttempt(value, controller);
		expect(value.pendingMutationCount).toBe(1);
	});

	it.each([
		[403, 'Permission denied', undefined],
		[404, 'File or directory not found', undefined],
		[500, 'Internal server error', 'INTERNAL_ERROR'],
	] as const)(
		'retains the submission after HTTP %s, which can follow disk mutation',
		async (status, message, code) => {
			const repository = createMemoryFileDraftRepository();
			const drafts = new FileDraftCoordinator({
				repository,
				deploymentId: 'deployment',
				userNamespace: 'user',
				browserSessionId: 'browser',
			});
			const coordinator = new FileSaveCoordinator({
				saveText: vi.fn(() => Promise.reject(new ApiError(status, message, code))),
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
			expect(value.dirty).toBe(true);
			expect(value.canDiscard).toBe(false);
			expect(value.pendingSubmission?.content).toBe('changed');
			const [journal] = await repository.getDrafts('user', 'deployment', 'browser');
			expect(journal?.unknownSubmission).toEqual(value.pendingSubmission);
			drafts.destroy();
		},
	);
});
