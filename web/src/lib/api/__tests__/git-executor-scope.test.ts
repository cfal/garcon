import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitStatus, gitCommitIndex, gitStageHunk } from '../git.js';
import { getGitReviewDocumentFileBodies } from '../git-review-documents.js';
import { getPullRequestDiff } from '../pull-requests.js';

const target = { executorId: 'remote-executor', projectPath: '/project' };
const scope = { executorId: target.executorId, instanceId: 'instance-a' };
const document = { ...scope, documentId: 'document-a' };
const fetchMock = vi.fn<typeof fetch>();
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('Git executor response boundaries', () => {
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
			}),
		);
		await expect(
			getGitReviewDocumentFileBodies(target, document, ['file.ts'], 'visible'),
		).rejects.toMatchObject({ errorCode: 'GIT_STALE_DOCUMENT' });
	});

	it('qualifies PR rendering identities by executor, instance, project, GitHub repository, and commits', async () => {
		const commits = { baseRefOid: 'e'.repeat(40), headRefOid: 'a'.repeat(40) };
		fetchMock.mockImplementation(async (url: string | URL | Request) => {
			const query = new URL(String(url), 'http://localhost').searchParams;
			return response({
				...scope,
				number: 1,
				baseRefOid: query.get('baseRefOid'),
				headRefOid: query.get('headRefOid'),
				files: [],
				fileBodies: {},
			});
		});
		const prTarget = { ...target, repository: { host: 'github.com', nameWithOwner: 'acme/app' } };
		const first = await getPullRequestDiff(prTarget, 1, commits);
		const second = await getPullRequestDiff({ ...prTarget, projectPath: '/other' }, 1, commits);
		const otherHost = await getPullRequestDiff(
			{ ...prTarget, repository: { ...prTarget.repository, host: 'github.example.com' } },
			1,
			commits,
		);
		const pushed = await getPullRequestDiff(prTarget, 1, {
			...commits,
			headRefOid: 'b'.repeat(40),
		});
		expect(first.documentId).not.toBe(second.documentId);
		expect(first.documentId).not.toBe(otherHost.documentId);
		expect(first.documentId).not.toBe(pushed.documentId);
		expect(first.documentId).toBe((await getPullRequestDiff(prTarget, 1, commits)).documentId);
		expect(first.documentId).toContain('remote-executor');
	});
});
