import { describe, expect, it, vi } from 'vitest';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import {
	FILE_DRAFT_MAX_INTERVAL_MS,
	FileDraftCoordinator,
} from '$lib/files/persistence/file-draft-coordinator.js';
import { createMemoryFileDraftRepository } from '$lib/files/persistence/file-draft-repository.js';

function document() {
	const value = new FileDocumentState(
		{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'src/file.ts' },
		'["/workspace","src/file.ts"]',
		'document-1',
	);
	value.baseline = 'initial';
	value.content = 'changed';
	return value;
}

describe('FileDraftCoordinator', () => {
	it('recovers its write queue after a transient repository failure', async () => {
		const repository = createMemoryFileDraftRepository();
		const putDraft = vi.spyOn(repository, 'putDraft');
		putDraft.mockRejectedValueOnce(new Error('quota'));
		const coordinator = new FileDraftCoordinator({
			repository,
			deploymentId: 'deployment',
			userNamespace: 'user',
			browserSessionId: 'browser',
		});
		const value = document();

		await expect(coordinator.persistSubmission(value)).rejects.toThrow('quota');
		await expect(coordinator.persistSubmission(value)).resolves.toBeUndefined();
		expect(putDraft).toHaveBeenCalledTimes(2);
	});

	it('refuses Save admission when browser storage is not durable', async () => {
		const coordinator = new FileDraftCoordinator({
			repository: createMemoryFileDraftRepository(false),
			deploymentId: 'deployment',
			userNamespace: 'user',
			browserSessionId: 'browser',
		});

		await expect(coordinator.persistSubmission(document())).rejects.toThrow(
			'Browser recovery storage is unavailable',
		);
	});

	it('continues restored draft generations instead of writing stale records', async () => {
		const repository = createMemoryFileDraftRepository();
		const coordinator = new FileDraftCoordinator({
			repository,
			deploymentId: 'deployment',
			userNamespace: 'user',
			browserSessionId: 'browser',
		});
		const value = document();
		coordinator.adopt(value, 9);

		await coordinator.persistSubmission(value);

		const [record] = await repository.getDrafts('user', 'deployment', 'browser');
		expect(record?.generation).toBe(10);
	});

	it('checkpoints continuous edits at the maximum interval', async () => {
		vi.useFakeTimers();
		try {
			const repository = createMemoryFileDraftRepository();
			const putDraft = vi.spyOn(repository, 'putDraft');
			const coordinator = new FileDraftCoordinator({
				repository,
				deploymentId: 'deployment',
				userNamespace: 'user',
				browserSessionId: 'browser',
			});
			const value = document();
			for (let elapsed = 0; elapsed < FILE_DRAFT_MAX_INTERVAL_MS; elapsed += 500) {
				coordinator.schedule(value);
				await vi.advanceTimersByTimeAsync(500);
			}

			expect(putDraft).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('persists the immutable document snapshot before releasing it', async () => {
		const repository = createMemoryFileDraftRepository();
		const coordinator = new FileDraftCoordinator({
			repository,
			deploymentId: 'deployment',
			userNamespace: 'user',
			browserSessionId: 'browser',
		});
		const value = document();

		await coordinator.closeDocument(value);
		value.setStoredContent('stale');

		const [record] = await repository.getDrafts('user', 'deployment', 'browser');
		expect(record?.content).toBe('changed');
	});

	it('retains the checkpoint generation until a detached Save settles', async () => {
		const repository = createMemoryFileDraftRepository();
		const coordinator = new FileDraftCoordinator({
			repository,
			deploymentId: 'deployment',
			userNamespace: 'user',
			browserSessionId: 'browser',
		});
		const value = document();
		value.pendingSubmission = {
			submissionId: 'submission',
			resourceKey: value.identityKey,
			expectedDiskRevision: 'v1:initial',
			submittedBufferVersion: value.bufferVersion,
			conflictIntent: 'reject',
			content: value.content,
			startedAt: 1,
		};
		value.saveOutcome = 'unknown';
		await coordinator.persistSubmission(value);

		await coordinator.closeDocument(value);
		value.baseline = value.content;
		value.dirty = false;
		value.pendingSubmission = null;
		value.saveOutcome = 'settling';
		await coordinator.acknowledge(value);

		expect(await repository.getDrafts('user', 'deployment', 'browser')).toEqual([]);
	});
});
