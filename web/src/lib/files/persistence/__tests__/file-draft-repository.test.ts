import { describe, expect, it } from 'vitest';
import {
	createFileDraftRepository,
	createMemoryFileDraftRepository,
	type FileRecentLocationV1,
	type SpaFileDraftV1,
	type SpaFileViewV1,
} from '$lib/files/persistence/file-draft-repository.js';

function recent(userNamespace: string, deploymentId: string): FileRecentLocationV1 {
	return {
		schemaVersion: 1,
		userNamespace,
		deploymentId,
		key: 'shared-key',
		canonicalFileRootPath: '/workspace',
		normalizedRelativePath: 'src/file.ts',
		displayPath: 'src/file.ts',
		revision: null,
		line: 1,
		column: 1,
		viewPreference: 'source',
		timestamp: 1,
	};
}

function view(
	userNamespace: string,
	deploymentId: string,
	browserSessionId = 'browser',
): SpaFileViewV1 {
	return {
		schemaVersion: 1,
		userNamespace,
		deploymentId,
		browserSessionId,
		viewId: 'shared-view',
		documentId: 'document',
		canonicalFileRootPath: '/workspace',
		normalizedRelativePath: 'src/file.ts',
		rendererMode: 'code',
		line: 1,
		column: 1,
		endLine: 1,
		endColumn: 1,
		scrollLeft: 0,
		scrollTop: 0,
		folds: [],
		pinned: true,
		preview: false,
		updatedAt: 1,
		placement: 'window-main',
	};
}

