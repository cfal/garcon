import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitStatus, gitCommitIndex, gitStageHunk } from '../git.js';
import {
	getGitReviewDocumentFileBodies,
	type GitReviewFilePatchBody,
} from '../git-review-documents.js';
import { getPullRequest } from '../pull-requests.js';
import { gitReviewWorker } from '$lib/git/review/git-review-worker-client.js';
import { createGitPatchIndex, getGitSplitPatchIndex } from '$lib/git/review/git-patch-index.js';

const target = { executorId: 'remote-executor', projectPath: '/project' };
const scope = { executorId: target.executorId, instanceId: 'instance-a' };
const document = { ...scope, documentId: 'document-a' };
const fetchMock = vi.fn<typeof fetch>();
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function patchBodies(paths: string[], patch: string): Record<string, GitReviewFilePatchBody> {
	return Object.fromEntries(
		paths.map((path) => [
			path,
			{
				path,
				patch,
				bodyFingerprint: path,
				bodyState: 'loaded',
				category: 'normal',
				isBinary: false,
				isTooLarge: false,
				patchBytes: patch.length,
				renderedRowCount: 2,
			},
		]),
	);
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Git executor response boundaries', () => {
	it('publishes each index before waiting for the next file, preserving deferred paths', async () => {
		const patch = '@@ -0,0 +1 @@\n+const value = true;\n';
		const index = createGitPatchIndex(patch);
		const indexed = {
			kind: 'index' as const,
			index: index.toData(),
			split: getGitSplitPatchIndex(index).toData(),
		};
		const held = Promise.withResolvers<typeof indexed>();
		const run = vi
			.spyOn(gitReviewWorker, 'run')
			.mockResolvedValueOnce(indexed)
			.mockReturnValueOnce(held.promise);
		fetchMock.mockResolvedValue(
			response({
				...scope,
				documentId: document.documentId,
				status: 'ready',
				files: patchBodies(['a.ts', 'b.ts'], patch),
				errors: {},
				deferredFiles: ['constructor'],
			}),
		);
		const onIndexedBodies = vi.fn();
		const result = getGitReviewDocumentFileBodies(
			target,
			document,
			['a.ts', 'b.ts', 'constructor'],
			'visible',
			{ onIndexedBodies },
		);
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
		expect(onIndexedBodies).toHaveBeenCalledTimes(1);
		expect(onIndexedBodies.mock.calls[0][1]).toEqual(['a.ts']);
		held.resolve(indexed);
		expect(await result).toMatchObject({ deferredFiles: ['constructor'] });
		expect(onIndexedBodies.mock.calls.map((call) => call[1])).toEqual([['a.ts'], ['b.ts']]);
	});

	it('stops indexing when a partial publication cancels its document', async () => {
		const patch = '@@ -0,0 +1 @@\n+value\n';
		const index = createGitPatchIndex(patch);
		const run = vi.spyOn(gitReviewWorker, 'run').mockResolvedValue({
			kind: 'index',
			index: index.toData(),
			split: getGitSplitPatchIndex(index).toData(),
		});
		fetchMock.mockResolvedValue(
			response({
				...scope,
				documentId: document.documentId,
				status: 'ready',
				files: patchBodies(['a.ts', 'b.ts'], patch),
				errors: {},
				deferredFiles: [],
			}),
		);
		const controller = new AbortController();
		await expect(
			getGitReviewDocumentFileBodies(target, document, ['a.ts', 'b.ts'], 'visible', {
				signal: controller.signal,
				onIndexedBodies: () => controller.abort(),
			}),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(run).toHaveBeenCalledOnce();
	});

	it.each(
		[undefined, [], ['a.ts'], ['a.ts', 'a.ts'], ['other']].map((deferredFiles) => ({
			deferredFiles,
		})),
	)('rejects incomplete or invalid singleton deferrals: %j', async ({ deferredFiles }) => {
		fetchMock.mockResolvedValue(
			response({
				...scope,
				documentId: document.documentId,
				status: 'ready',
				files: {},
				errors: {},
				deferredFiles,
			}),
		);
		await expect(
			getGitReviewDocumentFileBodies(target, document, ['a.ts'], 'visible'),
		).rejects.toMatchObject({ errorCode: 'GIT_INVALID_RESULT' });
	});
	it.each(['file.ts', 'constructor', 'toString', '__proto__'])(
		'indexes %s without changing executor-qualified metadata or selection proof',
		async (path) => {
			const patch = '@@ -0,0 +1 @@\n+const synthetic = true;\n';
			const index = createGitPatchIndex(patch);
			const run = vi.spyOn(gitReviewWorker, 'run').mockResolvedValue({
				kind: 'index',
				index: index.toData(),
				split: getGitSplitPatchIndex(index).toData(),
			});
			fetchMock.mockResolvedValue(
				response({
					...scope,
					documentId: document.documentId,
					status: 'ready',
					errors: {},
					deferredFiles: [],
					files: {
						[path]: {
							path,
							bodyFingerprint: 'synthetic',
							patchDigest: 'a'.repeat(64),
							bodyState: 'loaded',
							category: 'normal',
							isBinary: false,
							isTooLarge: false,
							patch,
							patchBytes: patch.length,
							renderedRowCount: 2,
						},
					},
				}),
			);
			const result = await getGitReviewDocumentFileBodies(target, document, [path], 'visible');
			expect(result.documentId).toContain('remote-executor');
			if (result.status !== 'ready') throw new Error('Expected ready result');
			expect(Object.hasOwn(result.files, path)).toBe(true);
			expect(result.files[path].patchDigest).toBe('a'.repeat(64));
			expect(result.files[path].patchIndex?.rowAt(1).text).toBe('const synthetic = true;');
			expect(run).toHaveBeenCalledOnce();
		},
	);

	it('surfaces indexing failures as per-file errors, not empty loaded bodies', async () => {
		vi.spyOn(gitReviewWorker, 'run').mockRejectedValue(new Error('Synthetic indexing deadline'));
		fetchMock.mockResolvedValue(
			response({
				...scope,
				documentId: document.documentId,
				status: 'ready',
				errors: {},
				deferredFiles: [],
				files: {
					'file.ts': {
						path: 'file.ts',
						bodyFingerprint: 'synthetic',
						bodyState: 'loaded',
						category: 'normal',
						isBinary: false,
						isTooLarge: false,
						patch: '@@ -0,0 +1 @@\n+synthetic\n',
						patchBytes: 32,
						renderedRowCount: 2,
					},
				},
			}),
		);
		const result = await getGitReviewDocumentFileBodies(target, document, ['file.ts'], 'visible');
		if (result.status !== 'ready') throw new Error('Expected ready result');
		expect(result.files['file.ts']).toMatchObject({
			bodyState: 'error',
			patch: null,
			patchIndex: null,
			error: 'Synthetic indexing deadline',
		});
	});
	it('rejects a Local response to an explicit remote read', async () => {
		fetchMock.mockResolvedValue(response({ ...scope, executorId: 'local' }));
		await expect(getGitStatus(target)).rejects.toMatchObject({ errorCode: 'GIT_INVALID_RESULT' });
		expect(fetchMock.mock.calls[0][0]).toContain('executorId=remote-executor');
	});

	it.each([
		{ ...scope, executorId: 'local', success: true },
		{ ...scope },
		{ ...scope, success: 'yes' },
	])('does not confirm malformed or retargeted mutations: %j', async (value) => {
		fetchMock.mockResolvedValue(response(value));
		await expect(gitCommitIndex(target, 'synthetic commit')).rejects.toMatchObject({
			errorCode: 'GIT_MUTATION_OUTCOME_UNKNOWN',
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('classifies a lost HTTP reply as uncertain without retrying', async () => {
		fetchMock.mockRejectedValue(new TypeError('Connection lost'));
		await expect(gitCommitIndex(target, 'synthetic commit')).rejects.toMatchObject({
			errorCode: 'GIT_MUTATION_OUTCOME_UNKNOWN',
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('preserves typed rejection before dispatch', async () => {
		fetchMock.mockResolvedValue(
			response(
				{
					success: false,
					error: 'Offline',
					errorCode: 'EXECUTOR_UNAVAILABLE',
					retryable: false,
				},
				503,
			),
		);
		await expect(gitCommitIndex(target, 'synthetic commit')).rejects.toMatchObject({
			errorCode: 'EXECUTOR_UNAVAILABLE',
		});
	});

	it('submits the exact captured partial-staging proof', async () => {
		fetchMock.mockResolvedValue(response({ ...scope, success: true }));
		const proof = { document, bodyFingerprint: 'fingerprint', patchDigest: 'a'.repeat(64) };
		await gitStageHunk(target, 'file.ts', 'stage', 0, 5, proof);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
			executorId: target.executorId,
			project: '/project',
			...proof,
			hunkIndex: 0,
			contextLines: 5,
		});
	});

	it('rejects review bodies from a replacement serving instance', async () => {
		fetchMock.mockResolvedValue(
			response({
				...scope,
				instanceId: 'instance-b',
				status: 'ready',
				documentId: document.documentId,
				files: {},
				errors: {},
				deferredFiles: [],
			}),
		);
		await expect(
			getGitReviewDocumentFileBodies(target, document, ['file.ts'], 'visible'),
		).rejects.toMatchObject({ errorCode: 'GIT_STALE_DOCUMENT' });
	});

	it('qualifies PR rendering identities by executor, instance, project, and GitHub repository', async () => {
		const payload = {
			...scope,
			number: 1,
			headRefOid: 'a'.repeat(40),
			updatedAt: '2026-01-01',
			fileBodies: {},
		};
		fetchMock.mockImplementation(async () => response(payload));
		const prTarget = { ...target, repository: { host: 'github.com', nameWithOwner: 'acme/app' } };
		const first = await getPullRequest(prTarget, 1);
		const second = await getPullRequest({ ...prTarget, projectPath: '/other' }, 1);
		const otherHost = await getPullRequest(
			{ ...prTarget, repository: { ...prTarget.repository, host: 'github.example.com' } },
			1,
		);
		expect(first.documentId).not.toBe(second.documentId);
		expect(first.documentId).not.toBe(otherHost.documentId);
		expect(first.documentId).toContain('remote-executor');
		expect(first.reviewId).not.toBe(second.reviewId);
		expect(first.reviewId).not.toBe(otherHost.reviewId);
		fetchMock.mockResolvedValue(response({ ...payload, updatedAt: '2026-01-02' }));
		const refreshed = await getPullRequest(prTarget, 1);
		expect(refreshed.reviewId).toBe(first.reviewId);
		expect(refreshed.documentId).not.toBe(first.documentId);
		fetchMock.mockResolvedValue(response({ ...payload, headRefOid: 'b'.repeat(40) }));
		const replacedHead = await getPullRequest(prTarget, 1);
		expect(replacedHead.reviewId).toBe(first.reviewId);
		expect(replacedHead.documentId).not.toBe(first.documentId);
	});
});
