import { describe, expect, it, vi } from 'vitest';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import {
	FILE_DRAFT_MAX_INTERVAL_MS,
	FileDraftCoordinator,
} from '$lib/files/persistence/file-draft-coordinator.svelte.js';
import { createMemoryFileDraftRepository } from '$lib/files/persistence/file-draft-repository.js';

function document() {
	const value = new FileDocumentState(
		{
			executorId: 'local',
			canonicalFileRootPath: '/workspace',
			normalizedRelativePath: 'src/file.ts',
		},
		'file',
	);
	value.baseline = 'initial';
	value.loadedRevision = 'v1:initial';
	value.content = 'changed';
	return value;
}
function harness(durable = true) {
	const repository = createMemoryFileDraftRepository(durable);
	const coordinator = new FileDraftCoordinator({
		repository,
		deploymentId: 'deployment',
		userNamespace: 'user',
	});
	return { repository, coordinator };
}

describe('FileDraftCoordinator', () => {
	it('keeps only the latest pending checkpoint while a write is blocked', async () => {
		const { repository, coordinator } = harness();
		const put = repository.putDraft.bind(repository);
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const writes = vi.spyOn(repository, 'putDraft').mockImplementationOnce(async (record) => {
			await barrier;
			await put(record);
		});
		const value = document();
		void coordinator.settle(value);
		await vi.waitFor(() => expect(writes).toHaveBeenCalledOnce());
		for (let revision = 0; revision < 100; revision += 1) {
			value.content = `synthetic revision ${revision}`;
			void coordinator.settle(value);
		}
		const flushed = coordinator.flush();
		release();
		await flushed;
		expect(writes).toHaveBeenCalledTimes(2);
		expect(writes.mock.calls.map(([record]) => record.content)).toEqual([
			'changed',
			'synthetic revision 99',
		]);
		coordinator.destroy();
	});

	it('does not coalesce checkpoints across a successful save deletion', async () => {
		const { repository, coordinator } = harness();
		const put = repository.putDraft.bind(repository);
		const remove = repository.deleteDraft.bind(repository);
		const operations: string[] = [];
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(repository, 'putDraft').mockImplementation(async (record) => {
			operations.push(record.content);
			if (operations.length === 1) await barrier;
			await put(record);
		});
		vi.spyOn(repository, 'deleteDraft').mockImplementation(async (id) => {
			operations.push('delete');
			await remove(id);
		});
		const value = document();
		void coordinator.settle(value);
		await vi.waitFor(() => expect(operations).toEqual(['changed']));
		value.content = 'before save';
		void coordinator.settle(value);
		value.dirty = false;
		void coordinator.settle(value);
		value.content = 'after save';
		const final = coordinator.settle(value);
		release();
		await final;
		expect(operations).toEqual(['changed', 'before save', 'delete', 'after save']);
		coordinator.destroy();
	});

	it('discovers metadata without reading bodies and reports a missing recovery body', async () => {
		const { repository, coordinator } = harness();
		coordinator.closeDocument(document());
		await coordinator.flush();
		const read = vi.spyOn(repository, 'getDraft');
		await coordinator.initialize();
		expect(read).not.toHaveBeenCalled();
		const [summary] = coordinator.available;
		expect(summary).not.toHaveProperty('content');
		await repository.deleteDraft(summary.documentId);
		expect(await coordinator.read(summary)).toBeNull();
		expect(coordinator.error).toBeTruthy();
		expect(coordinator.available).toHaveLength(0);
		coordinator.destroy();
	});

	it('does not warn about unavailable storage when a clean document needs no backup', async () => {
		const { coordinator } = harness(false);
		const value = document();
		value.dirty = false;
		coordinator.closeDocument(value);
		await coordinator.flush();
		expect(value.recoveryError).toBeNull();
		coordinator.destroy();
	});

	it('reports checkpoint failure and retries without rejecting editor operations', async () => {
		const { repository, coordinator } = harness();
		const putDraft = vi.spyOn(repository, 'putDraft').mockRejectedValueOnce(new Error('quota'));
		const value = document();
		await expect(coordinator.settle(value)).resolves.toBeUndefined();
		expect(value.recoveryError).toBe('quota');
		await coordinator.settle(value);
		expect(value.recoveryError).toBeNull();
		expect(putDraft).toHaveBeenCalledTimes(2);
		coordinator.destroy();
	});

	it('marks unavailable storage without guarding the document', async () => {
		const { coordinator } = harness(false);
		const value = document();
		await coordinator.settle(value);
		expect(value.recoveryError).toBeTruthy();
		expect(value.mutationGuarded).toBe(false);
		coordinator.destroy();
	});

	it('retires a recovery summary only after its clean checkpoint deletion succeeds', async () => {
		const { repository, coordinator } = harness();
		try {
			const value = document();
			await coordinator.settle(value);
			await coordinator.initialize();
			const [summary] = coordinator.available;
			vi.spyOn(repository, 'deleteDraft').mockRejectedValueOnce(new Error('Storage blocked'));
			value.content = value.baseline;
			await coordinator.settle(value);
			expect(value.recoveryError).toBe('Storage blocked');
			expect(coordinator.available).toEqual([summary]);
			expect((await coordinator.read(summary))?.content).toBe('changed');
			await coordinator.settle(value);
			expect(value.recoveryError).toBeNull();
			expect(coordinator.available).toEqual([]);
			expect(await repository.getDraft(summary.documentId)).toBeNull();
		} finally {
			coordinator.destroy();
		}
	});

	it('uses one draft slot across close and reopen', async () => {
		const { repository, coordinator } = harness();
		coordinator.closeDocument(document());
		const reopened = document();
		reopened.content = 'newer edit';
		await coordinator.settle(reopened);
		const records = await repository.getDrafts('user', 'deployment');
		expect(records).toHaveLength(1);
		expect((await repository.getDraft(records[0].documentId))?.content).toBe('newer edit');
		coordinator.destroy();
	});

	it('serializes a checkpoint before a later successful Save cleanup', async () => {
		const { repository, coordinator } = harness();
		const put = repository.putDraft.bind(repository);
		let release!: () => void;
		vi.spyOn(repository, 'putDraft').mockImplementationOnce(async (record) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			await put(record);
		});
		const value = document();
		const checkpoint = coordinator.settle(value);
		await vi.waitFor(() => expect(repository.putDraft).toHaveBeenCalled());
		value.baseline = value.content;
		value.dirty = false;
		const cleanup = coordinator.settle(value);
		release();
		await Promise.all([checkpoint, cleanup]);
		expect(await repository.getDrafts('user', 'deployment')).toEqual([]);
		coordinator.destroy();
	});

	it('checkpoints continuous edits at the maximum interval', async () => {
		vi.useFakeTimers();
		const { repository, coordinator } = harness();
		try {
			const putDraft = vi.spyOn(repository, 'putDraft');
			const value = document();
			for (let elapsed = 0; elapsed < FILE_DRAFT_MAX_INTERVAL_MS; elapsed += 500) {
				coordinator.schedule(value);
				await vi.advanceTimersByTimeAsync(500);
			}
			expect(putDraft).toHaveBeenCalledOnce();
		} finally {
			coordinator.destroy();
			vi.useRealTimers();
		}
	});

	it('discovers drafts without publishing live documents and forgets an explicit discard', async () => {
		const { repository, coordinator } = harness();
		coordinator.closeDocument(document());
		await coordinator.flush();
		await coordinator.initialize();
		const draft = coordinator.available[0];
		expect(draft).not.toHaveProperty('content');
		expect((await coordinator.read(draft))?.content).toBe('changed');
		coordinator.discard(draft);
		expect(coordinator.available).toEqual([]);
		await coordinator.flush();
		expect(await repository.getDrafts('user', 'deployment')).toEqual([]);
		coordinator.destroy();
	});

	it('propagates explicit cleanup failures and allows retry', async () => {
		const { repository, coordinator } = harness();
		const error = new Error('Storage blocked');
		vi.spyOn(repository, 'clearDrafts').mockRejectedValueOnce(error);
		await expect(coordinator.clear()).rejects.toBe(error);
		expect(coordinator.error).toBe('Storage blocked');
		await expect(coordinator.clear()).resolves.toBe(true);
		expect(coordinator.error).toBeNull();
		coordinator.destroy();
	});

	it('orders writes across close and reopen while the old checkpoint is pending', async () => {
		const { repository, coordinator } = harness();
		const put = repository.putDraft.bind(repository);
		let release!: () => void;
		vi.spyOn(repository, 'putDraft').mockImplementationOnce(async (record) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			await put(record);
		});
		const closed = document();
		coordinator.closeDocument(closed);
		closed.dispose();
		await vi.waitFor(() => expect(repository.putDraft).toHaveBeenCalledOnce());
		const reopened = document();
		reopened.content = 'reopened edit';
		const checkpoint = coordinator.settle(reopened);
		expect(repository.putDraft).toHaveBeenCalledOnce();
		release();
		await checkpoint;
		const [summary] = await repository.getDrafts('user', 'deployment');
		expect((await repository.getDraft(summary.documentId))?.content).toBe('reopened edit');
		coordinator.destroy();
	});
});