describe('file draft repository', () => {
	it('atomically adopts a recovered draft under a live document key', async () => {
		const repository = createMemoryFileDraftRepository();
		const draft: SpaFileDraftV1 = {
			schemaVersion: 1,
			deploymentId: 'deployment',
			userNamespace: 'user',
			browserSessionId: 'browser',
			documentId: 'restored-document',
			canonicalFileRootPath: '/workspace',
			normalizedRelativePath: 'src/file.ts',
			displayPath: 'src/file.ts',
			diskRevision: 'v1:restored',
			baselineContent: 'base',
			content: 'local',
			bufferVersion: 3,
			savedAt: 1,
			generation: 7,
			unknownSubmission: null,
			closed: false,
		};
		await repository.putDraft(draft);
		const [stored] = await repository.getDrafts('user', 'deployment', 'browser');

		const adopted = await repository.adoptDraft(stored!, 'live-document');

		expect(adopted.localDocumentId).toBe('live-document');
		expect(adopted.documentId).not.toBe(draft.documentId);
		expect(await repository.getDrafts('user', 'deployment', 'browser')).toEqual([adopted]);
	});

	it('retries a transient IndexedDB open failure', async () => {
		let attempts = 0;
		const indexedDb = {
			open() {
				attempts += 1;
				const request: Record<string, unknown> = {
					result: undefined,
					error: new Error('open failed'),
				};
				queueMicrotask(() => (request.onerror as (() => void) | null)?.());
				return request as unknown as IDBOpenDBRequest;
			},
		};
		const repository = createFileDraftRepository(indexedDb);

		await expect(repository.getRecents('user', 'deployment')).rejects.toThrow('open failed');
		await expect(repository.getRecents('user', 'deployment')).rejects.toThrow('open failed');
		expect(attempts).toBe(2);
	});

	it('keeps recents and view IDs isolated by user and deployment', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putRecent(recent('user-a', 'deployment-a'));
		await repository.putRecent(recent('user-b', 'deployment-a'));
		await repository.putView(view('user-a', 'deployment-a'));
		await repository.putView(view('user-b', 'deployment-a'));

		expect(await repository.getRecents('user-a', 'deployment-a')).toHaveLength(1);
		expect(await repository.getRecents('user-b', 'deployment-a')).toHaveLength(1);
		expect(await repository.getViews('user-a', 'deployment-a', 'browser')).toHaveLength(1);
		expect(await repository.getViews('user-b', 'deployment-a', 'browser')).toHaveLength(1);
	});

	it('keeps same-user view ownership isolated between browser sessions', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putView(view('user', 'deployment', 'tab-a'));
		await repository.putView(view('user', 'deployment', 'tab-b'));

		expect(await repository.getViews('user', 'deployment', 'tab-a')).toHaveLength(1);
		expect(await repository.getViews('user', 'deployment', 'tab-b')).toHaveLength(1);
		await repository.deleteView('shared-view', 'user', 'deployment', 'tab-a');
		expect(await repository.getViews('user', 'deployment', 'tab-a')).toEqual([]);
		expect(await repository.getViews('user', 'deployment', 'tab-b')).toHaveLength(1);
	});

	it('rejects one draft beyond the per-document recovery budget', async () => {
		const repository = createMemoryFileDraftRepository();
		await expect(
			repository.putDraft({
				schemaVersion: 1,
				deploymentId: 'deployment',
				userNamespace: 'user',
				browserSessionId: 'browser',
				documentId: 'large',
				canonicalFileRootPath: '/workspace',
				normalizedRelativePath: 'large.txt',
				displayPath: 'large.txt',
				diskRevision: null,
				baselineContent: null,
				content: 'x'.repeat(24 * 1024 * 1024),
				bufferVersion: 1,
				savedAt: 1,
				generation: 1,
				unknownSubmission: null,
				closed: false,
			}),
		).rejects.toThrow('too large');
	});

	it('clears only the requested recovery namespace', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putRecent(recent('user-a', 'deployment-a'));
		await repository.putRecent(recent('user-b', 'deployment-a'));

		await expect(
			repository.clearNamespaceIfUnprotected('user-a', 'deployment-a'),
		).resolves.toBe(true);

		expect(await repository.getRecents('user-a', 'deployment-a')).toEqual([]);
		expect(await repository.getRecents('user-b', 'deployment-a')).toHaveLength(1);
	});

	it('clears shared navigation while retaining recovery owned by another browser session', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putRecent(recent('user', 'deployment'));
		await repository.putNavigation({
			schemaVersion: 1,
			userNamespace: 'user',
			deploymentId: 'deployment',
			key: JSON.stringify(['user', 'deployment']),
			entries: [recent('user', 'deployment')],
			index: 0,
			updatedAt: 1,
		});
		await repository.putView(view('user', 'deployment', 'tab-a'));
		await repository.putView(view('user', 'deployment', 'tab-b'));

		await expect(
			repository.clearNamespaceIfUnprotected('user', 'deployment', 'tab-a'),
		).resolves.toBe(true);

		expect(await repository.getRecents('user', 'deployment')).toEqual([]);
		expect(await repository.getNavigation('user', 'deployment')).toBeNull();
		expect(await repository.getViews('user', 'deployment', 'tab-a')).toEqual([]);
		expect(await repository.getViews('user', 'deployment', 'tab-b')).toHaveLength(1);
	});

	it('keeps the entire namespace when any draft remains protected', async () => {
		const repository = createMemoryFileDraftRepository();
		await repository.putRecent(recent('user', 'deployment'));
		await repository.putView(view('user', 'deployment'));
		await repository.putDraft({
			schemaVersion: 1,
			deploymentId: 'deployment',
			userNamespace: 'user',
			browserSessionId: 'browser',
			documentId: 'protected-draft',
			canonicalFileRootPath: '/workspace',
			normalizedRelativePath: 'src/file.ts',
			displayPath: 'src/file.ts',
			diskRevision: 'v1:base',
			baselineContent: 'base',
			content: 'unsaved',
			bufferVersion: 1,
			savedAt: 1,
			generation: 1,
			unknownSubmission: null,
			closed: false,
		});

		await expect(
			repository.clearNamespaceIfUnprotected('user', 'deployment', 'browser'),
		).resolves.toBe(false);

		expect(await repository.getDrafts('user', 'deployment', 'browser')).toHaveLength(1);
		expect(await repository.getViews('user', 'deployment', 'browser')).toHaveLength(1);
		expect(await repository.getRecents('user', 'deployment')).toHaveLength(1);
	});
});
