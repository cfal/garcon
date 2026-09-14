import { describe, expect, it } from 'vitest';
import {
	createFileDraftRepository,
	createMemoryFileDraftRepository,
	fileDraftKey,
	FILE_DRAFT_DOCUMENT_LIMIT_BYTES,
	FILE_DRAFT_LIMIT,
	type FileDraft,
} from '$lib/files/persistence/file-draft-repository.js';

function draft(path = 'file.ts', userNamespace = 'user', deploymentId = 'deployment'): FileDraft {
	return {
		schemaVersion: 1,
		userNamespace,
		deploymentId,
		documentId: fileDraftKey(userNamespace, deploymentId, '/workspace', path),
		canonicalFileRootPath: '/workspace',
		normalizedRelativePath: path,
		content: 'changed',
		savedAt: 1,
	};
}

describe('file draft repository', () => {
	it('overwrites the one backup per file instead of creating recovery copies', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(draft());
		await repository.putDraft({ ...draft(), content: 'latest', savedAt: 2 });
		expect(await repository.getDrafts('user', 'deployment')).toEqual([
			{ ...draft(), content: 'latest', savedAt: 2 },
		]);
	});

	it('retries a transient IndexedDB open failure', async () => {
		let attempts = 0;
		const indexedDb = {
			open() {
				attempts += 1;
				throw new Error('open failed');
			},
		} satisfies Pick<IDBFactory, 'open'>;
		const repository = createFileDraftRepository(indexedDb);
		await expect(repository.getDrafts('user', 'deployment')).rejects.toThrow('open failed');
		await expect(repository.getDrafts('user', 'deployment')).rejects.toThrow('open failed');
		expect(attempts).toBe(2);
	});

	it('isolates backups and clearing by user and deployment', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putDraft(draft('file.ts', 'user-a'));
		await repository.putDraft(draft('file.ts', 'user-b'));
		await repository.putDraft(draft('file.ts', 'user-a', 'other-deployment'));
		await repository.clearDrafts('user-a', 'deployment');
		expect(await repository.getDrafts('user-a', 'deployment')).toEqual([]);
		expect(await repository.getDrafts('user-b', 'deployment')).toHaveLength(1);
		expect(await repository.getDrafts('user-a', 'other-deployment')).toHaveLength(1);
	});

	it('evicts the oldest backup when the retained file limit is reached', async () => {
		const repository = createMemoryFileDraftRepository();
		for (let i = 0; i <= FILE_DRAFT_LIMIT; i++) {
			await repository.putDraft({ ...draft(i + '.txt'), savedAt: i });
		}
		const records = await repository.getDrafts('user', 'deployment');
		expect(records).toHaveLength(FILE_DRAFT_LIMIT);
		expect(records.some((record) => record.normalizedRelativePath === '0.txt')).toBe(false);
	});

	it('enforces the per-file boundary without removing an existing backup on failure', async () => {
		const repository = createMemoryFileDraftRepository();
		const content = 'x'.repeat(FILE_DRAFT_DOCUMENT_LIMIT_BYTES / 2);
		await repository.putDraft({ ...draft(), content });
		await expect(repository.putDraft({ ...draft(), content: content + 'x' })).rejects.toThrow(
			'too large',
		);
		expect((await repository.getDrafts('user', 'deployment'))[0].content).toBe(content);
	});

	it('evicts older backups to stay within the total byte budget', async () => {
		const repository = createMemoryFileDraftRepository();
		const content = 'x'.repeat(FILE_DRAFT_DOCUMENT_LIMIT_BYTES / 2);
		for (let i = 0; i < 5; i++) {
			await repository.putDraft({ ...draft(i + '.txt'), content, savedAt: i });
		}
		expect(
			(await repository.getDrafts('user', 'deployment')).map(
				(record) => record.normalizedRelativePath,
			),
		).toEqual(['4.txt', '3.txt', '2.txt', '1.txt']);
	});
});
